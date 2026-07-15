const { resilientFetch } = require('../utils/resilientFetch');
const GDACS_HOME_URL = 'https://www.gdacs.org/';
const GDACS_API_DOCS_URL = 'https://www.gdacs.org/gdacsapi/swagger/index.html';
const GDACS_OPENAPI_URL = 'https://www.gdacs.org/gdacsapi/swagger/v1/swagger.json';
const GDACS_FEED_REFERENCE_URL = 'https://www.gdacs.org/feed_reference.aspx';
const GDACS_RSS_24H_URL = 'https://www.gdacs.org/xml/rss_24h.xml';
const GDACS_RSS_ALL_URL = 'https://www.gdacs.org/xml/rss.xml';

async function collectDisasterContext({ timeoutMs = 8000, feedUrl = GDACS_RSS_24H_URL, onEvent = () => {} } = {}) {
  const failures = [];
  let events = [];
  try {
    const xml = await fetchText(feedUrl, timeoutMs);
    events = parseGdacsRss(xml);
    emit(onEvent, 'gdacs-disasters', 34, 'debug', 'Fetched GDACS disaster RSS/GeoRSS feed.', {
      events: events.length,
      feedUrl,
    });
  } catch (error) {
    failures.push({ source: 'gdacs-rss', url: feedUrl, error: error.message });
    emit(onEvent, 'gdacs-disasters', 34, 'warn', 'GDACS disaster RSS/GeoRSS feed unavailable.', {
      feedUrl,
      error: error.message,
    });
  }

  return evaluateDisasterContext({ events, failures });
}

function parseGdacsRss(xml) {
  return matchAll(String(xml || ''), /<item\b[\s\S]*?<\/item>/gi)
    .map((itemMatch) => {
      const itemXml = itemMatch[0];
      const eventType = text(itemXml, 'gdacs:eventtype') || eventTypeFromGuid(text(itemXml, 'guid'));
      const alertLevel = normalizeAlertLevel(text(itemXml, 'gdacs:alertlevel'));
      const severity = tagWithAttributes(itemXml, 'gdacs:severity');
      const population = tagWithAttributes(itemXml, 'gdacs:population');
      const lat = number(text(itemXml, 'geo:lat') || text(itemXml, 'georss:point')?.split(/\s+/)[0]);
      const lon = number(text(itemXml, 'geo:long') || text(itemXml, 'georss:point')?.split(/\s+/)[1]);
      return {
        title: decodeXml(text(itemXml, 'title')),
        description: decodeXml(text(itemXml, 'description')),
        link: decodeXml(text(itemXml, 'link')),
        pubDate: text(itemXml, 'pubDate'),
        dateAdded: text(itemXml, 'gdacs:dateadded'),
        dateModified: text(itemXml, 'gdacs:datemodified'),
        fromDate: text(itemXml, 'gdacs:fromdate'),
        toDate: text(itemXml, 'gdacs:todate'),
        eventType,
        eventTypeName: eventTypeName(eventType),
        alertLevel,
        alertScore: number(text(itemXml, 'gdacs:alertscore')),
        episodeAlertLevel: normalizeAlertLevel(text(itemXml, 'gdacs:episodealertlevel')),
        episodeAlertScore: number(text(itemXml, 'gdacs:episodealertscore')),
        eventId: text(itemXml, 'gdacs:eventid'),
        episodeId: text(itemXml, 'gdacs:episodeid'),
        country: decodeXml(text(itemXml, 'gdacs:country')),
        iso3: text(itemXml, 'gdacs:iso3'),
        lat,
        lon,
        bbox: text(itemXml, 'gdacs:bbox'),
        severity: {
          text: decodeXml(severity.body),
          unit: severity.attrs.unit || null,
          value: number(severity.attrs.value),
        },
        population: {
          text: decodeXml(population.body),
          unit: population.attrs.unit || null,
          value: number(population.attrs.value),
        },
        vulnerability: number(attrFor(itemXml, 'gdacs:vulnerability', 'value')),
        cap: decodeXml(text(itemXml, 'gdacs:cap')),
        icon: decodeXml(text(itemXml, 'gdacs:icon')),
      };
    })
    .filter((event) => event.title || event.eventId);
}

