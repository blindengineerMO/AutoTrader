const { resilientFetch } = require('../utils/resilientFetch');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const DATASETS = [
  {
    id: 'mrts',
    name: 'Monthly Retail Trade and Food Services',
    apiBase: 'https://api.census.gov/data/timeseries/eits/mrts',
    docsUrl: 'https://api.census.gov/data/timeseries/eits/mrts.html',
    variablesUrl: 'https://api.census.gov/data/timeseries/eits/mrts/variables.json',
    programUrl: 'https://www.census.gov/retail/',
    cadence: 'monthly',
    measureType: 'retail-sales-inventory-category',
    caveat: 'Completed monthly category-level retail sales, inventory, and inventory-to-sales evidence. It is not UPC, SKU, store-level, or company-level sales.',
  },
  {
    id: 'marts',
    name: 'Advance Monthly Sales for Retail and Food Services',
    apiBase: 'https://api.census.gov/data/timeseries/eits/marts',
    docsUrl: 'https://api.census.gov/data/timeseries/eits/marts.html',
    variablesUrl: 'https://api.census.gov/data/timeseries/eits/marts/variables.json',
    programUrl: 'https://www.census.gov/retail/',
    cadence: 'monthly-advance',
    measureType: 'advance-retail-sales-category',
    caveat: 'Faster but less detailed advance retail-sales evidence. Compare against later MRTS/final releases before treating it as confirmed trend.',
  },
  {
    id: 'mtis',
    name: 'Manufacturing and Trade Inventories and Sales',
    apiBase: 'https://api.census.gov/data/timeseries/eits/mtis',
    docsUrl: 'https://api.census.gov/data/timeseries/eits/mtis.html',
    variablesUrl: 'https://api.census.gov/data/timeseries/eits/mtis/variables.json',
    programUrl: 'https://www.census.gov/mtis/',
    cadence: 'monthly',
    measureType: 'combined-business-sales-inventory',
    caveat: 'Combined retail, wholesale, and manufacturing sales/inventory evidence for demand slowdowns, excess inventory, and supply shortages.',
  },
];

const ARTS_SOURCE = {
  id: 'arts',
  name: 'Annual Retail Trade Survey / Annual Integrated Economic Survey transition',
  programUrl: 'https://www.census.gov/programs-surveys/arts.html',
  cadence: 'annual',
  measureType: 'annual-retail-structure',
  caveat: 'Annual retail sales, e-commerce sales, inventories, gross margins, operating expenses, and merchandise-line context. ARTS transitioned to AIES; preserve survey/NAICS/restatement context.',
};

const PREFERRED_VARIABLES = [
  'cell_value',
  'data_type_code',
  'category_code',
  'time_slot_id',
  'time_slot_name',
  'time_slot_date',
  'seasonally_adj',
  'geo_level_code',
  'program_code',
  'error_data',
];

const VARIABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const variableCaches = new Map();

async function collectRetailTradeContext({
  userId,
  apiKey,
  startTime,
  geography = 'us',
  datasets = ['mrts', 'marts', 'mtis'],
  timeoutMs = 8000,
  includeData = true,
  onEvent = () => {},
} = {}) {
  const resolvedApiKey = apiKey === false ? '' : apiKey || getConfiguredApiKey(userId);
  const selectedDatasets = selectDatasets(datasets);
  const failures = [];
  const datasetContexts = [];

  for (const dataset of selectedDatasets) {
    try {
      const variables = await getDatasetVariables(dataset.id, { timeoutMs });
      const selectedVariables = selectVariables(variables);
      if (!resolvedApiKey || includeData === false) {
        datasetContexts.push(metadataOnlyDataset(dataset, variables, selectedVariables, resolvedApiKey ? 'data-fetch-disabled' : 'missing-census-api-key'));
        continue;
      }
      const queryUrl = buildDatasetQueryUrl({
        dataset,
        getVariables: selectedVariables,
        startTime: startTime || defaultStartTime(),
        geography,
        apiKey: resolvedApiKey,
      });
      emit(onEvent, 'census-retail-trade', 34, 'debug', 'Fetching Census retail/trade economic indicator rows.', {
        dataset: dataset.id,
        startTime: startTime || defaultStartTime(),
        geography,
        variables: selectedVariables,
      });
      const rows = parseCensusTable(await fetchJson(queryUrl, timeoutMs));
      datasetContexts.push(evaluateDatasetRows(dataset, rows, {
        selectedVariables,
        variables,
        queryUrl: stripKey(queryUrl),
      }));
    } catch (error) {
      failures.push({ source: dataset.id, url: dataset.apiBase, error: error.message });
      datasetContexts.push(unavailableDataset(dataset, error.message));
      emit(onEvent, 'census-retail-trade', 34, 'warn', 'Census retail/trade dataset unavailable; continuing with remaining datasets.', {
        dataset: dataset.id,
        error: error.message,
      });
    }
  }

  return evaluateRetailTradeContext({
    datasetContexts,
    failures,
    apiKeyConfigured: Boolean(resolvedApiKey),
  });
}

