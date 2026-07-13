const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const API_BASE = 'https://api.census.gov/data/timeseries/bds';
const VARIABLES_URL = `${API_BASE}/variables.json`;
const DATASET_DOC_URL = 'https://www.census.gov/programs-surveys/bds/data.API.html';
const DATASET_API_URL = `${API_BASE}.html`;
const PROGRAM_URL = 'https://www.census.gov/programs-surveys/bds/data.html';

const PREFERRED_VARIABLES = [
  'NAME',
  'YEAR',
  'FIRM',
  'ESTABS_ENTRY',
  'ESTABS_ENTRY_RATE',
  'ESTABS_EXIT',
  'ESTABS_EXIT_RATE',
  'FIRMDEATH_FIRMS',
  'JOB_CREATION',
  'JOB_CREATION_BIRTHS',
  'JOB_DESTRUCTION',
  'NET_JOB_CREATION',
];

const POSITIVE_METRICS = ['FIRM', 'ESTABS_ENTRY', 'ESTABS_ENTRY_RATE', 'JOB_CREATION', 'JOB_CREATION_BIRTHS', 'NET_JOB_CREATION'];
const RISK_METRICS = ['ESTABS_EXIT', 'ESTABS_EXIT_RATE', 'FIRMDEATH_FIRMS', 'JOB_DESTRUCTION'];

const BDS_VARIABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let variablesCache = null;
let variablesCacheAt = 0;

async function collectBusinessDynamicsStatistics({ userId, apiKey, startYear, geography = 'us:*', timeoutMs = 7000, onEvent = () => {} } = {}) {
  const resolvedApiKey = apiKey || getConfiguredApiKey(userId);
  const sources = sourceList();
  if (!resolvedApiKey) {
    const skipped = unavailableContext('Census API key is not configured; BDS research skipped.', sources);
    emit(onEvent, 'census-bds', 30, 'warn', skipped.reason, {
      providerKey: 'census-bds',
      env: 'CENSUS_API_KEY',
    });
    return skipped;
  }

  try {
    const variables = await getBdsVariables({ timeoutMs });
    const selectedVariables = selectVariables(variables);
    const queryUrl = buildBdsQueryUrl({
      getVariables: selectedVariables,
      startYear: startYear || defaultStartYear(),
      geography,
      apiKey: resolvedApiKey,
    });
    emit(onEvent, 'census-bds', 30, 'debug', 'Fetching Census Business Dynamics Statistics.', {
      startYear: startYear || defaultStartYear(),
      geography,
      variables: selectedVariables,
    });
    const data = await fetchJson(queryUrl, timeoutMs);
    const rows = parseCensusTable(data);
    const context = evaluateBdsRows(rows, { selectedVariables, queryUrl: stripKey(queryUrl), variables });
    emit(onEvent, 'census-bds', 34, 'debug', 'Census BDS evaluation complete.', {
      rows: rows.length,
      latestYear: context.latestYear,
      opportunityScore: context.opportunityScore,
      riskScore: context.riskScore,
      momentum: context.momentum,
    });
    return context;
  } catch (error) {
    emit(onEvent, 'census-bds', 32, 'warn', 'Census BDS source unavailable; continuing without business-dynamics context.', {
      error: error.message,
    });
    return unavailableContext(error.message, sources);
  }
}

function getConfiguredApiKey(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'census-bds') : null;
  return saved?.apiKey || config.censusApiKey || '';
}

async function getBdsVariables({ force = false, timeoutMs = 7000 } = {}) {
  const now = Date.now();
  if (!force && variablesCache && now - variablesCacheAt < BDS_VARIABLE_CACHE_TTL_MS) return variablesCache;
  const data = await fetchJson(VARIABLES_URL, timeoutMs);
  variablesCache = data?.variables || {};
  variablesCacheAt = now;
  return variablesCache;
}

