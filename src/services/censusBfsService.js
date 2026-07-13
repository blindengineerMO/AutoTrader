const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const API_BASE = 'https://api.census.gov/data/timeseries/eits/bfs';
const VARIABLES_URL = `${API_BASE}/variables.json`;
const DATASET_DOC_URL = 'https://api.census.gov/data/timeseries/eits/bfs.html';
const PROGRAM_URL = 'https://www.census.gov/econ/bfs/index.html';

const PREFERRED_VARIABLES = [
  'cell_value',
  'time_slot_id',
  'time_slot_name',
  'time_slot_date',
  'category_code',
  'data_type_code',
  'seasonally_adj',
  'geo_level_code',
  'error_data',
];

const BFS_VARIABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let variablesCache = null;
let variablesCacheAt = 0;

async function collectBusinessFormationStatistics({ userId, apiKey, startTime, geography = 'us', timeoutMs = 7000, onEvent = () => {} } = {}) {
  const resolvedApiKey = apiKey || getConfiguredApiKey(userId);
  const sources = sourceList();
  if (!resolvedApiKey) {
    const skipped = unavailableContext('Census API key is not configured; BFS research skipped.', sources);
    emit(onEvent, 'census-bfs', 29, 'warn', skipped.reason, {
      providerKey: 'census-bfs',
      env: 'CENSUS_API_KEY',
    });
    return skipped;
  }

  try {
    const variables = await getBfsVariables({ timeoutMs });
    const selectedVariables = selectVariables(variables);
    const queryUrl = buildBfsQueryUrl({
      getVariables: selectedVariables,
      startTime: startTime || defaultStartTime(),
      geography,
      apiKey: resolvedApiKey,
    });
    emit(onEvent, 'census-bfs', 29, 'debug', 'Fetching Census Business Formation Statistics.', {
      startTime: startTime || defaultStartTime(),
      geography,
      variables: selectedVariables,
    });
    const data = await fetchJson(queryUrl, timeoutMs);
    const rows = parseCensusTable(data);
    const context = evaluateBfsRows(rows, { selectedVariables, queryUrl: stripKey(queryUrl), variables });
    emit(onEvent, 'census-bfs', 33, 'debug', 'Census BFS evaluation complete.', {
      rows: rows.length,
      latestPeriod: context.latestPeriod,
      opportunityScore: context.opportunityScore,
      momentum: context.momentum,
    });
    return context;
  } catch (error) {
    emit(onEvent, 'census-bfs', 31, 'warn', 'Census BFS source unavailable; continuing without business-formation context.', {
      error: error.message,
    });
    return unavailableContext(error.message, sources);
  }
}

function getConfiguredApiKey(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'census-bfs') : null;
  return saved?.apiKey || config.censusApiKey || '';
}

async function getBfsVariables({ force = false, timeoutMs = 7000 } = {}) {
  const now = Date.now();
  if (!force && variablesCache && now - variablesCacheAt < BFS_VARIABLE_CACHE_TTL_MS) return variablesCache;
  const data = await fetchJson(VARIABLES_URL, timeoutMs);
  variablesCache = data?.variables || {};
  variablesCacheAt = now;
  return variablesCache;
}

function selectVariables(variables) {
  const available = new Set(Object.keys(variables || {}));
  const selected = PREFERRED_VARIABLES.filter((name) => available.has(name));
  for (const required of ['cell_value', 'time_slot_id', 'category_code', 'data_type_code', 'seasonally_adj']) {
    if (!selected.includes(required)) throw new Error(`Census BFS variable listing is missing required variable ${required}`);
  }
  return selected;
}

function buildBfsQueryUrl({ getVariables = PREFERRED_VARIABLES, startTime = defaultStartTime(), geography = 'us', apiKey } = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set('get', getVariables.join(','));
  url.searchParams.set('time', `from ${startTime}`);
  if (geography && geography !== 'us') url.searchParams.set('for', geography);
  if (apiKey) url.searchParams.set('key', apiKey);
  return url.toString().replace(/\+/g, '%20');
}

function parseCensusTable(table) {
  if (!Array.isArray(table) || !Array.isArray(table[0])) return [];
  const headers = table[0];
  return table.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
}

