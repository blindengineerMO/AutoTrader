const { resilientFetch } = require('../utils/resilientFetch');
const EONET_HOME_URL = 'https://eonet.gsfc.nasa.gov/';
const EONET_DOCS_URL = 'https://eonet.gsfc.nasa.gov/docs/v3';
const EONET_OPEN_EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open';
const EONET_RECENT_EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?days=30';
const EONET_CATEGORIES_URL = 'https://eonet.gsfc.nasa.gov/api/v3/categories';

async function collectNaturalEventContext({ timeoutMs = 8000, days = 30, limit = 100, onEvent = () => {} } = {}) {
  const failures = [];
  const boundedLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  const boundedDays = Math.max(1, Math.min(365, Number(days) || 30));
  let openEvents = [];
  let recentEvents = [];
  let categories = [];

  try {
    const openData = await fetchJson(withParams(EONET_OPEN_EVENTS_URL, { limit: boundedLimit }), timeoutMs);
    openEvents = normalizeEvents(openData.events || []);
    emit(onEvent, 'eonet-natural-events', 35, 'debug', 'Fetched NASA EONET current open natural events.', {
      events: openEvents.length,
      url: EONET_OPEN_EVENTS_URL,
    });
  } catch (error) {
    failures.push({ source: 'eonet-open-events', url: EONET_OPEN_EVENTS_URL, error: error.message });
    emit(onEvent, 'eonet-natural-events', 35, 'warn', 'NASA EONET current open events unavailable.', {
      error: error.message,
    });
  }

  try {
    const recentUrl = `https://eonet.gsfc.nasa.gov/api/v3/events?days=${boundedDays}`;
    const recentData = await fetchJson(withParams(recentUrl, { limit: boundedLimit }), timeoutMs);
    recentEvents = normalizeEvents(recentData.events || []);
    emit(onEvent, 'eonet-natural-events', 36, 'debug', 'Fetched NASA EONET recent natural events.', {
      events: recentEvents.length,
      days: boundedDays,
      url: recentUrl,
    });
  } catch (error) {
    failures.push({ source: 'eonet-recent-events', url: EONET_RECENT_EVENTS_URL, error: error.message });
    emit(onEvent, 'eonet-natural-events', 36, 'warn', 'NASA EONET recent events unavailable.', {
      days: boundedDays,
      error: error.message,
    });
  }

  try {
    const categoryData = await fetchJson(EONET_CATEGORIES_URL, timeoutMs);
    categories = normalizeCategories(categoryData.categories || []);
  } catch (error) {
    failures.push({ source: 'eonet-categories', url: EONET_CATEGORIES_URL, error: error.message });
  }

  return evaluateNaturalEventContext({
    events: dedupeEvents([...openEvents, ...recentEvents]),
    categories,
    failures,
    days: boundedDays,
  });
}

function normalizeEvents(events = []) {
  return events.map((event) => {
    const geometry = Array.isArray(event.geometry) ? event.geometry : [];
    const sortedGeometry = [...geometry].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const latestGeometry = sortedGeometry[0] || {};
    const coordinates = Array.isArray(latestGeometry.coordinates) ? latestGeometry.coordinates : [];
    const lon = number(coordinates[0]);
    const lat = number(coordinates[1]);
    const categories = normalizeCategories(event.categories || []);
    const sources = (event.sources || []).map((source) => ({
      id: cleanText(source.id),
      url: cleanText(source.url),
    })).filter((source) => source.id || source.url);
    return {
      id: cleanText(event.id),
      title: cleanText(event.title),
      description: cleanText(event.description),
      link: cleanText(event.link),
      closed: event.closed || null,
      isOpen: event.closed === null || event.closed === undefined,
      categories,
      categoryIds: categories.map((category) => category.id).filter(Boolean),
      categoryTitles: categories.map((category) => category.title).filter(Boolean),
      sources,
      sourceUrls: sources.map((source) => source.url).filter(Boolean),
      geometry: sortedGeometry.map((item) => ({
        date: item.date || null,
        type: item.type || null,
        coordinates: Array.isArray(item.coordinates) ? item.coordinates : [],
        magnitudeValue: number(item.magnitudeValue),
        magnitudeUnit: cleanText(item.magnitudeUnit),
        magnitudeDescription: cleanText(item.magnitudeDescription),
      })),
      latestDate: latestGeometry.date || null,
      latitude: lat,
      longitude: lon,
      magnitudeValue: number(latestGeometry.magnitudeValue),
      magnitudeUnit: cleanText(latestGeometry.magnitudeUnit),
      magnitudeDescription: cleanText(latestGeometry.magnitudeDescription),
    };
  }).filter((event) => event.id || event.title);
}

function normalizeCategories(categories = []) {
  return categories.map((category) => ({
    id: cleanText(category.id),
    title: cleanText(category.title),
    description: cleanText(category.description),
    link: cleanText(category.link),
    layers: cleanText(category.layers),
  })).filter((category) => category.id || category.title);
}