function selectVariables(variables) {
  const available = new Set(Object.keys(variables || {}));
  const selected = PREFERRED_VARIABLES.filter((name) => available.has(name));
  for (const required of ['YEAR', 'FIRM', 'ESTABS_ENTRY', 'ESTABS_EXIT', 'FIRMDEATH_FIRMS', 'JOB_CREATION', 'JOB_DESTRUCTION']) {
    if (!selected.includes(required)) throw new Error(`Census BDS variable listing is missing required variable ${required}`);
  }
  return selected;
}

function buildBdsQueryUrl({ getVariables = PREFERRED_VARIABLES, startYear = defaultStartYear(), geography = 'us:*', apiKey } = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set('get', getVariables.join(','));
  url.searchParams.set('time', `from ${startYear}`);
  url.searchParams.set('for', geography);
  if (apiKey) url.searchParams.set('key', apiKey);
  return url.toString().replace(/\+/g, '%20');
}

function parseCensusTable(table) {
  if (!Array.isArray(table) || !Array.isArray(table[0])) return [];
  const headers = table[0];
  return table.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
}

function evaluateBdsRows(rows, { selectedVariables = PREFERRED_VARIABLES, queryUrl, variables = {} } = {}) {
  const cleanRows = rows
    .map((row) => ({
      ...row,
      year: Number(row.YEAR || row.time || 0),
    }))
    .filter((row) => Number.isFinite(row.year) && row.year > 0)
    .sort((a, b) => a.year - b.year);
  const metricTrends = [...new Set([...POSITIVE_METRICS, ...RISK_METRICS])]
    .filter((metric) => selectedVariables.includes(metric))
    .map((metric) => buildMetricTrend(metric, cleanRows))
    .filter(Boolean);
  const latestYear = cleanRows[cleanRows.length - 1]?.year || null;
  const positiveGrowth = metricTrends.filter((trend) => trend.direction === 'positive').map((trend) => trend.latestVsPriorPct).filter(Number.isFinite);
  const riskGrowth = metricTrends.filter((trend) => trend.direction === 'risk').map((trend) => trend.latestVsPriorPct).filter(Number.isFinite);
  const averagePositiveGrowthPct = Number(average(positiveGrowth).toFixed(2));
  const averageRiskGrowthPct = Number(average(riskGrowth).toFixed(2));
  const netDynamismPct = Number((averagePositiveGrowthPct - averageRiskGrowthPct).toFixed(2));
  const positiveSeries = positiveGrowth.filter((value) => value > 0).length;
  const negativeSeries = positiveGrowth.filter((value) => value < 0).length + riskGrowth.filter((value) => value > 0).length;
  const opportunityScore = clampScore(50 + averagePositiveGrowthPct * 1.25 - averageRiskGrowthPct * 0.9 + (positiveSeries - negativeSeries) * 1.2);
  const riskScore = clampScore(50 + averageRiskGrowthPct * 1.35 - averagePositiveGrowthPct * 0.65 + negativeSeries * 1.1);
  const momentum = netDynamismPct > 2 ? 'business-dynamism-expanding'
    : netDynamismPct < -2 ? 'business-dynamism-cooling'
      : 'business-dynamism-stable';

  return {
    available: true,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(queryUrl),
    selectedVariables,
    variableLabels: Object.fromEntries(selectedVariables.map((name) => [name, variables[name]?.label || name])),
    latestYear,
    rows: cleanRows.length,
    metricCount: metricTrends.length,
    averagePositiveGrowthPct,
    averageRiskGrowthPct,
    netDynamismPct,
    positiveSeries,
    negativeSeries,
    opportunityScore,
    riskScore,
    momentum,
    topMetrics: metricTrends.sort((a, b) => Math.abs(b.latestVsPriorPct) - Math.abs(a.latestVsPriorPct)).slice(0, 8),
    narrative: `Census BDS ${momentum}: positive dynamism changed ${averagePositiveGrowthPct}% while shutdown/destruction risk changed ${averageRiskGrowthPct}% year over year.`,
  };
}

