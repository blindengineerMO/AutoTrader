const { resilientFetch } = require('../utils/resilientFetch');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const { config } = require('../config');

const RELIEFWEB_HOME_URL = 'https://reliefweb.int/';
const RELIEFWEB_DOCS_URL = 'https://apidoc.reliefweb.int/';
const RELIEFWEB_ENDPOINTS_URL = 'https://apidoc.reliefweb.int/endpoints';
const RELIEFWEB_API_BASE_URL = 'https://api.reliefweb.int/v2/';
const RELIEFWEB_LEGACY_API_BASE_URL = 'https://api.reliefweb.int/v1/';
const RELIEFWEB_DISASTERS_URL = 'https://api.reliefweb.int/v2/disasters';
const RELIEFWEB_REPORTS_URL = 'https://api.reliefweb.int/v2/reports';

async function collectHumanitarianContext({ userId, timeoutMs = 8000, limit = 25, onEvent = () => {} } = {}) {
  const failures = [];
  const appName = getAppName(userId);
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  let disasters = [];
  let reports = [];

  if (!appName) {
    failures.push({
      source: 'reliefweb-config',
      url: RELIEFWEB_DOCS_URL,
      error: 'ReliefWeb appName is not configured. Set RELIEFWEB_APP_NAME or Settings data-source provider reliefweb.appName.',
    });
    emit(onEvent, 'reliefweb-humanitarian', 37, 'warn', 'ReliefWeb appName not configured; skipping executable humanitarian API pull.', {});
    return evaluateHumanitarianContext({ disasters, reports, failures, appConfigured: false });
  }

  try {
    const data = await fetchJson(buildUrl(RELIEFWEB_DISASTERS_URL, appName, boundedLimit), timeoutMs);
    disasters = normalizeDisasters(data.data || []);
    emit(onEvent, 'reliefweb-humanitarian', 37, 'debug', 'Fetched ReliefWeb disaster metadata.', {
      disasters: disasters.length,
    });
  } catch (error) {
    failures.push({ source: 'reliefweb-disasters', url: RELIEFWEB_DISASTERS_URL, error: error.message });
    emit(onEvent, 'reliefweb-humanitarian', 37, 'warn', 'ReliefWeb disaster endpoint unavailable.', {
      error: error.message,
    });
  }

  try {
    const data = await fetchJson(buildUrl(RELIEFWEB_REPORTS_URL, appName, boundedLimit), timeoutMs);
    reports = normalizeReports(data.data || []);
    emit(onEvent, 'reliefweb-humanitarian', 38, 'debug', 'Fetched ReliefWeb humanitarian reports.', {
      reports: reports.length,
    });
  } catch (error) {
    failures.push({ source: 'reliefweb-reports', url: RELIEFWEB_REPORTS_URL, error: error.message });
    emit(onEvent, 'reliefweb-humanitarian', 38, 'warn', 'ReliefWeb reports endpoint unavailable.', {
      error: error.message,
    });
  }

  return evaluateHumanitarianContext({ disasters, reports, failures, appConfigured: true });
}

function normalizeDisasters(items = []) {
  return items.map((item) => {
    const fields = item.fields || {};
    return {
      id: cleanText(item.id),
      href: cleanText(item.href),
      name: cleanText(fields.name || fields.title),
      status: cleanText(fields.status),
      description: cleanText(fields.description),
      type: normalizeNamedList(fields.type),
      country: normalizeNamedList(fields.country),
      date: normalizeDate(fields.date),
      profileUrl: cleanText(fields.url || item.href),
      source: 'reliefweb-disaster',
    };
  }).filter((item) => item.id || item.name);
}

function normalizeReports(items = []) {
  return items.map((item) => {
    const fields = item.fields || {};
    return {
      id: cleanText(item.id),
      href: cleanText(item.href),
      title: cleanText(fields.title),
      url: cleanText(fields.url || item.href),
      body: cleanText(fields.body || fields['body-html']),
      sourceOrganizations: normalizeNamedList(fields.source),
      country: normalizeNamedList(fields.country),
      disaster: normalizeNamedList(fields.disaster),
      theme: normalizeNamedList(fields.theme),
      format: normalizeNamedList(fields.format),
      date: normalizeDate(fields.date),
      source: 'reliefweb-report',
    };
  }).filter((item) => item.id || item.title);
}