function evaluateDisasterContext({ events = [], failures = [] } = {}) {
  const alertWeights = { Green: 18, Orange: 58, Red: 86 };
  const scoredEvents = events.map((event) => {
    const alertBase = alertWeights[event.alertLevel] ?? 25;
    const populationBoost = Math.min(24, Math.log10(Math.max(1, event.population?.value || 0)) * 4);
    const severityBoost = Math.min(16, Math.max(0, Number(event.severity?.value || 0) - 4) * 4);
    const vulnerabilityBoost = Math.min(10, Math.max(0, Number(event.vulnerability || 0)) * 2);
    const score = clampScore(alertBase + populationBoost + severityBoost + vulnerabilityBoost);
    return { ...event, impactScore: score };
  }).sort((a, b) => b.impactScore - a.impactScore);
  const activeHighImpact = scoredEvents.filter((event) => event.impactScore >= 62 || ['Orange', 'Red'].includes(event.alertLevel));
  const estimatedPopulationExposure = scoredEvents.reduce((sum, event) => sum + (Number(event.population?.value) || 0), 0);
  const maxImpactScore = scoredEvents[0]?.impactScore || 0;
  const averageImpactScore = scoredEvents.length ? Math.round(scoredEvents.reduce((sum, event) => sum + event.impactScore, 0) / scoredEvents.length) : 0;
  const alertCounts = countBy(scoredEvents, 'alertLevel');
  const eventTypeCounts = countBy(scoredEvents, 'eventType');
  const disasterRiskScore = clampScore(Math.max(maxImpactScore, averageImpactScore + activeHighImpact.length * 5));
  const supplyChainRiskScore = clampScore(disasterRiskScore + (eventTypeCounts.TC || 0) * 3 + (eventTypeCounts.FL || 0) * 3 + (eventTypeCounts.WF || 0) * 2);
  const insuranceRiskScore = clampScore(disasterRiskScore + (eventTypeCounts.EQ || 0) * 2 + (eventTypeCounts.TC || 0) * 3 + (eventTypeCounts.FL || 0) * 3);
  const recoveryOpportunityScore = clampScore(45 + activeHighImpact.length * 8 + Math.log10(Math.max(1, estimatedPopulationExposure)) * 3);
  const momentum = disasterRiskScore >= 70 ? 'global-disaster-risk-elevated'
    : disasterRiskScore >= 45 ? 'global-disaster-risk-watch'
      : 'global-disaster-risk-quiet';

  return {
    available: scoredEvents.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    latestPeriod: scoredEvents[0]?.pubDate || scoredEvents[0]?.dateModified || null,
    events: scoredEvents,
    eventCount: scoredEvents.length,
    highImpactCount: activeHighImpact.length,
    alertCounts,
    eventTypeCounts,
    estimatedPopulationExposure,
    maxImpactScore,
    averageImpactScore,
    disasterRiskScore,
    supplyChainRiskScore,
    insuranceRiskScore,
    recoveryOpportunityScore,
    opportunityScore: recoveryOpportunityScore,
    riskScore: disasterRiskScore,
    momentum,
    narrative: scoredEvents.length
      ? `GDACS ${momentum}: ${scoredEvents.length} recent events, ${activeHighImpact.length} high-impact watch events, max impact ${maxImpactScore}, exposed population ${estimatedPopulationExposure}.`
      : 'GDACS disaster context unavailable or no current events were returned.',
  };
}