function evaluateRetailTradeContext({ datasetContexts = [], failures = [], apiKeyConfigured = false } = {}) {
  const availableDatasets = datasetContexts.filter((dataset) => dataset.available);
  const trendValues = availableDatasets.flatMap((dataset) => (dataset.topSeries || []).map((series) => series.latestVsPriorPct)).filter(Number.isFinite);
  const averageTrendPct = Number(average(trendValues).toFixed(2));
  const positiveSeries = availableDatasets.reduce((sum, dataset) => sum + (dataset.positiveSeries || 0), 0);
  const negativeSeries = availableDatasets.reduce((sum, dataset) => sum + (dataset.negativeSeries || 0), 0);
  const retailDemandScore = clampScore(50 + averageTrendPct * 1.7 + (positiveSeries - negativeSeries) * 0.8);
  const inventoryStressSignals = availableDatasets.flatMap((dataset) => dataset.topSeries || [])
    .filter((series) => /invent|stock|ratio/i.test(`${series.dataTypeCode} ${series.seriesKey}`) && series.latestVsPriorPct > 1.5);
  const inventoryPressureScore = clampScore(42 + inventoryStressSignals.length * 7 + Math.max(0, -averageTrendPct) * 1.4);
  const demandSlowdownScore = clampScore(45 + negativeSeries * 1.6 + Math.max(0, -averageTrendPct) * 2.2);
  const consumerBias = retailDemandScore >= 58 && demandSlowdownScore < 58 ? 'constructive'
    : retailDemandScore <= 44 || demandSlowdownScore >= 62 ? 'softening'
      : 'neutral';

  return {
    available: availableDatasets.length > 0,
    provider: 'census-retail-trade',
    fetchedAt: new Date().toISOString(),
    apiKeyConfigured,
    sourceList: sourceList(),
    datasets: datasetContexts,
    annualRetailSource: ARTS_SOURCE,
    rows: datasetContexts.reduce((sum, dataset) => sum + (dataset.rows || 0), 0),
    seriesCount: datasetContexts.reduce((sum, dataset) => sum + (dataset.seriesCount || 0), 0),
    averageTrendPct,
    positiveSeries,
    negativeSeries,
    retailDemandScore,
    inventoryPressureScore,
    demandSlowdownScore,
    consumerBias,
    failures,
    caveat: 'Census MRTS, MARTS, MTIS, and ARTS/AIES are category or aggregate trade evidence. They do not identify individual products, UPCs, stores, or company-specific sales.',
    narrative: apiKeyConfigured
      ? `Census retail/trade ${consumerBias}: average latest-vs-prior movement ${averageTrendPct}% across ${datasetContexts.length} datasets, with retail demand score ${retailDemandScore} and inventory pressure ${inventoryPressureScore}.`
      : 'Census retail/trade metadata available, but a Census API key is required for MRTS/MARTS/MTIS data pulls.',
  };
}

function evaluateDatasetRows(dataset, rows, { selectedVariables = PREFERRED_VARIABLES, variables = {}, queryUrl } = {}) {
  const cleanRows = rows
    .map((row) => ({
      ...row,
      numericValue: parseNumber(row.cell_value),
      timeSort: Number(row.time_slot_id || String(row.time || '').replace(/\D/g, '') || 0),
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
  const growthValues = seriesTrends.map((item) => item.latestVsPriorPct).filter(Number.isFinite);
  const averageGrowthPct = Number(average(growthValues).toFixed(2));
  const positiveSeries = seriesTrends.filter((item) => item.latestVsPriorPct > 0).length;
  const negativeSeries = seriesTrends.filter((item) => item.latestVsPriorPct < 0).length;
  return {
    available: true,
    id: dataset.id,
    name: dataset.name,
    measureType: dataset.measureType,
    cadence: dataset.cadence,
    caveat: dataset.caveat,
    queryUrl,
    selectedVariables,
    variableLabels: Object.fromEntries(selectedVariables.map((name) => [name, variables[name]?.label || name])),
    rows: cleanRows.length,
    seriesCount: seriesTrends.length,
    latestPeriod: cleanRows.slice().sort((a, b) => b.timeSort - a.timeSort)[0]?.period || null,
    averageGrowthPct,
    positiveSeries,
    negativeSeries,
    topSeries: seriesTrends
      .sort((a, b) => Math.abs(b.latestVsPriorPct) - Math.abs(a.latestVsPriorPct))
      .slice(0, 12),
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

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'census-retail-trade',
    fetchedAt: context.fetchedAt,
    apiKeyConfigured: Boolean(context.apiKeyConfigured),
    consumerBias: context.consumerBias,
    retailDemandScore: context.retailDemandScore,
    inventoryPressureScore: context.inventoryPressureScore,
    demandSlowdownScore: context.demandSlowdownScore,
    averageTrendPct: context.averageTrendPct,
    rows: context.rows || 0,
    seriesCount: context.seriesCount || 0,
    datasets: (context.datasets || []).map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      available: Boolean(dataset.available),
      measureType: dataset.measureType,
      cadence: dataset.cadence,
      rows: dataset.rows || 0,
      seriesCount: dataset.seriesCount || 0,
      latestPeriod: dataset.latestPeriod,
      averageGrowthPct: dataset.averageGrowthPct,
      topSeries: (dataset.topSeries || []).slice(0, 5),
      reason: dataset.reason,
      caveat: dataset.caveat,
      queryUrl: dataset.queryUrl,
    })),
    annualRetailSource: context.annualRetailSource || ARTS_SOURCE,
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.caveat,
    bmclUse: 'Share as official Census category-level retail, advance retail, combined trade inventory/sales, and annual retail-structure evidence. Compare sales, inventories, inventory-to-sales, advance-vs-final revisions, MTIS supply/demand signals, and ARTS/AIES annual structure before scoring retailers, CPG, ecommerce, home improvement, apparel, autos, restaurants, logistics, and consumer-discretionary exposure. Never treat it as UPC, store-level, or company-specific sales.',
  };
}

