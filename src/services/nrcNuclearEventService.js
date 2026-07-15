const { resilientFetch } = require('../utils/resilientFetch');
const NRC_EVENT_NOTIFICATIONS_PAGE_URL = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/';
const NRC_EVENT_NOTIFICATIONS_INDEX_URL = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/index';
const NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL = 'https://www.nrc.gov/sites/default/files/doc_library/reading-rm/doc-collections/event-status/event/event-notification-rpt-lastmonth.txt';
const NRC_EVENT_NOTIFICATIONS_DICTIONARY_URL = 'https://www.nrc.gov/sites/default/files/doc_library/reading-rm/doc-collections/event-status/event/event-notification-rpt-datadictionary.xls';
const NRC_REACTOR_STATUS_PAGE_URL = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/';
const NRC_REACTOR_STATUS_LAST_365_URL = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/PowerReactorStatusForLast365Days.txt';
const NRC_REACTOR_STATUS_DICTIONARY_URL = 'https://www.nrc.gov/sites/default/files/doc_library/reading-rm/doc-collections/event-status/reactor-status/data_gov_powerstatus_datadictionary.xls';

async function collectNuclearEventContext({
  timeoutMs = 8000,
  eventLimit = 150,
  reactorLimit = 500,
  onEvent = () => {},
} = {}) {
  const failures = [];
  const [eventResult, reactorResult] = await Promise.allSettled([
    fetchText(NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL, timeoutMs),
    fetchText(NRC_REACTOR_STATUS_LAST_365_URL, timeoutMs),
  ]);

  let events = [];
  let reactorStatuses = [];
  if (eventResult.status === 'fulfilled') {
    events = normalizeEventNotificationRecords(parseEventNotificationRecords(eventResult.value))
      .slice(0, Math.min(Math.max(Number(eventLimit) || 150, 1), 500));
    emit(onEvent, 'nrc-nuclear-events', 42, 'debug', 'Fetched NRC event notification raw feed.', {
      events: events.length,
      url: NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL,
    });
  } else {
    failures.push({ source: 'nrc-event-notifications-last-month', url: NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL, error: eventResult.reason.message });
    emit(onEvent, 'nrc-nuclear-events', 42, 'warn', 'NRC event notification raw feed unavailable.', {
      url: NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL,
      error: eventResult.reason.message,
    });
  }

  if (reactorResult.status === 'fulfilled') {
    reactorStatuses = normalizeReactorStatusRecords(parsePipeRecords(reactorResult.value))
      .slice(0, Math.min(Math.max(Number(reactorLimit) || 500, 1), 5000));
    emit(onEvent, 'nrc-reactor-status', 43, 'debug', 'Fetched NRC power reactor status raw feed.', {
      statuses: reactorStatuses.length,
      url: NRC_REACTOR_STATUS_LAST_365_URL,
    });
  } else {
    failures.push({ source: 'nrc-power-reactor-status-last-365', url: NRC_REACTOR_STATUS_LAST_365_URL, error: reactorResult.reason.message });
    emit(onEvent, 'nrc-reactor-status', 43, 'warn', 'NRC power reactor status raw feed unavailable.', {
      url: NRC_REACTOR_STATUS_LAST_365_URL,
      error: reactorResult.reason.message,
    });
  }

  return evaluateNuclearEventContext({ events, reactorStatuses, failures });
}

function parseEventNotificationRecords(text) {
  const clean = String(text || '').replace(/\r/g, '');
  const firstNewline = clean.indexOf('\n');
  if (firstNewline < 0) return [];
  const headers = clean.slice(0, firstNewline).split('|').map(normalizeHeader);
  const body = clean.slice(firstNewline + 1);
  const matches = [...body.matchAll(/\|\s*([^|\n]+)\|(\d{4,6})\|/g)];
  if (!matches.length) return parsePipeRecords(clean);

  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? body.length;
    const chunk = body.slice(start, end).trim();
    const fields = chunk.replace(/^\|/, '').split('|');
    return mapFields(headers, fields);
  });
}

function parsePipeRecords(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('|').map(normalizeHeader);
  return lines.slice(1)
    .map((line) => mapFields(headers, line.split('|')))
    .filter((record) => Object.keys(record).length);
}