function buildMetricTrend(metric, rows) {
  const sorted = rows.slice().sort((a, b) => b.year - a.year);
  const latest = sorted.find((row) => Number.isFinite(parseNumber(row[metric])));
  if (!latest) return null;
  const prior = sorted.find((row) => row.year < latest.year && Number.isFinite(parseNumber(row[metric])));
  const latestValue = parseNumber(latest[metric]);
  const priorValue = parseNumber(prior?.[metric]);
  const latestVsPriorPct = priorValue ? ((latestValue - priorValue) / priorValue) * 100 : 0;
  return {
    metric,
    label: metricLabel(metric),
    direction: RISK_METRICS.includes(metric) ? 'risk' : 'positive',
    latestYear: latest.year,
    latestValue,
    priorYear: prior?.year || null,
    priorValue: priorValue ?? null,
    latestVsPriorPct: Number(latestVsPriorPct.toFixed(2)),
  };
}

function scoreCandidate({ candidate, bdsContext }) {
  if (!bdsContext?.available) return { normalized: 0.5, compositeScore: 50, explanation: 'Census BDS context unavailable.' };
  const symbol = candidate?.symbol || '';
  const theme = candidate?.theme || '';
  const exposure = ['IWM', 'SPY', 'QQQ', 'DIA'].includes(symbol) ? 0.76
    : ['DOCN', 'NET', 'DDOG', 'MDB', 'SNOW', 'BILL', 'HUBS', 'TEAM', 'CRM', 'SHOP'].includes(symbol) || /saas|startup|growth|small|business|payroll|financial/i.test(theme) ? 0.74
      : ['JPM', 'BAC', 'XLF', 'ADP', 'PAYX', 'INTU', 'SQ', 'PYPL'].includes(symbol) ? 0.66
        : 0.4;
  const raw = 0.5 + ((bdsContext.opportunityScore - bdsContext.riskScore) / 100) * exposure;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `Census BDS ${bdsContext.momentum} with opportunity ${bdsContext.opportunityScore}, risk ${bdsContext.riskScore}, exposure ${Math.round(exposure * 100)}.`,
    topMetrics: bdsContext.topMetrics?.slice(0, 3) || [],
  };
}

function unavailableContext(reason, sources = sourceList()) {
  return {
    available: false,
    fetchedAt: new Date().toISOString(),
    sourceList: sources,
    selectedVariables: [],
    rows: 0,
    metricCount: 0,
    averagePositiveGrowthPct: 0,
    averageRiskGrowthPct: 0,
    netDynamismPct: 0,
    positiveSeries: 0,
    negativeSeries: 0,
    opportunityScore: 50,
    riskScore: 50,
    momentum: 'unavailable',
    topMetrics: [],
    reason,
    narrative: `Census BDS unavailable: ${reason}`,
  };
}

async function fetchJson(url, timeoutMs = 7000) {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`${stripKey(url)} failed with ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await res.text();
    throw new Error(`${stripKey(url)} returned non-JSON response: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  return res.json();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 AutoTrader Census BDS research bot',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList(queryUrl = API_BASE) {
  return [
    { name: 'Census Business Dynamics Statistics', type: 'business-dynamics-statistics', url: PROGRAM_URL },
    { name: 'Census BDS API documentation', type: 'business-dynamics-api', url: DATASET_DOC_URL },
    { name: 'Census BDS API dataset', type: 'business-dynamics-api-dataset', url: DATASET_API_URL },
    { name: 'Census BDS variables', type: 'business-dynamics-api-variables', url: VARIABLES_URL },
    { name: 'Census BDS query', type: 'business-dynamics-api-query', url: stripKey(queryUrl) },
  ];
}

function defaultStartYear() {
  return String(new Date().getUTCFullYear() - 6);
}

function metricLabel(metric) {
  return String(metric || '').toLowerCase().replace(/_/g, ' ');
}

function parseNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function stripKey(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('key');
    return parsed.toString().replace(/\+/g, '%20');
  } catch {
    return String(url || '').replace(/([?&]key=)[^&]+/i, '$1[redacted]');
  }
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
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
  API_BASE,
  VARIABLES_URL,
  collectBusinessDynamicsStatistics,
  getBdsVariables,
  selectVariables,
  buildBdsQueryUrl,
  parseCensusTable,
  evaluateBdsRows,
  scoreCandidate,
};