function evaluateHumanitarianContext({ disasters = [], reports = [], failures = [], appConfigured = false } = {}) {
  const text = [
    disasters.map((item) => `${item.name} ${item.description} ${item.type.map((entry) => entry.name).join(' ')} ${item.country.map((entry) => entry.name).join(' ')}`).join(' '),
    reports.map((item) => `${item.title} ${item.body} ${item.theme.map((entry) => entry.name).join(' ')} ${item.country.map((entry) => entry.name).join(' ')}`).join(' '),
  ].join(' ').toLowerCase();
  const disasterTypeCounts = countNamed(disasters.flatMap((item) => item.type));
  const countryCounts = countNamed([...disasters.flatMap((item) => item.country), ...reports.flatMap((item) => item.country)]);
  const reportThemeCounts = countNamed(reports.flatMap((item) => item.theme));
  const conflictSignal = keywordScore(text, ['conflict', 'war', 'armed', 'violence', 'attack', 'hostilities', 'insecurity']);
  const displacementSignal = keywordScore(text, ['displaced', 'displacement', 'refugee', 'evacuat', 'shelter', 'camp']);
  const casualtySignal = keywordScore(text, ['death', 'killed', 'casualt', 'injur', 'fatalit']);
  const aidSignal = keywordScore(text, ['aid', 'humanitarian', 'response', 'relief', 'assistance', 'funding', 'appeal']);
  const infrastructureSignal = keywordScore(text, ['infrastructure', 'road', 'bridge', 'power', 'water', 'hospital', 'school', 'port']);
  const foodHealthSignal = keywordScore(text, ['food', 'nutrition', 'health', 'cholera', 'disease', 'medicine', 'water', 'sanitation']);
  const humanitarianImpactScore = clampScore(32 + disasters.length * 4 + reports.length * 2 + conflictSignal * 5 + displacementSignal * 4 + casualtySignal * 4);
  const crisisSeverityScore = clampScore(humanitarianImpactScore + casualtySignal * 3 + displacementSignal * 3);
  const aidRequirementScore = clampScore(36 + aidSignal * 6 + foodHealthSignal * 4 + reports.length * 2);
  const infrastructureRecoveryScore = clampScore(38 + infrastructureSignal * 7 + disasters.length * 3);
  const supplyChainDisruptionScore = clampScore(35 + conflictSignal * 6 + infrastructureSignal * 5 + displacementSignal * 2);
  const latestPeriod = [...disasters.map((item) => item.date.changed || item.date.created || item.date.event), ...reports.map((item) => item.date.original || item.date.created)]
    .filter(Boolean)
    .sort()
    .pop() || null;
  const momentum = humanitarianImpactScore >= 70 ? 'humanitarian-crisis-risk-elevated'
    : humanitarianImpactScore >= 45 ? 'humanitarian-crisis-risk-watch'
      : 'humanitarian-crisis-risk-quiet';

  return {
    available: disasters.length > 0 || reports.length > 0,
    appConfigured,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    latestPeriod,
    disasters,
    reports,
    disasterCount: disasters.length,
    reportCount: reports.length,
    disasterTypeCounts,
    countryCounts,
    reportThemeCounts,
    conflictSignal,
    displacementSignal,
    casualtySignal,
    aidSignal,
    infrastructureSignal,
    foodHealthSignal,
    humanitarianImpactScore,
    crisisSeverityScore,
    aidRequirementScore,
    infrastructureRecoveryScore,
    supplyChainDisruptionScore,
    riskScore: humanitarianImpactScore,
    opportunityScore: infrastructureRecoveryScore,
    momentum,
    narrative: disasters.length || reports.length
      ? `ReliefWeb ${momentum}: ${disasters.length} disaster records and ${reports.length} humanitarian reports; crisis severity ${crisisSeverityScore}, aid requirement ${aidRequirementScore}, supply-chain disruption ${supplyChainDisruptionScore}.`
      : appConfigured
        ? 'ReliefWeb humanitarian context unavailable or no recent disaster/report records were returned.'
        : 'ReliefWeb humanitarian context skipped because an approved appName is not configured.',
  };
}