function normalizeEventNotificationRecords(records = []) {
  return records.map((record) => {
    const eventText = cleanText(get(record, 'eventtext'));
    const emergencyClass = cleanText(get(record, 'emergencyclass'));
    const cfrCodes = [get(record, 'cfrcd1'), get(record, 'cfrcd2'), get(record, 'cfrcd3'), get(record, 'cfrcd4')]
      .map(cleanText).filter(Boolean);
    const cfrDescriptions = [get(record, 'cfrdescr1'), get(record, 'cfrdescr2'), get(record, 'cfrdescr3'), get(record, 'cfrdescr4')]
      .map(cleanText).filter(Boolean);
    const scramCodes = [get(record, 'scramcode1'), get(record, 'scramcode2'), get(record, 'scramcode3')]
      .map(cleanText).filter(Boolean);
    const normalized = {
      source: 'nrc-event-notifications',
      sourceUrl: NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL,
      eventDescription: cleanText(get(record, 'eventdesc')),
      eventNumber: cleanText(get(record, 'enno')),
      siteName: cleanText(get(record, 'sitename')),
      licenseeName: cleanText(get(record, 'licenseename')),
      regionNo: cleanText(get(record, 'regionno')),
      cityName: cleanText(get(record, 'cityname')),
      stateCode: cleanText(get(record, 'statecd')),
      countyName: cleanText(get(record, 'countyname')),
      licenseNo: cleanText(get(record, 'licenseno')),
      agreementState: cleanText(get(record, 'agreementstateind')),
      docketNo: cleanText(get(record, 'docketno')),
      notificationDate: cleanText(get(record, 'notificationdt')),
      notificationTime: cleanText(get(record, 'notificationtime')),
      eventDate: cleanText(get(record, 'eventdt')),
      eventTime: cleanText(get(record, 'eventtime')),
      timeZone: cleanText(get(record, 'timezone')),
      lastUpdatedDate: cleanText(get(record, 'lastupdateddt')),
      emergencyClass,
      cfrCodes,
      cfrDescriptions,
      scramCodes,
      reactorCritical: cleanText(get(record, 'rxcrit1')),
      initialPower: numberOrNull(get(record, 'initialpwr1')),
      currentPower: numberOrNull(get(record, 'currentpwr1')),
      eventText,
    };
    normalized.impactScore = eventImpactScore(normalized);
    return normalized;
  }).filter((record) => record.eventNumber || record.eventDescription || record.siteName || record.eventText);
}

function normalizeReactorStatusRecords(records = []) {
  return records.map((record) => {
    const power = numberOrNull(get(record, 'power'));
    const status = {
      source: 'nrc-power-reactor-status',
      sourceUrl: NRC_REACTOR_STATUS_LAST_365_URL,
      reportDate: cleanText(get(record, 'reportdt')),
      unit: cleanText(get(record, 'unit')),
      power,
    };
    status.status = power === null ? 'unknown' : power <= 0 ? 'offline' : power < 95 ? 'derated' : 'online';
    status.impactScore = power === null ? 35 : power <= 0 ? 86 : power < 50 ? 72 : power < 95 ? 54 : 18;
    return status;
  }).filter((record) => record.reportDate || record.unit);
}