function evaluateBfsRows(rows, { selectedVariables = PREFERRED_VARIABLES, queryUrl, variables = {} } = {}) {
  const cleanRows = rows
    .map((row) => ({
      ...row,
      numericValue: parseNumber(row.cell_value),
      timeSort: Number(row.time_slot_id || row.time?.replace(/\D/g, '') || 0),
      period: row.time_slot_date || row.time || row.time_slot_name || row.time_slot_id || null,
      seriesKey: [row.category_code || 'unknown-category', row.data_type_code || 'unknown-type', row.seasonally_adj || 'raw'].join('|'),
    }))
    .filter((row) => Number.isFinite(row.numericValue) && !/^yes$/i.test(String(row.error_data || '')));
  const seriesMap = new Map();
  for (const row of cleanRows) {
    const list = seriesMap.get(row.seriesKey) || [];
    list.push(row);
    seriesMap.set(row.seriesKey, list);
  }
  const seriesTrends = [...seriesMap.entries()].map(([seriesKey, list]) => buildSeriesTrend(seriesKey, list)).filter(Boolean);
  const latestPeriod = cleanRows.slice().sort((a, b) => b.timeSort - a.timeSort)[0]?.period || null;
  const growthValues = seriesTrends.map((item) => item.latestVsPriorPct).filter(Number.isFinite);
  const averageGrowthPct = Number(average(growthValues).toFixed(2));
  const positiveSeries = seriesTrends.filter((item) => item.latestVsPriorPct > 0).length;
  const negativeSeries = seriesTrends.filter((item) => item.latestVsPriorPct < 0).length;
  const opportunityScore = clampScore(50 + averageGrowthPct * 1.8 + (positiveSeries - negativeSeries) * 1.5);
  const riskScore = clampScore(52 - averageGrowthPct * 1.25 + negativeSeries * 1.2);
  const momentum = averageGrowthPct > 2 ? 'formation-accelerating'
    : averageGrowthPct < -2 ? 'formation-cooling'
      : 'formation-stable';

  return {
    available: true,
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(queryUrl),
    selectedVariables,
    variableLabels: Object.fromEntries(selectedVariables.map((name) => [name, variables[name]?.label || name])),
    latestPeriod,
    rows: cleanRows.length,
    seriesCount: seriesTrends.length,
    averageGrowthPct,
    positiveSeries,
    negativeSeries,
    opportunityScore,
    riskScore,
    momentum,
    topSeries: seriesTrends
      .sort((a, b) => Math.abs(b.latestVsPriorPct) - Math.abs(a.latestVsPriorPct))
      .slice(0, 8),
    narrative: `Census BFS ${momentum}: average latest-vs-prior movement ${averageGrowthPct}% across ${seriesTrends.length} aggregate business-formation series.`,
  };
}

function buildSeriesTrend(seriesKey, rows) {
  const sorted = rows.slice().sort((a, b) => b.timeSort - a.timeSort);
  const latest = sorted[0];
  const prior = sorted.find((row) => row.timeSort < latest.timeSort);
  if (!latest) return null;
  const latestVsPriorPct = prior?.numericValue ? ((latest.numericValue - prior.numericValue) / prior.numericValue) * 100 : 0;
  return {
    seriesKey,
    categoryCode: latest.category_code,
    dataTypeCode: latest.data_type_code,
    seasonallyAdjusted: latest.seasonally_adj,
    latestPeriod: latest.period,
    latestValue: latest.numericValue,
    priorPeriod: prior?.period || null,
    priorValue: prior?.numericValue ?? null,
    latestVsPriorPct: Number(latestVsPriorPct.toFixed(2)),
  };
}

function scoreCandidate({ candidate, bfsContext }) {
  if (!bfsContext?.available) return { normalized: 0.5, compositeScore: 50, explanation: 'Census BFS context unavailable.' };
  const symbol = candidate?.symbol || '';
  const theme = candidate?.theme || '';
  const exposure = ['IWM', 'SPY', 'QQQ', 'DIA'].includes(symbol) ? 0.78
    : ['DOCN', 'NET', 'DDOG', 'MDB', 'SNOW', 'BILL', 'HUBS', 'TEAM', 'CRM', 'SHOP'].includes(symbol) || /saas|startup|growth|small|business|financial/i.test(theme) ? 0.72
      : ['JPM', 'BAC', 'XLF', 'ADP', 'PAYX', 'INTU'].includes(symbol) ? 0.68
        : 0.42;
  const raw = 0.5 + ((bfsContext.opportunityScore - bfsContext.riskScore) / 100) * exposure;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `Census BFS ${bfsContext.momentum} with opportunity ${bfsContext.opportunityScore}, risk ${bfsContext.riskScore}, exposure ${Math.round(exposure * 100)}.`,
    topSeries: bfsContext.topSeries?.slice(0, 3) || [],
  };
}

function unavailableContext(reason, sources = sourceList()) {
  return {
    available: false,
    fetchedAt: new Date().toISOString(),
    sourceList: sources,
    selectedVariables: [],
    rows: 0,
    seriesCount: 0,
    averageGrowthPct: 0,
    positiveSeries: 0,
    negativeSeries: 0,
    opportunityScore: 50,
    riskScore: 50,
    momentum: 'unavailable',
    topSeries: [],
    reason,
    narrative: `Census BFS unavailable: ${reason}`,
  };
}

async function fetchJson(url, timeoutMs = 7000) {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`${stripKey(url)} failed with ${res.status}`);
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
        'User-Agent': 'Mozilla/5.0 AutoTrader Census BFS research bot',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList(queryUrl = API_BASE) {
  return [
    { name: 'Census Business Formation Statistics', type: 'business-formation-statistics', url: PROGRAM_URL },
    { name: 'Census BFS API documentation', type: 'business-formation-api', url: DATASET_DOC_URL },
    { name: 'Census BFS variables', type: 'business-formation-api-variables', url: VARIABLES_URL },
    { name: 'Census BFS query', type: 'business-formation-api-query', url: stripKey(queryUrl) },
  ];
}

function defaultStartTime() {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 12);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
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
  collectBusinessFormationStatistics,
  getBfsVariables,
  selectVariables,
  buildBfsQueryUrl,
  parseCensusTable,
  evaluateBfsRows,
  scoreCandidate,
};