function scoreCandidate({ candidate, humanitarianContext }) {
  if (!humanitarianContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'ReliefWeb humanitarian context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const recoveryBeneficiaries = new Set(['CAT', 'DE', 'URI', 'VMC', 'MLM', 'HD', 'LOW', 'PWR', 'EME', 'XLI']);
  const insurers = new Set(['ALL', 'PGR', 'TRV', 'CB', 'AIG', 'RE']);
  const logisticsTravel = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JETS', 'CCL', 'RCL']);
  const healthcare = new Set(['JNJ', 'PFE', 'MRK', 'ABT', 'BAX', 'XLV']);
  const foodAgriculture = new Set(['ADM', 'BG', 'KR', 'GIS', 'KHC', 'WMT', 'COST']);
  const defense = new Set(['LMT', 'RTX', 'NOC', 'GD', 'HII', 'ITA']);
  let exposure = 0.28;
  let direction = -0.08;
  let label = 'limited direct humanitarian-crisis exposure';

  if (recoveryBeneficiaries.has(symbol) || /construction|infrastructure|materials|rebuild|equipment/.test(theme)) {
    exposure = 0.74;
    direction = 0.72;
    label = 'can benefit from infrastructure repair, rebuilding, equipment, and emergency-response demand';
  } else if (defense.has(symbol) || /defense|aerospace|military/.test(theme)) {
    exposure = 0.72;
    direction = humanitarianContext.conflictSignal > 0 ? 0.58 : 0.1;
    label = 'can see demand tailwinds when humanitarian reporting indicates conflict-related emergencies';
  } else if (healthcare.has(symbol) || /health|medical|pharma|medicine/.test(theme)) {
    exposure = 0.58;
    direction = humanitarianContext.foodHealthSignal > 0 ? 0.34 : 0.08;
    label = 'can see medical, sanitation, and disease-response demand, while facing access and logistics constraints';
  } else if (foodAgriculture.has(symbol) || /food|grocery|agriculture|staples/.test(theme)) {
    exposure = 0.62;
    direction = humanitarianContext.aidRequirementScore >= 60 ? 0.22 : -0.12;
    label = 'has mixed food-demand, aid-procurement, supply, and local disruption exposure';
  } else if (insurers.has(symbol) || /insurance|reinsurance/.test(theme)) {
    exposure = 0.78;
    direction = -0.68;
    label = 'faces claims, insured-asset, and catastrophe-risk pressure where crises overlap covered markets';
  } else if (logisticsTravel.has(symbol) || /logistics|shipping|airline|travel|cruise/.test(theme)) {
    exposure = 0.76;
    direction = -0.62;
    label = 'faces access, route, border, port, and safety disruption risk in humanitarian emergencies';
  }

  const riskDelta = (humanitarianContext.riskScore - 50) / 55;
  const opportunityDelta = (humanitarianContext.infrastructureRecoveryScore - 50) / 50;
  const raw = 0.5 + (direction >= 0 ? opportunityDelta : riskDelta * direction) * exposure - Math.max(0, riskDelta) * exposure * (direction >= 0 ? 0.08 : 0);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `ReliefWeb ${humanitarianContext.momentum}; ${symbol || 'candidate'} ${label}. Humanitarian impact ${humanitarianContext.humanitarianImpactScore}, aid requirement ${humanitarianContext.aidRequirementScore}, supply-chain disruption ${humanitarianContext.supplyChainDisruptionScore}, infrastructure recovery ${humanitarianContext.infrastructureRecoveryScore}.`,
    topDisasters: humanitarianContext.disasters?.slice(0, 5) || [],
    topReports: humanitarianContext.reports?.slice(0, 5) || [],
  };
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    appConfigured: Boolean(context?.appConfigured),
    fetchedAt: context?.fetchedAt,
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    disasterCount: context?.disasterCount || 0,
    reportCount: context?.reportCount || 0,
    disasterTypeCounts: context?.disasterTypeCounts || {},
    countryCounts: context?.countryCounts || {},
    reportThemeCounts: context?.reportThemeCounts || {},
    signals: {
      conflict: context?.conflictSignal || 0,
      displacement: context?.displacementSignal || 0,
      casualties: context?.casualtySignal || 0,
      aid: context?.aidSignal || 0,
      infrastructure: context?.infrastructureSignal || 0,
      foodHealth: context?.foodHealthSignal || 0,
    },
    scores: {
      risk: context?.riskScore || 50,
      humanitarianImpact: context?.humanitarianImpactScore || 50,
      crisisSeverity: context?.crisisSeverityScore || 50,
      aidRequirement: context?.aidRequirementScore || 50,
      infrastructureRecovery: context?.infrastructureRecoveryScore || 50,
      supplyChainDisruption: context?.supplyChainDisruptionScore || 50,
    },
    topDisasters: (context?.disasters || []).slice(0, 8),
    topReports: (context?.reports || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as ReliefWeb curated humanitarian disaster/report evidence. Share compact countries, disaster types, report themes, sources, dates, and impact signals; do not move full report bodies through BMCL.',
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'application/json',
    'User-Agent': 'AutoTrader ReliefWeb humanitarian research bot',
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error?.message || parsed.message || body;
    } catch (_) {
      // Keep raw body.
    }
    throw new Error(`${url} failed with ${res.status}: ${detail}`);
  }
  return JSON.parse(body);
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'reliefweb', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function getAppName(userId) {
  if (userId) {
    const saved = providerCredentialRepo.getSecret(userId, 'reliefweb');
    if (saved?.appName) return cleanText(saved.appName);
  }
  return cleanText(config.reliefWebAppName);
}