function evaluateNuclearEventContext({ events = [], reactorStatuses = [], failures = [] } = {}) {
  const sortedEvents = [...events].sort((a, b) => b.impactScore - a.impactScore);
  const latestStatuses = latestReactorStatuses(reactorStatuses);
  const offlineStatuses = latestStatuses.filter((status) => status.status === 'offline');
  const deratedStatuses = latestStatuses.filter((status) => status.status === 'derated');
  const averagePowerPct = latestStatuses.length
    ? Math.round(latestStatuses.reduce((sum, status) => sum + (Number(status.power) || 0), 0) / latestStatuses.length)
    : null;
  const scramCount = sortedEvents.filter((event) => event.scramCodes.length || /scram/i.test(event.eventText)).length;
  const part21Count = sortedEvents.filter((event) => /part\s*21/i.test(event.eventDescription)).length;
  const powerReactorEventCount = sortedEvents.filter((event) => /power reactor/i.test(event.eventDescription)).length;
  const agreementStateCount = sortedEvents.filter((event) => /agreement state/i.test(event.eventDescription) || /^y$/i.test(event.agreementState)).length;
  const emergencyClassCount = sortedEvents.filter((event) => event.emergencyClass && !/non/i.test(event.emergencyClass)).length;
  const highImpactEventCount = sortedEvents.filter((event) => event.impactScore >= 65).length;
  const maxEventImpact = sortedEvents[0]?.impactScore || 0;
  const safetyIncidentScore = clampScore(Math.max(maxEventImpact, 30 + highImpactEventCount * 7 + scramCount * 8 + emergencyClassCount * 10));
  const reactorOutageScore = clampScore(25 + offlineStatuses.length * 8 + deratedStatuses.length * 3 + Math.max(0, 100 - (averagePowerPct ?? 100)) * 0.8);
  const regulatoryNotificationScore = clampScore(25 + sortedEvents.length * 1.2 + part21Count * 5 + agreementStateCount * 2 + powerReactorEventCount * 4);
  const nuclearUtilityRiskScore = clampScore(Math.max(safetyIncidentScore, reactorOutageScore, regulatoryNotificationScore));
  const nuclearServicesOpportunityScore = clampScore(35 + offlineStatuses.length * 7 + deratedStatuses.length * 4 + scramCount * 5 + part21Count * 4);
  const alternativeEnergyOpportunityScore = clampScore(35 + offlineStatuses.length * 5 + Math.max(0, 100 - (averagePowerPct ?? 100)) * 0.6);
  const riskScore = nuclearUtilityRiskScore;
  const momentum = riskScore >= 70 ? 'nrc-nuclear-event-risk-elevated'
    : riskScore >= 48 ? 'nrc-nuclear-event-risk-watch'
      : 'nrc-nuclear-event-risk-quiet';

  return {
    available: sortedEvents.length > 0 || latestStatuses.length > 0,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    latestPeriod: sortedEvents[0]?.notificationDate || latestStatuses[0]?.reportDate || null,
    events: sortedEvents,
    reactorStatuses: latestStatuses.sort((a, b) => b.impactScore - a.impactScore),
    eventCount: sortedEvents.length,
    reactorStatusCount: latestStatuses.length,
    highImpactEventCount,
    scramCount,
    part21Count,
    powerReactorEventCount,
    agreementStateCount,
    emergencyClassCount,
    offlineUnitCount: offlineStatuses.length,
    deratedUnitCount: deratedStatuses.length,
    averagePowerPct,
    safetyIncidentScore,
    reactorOutageScore,
    regulatoryNotificationScore,
    nuclearUtilityRiskScore,
    nuclearServicesOpportunityScore,
    alternativeEnergyOpportunityScore,
    riskScore,
    opportunityScore: nuclearServicesOpportunityScore,
    momentum,
    narrative: sortedEvents.length || latestStatuses.length
      ? `NRC ${momentum}: ${sortedEvents.length} event notifications, ${offlineStatuses.length} offline reactors, ${deratedStatuses.length} derated reactors, utility risk ${riskScore}.`
      : 'NRC nuclear event and power reactor status context unavailable or empty.',
  };
}