function evaluateNaturalEventContext({ events = [], categories = [], failures = [], days = 30 } = {}) {
  const scoredEvents = events.map((event) => ({
    ...event,
    impactScore: scoreEventImpact(event),
  })).sort((a, b) => b.impactScore - a.impactScore);
  const openEvents = scoredEvents.filter((event) => event.isOpen);
  const highImpactEvents = scoredEvents.filter((event) => event.impactScore >= 62);
  const categoryCounts = countCategories(scoredEvents);
  const maxImpactScore = scoredEvents[0]?.impactScore || 0;
  const averageImpactScore = scoredEvents.length
    ? Math.round(scoredEvents.reduce((sum, event) => sum + event.impactScore, 0) / scoredEvents.length)
    : 0;
  const naturalEventRiskScore = clampScore(Math.max(maxImpactScore, averageImpactScore + highImpactEvents.length * 4));
  const wildfireRiskScore = clampScore(naturalEventRiskScore + (categoryCounts.wildfires || 0) * 5);
  const stormFloodRiskScore = clampScore(naturalEventRiskScore + (categoryCounts.severeStorms || 0) * 5 + (categoryCounts.floods || 0) * 5);
  const aviationVisibilityRiskScore = clampScore(40 + (categoryCounts.volcanoes || 0) * 12 + (categoryCounts.dustHaze || 0) * 10 + (categoryCounts.wildfires || 0) * 4);
  const agricultureDroughtRiskScore = clampScore(38 + (categoryCounts.drought || 0) * 14 + (categoryCounts.tempExtremes || 0) * 8 + (categoryCounts.floods || 0) * 5);
  const recoveryOpportunityScore = clampScore(42 + highImpactEvents.length * 7 + (categoryCounts.floods || 0) * 5 + (categoryCounts.wildfires || 0) * 5 + (categoryCounts.severeStorms || 0) * 5);
  const latestPeriod = scoredEvents
    .map((event) => event.latestDate)
    .filter(Boolean)
    .sort()
    .pop() || null;
  const momentum = naturalEventRiskScore >= 70 ? 'earth-natural-event-risk-elevated'
    : naturalEventRiskScore >= 45 ? 'earth-natural-event-risk-watch'
      : 'earth-natural-event-risk-quiet';

  return {
    available: scoredEvents.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    latestPeriod,
    days,
    events: scoredEvents,
    categories,
    eventCount: scoredEvents.length,
    openEventCount: openEvents.length,
    highImpactCount: highImpactEvents.length,
    categoryCounts,
    maxImpactScore,
    averageImpactScore,
    naturalEventRiskScore,
    wildfireRiskScore,
    stormFloodRiskScore,
    aviationVisibilityRiskScore,
    agricultureDroughtRiskScore,
    recoveryOpportunityScore,
    opportunityScore: recoveryOpportunityScore,
    riskScore: naturalEventRiskScore,
    momentum,
    narrative: scoredEvents.length
      ? `NASA EONET ${momentum}: ${scoredEvents.length} events across ${days} day(s), ${openEvents.length} open, ${highImpactEvents.length} high-impact natural-event watches.`
      : 'NASA EONET natural-event context unavailable or no current events were returned.',
  };
}