function buildUrl(baseUrl, appName, limit) {
  const url = new URL(baseUrl);
  url.searchParams.set('appname', appName);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('profile', 'list');
  return url.toString();
}

function sourceList() {
  return [
    { name: 'ReliefWeb', type: 'reliefweb-main', url: RELIEFWEB_HOME_URL },
    { name: 'ReliefWeb API documentation', type: 'reliefweb-api-docs', url: RELIEFWEB_DOCS_URL },
    { name: 'ReliefWeb endpoint documentation', type: 'reliefweb-endpoints', url: RELIEFWEB_ENDPOINTS_URL },
    { name: 'ReliefWeb API base v2', type: 'reliefweb-api-base', url: RELIEFWEB_API_BASE_URL },
    { name: 'ReliefWeb legacy-compatible API base v1', type: 'reliefweb-api-base-legacy', url: RELIEFWEB_LEGACY_API_BASE_URL },
    { name: 'ReliefWeb disaster endpoint', type: 'reliefweb-disasters', url: RELIEFWEB_DISASTERS_URL },
    { name: 'ReliefWeb reports endpoint', type: 'reliefweb-reports', url: RELIEFWEB_REPORTS_URL },
  ];
}

function normalizeNamedList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => {
    if (typeof item === 'string') return { id: '', name: cleanText(item) };
    return { id: cleanText(item.id), name: cleanText(item.name || item.title || item.shortname) };
  }).filter((item) => item.id || item.name);
}

function normalizeDate(value = {}) {
  if (typeof value === 'string') return { original: value };
  return {
    created: value.created || null,
    changed: value.changed || null,
    original: value.original || null,
    event: value.event || null,
  };
}

function countNamed(items) {
  return items.reduce((acc, item) => {
    const key = item.name || item.id || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function keywordScore(text, terms) {
  return terms.reduce((sum, term) => sum + (text.match(new RegExp(escapeRegex(term), 'g')) || []).length, 0);
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
  RELIEFWEB_HOME_URL,
  RELIEFWEB_DOCS_URL,
  RELIEFWEB_ENDPOINTS_URL,
  RELIEFWEB_API_BASE_URL,
  RELIEFWEB_LEGACY_API_BASE_URL,
  RELIEFWEB_DISASTERS_URL,
  RELIEFWEB_REPORTS_URL,
  collectHumanitarianContext,
  normalizeDisasters,
  normalizeReports,
  evaluateHumanitarianContext,
  scoreCandidate,
  compactForBmcl,
};