function scoreCandidate({ candidate, nuclearEventContext }) {
  if (!nuclearEventContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'NRC nuclear event/status context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const nuclearUtilities = new Set(['NEE', 'DUK', 'SO', 'EXC', 'CEG', 'D', 'AEP', 'VST', 'NRG', 'PEG', 'XLU']);
  const nuclearFuelServices = new Set(['CCJ', 'UUUU', 'URA', 'URNM', 'BWXT', 'LEU']);
  const gridIndustrialServices = new Set(['PWR', 'EME', 'ETN', 'EMR', 'HON', 'GEV', 'FLR', 'J']);
  const alternateEnergy = new Set(['XOM', 'CVX', 'COP', 'LNG', 'UNG', 'XLE', 'TAN', 'FSLR', 'ENPH']);
  const insurers = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE']);
  let exposure = 0.25;
  let direction = -0.06;
  let label = 'limited direct nuclear-facility event exposure';

  if (nuclearUtilities.has(symbol) || /nuclear utility|utility|power reactor|regulated power|electric utility/.test(theme)) {
    exposure = 0.9;
    direction = -0.72;
    label = 'has direct reactor outage, safety, inspection, regulatory, replacement-power, and operating-cost exposure';
  } else if (nuclearFuelServices.has(symbol) || /uranium|nuclear fuel|nuclear service|reactor component|small modular reactor/.test(theme)) {
    exposure = 0.74;
    direction = nuclearEventContext.safetyIncidentScore >= 75 ? -0.34 : 0.46;
    label = 'has mixed nuclear fuel/service demand exposure with safety-event headline risk';
  } else if (gridIndustrialServices.has(symbol) || /grid|engineering|industrial service|maintenance|construction|infrastructure/.test(theme)) {
    exposure = 0.7;
    direction = 0.58;
    label = 'can benefit from outage response, maintenance, remediation, grid, and nuclear facility service demand';
  } else if (alternateEnergy.has(symbol) || /natural gas|solar|alternative energy|backup power|replacement power/.test(theme)) {
    exposure = 0.58;
    direction = 0.34;
    label = 'can benefit when nuclear outages raise replacement-power or grid-balancing demand';
  } else if (insurers.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.5;
    direction = -0.28;
    label = 'has indirect nuclear incident, liability, operational interruption, and catastrophe risk exposure';
  }

  const riskDelta = (nuclearEventContext.riskScore - 50) / 55;
  const servicesDelta = (nuclearEventContext.nuclearServicesOpportunityScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? servicesDelta * direction : riskDelta * direction) * exposure;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `NRC ${nuclearEventContext.momentum}; ${symbol || 'candidate'} ${label}. Safety incident score ${nuclearEventContext.safetyIncidentScore}, reactor outage score ${nuclearEventContext.reactorOutageScore}, regulatory notification score ${nuclearEventContext.regulatoryNotificationScore}, nuclear services opportunity ${nuclearEventContext.nuclearServicesOpportunityScore}.`,
    topEvents: nuclearEventContext.events?.slice(0, 5) || [],
    topOutages: nuclearEventContext.reactorStatuses?.filter((status) => status.status !== 'online').slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    eventCount: context?.eventCount || 0,
    reactorStatusCount: context?.reactorStatusCount || 0,
    highImpactEventCount: context?.highImpactEventCount || 0,
    scramCount: context?.scramCount || 0,
    part21Count: context?.part21Count || 0,
    powerReactorEventCount: context?.powerReactorEventCount || 0,
    offlineUnitCount: context?.offlineUnitCount || 0,
    deratedUnitCount: context?.deratedUnitCount || 0,
    averagePowerPct: context?.averagePowerPct ?? null,
    scores: {
      risk: context?.riskScore || 50,
      safetyIncident: context?.safetyIncidentScore || 50,
      reactorOutage: context?.reactorOutageScore || 50,
      regulatoryNotification: context?.regulatoryNotificationScore || 50,
      nuclearUtilityRisk: context?.nuclearUtilityRiskScore || 50,
      nuclearServicesOpportunity: context?.nuclearServicesOpportunityScore || 50,
      alternativeEnergyOpportunity: context?.alternativeEnergyOpportunityScore || 50,
    },
    topEvents: (context?.events || []).slice(0, 8).map((event) => ({
      eventNumber: event.eventNumber,
      eventDescription: event.eventDescription,
      siteName: event.siteName,
      licenseeName: event.licenseeName,
      stateCode: event.stateCode,
      emergencyClass: event.emergencyClass,
      cfrCodes: event.cfrCodes,
      scramCodes: event.scramCodes,
      currentPower: event.currentPower,
      impactScore: event.impactScore,
      eventText: cleanText(event.eventText).slice(0, 500),
      sourceUrl: event.sourceUrl,
    })),
    topOutages: (context?.reactorStatuses || []).filter((status) => status.status !== 'online').slice(0, 8),
    sources: context?.sourceList || sourceList(),
    failures: context?.failures || [],
    bmclUse: 'Share as official NRC nuclear event/status evidence; compare event notification type, CFR basis, emergency class, scram/shutdown/derate, current power, plant/operator/vendor exposure before scoring utilities, uranium, nuclear services, grid, industrial suppliers, insurers, or regional power prices.',
  };
}