function metadataOnlyDataset(dataset, variables, selectedVariables, reason) {
  return {
    available: false,
    id: dataset.id,
    name: dataset.name,
    measureType: dataset.measureType,
    cadence: dataset.cadence,
    caveat: dataset.caveat,
    selectedVariables,
    variableLabels: Object.fromEntries(selectedVariables.map((name) => [name, variables[name]?.label || name])),
    rows: 0,
    seriesCount: 0,
    topSeries: [],
    reason,
  };
}

function unavailableDataset(dataset, reason) {
  return {
    available: false,
    id: dataset.id,
    name: dataset.name,
    measureType: dataset.measureType,
    cadence: dataset.cadence,
    caveat: dataset.caveat,
    rows: 0,
    seriesCount: 0,
    topSeries: [],
    reason,
  };
}

function getConfiguredApiKey(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'census-retail') : null;
  return saved?.apiKey || config.censusApiKey || '';
}

async function getDatasetVariables(datasetId, { force = false, timeoutMs = 8000 } = {}) {
  const dataset = DATASETS.find((item) => item.id === datasetId);
  if (!dataset) throw new Error(`Unknown Census retail/trade dataset ${datasetId}`);
  const cache = variableCaches.get(dataset.id);
  const now = Date.now();
  if (!force && cache && now - cache.at < VARIABLE_CACHE_TTL_MS) return cache.variables;
  const data = await fetchJson(dataset.variablesUrl, timeoutMs);
  const variables = data?.variables || {};
  variableCaches.set(dataset.id, { at: now, variables });
  return variables;
}

function selectVariables(variables) {
  const available = new Set(Object.keys(variables || {}));
  const selected = PREFERRED_VARIABLES.filter((name) => available.has(name));
  for (const required of ['cell_value', 'data_type_code', 'category_code', 'seasonally_adj']) {
    if (!selected.includes(required)) throw new Error(`Census retail/trade variable listing is missing required variable ${required}`);
  }
  return selected;
}

function buildDatasetQueryUrl({ dataset, getVariables = PREFERRED_VARIABLES, startTime = defaultStartTime(), geography = 'us', apiKey } = {}) {
  const url = new URL(dataset.apiBase || dataset);
  url.searchParams.set('get', getVariables.join(','));
  url.searchParams.set('time', `from ${startTime}`);
  if (geography === 'us') url.searchParams.set('for', 'us:*');
  else if (geography) url.searchParams.set('for', geography);
  if (apiKey) url.searchParams.set('key', apiKey);
  return url.toString().replace(/\+/g, '%20');
}

function parseCensusTable(table) {
  if (!Array.isArray(table) || !Array.isArray(table[0])) return [];
  const headers = table[0];
  return table.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
}

function sourceList() {
  return [
    { name: 'Census Monthly Retail Trade', type: 'retail-program', url: 'https://www.census.gov/retail/' },
    ...DATASETS.flatMap((dataset) => [
      { name: dataset.name, type: dataset.measureType, url: dataset.apiBase },
      { name: `${dataset.name} variables`, type: `${dataset.id}-variables`, url: dataset.variablesUrl.replace(/\.json$/, '.html') },
    ]),
    { name: 'Census Annual Retail Trade Survey', type: 'annual-retail-structure', url: ARTS_SOURCE.programUrl },
  ];
}

function selectDatasets(datasets) {
  const requested = new Set((Array.isArray(datasets) ? datasets : [datasets]).filter(Boolean).map((item) => String(item).toLowerCase()));
  const selected = DATASETS.filter((dataset) => !requested.size || requested.has(dataset.id));
  return selected.length ? selected : DATASETS;
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`${stripKey(url)} failed with ${res.status}`);
  return res.json();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 AutoTrader Census retail trade research bot',
      },
    }, { bucket: 'census-retail-trade', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
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

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  DATASETS,
  ARTS_SOURCE,
  collectRetailTradeContext,
  evaluateRetailTradeContext,
  evaluateDatasetRows,
  getDatasetVariables,
  selectVariables,
  buildDatasetQueryUrl,
  parseCensusTable,
  compactForBmcl,
  sourceList,
};