function scoreCandidate({ candidate, disasterContext }) {
  if (!disasterContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'GDACS disaster context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['URI', 'CAT', 'DE', 'VMC', 'MLM', 'HD', 'LOW', 'PWR', 'EME']);
  const utilities = new Set(['XLU', 'NEE', 'DUK', 'SO', 'AEP']);
  const insurance = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const staplesRetail = new Set(['WMT', 'COST', 'TGT', 'KR']);
  let exposure = 0.32;
  let direction = -0.1;
  let label = 'limited direct disaster exposure';

  if (recoveryBeneficiaries.has(symbol) || /construction|infrastructure|materials|home improvement|equipment|rebuild/.test(theme)) {
    exposure = 0.78;
    direction = 0.82;
    label = 'can benefit from recovery, rebuilding, equipment rental, or infrastructure demand after severe disasters';
  } else if (utilities.has(symbol) || /utility|electricity|power/.test(theme)) {
    exposure = 0.76;
    direction = -0.35;
    label = 'faces outage, restoration cost, and local infrastructure disruption risk';
  } else if (insurance.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.82;
    direction = -0.8;
    label = 'faces claims and catastrophe-loss risk from elevated disasters';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise/.test(theme)) {
    exposure = 0.74;
    direction = -0.72;
    label = 'faces route disruption, travel interruption, and supply-chain friction risk';
  } else if (staplesRetail.has(symbol) || /retail|grocery|consumer/.test(theme)) {
    exposure = 0.54;
    direction = disasterContext.recoveryOpportunityScore >= 60 ? 0.18 : -0.28;
    label = 'has mixed exposure through emergency demand, store disruption, and local consumer pressure';
  }

  const riskDelta = (disasterContext.riskScore - 50) / 55;
  const opportunityDelta = (disasterContext.recoveryOpportunityScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? opportunityDelta : riskDelta * direction) * exposure - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.12 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `GDACS ${disasterContext.momentum}; ${symbol || 'candidate'} ${label}. Disaster risk ${disasterContext.riskScore}, supply-chain risk ${disasterContext.supplyChainRiskScore}, recovery opportunity ${disasterContext.recoveryOpportunityScore}.`,
    topEvents: disasterContext.events?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    eventCount: context?.eventCount || 0,
    highImpactCount: context?.highImpactCount || 0,
    alertCounts: context?.alertCounts || {},
    eventTypeCounts: context?.eventTypeCounts || {},
    estimatedPopulationExposure: context?.estimatedPopulationExposure || 0,
    scores: {
      risk: context?.riskScore || 50,
      disasterRisk: context?.disasterRiskScore || 50,
      supplyChainRisk: context?.supplyChainRiskScore || 50,
      insuranceRisk: context?.insuranceRiskScore || 50,
      recoveryOpportunity: context?.recoveryOpportunityScore || 50,
    },
    topEvents: (context?.events || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official GDACS near-real-time global disaster alert evidence. Share compact alert levels, impact estimates, geometry/location, and source URLs; do not move full feeds through BMCL.',
  };
}

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/rss+xml,application/xml,text/xml,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader GDACS disaster research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'gdacs', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'GDACS', type: 'gdacs-home', url: GDACS_HOME_URL },
    { name: 'GDACS API documentation', type: 'gdacs-api-docs', url: GDACS_API_DOCS_URL },
    { name: 'GDACS OpenAPI specification', type: 'gdacs-openapi', url: GDACS_OPENAPI_URL },
    { name: 'GDACS RSS and GeoRSS feed reference', type: 'gdacs-feed-reference', url: GDACS_FEED_REFERENCE_URL },
    { name: 'GDACS 24-hour RSS/GeoRSS alerts', type: 'gdacs-rss-georss', url: GDACS_RSS_24H_URL },
    { name: 'GDACS all events RSS/GeoRSS alerts', type: 'gdacs-rss-georss', url: GDACS_RSS_ALL_URL },
  ];
}

function tagWithAttributes(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${escapeRegex(tag)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, 'i'));
  if (!match) {
    const selfClosing = String(xml || '').match(new RegExp(`<${escapeRegex(tag)}\\b([^>]*)\\/>`, 'i'));
    return { attrs: selfClosing ? parseAttrs(selfClosing[1]) : {}, body: '' };
  }
  return { attrs: parseAttrs(match[1]), body: match[2] || '' };
}

function text(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${escapeRegex(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : '';
}

function attrFor(xml, tag, attr) {
  const attrs = tagWithAttributes(xml, tag).attrs;
  return attrs[attr] || '';
}

function parseAttrs(value) {
  const attrs = {};
  for (const match of matchAll(value, /([a-z0-9:_-]+)\s*=\s*"([^"]*)"/gi)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function matchAll(value, pattern) {
  return Array.from(String(value || '').matchAll(pattern)).map((match) => match[0] === undefined ? match : match);
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function eventTypeFromGuid(guid) {
  return String(guid || '').match(/^[A-Z]+/)?.[0] || '';
}

function eventTypeName(code) {
  return {
    EQ: 'earthquake',
    TC: 'tropical cyclone',
    FL: 'flood',
    WF: 'wildfire',
    DR: 'drought',
    VO: 'volcano',
    TS: 'tsunami',
  }[String(code || '').toUpperCase()] || String(code || '').toLowerCase() || 'unknown';
}

function normalizeAlertLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'red') return 'Red';
  if (normalized === 'orange') return 'Orange';
  if (normalized === 'green') return 'Green';
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Unknown';
}

function number(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  GDACS_HOME_URL,
  GDACS_API_DOCS_URL,
  GDACS_OPENAPI_URL,
  GDACS_FEED_REFERENCE_URL,
  GDACS_RSS_24H_URL,
  GDACS_RSS_ALL_URL,
  collectDisasterContext,
  parseGdacsRss,
  evaluateDisasterContext,
  scoreCandidate,
  compactForBmcl,
};
