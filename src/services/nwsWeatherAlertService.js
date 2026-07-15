const { resilientFetch } = require('../utils/resilientFetch');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const { config } = require('../config');

const NWS_API_DOCS_URL = 'https://www.weather.gov/documentation/services-web-api';
const NWS_ACTIVE_ALERTS_URL = 'https://api.weather.gov/alerts/active';
const NWS_MISSOURI_ALERTS_URL = 'https://api.weather.gov/alerts/active?area=MO';
const NWS_ST_LOUIS_POINT_ALERTS_URL = 'https://api.weather.gov/alerts/active?point=38.6270,-90.1994';
const NWS_TORNADO_WARNING_ALERTS_URL = 'https://api.weather.gov/alerts/active?event=Tornado%20Warning';
const DEFAULT_USER_AGENT = 'AutoTrader weather-alert research bot (configure NWS_USER_AGENT or Settings nws-weather.userAgent)';

async function collectWeatherAlertContext({
  userId,
  timeoutMs = 8000,
  area,
  point,
  event,
  limit = 300,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const userAgent = resolveUserAgent(userId);
  const queryUrl = buildAlertsUrl({ area, point, event });
  let alerts = [];

  try {
    const payload = await fetchJson(queryUrl, timeoutMs, userAgent);
    alerts = normalizeAlertFeatures(payload.features || []).slice(0, Math.min(Math.max(Number(limit) || 300, 1), 500));
    emit(onEvent, 'nws-weather-alerts', 42, 'debug', 'Fetched National Weather Service active alerts.', {
      alerts: alerts.length,
      queryUrl,
      userAgentConfigured: userAgent.configured,
    });
  } catch (error) {
    failures.push({ source: 'nws-active-alerts', url: queryUrl, error: error.message });
    emit(onEvent, 'nws-weather-alerts', 42, 'warn', 'National Weather Service active alerts unavailable.', {
      queryUrl,
      error: error.message,
      userAgentConfigured: userAgent.configured,
    });
  }

  return evaluateWeatherAlertContext({
    alerts,
    failures,
    queryUrl,
    userAgentConfigured: userAgent.configured,
  });
}

function resolveUserAgent(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'nws-weather') : null;
  const value = saved?.userAgent || config.nwsUserAgent || DEFAULT_USER_AGENT;
  return {
    value,
    configured: Boolean(saved?.userAgent || config.nwsUserAgent),
  };
}

function buildAlertsUrl({ area, point, event } = {}) {
  const params = new URLSearchParams();
  if (area) params.set('area', cleanText(area).toUpperCase());
  if (point) params.set('point', cleanText(point));
  if (event) params.set('event', cleanText(event));
  const query = params.toString();
  return query ? `${NWS_ACTIVE_ALERTS_URL}?${query}` : NWS_ACTIVE_ALERTS_URL;
}

function normalizeAlertFeatures(features = []) {
  return (Array.isArray(features) ? features : []).map((feature) => {
    const props = feature?.properties || {};
    const geometrySummary = summarizeGeometry(feature?.geometry);
    return {
      id: cleanText(props.id || feature?.id),
      source: 'nws-weather-alerts',
      type: cleanText(feature?.type),
      event: cleanText(props.event),
      headline: cleanText(props.headline),
      description: cleanText(props.description),
      instruction: cleanText(props.instruction),
      areaDesc: cleanText(props.areaDesc),
      severity: normalizeEnum(props.severity),
      urgency: normalizeEnum(props.urgency),
      certainty: normalizeEnum(props.certainty),
      category: normalizeEnum(props.category),
      response: normalizeEnum(props.response),
      status: normalizeEnum(props.status),
      messageType: normalizeEnum(props.messageType),
      sent: cleanText(props.sent),
      effective: cleanText(props.effective),
      onset: cleanText(props.onset),
      expires: cleanText(props.expires),
      ends: cleanText(props.ends),
      sender: cleanText(props.sender),
      senderName: cleanText(props.senderName),
      url: cleanText(props['@id'] || props.id || feature?.id),
      affectedZones: Array.isArray(props.affectedZones) ? props.affectedZones.map(cleanText).filter(Boolean) : [],
      sameCodes: normalizeStringArray(props.geocode?.SAME),
      ugcCodes: normalizeStringArray(props.geocode?.UGC),
      parameters: props.parameters || {},
      geometryType: cleanText(feature?.geometry?.type),
      bbox: geometrySummary.bbox,
      centroid: geometrySummary.centroid,
    };
  }).filter((alert) => alert.id || alert.event || alert.headline);
}