function scoreCandidate({ candidate, naturalEventContext }) {
  if (!naturalEventContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'NASA EONET natural-event context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['URI', 'CAT', 'DE', 'VMC', 'MLM', 'HD', 'LOW', 'PWR', 'EME', 'XLI']);
  const utilities = new Set(['XLU', 'NEE', 'DUK', 'SO', 'AEP']);
  const insurance = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const agricultureFood = new Set(['ADM', 'BG', 'DE', 'MOS', 'CF', 'KR', 'GIS', 'KHC']);
  const energy = new Set(['XLE', 'XOM', 'CVX', 'COP', 'SLB']);
  let exposure = 0.3;
  let direction = -0.08;
  let label = 'limited direct natural-event exposure';

  if (recoveryBeneficiaries.has(symbol) || /construction|infrastructure|materials|home improvement|equipment|rebuild/.test(theme)) {
    exposure = 0.8;
    direction = 0.78;
    label = 'can benefit from repair, rebuilding, equipment, materials, and infrastructure demand after natural events';
  } else if (utilities.has(symbol) || /utility|electricity|power/.test(theme)) {
    exposure = 0.78;
    direction = -0.42;
    label = 'faces outage, grid restoration, vegetation-management, and local service-disruption risk';
  } else if (insurance.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.84;
    direction = -0.82;
    label = 'faces catastrophe claims and reinsurance-loss risk';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise/.test(theme)) {
    exposure = 0.76;
    direction = -0.7;
    label = 'faces storm, ash, flood, smoke, and route disruption risk';
  } else if (agricultureFood.has(symbol) || /agriculture|fertilizer|food|grocery|crop/.test(theme)) {
    exposure = 0.68;
    direction = naturalEventContext.agricultureDroughtRiskScore >= 58 ? -0.38 : 0.08;
    label = 'has crop, commodity, grocery, and supply exposure to drought, flood, and temperature extremes';
  } else if (energy.has(symbol) || /energy|oil|gas|refinery|pipeline/.test(theme)) {
    exposure = 0.58;
    direction = naturalEventContext.stormFloodRiskScore >= 62 ? -0.2 : 0.14;
    label = 'has mixed production, refinery, pipeline, and demand exposure to storms, floods, and extreme weather';
  }

  const riskDelta = (naturalEventContext.riskScore - 50) / 55;
  const opportunityDelta = (naturalEventContext.recoveryOpportunityScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? opportunityDelta : riskDelta * direction) * exposure - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.1 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `NASA EONET ${naturalEventContext.momentum}; ${symbol || 'candidate'} ${label}. Natural-event risk ${naturalEventContext.riskScore}, wildfire risk ${naturalEventContext.wildfireRiskScore}, storm/flood risk ${naturalEventContext.stormFloodRiskScore}, recovery opportunity ${naturalEventContext.recoveryOpportunityScore}.`,
    topEvents: naturalEventContext.events?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    eventCount: context?.eventCount || 0,
    openEventCount: context?.openEventCount || 0,
    highImpactCount: context?.highImpactCount || 0,
    categoryCounts: context?.categoryCounts || {},
    scores: {
      risk: context?.riskScore || 50,
      naturalEventRisk: context?.naturalEventRiskScore || 50,
      wildfireRisk: context?.wildfireRiskScore || 50,
      stormFloodRisk: context?.stormFloodRiskScore || 50,
      aviationVisibilityRisk: context?.aviationVisibilityRiskScore || 50,
      agricultureDroughtRisk: context?.agricultureDroughtRiskScore || 50,
      recoveryOpportunity: context?.recoveryOpportunityScore || 50,
    },
    topEvents: (context?.events || []).slice(0, 8),
    categories: (context?.categories || []).slice(0, 16),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official NASA EONET natural-event and satellite-imagery metadata evidence. Share compact event categories, geometry, magnitude, source URLs, and company location/customer/supply-chain overlap; do not move full feeds through BMCL.',
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader NASA EONET natural event research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`EONET returned non-JSON response: ${error.message}`);
  }
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'eonet', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'NASA EONET', type: 'nasa-eonet-main', url: EONET_HOME_URL },
    { name: 'NASA EONET API v3 documentation', type: 'nasa-eonet-api-docs', url: EONET_DOCS_URL },
    { name: 'NASA EONET current open events', type: 'nasa-eonet-open-events', url: EONET_OPEN_EVENTS_URL },
    { name: 'NASA EONET recent events', type: 'nasa-eonet-recent-events', url: EONET_RECENT_EVENTS_URL },
    { name: 'NASA EONET categories', type: 'nasa-eonet-categories', url: EONET_CATEGORIES_URL },
  ];
}

function scoreEventImpact(event) {
  const categories = new Set(event.categoryIds || []);
  const base = event.isOpen ? 40 : 28;
  const categoryBoosts = {
    severeStorms: 24,
    wildfires: 22,
    floods: 22,
    volcanoes: 20,
    drought: 18,
    tempExtremes: 18,
    landslides: 16,
    dustHaze: 14,
    earthquakes: 14,
    seaLakeIce: 8,
  };
  const categoryBoost = [...categories].reduce((sum, category) => sum + (categoryBoosts[category] || 6), 0);
  const magnitudeBoost = Math.min(20, Math.log10(Math.max(1, Number(event.magnitudeValue) || 0)) * 5);
  const geometryBoost = event.latitude !== null && event.longitude !== null ? 5 : 0;
  return clampScore(base + categoryBoost + magnitudeBoost + geometryBoost);
}

function dedupeEvents(events) {
  const map = new Map();
  for (const event of events) {
    const key = event.id || `${event.title}:${event.latestDate}`;
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || scoreEventImpact(event) > scoreEventImpact(existing)) map.set(key, event);
  }
  return [...map.values()];
}

function countCategories(events) {
  return events.reduce((acc, event) => {
    for (const category of event.categoryIds || []) {
      acc[category] = (acc[category] || 0) + 1;
    }
    return acc;
  }, {});
}

function withParams(url, params = {}) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function number(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  EONET_HOME_URL,
  EONET_DOCS_URL,
  EONET_OPEN_EVENTS_URL,
  EONET_RECENT_EVENTS_URL,
  EONET_CATEGORIES_URL,
  collectNaturalEventContext,
  normalizeEvents,
  normalizeCategories,
  evaluateNaturalEventContext,
  scoreCandidate,
  compactForBmcl,
};