function sourceList() {
  return [
    { id: 'nrc-event-notification-reports', title: 'NRC Event Notification Reports', url: NRC_EVENT_NOTIFICATIONS_PAGE_URL, type: 'official-index' },
    { id: 'nrc-event-notification-lastmonth-raw', title: 'NRC Event Notification Report Last Month Raw Text', url: NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL, type: 'pipe-delimited-raw-data' },
    { id: 'nrc-event-notification-data-dictionary', title: 'NRC Event Notification Data Dictionary', url: NRC_EVENT_NOTIFICATIONS_DICTIONARY_URL, type: 'data-dictionary' },
    { id: 'nrc-power-reactor-status-reports', title: 'NRC Power Reactor Status Reports', url: NRC_REACTOR_STATUS_PAGE_URL, type: 'official-index' },
    { id: 'nrc-power-reactor-status-last365-raw', title: 'NRC Power Reactor Status Last 365 Days Raw Text', url: NRC_REACTOR_STATUS_LAST_365_URL, type: 'pipe-delimited-raw-data' },
    { id: 'nrc-power-reactor-status-data-dictionary', title: 'NRC Power Reactor Status Data Dictionary', url: NRC_REACTOR_STATUS_DICTIONARY_URL, type: 'data-dictionary' },
  ];
}

function latestReactorStatuses(statuses = []) {
  const byUnit = new Map();
  for (const status of statuses) {
    const unit = status.unit;
    if (!unit) continue;
    const existing = byUnit.get(unit);
    if (!existing || Date.parse(status.reportDate) > Date.parse(existing.reportDate || '')) byUnit.set(unit, status);
  }
  return [...byUnit.values()];
}

function eventImpactScore(event) {
  const text = `${event.eventDescription} ${event.emergencyClass} ${event.cfrCodes.join(' ')} ${event.cfrDescriptions.join(' ')} ${event.eventText}`.toLowerCase();
  let score = 28;
  if (/general emergency/.test(text)) score += 55;
  else if (/site area emergency/.test(text)) score += 45;
  else if (/alert/.test(text)) score += 34;
  else if (/unusual event|unusual/.test(text)) score += 22;
  if (/power reactor/.test(text)) score += 12;
  if (/part\s*21|defect|deviation|noncompliance/.test(text)) score += 9;
  if (/scram|shutdown|trip|current power[^0-9]*0|manual reactor trip|automatic reactor trip/.test(text)) score += 18;
  if (/fire|explosion|leak|contamination|overexposure|injur|lost|stolen|security|safety system|emergency diesel|cooling/.test(text)) score += 12;
  if (Number(event.currentPower) === 0) score += 10;
  else if (Number(event.currentPower) > 0 && Number(event.currentPower) < 95) score += 5;
  return clampScore(score);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await resilientFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AutoTrader NRC nuclear event research bot' },
    }, { bucket: 'nrc', timeoutMs: 0 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function mapFields(headers, fields) {
  const record = {};
  headers.forEach((header, index) => {
    if (!header) return;
    record[header] = cleanText(fields[index]);
  });
  if (headers.includes('eventtext')) {
    const eventIndex = headers.indexOf('eventtext');
    record.eventtext = cleanText(fields.slice(eventIndex).join('|'));
  }
  return record;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function get(record, key) {
  return record?.[key] ?? '';
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function numberOrNull(value) {
  const parsed = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function emit(onEvent, step, progress, level, message, data) {
  try {
    onEvent({ step, progress, level, message, data });
  } catch (_) {
    // Ignore observer failures during autonomous research.
  }
}

module.exports = {
  NRC_EVENT_NOTIFICATIONS_PAGE_URL,
  NRC_EVENT_NOTIFICATIONS_INDEX_URL,
  NRC_EVENT_NOTIFICATIONS_LAST_MONTH_URL,
  NRC_EVENT_NOTIFICATIONS_DICTIONARY_URL,
  NRC_REACTOR_STATUS_PAGE_URL,
  NRC_REACTOR_STATUS_LAST_365_URL,
  NRC_REACTOR_STATUS_DICTIONARY_URL,
  collectNuclearEventContext,
  parseEventNotificationRecords,
  parsePipeRecords,
  normalizeEventNotificationRecords,
  normalizeReactorStatusRecords,
  evaluateNuclearEventContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
  countBy,
};
