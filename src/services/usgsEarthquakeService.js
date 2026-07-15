const { resilientFetch } = require('../utils/resilientFetch');
const USGS_EARTHQUAKE_DOCS_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/';
const USGS_EARTHQUAKE_QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const USGS_M45_30D_QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=now-30days&minmagnitude=4.5';
const USGS_BBOX_QUERY_TEMPLATE_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=24&maxlatitude=50&minlongitude=-125&maxlongitude=-66&starttime=2026-01-01';
const USGS_GEOJSON_FEEDS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php';
const USGS_ALL_HOUR_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
const USGS_M25_DAY_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const USGS_CSV_FEEDS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/csv.php';

async function collectEarthquakeContext({
  timeoutMs = 8000,
  minMagnitude = 4.5,
  days = 30,
  limit = 200,
  bbox,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const queryUrl = buildQueryUrl({ minMagnitude, days, limit, bbox });
  let queryEvents = [];
  let realtimeEvents = [];

  try {
    const payload = await fetchJson(queryUrl, timeoutMs);
    queryEvents = normalizeGeoJsonFeatures(payload.features || [], { source: 'usgs-earthquake-query' });
    emit(onEvent, 'usgs-earthquakes', 40, 'debug', 'Fetched USGS earthquake catalog query.', {
      events: queryEvents.length,
      queryUrl,
    });
  } catch (error) {
    failures.push({ source: 'usgs-earthquake-query', url: queryUrl, error: error.message });
    emit(onEvent, 'usgs-earthquakes', 40, 'warn', 'USGS earthquake catalog query unavailable.', {
      queryUrl,
      error: error.message,
    });
  }

  try {
    const payload = await fetchJson(USGS_M25_DAY_FEED_URL, timeoutMs);
    realtimeEvents = normalizeGeoJsonFeatures(payload.features || [], { source: 'usgs-earthquake-realtime-feed' });
    emit(onEvent, 'usgs-earthquakes', 41, 'debug', 'Fetched USGS real-time earthquake GeoJSON feed.', {
      events: realtimeEvents.length,
      feedUrl: USGS_M25_DAY_FEED_URL,
    });
  } catch (error) {
    failures.push({ source: 'usgs-earthquake-realtime-feed', url: USGS_M25_DAY_FEED_URL, error: error.message });
    emit(onEvent, 'usgs-earthquakes', 41, 'warn', 'USGS real-time earthquake GeoJSON feed unavailable.', {
      feedUrl: USGS_M25_DAY_FEED_URL,
      error: error.message,
    });
  }

  return evaluateEarthquakeContext({
    events: dedupeEvents([...queryEvents, ...realtimeEvents]),
    failures,
    days,
    minMagnitude,
    queryUrl,
  });
}

function buildQueryUrl({ minMagnitude = 4.5, days = 30, limit = 200, bbox } = {}) {
  const params = new URLSearchParams({
    format: 'geojson',
    starttime: `now-${Math.min(Math.max(Number(days) || 30, 1), 365)}days`,
    minmagnitude: String(Math.min(Math.max(Number(minMagnitude) || 4.5, 0), 10)),
    orderby: 'time',
    limit: String(Math.min(Math.max(Number(limit) || 200, 1), 2000)),
  });
  if (bbox && typeof bbox === 'object') {
    for (const key of ['minlatitude', 'maxlatitude', 'minlongitude', 'maxlongitude']) {
      const value = Number(bbox[key]);
      if (Number.isFinite(value)) params.set(key, String(value));
    }
  }
  return `${USGS_EARTHQUAKE_QUERY_URL}?${params.toString()}`;
}

function normalizeGeoJsonFeatures(features = [], { source = 'usgs-earthquake' } = {}) {
  return (Array.isArray(features) ? features : []).map((feature) => {
    const props = feature?.properties || {};
    const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    return {
      id: cleanText(feature?.id || props.code || props.ids),
      source,
      title: cleanText(props.title || props.place),
      place: cleanText(props.place),
      type: cleanText(props.type || feature?.geometry?.type),
      magnitude: number(props.mag),
      magType: cleanText(props.magType),
      time: millisToIso(props.time),
      updated: millisToIso(props.updated),
      url: cleanText(props.url),
      detailUrl: cleanText(props.detail),
      felt: number(props.felt),
      cdi: number(props.cdi),
      mmi: number(props.mmi),
      alert: normalizeAlert(props.alert),
      status: cleanText(props.status),
      tsunami: Number(props.tsunami || 0) > 0,
      significance: number(props.sig),
      network: cleanText(props.net),
      code: cleanText(props.code),
      ids: cleanText(props.ids),
      sources: cleanText(props.sources),
      eventTypes: cleanText(props.types),
      stationCount: number(props.nst),
      minimumDistance: number(props.dmin),
      rms: number(props.rms),
      gap: number(props.gap),
      longitude: number(coords[0]),
      latitude: number(coords[1]),
      depthKm: number(coords[2]),
    };
  }).filter((event) => event.id || event.title || Number.isFinite(event.magnitude));
}

function evaluateEarthquakeContext({ events = [], failures = [], days = 30, minMagnitude = 4.5, queryUrl = USGS_M45_30D_QUERY_URL } = {}) {
  const scoredEvents = events.map((event) => ({
    ...event,
    impactScore: earthquakeImpactScore(event),
  })).sort((a, b) => b.impactScore - a.impactScore || (b.magnitude || 0) - (a.magnitude || 0));

  const highMagnitude = scoredEvents.filter((event) => Number(event.magnitude || 0) >= 6);
  const shallowHighMagnitude = highMagnitude.filter((event) => Number(event.depthKm || 999) <= 70);
  const tsunamiCount = scoredEvents.filter((event) => event.tsunami).length;
  const alertCounts = countBy(scoredEvents, 'alert');
  const magnitudeBuckets = {
    m25To44: scoredEvents.filter((event) => event.magnitude >= 2.5 && event.magnitude < 4.5).length,
    m45To59: scoredEvents.filter((event) => event.magnitude >= 4.5 && event.magnitude < 6).length,
    m60To69: scoredEvents.filter((event) => event.magnitude >= 6 && event.magnitude < 7).length,
    m70Plus: scoredEvents.filter((event) => event.magnitude >= 7).length,
  };
  const maxImpactScore = scoredEvents[0]?.impactScore || 0;
  const averageMagnitude = scoredEvents.length
    ? Number((scoredEvents.reduce((sum, event) => sum + Number(event.magnitude || 0), 0) / scoredEvents.length).toFixed(2))
    : 0;
  const maxMagnitude = scoredEvents.reduce((max, event) => Math.max(max, Number(event.magnitude || 0)), 0);
  const earthquakeRiskScore = clampScore(Math.max(
    maxImpactScore,
    30 + highMagnitude.length * 5 + shallowHighMagnitude.length * 4 + tsunamiCount * 6 + (alertCounts.orange || 0) * 9 + (alertCounts.red || 0) * 16
  ));
  const seismicSupplyChainRiskScore = clampScore(earthquakeRiskScore + shallowHighMagnitude.length * 4 + tsunamiCount * 6);
  const infrastructureDamageRiskScore = clampScore(earthquakeRiskScore + magnitudeBuckets.m70Plus * 8 + shallowHighMagnitude.length * 5);
  const tsunamiRiskScore = clampScore(35 + tsunamiCount * 18 + (alertCounts.orange || 0) * 6 + (alertCounts.red || 0) * 10);
  const insuranceRiskScore = clampScore(earthquakeRiskScore + highMagnitude.length * 3 + tsunamiCount * 4);
  const recoveryOpportunityScore = clampScore(42 + highMagnitude.length * 7 + shallowHighMagnitude.length * 5 + tsunamiCount * 4);
  const momentum = earthquakeRiskScore >= 70 ? 'seismic-risk-elevated'
    : earthquakeRiskScore >= 48 ? 'seismic-risk-watch'
      : 'seismic-risk-quiet';

  return {
    available: scoredEvents.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(queryUrl),
    failures,
    days,
    minMagnitude,
    latestPeriod: scoredEvents[0]?.time || null,
    events: scoredEvents,
    eventCount: scoredEvents.length,
    highMagnitudeCount: highMagnitude.length,
    shallowHighMagnitudeCount: shallowHighMagnitude.length,
    tsunamiCount,
    alertCounts,
    magnitudeBuckets,
    maxMagnitude,
    averageMagnitude,
    maxImpactScore,
    earthquakeRiskScore,
    seismicSupplyChainRiskScore,
    infrastructureDamageRiskScore,
    tsunamiRiskScore,
    insuranceRiskScore,
    recoveryOpportunityScore,
    riskScore: earthquakeRiskScore,
    opportunityScore: recoveryOpportunityScore,
    momentum,
    narrative: scoredEvents.length
      ? `USGS ${momentum}: ${scoredEvents.length} earthquake events, ${highMagnitude.length} magnitude 6+ events, ${tsunamiCount} tsunami-flagged events, max magnitude ${Number(maxMagnitude.toFixed(1))}.`
      : 'USGS earthquake context unavailable or no matching seismic events were returned.',
  };
}

function earthquakeImpactScore(event) {
  const mag = Number(event.magnitude || 0);
  const magnitudeScore = Math.max(0, (mag - 2.5) * 18);
  const depthBoost = Number(event.depthKm || 999) <= 70 ? 9 : Number(event.depthKm || 999) <= 150 ? 4 : 0;
  const alertBoost = { green: 8, yellow: 18, orange: 35, red: 50 }[event.alert] || 0;
  const intensityBoost = Math.max(Number(event.cdi || 0), Number(event.mmi || 0)) * 4;
  const feltBoost = Math.min(12, Math.log10(Math.max(1, Number(event.felt || 0))) * 4);
  const tsunamiBoost = event.tsunami ? 14 : 0;
  const significanceBoost = Math.min(16, Number(event.significance || 0) / 80);
  return clampScore(20 + magnitudeScore + depthBoost + alertBoost + intensityBoost + feltBoost + tsunamiBoost + significanceBoost);
}

function scoreCandidate({ candidate, earthquakeContext }) {
  if (!earthquakeContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'USGS earthquake context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['URI', 'CAT', 'DE', 'VMC', 'MLM', 'HD', 'LOW', 'PWR', 'EME', 'XLI']);
  const insurers = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE']);
  const utilitiesEnergy = new Set(['XLU', 'NEE', 'DUK', 'SO', 'AEP', 'XOM', 'CVX', 'VLO', 'MPC']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const semisElectronics = new Set(['TSM', 'NVDA', 'AMD', 'AAPL', 'SOXX', 'INTC', 'QCOM']);
  const realEstateHousing = new Set(['XLRE', 'LEN', 'DHI', 'PHM', 'NVR']);
  let exposure = 0.3;
  let direction = -0.08;
  let label = 'limited direct seismic exposure';

  if (recoveryBeneficiaries.has(symbol) || /construction|infrastructure|materials|equipment|home improvement|rebuild/.test(theme)) {
    exposure = 0.8;
    direction = 0.82;
    label = 'can benefit from rebuilding, equipment rental, materials, and infrastructure hardening after damaging earthquakes';
  } else if (insurers.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.82;
    direction = -0.78;
    label = 'faces earthquake catastrophe, property, and business-interruption claim risk';
  } else if (utilitiesEnergy.has(symbol) || /utility|electricity|power|refinery|pipeline|energy/.test(theme)) {
    exposure = 0.74;
    direction = -0.46;
    label = 'faces outage, repair, refinery, pipeline, and local infrastructure disruption risk';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise|port/.test(theme)) {
    exposure = 0.72;
    direction = -0.66;
    label = 'faces route, port, airport, travel, and supply-chain disruption risk';
  } else if (semisElectronics.has(symbol) || /semiconductor|chip|electronics|hardware|supply chain/.test(theme)) {
    exposure = 0.7;
    direction = -0.52;
    label = 'can be exposed to seismic disruption in fabs, component suppliers, and electronics supply chains';
  } else if (realEstateHousing.has(symbol) || /real estate|housing|homebuilder|mortgage|property/.test(theme)) {
    exposure = 0.62;
    direction = earthquakeContext.recoveryOpportunityScore >= 65 ? 0.1 : -0.42;
    label = 'has mixed property-damage, permit, repair, insurance, and rebuilding exposure';
  }

  const riskDelta = (earthquakeContext.riskScore - 50) / 55;
  const opportunityDelta = (earthquakeContext.recoveryOpportunityScore - 50) / 50;
  const raw = 0.5
    + (direction >= 0 ? opportunityDelta * direction : riskDelta * direction) * exposure
    - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.1 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `USGS ${earthquakeContext.momentum}; ${symbol || 'candidate'} ${label}. Seismic risk ${earthquakeContext.riskScore}, supply-chain risk ${earthquakeContext.seismicSupplyChainRiskScore}, infrastructure risk ${earthquakeContext.infrastructureDamageRiskScore}, recovery opportunity ${earthquakeContext.recoveryOpportunityScore}.`,
    topEvents: earthquakeContext.events?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    eventCount: context?.eventCount || 0,
    highMagnitudeCount: context?.highMagnitudeCount || 0,
    shallowHighMagnitudeCount: context?.shallowHighMagnitudeCount || 0,
    tsunamiCount: context?.tsunamiCount || 0,
    alertCounts: context?.alertCounts || {},
    magnitudeBuckets: context?.magnitudeBuckets || {},
    maxMagnitude: context?.maxMagnitude || 0,
    averageMagnitude: context?.averageMagnitude || 0,
    scores: {
      risk: context?.riskScore || 50,
      earthquakeRisk: context?.earthquakeRiskScore || 50,
      seismicSupplyChainRisk: context?.seismicSupplyChainRiskScore || 50,
      infrastructureDamageRisk: context?.infrastructureDamageRiskScore || 50,
      tsunamiRisk: context?.tsunamiRiskScore || 50,
      insuranceRisk: context?.insuranceRiskScore || 50,
      recoveryOpportunity: context?.recoveryOpportunityScore || 50,
    },
    topEvents: (context?.events || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 12),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official USGS earthquake catalog and real-time seismic-risk evidence. Share compact magnitude, depth, alert, intensity, tsunami, geometry, and source URLs; do not move full feeds through BMCL.',
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/geo+json,application/json,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader USGS earthquake research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'usgs', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList(queryUrl = USGS_M45_30D_QUERY_URL) {
  return [
    { name: 'USGS Earthquake Catalog API documentation', type: 'usgs-earthquake-docs', url: USGS_EARTHQUAKE_DOCS_URL },
    { name: 'USGS Earthquake Catalog query endpoint', type: 'usgs-earthquake-query', url: USGS_EARTHQUAKE_QUERY_URL },
    { name: 'USGS magnitude 4.5+ earthquakes, last 30 days', type: 'usgs-earthquake-m45-30d-query', url: USGS_M45_30D_QUERY_URL },
    { name: 'USGS bounding-box earthquake query template', type: 'usgs-earthquake-bbox-query', url: USGS_BBOX_QUERY_TEMPLATE_URL },
    { name: 'USGS real-time earthquake GeoJSON feeds', type: 'usgs-earthquake-geojson-feeds', url: USGS_GEOJSON_FEEDS_URL },
    { name: 'USGS all earthquakes in the past hour GeoJSON feed', type: 'usgs-earthquake-all-hour-feed', url: USGS_ALL_HOUR_FEED_URL },
    { name: 'USGS magnitude 2.5+ in the past day GeoJSON feed', type: 'usgs-earthquake-m25-day-feed', url: USGS_M25_DAY_FEED_URL },
    { name: 'USGS earthquake CSV feeds', type: 'usgs-earthquake-csv-feeds', url: USGS_CSV_FEEDS_URL },
    { name: 'USGS executable earthquake query used this run', type: 'usgs-earthquake-active-query', url: queryUrl },
  ];
}

function dedupeEvents(events) {
  const seen = new Set();
  const deduped = [];
  for (const event of events) {
    const key = event.id || `${event.time}:${event.latitude}:${event.longitude}:${event.magnitude}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function normalizeAlert(value) {
  const normalized = cleanText(value).toLowerCase();
  return ['green', 'yellow', 'orange', 'red'].includes(normalized) ? normalized : normalized || 'unknown';
}

function millisToIso(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 50;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function emit(onEvent, step, progress, level, message, data) {
  try {
    onEvent({ step, progress, level, message, data });
  } catch (_) {
    // status callbacks are best-effort only
  }
}

module.exports = {
  USGS_EARTHQUAKE_DOCS_URL,
  USGS_EARTHQUAKE_QUERY_URL,
  USGS_M45_30D_QUERY_URL,
  USGS_BBOX_QUERY_TEMPLATE_URL,
  USGS_GEOJSON_FEEDS_URL,
  USGS_ALL_HOUR_FEED_URL,
  USGS_M25_DAY_FEED_URL,
  USGS_CSV_FEEDS_URL,
  collectEarthquakeContext,
  buildQueryUrl,
  normalizeGeoJsonFeatures,
  evaluateEarthquakeContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