function evaluateWeatherAlertContext({ alerts = [], failures = [], queryUrl = NWS_ACTIVE_ALERTS_URL, userAgentConfigured = false } = {}) {
  const scoredAlerts = alerts.map((alert) => ({
    ...alert,
    impactScore: weatherAlertImpactScore(alert),
    eventFamily: eventFamily(alert.event),
  })).sort((a, b) => b.impactScore - a.impactScore);
  const severeAlerts = scoredAlerts.filter((alert) => alert.impactScore >= 65 || ['Extreme', 'Severe'].includes(alert.severity));
  const tornadoCount = scoredAlerts.filter((alert) => /tornado/i.test(alert.event)).length;
  const floodCount = scoredAlerts.filter((alert) => /flood|flash flood/i.test(alert.event)).length;
  const fireCount = scoredAlerts.filter((alert) => /fire|red flag/i.test(alert.event)).length;
  const heatColdCount = scoredAlerts.filter((alert) => /heat|cold|freeze|wind chill/i.test(alert.event)).length;
  const winterCount = scoredAlerts.filter((alert) => /winter|blizzard|ice|snow/i.test(alert.event)).length;
  const maxImpactScore = scoredAlerts[0]?.impactScore || 0;
  const averageImpactScore = scoredAlerts.length
    ? Math.round(scoredAlerts.reduce((sum, alert) => sum + alert.impactScore, 0) / scoredAlerts.length)
    : 0;
  const alertRiskScore = clampScore(Math.max(maxImpactScore, averageImpactScore + severeAlerts.length * 3));
  const logisticsRiskScore = clampScore(alertRiskScore + floodCount * 3 + winterCount * 3 + tornadoCount * 2);
  const utilityRiskScore = clampScore(alertRiskScore + tornadoCount * 4 + winterCount * 3 + heatColdCount * 2 + fireCount * 2);
  const agricultureRiskScore = clampScore(35 + fireCount * 9 + floodCount * 6 + heatColdCount * 6 + winterCount * 4);
  const insuranceRiskScore = clampScore(alertRiskScore + tornadoCount * 5 + floodCount * 4 + fireCount * 4 + winterCount * 2);
  const retailFootTrafficRiskScore = clampScore(40 + severeAlerts.length * 4 + winterCount * 5 + floodCount * 4 + tornadoCount * 4);
  const recoveryOpportunityScore = clampScore(38 + severeAlerts.length * 5 + tornadoCount * 6 + floodCount * 5 + fireCount * 4 + winterCount * 3);
  const momentum = alertRiskScore >= 72 ? 'us-weather-alert-risk-elevated'
    : alertRiskScore >= 48 ? 'us-weather-alert-risk-watch'
      : 'us-weather-alert-risk-quiet';

  return {
    available: scoredAlerts.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(queryUrl),
    failures,
    userAgentConfigured,
    latestPeriod: scoredAlerts[0]?.sent || scoredAlerts[0]?.effective || null,
    alerts: scoredAlerts,
    alertCount: scoredAlerts.length,
    severeAlertCount: severeAlerts.length,
    eventCounts: countBy(scoredAlerts, 'event'),
    eventFamilyCounts: countBy(scoredAlerts, 'eventFamily'),
    severityCounts: countBy(scoredAlerts, 'severity'),
    urgencyCounts: countBy(scoredAlerts, 'urgency'),
    certaintyCounts: countBy(scoredAlerts, 'certainty'),
    categoryCounts: countBy(scoredAlerts, 'category'),
    tornadoCount,
    floodCount,
    fireCount,
    heatColdCount,
    winterCount,
    maxImpactScore,
    averageImpactScore,
    weatherAlertRiskScore: alertRiskScore,
    logisticsRiskScore,
    utilityRiskScore,
    agricultureRiskScore,
    insuranceRiskScore,
    retailFootTrafficRiskScore,
    recoveryOpportunityScore,
    riskScore: alertRiskScore,
    opportunityScore: recoveryOpportunityScore,
    momentum,
    narrative: scoredAlerts.length
      ? `NWS ${momentum}: ${scoredAlerts.length} active alerts, ${severeAlerts.length} severe/high-impact alerts, max impact ${maxImpactScore}.`
      : 'NWS active weather alert context unavailable or no active alerts were returned.',
  };
}

function weatherAlertImpactScore(alert) {
  const severityBase = { Extreme: 92, Severe: 74, Moderate: 50, Minor: 28, Unknown: 36 }[alert.severity] || 36;
  const urgencyBoost = { Immediate: 12, Expected: 8, Future: 3, Past: -8, Unknown: 0 }[alert.urgency] || 0;
  const certaintyBoost = { Observed: 10, Likely: 8, Possible: 3, Unlikely: -8, Unknown: 0 }[alert.certainty] || 0;
  const eventBoost = /tornado warning|flash flood warning|hurricane warning|blizzard warning|ice storm warning|red flag warning/i.test(alert.event) ? 12
    : /warning/i.test(alert.event) ? 8
      : /watch/i.test(alert.event) ? 4
        : /advisory/i.test(alert.event) ? 1
          : 0;
  return clampScore(severityBase + urgencyBoost + certaintyBoost + eventBoost);
}

function scoreCandidate({ candidate, weatherAlertContext }) {
  if (!weatherAlertContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'NWS active weather alert context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['HD', 'LOW', 'CAT', 'DE', 'URI', 'PWR', 'EME', 'VMC', 'MLM']);
  const utilities = new Set(['XLU', 'NEE', 'DUK', 'SO', 'AEP', 'EXC']);
  const insurers = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const agricultureFood = new Set(['ADM', 'BG', 'DE', 'MOS', 'CF', 'KR', 'TSN', 'HRL']);
  const retailRestaurants = new Set(['WMT', 'TGT', 'COST', 'KR', 'MCD', 'SBUX', 'YUM']);
  let exposure = 0.3;
  let direction = -0.08;
  let label = 'limited direct U.S. active weather-alert exposure';

  if (recoveryBeneficiaries.has(symbol) || /home improvement|construction|infrastructure|equipment|materials|rebuild|repair/.test(theme)) {
    exposure = 0.78;
    direction = 0.78;
    label = 'can benefit from storm recovery, repair, equipment rental, and infrastructure response demand';
  } else if (utilities.has(symbol) || /utility|electricity|power|grid/.test(theme)) {
    exposure = 0.82;
    direction = -0.52;
    label = 'faces outage, grid repair, vegetation, crew, and local restoration cost risk';
  } else if (insurers.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.84;
    direction = -0.78;
    label = 'faces weather catastrophe, property, auto, crop, and business-interruption claim risk';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise|port|delivery/.test(theme)) {
    exposure = 0.76;
    direction = -0.68;
    label = 'faces route disruption, delay, airport, port, delivery, and travel interruption risk';
  } else if (agricultureFood.has(symbol) || /agriculture|crop|food|farm|fertilizer|livestock|grocery/.test(theme)) {
    exposure = 0.7;
    direction = -0.46;
    label = 'can be exposed to crop, livestock, food distribution, and agricultural input disruption';
  } else if (retailRestaurants.has(symbol) || /retail|restaurant|consumer|store|foot traffic/.test(theme)) {
    exposure = 0.62;
    direction = weatherAlertContext.recoveryOpportunityScore >= 62 ? 0.08 : -0.36;
    label = 'has mixed emergency-demand, store-closure, foot-traffic, and local consumer disruption exposure';
  }

  const riskDelta = (weatherAlertContext.riskScore - 50) / 55;
  const opportunityDelta = (weatherAlertContext.recoveryOpportunityScore - 50) / 50;
  const raw = 0.5
    + (direction >= 0 ? opportunityDelta * direction : riskDelta * direction) * exposure
    - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.1 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `NWS ${weatherAlertContext.momentum}; ${symbol || 'candidate'} ${label}. Weather alert risk ${weatherAlertContext.riskScore}, logistics risk ${weatherAlertContext.logisticsRiskScore}, utility risk ${weatherAlertContext.utilityRiskScore}, insurance risk ${weatherAlertContext.insuranceRiskScore}, recovery opportunity ${weatherAlertContext.recoveryOpportunityScore}.`,
    topAlerts: weatherAlertContext.alerts?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    userAgentConfigured: Boolean(context?.userAgentConfigured),
    alertCount: context?.alertCount || 0,
    severeAlertCount: context?.severeAlertCount || 0,
    eventCounts: context?.eventCounts || {},
    eventFamilyCounts: context?.eventFamilyCounts || {},
    severityCounts: context?.severityCounts || {},
    urgencyCounts: context?.urgencyCounts || {},
    certaintyCounts: context?.certaintyCounts || {},
    scores: {
      risk: context?.riskScore || 50,
      weatherAlertRisk: context?.weatherAlertRiskScore || 50,
      logisticsRisk: context?.logisticsRiskScore || 50,
      utilityRisk: context?.utilityRiskScore || 50,
      agricultureRisk: context?.agricultureRiskScore || 50,
      insuranceRisk: context?.insuranceRiskScore || 50,
      retailFootTrafficRisk: context?.retailFootTrafficRiskScore || 50,
      recoveryOpportunity: context?.recoveryOpportunityScore || 50,
    },
    topAlerts: (context?.alerts || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official National Weather Service active alert evidence. Share compact event, severity, urgency, certainty, area, geometry, and source URLs; do not move full alert collections through BMCL.',
  };
}

async function fetchJson(url, timeoutMs = 8000, userAgent = resolveUserAgent()) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/geo+json,application/json',
    'User-Agent': userAgent.value || DEFAULT_USER_AGENT,
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'nws', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList(queryUrl = NWS_ACTIVE_ALERTS_URL) {
  return [
    { name: 'National Weather Service API documentation', type: 'nws-api-docs', url: NWS_API_DOCS_URL },
    { name: 'NWS all active U.S. alerts', type: 'nws-active-alerts', url: NWS_ACTIVE_ALERTS_URL },
    { name: 'NWS active alerts for Missouri', type: 'nws-active-alerts-area', url: NWS_MISSOURI_ALERTS_URL },
    { name: 'NWS active alerts near St. Louis coordinates', type: 'nws-active-alerts-point', url: NWS_ST_LOUIS_POINT_ALERTS_URL },
    { name: 'NWS active Tornado Warning alerts', type: 'nws-active-alerts-event', url: NWS_TORNADO_WARNING_ALERTS_URL },
    { name: 'NWS executable active-alert query used this run', type: 'nws-active-alerts-active-query', url: queryUrl },
  ];
}

function summarizeGeometry(geometry) {
  const points = flattenCoordinates(geometry?.coordinates);
  if (!points.length) return { bbox: null, centroid: null };
  const lons = points.map((point) => point[0]).filter(Number.isFinite);
  const lats = points.map((point) => point[1]).filter(Number.isFinite);
  if (!lons.length || !lats.length) return { bbox: null, centroid: null };
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const centroid = {
    longitude: Number((lons.reduce((sum, lon) => sum + lon, 0) / lons.length).toFixed(4)),
    latitude: Number((lats.reduce((sum, lat) => sum + lat, 0) / lats.length).toFixed(4)),
  };
  return { bbox, centroid };
}

function flattenCoordinates(value) {
  if (!Array.isArray(value)) return [];
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    return [[Number(value[0]), Number(value[1])]];
  }
  return value.flatMap(flattenCoordinates);
}

function eventFamily(event) {
  const lower = String(event || '').toLowerCase();
  if (/tornado|severe thunderstorm|wind|hail/.test(lower)) return 'severe-convective';
  if (/flood|coastal|storm surge|high surf/.test(lower)) return 'flood-water';
  if (/hurricane|tropical/.test(lower)) return 'tropical';
  if (/fire|red flag|smoke/.test(lower)) return 'fire-smoke';
  if (/heat|cold|freeze|frost|wind chill/.test(lower)) return 'temperature';
  if (/winter|blizzard|ice|snow/.test(lower)) return 'winter';
  if (/fog|dust|visibility/.test(lower)) return 'visibility';
  return lower ? 'other-weather' : 'unknown';
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function normalizeStringArray(value) {
  const list = Array.isArray(value) ? value : [value].filter(Boolean);
  return list.map(cleanText).filter(Boolean);
}

function normalizeEnum(value) {
  const text = cleanText(value);
  return text || 'Unknown';
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
  NWS_API_DOCS_URL,
  NWS_ACTIVE_ALERTS_URL,
  NWS_MISSOURI_ALERTS_URL,
  NWS_ST_LOUIS_POINT_ALERTS_URL,
  NWS_TORNADO_WARNING_ALERTS_URL,
  collectWeatherAlertContext,
  resolveUserAgent,
  buildAlertsUrl,
  normalizeAlertFeatures,
  evaluateWeatherAlertContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
