const { resilientFetch } = require('../utils/resilientFetch');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BLS_CPI_URL = 'https://www.bls.gov/cpi/data.htm';
const BLS_AVERAGE_PRICE_URL = 'https://www.bls.gov/charts/consumer-price-index/consumer-price-index-average-price-data.htm';
const BLS_PPI_URL = 'https://www.bls.gov/ppi/data.htm';
const BLS_DEVELOPERS_URL = 'https://www.bls.gov/developers/';

const BLS_PRICING_SERIES = [
  {
    id: 'CUUR0000SA0',
    name: 'CPI all items',
    family: 'cpi',
    category: 'all-items',
    unit: 'index',
    exposure: 'broad-consumer-inflation',
  },
  {
    id: 'CUUR0000SAH3',
    name: 'CPI household furnishings and operations',
    family: 'cpi',
    category: 'household-furnishings',
    unit: 'index',
    exposure: 'home-goods-affordability',
  },
  {
    id: 'CUUR0000SEHK',
    name: 'CPI appliances',
    family: 'cpi',
    category: 'appliances',
    unit: 'index',
    exposure: 'appliance-affordability',
  },
  {
    id: 'CUUR0000SAA',
    name: 'CPI apparel',
    family: 'cpi',
    category: 'apparel',
    unit: 'index',
    exposure: 'apparel-affordability',
  },
  {
    id: 'CUUR0000SETA01',
    name: 'CPI new vehicles',
    family: 'cpi',
    category: 'new-vehicles',
    unit: 'index',
    exposure: 'auto-affordability',
  },
  {
    id: 'CUUR0000SETA02',
    name: 'CPI used cars and trucks',
    family: 'cpi',
    category: 'used-vehicles',
    unit: 'index',
    exposure: 'used-auto-affordability',
  },
  {
    id: 'CUUR0000SAF1',
    name: 'CPI food',
    family: 'cpi',
    category: 'food-products',
    unit: 'index',
    exposure: 'food-affordability',
  },
  {
    id: 'APU0000708111',
    name: 'Average price eggs, grade A, large, per dozen',
    family: 'average-price',
    category: 'food-products',
    unit: 'dollars',
    exposure: 'selected-food-dollar-price',
  },
  {
    id: 'APU0000709112',
    name: 'Average price gasoline, all types, per gallon',
    family: 'average-price',
    category: 'fuel-products',
    unit: 'dollars',
    exposure: 'consumer-fuel-dollar-price',
  },
  {
    id: 'WPUFD4',
    name: 'PPI final demand',
    family: 'ppi',
    category: 'final-demand',
    unit: 'index',
    exposure: 'producer-selling-price-pressure',
  },
  {
    id: 'WPUFD49207',
    name: 'PPI final demand services',
    family: 'ppi',
    category: 'services',
    unit: 'index',
    exposure: 'service-producer-price-pressure',
  },
  {
    id: 'WPUFD49104',
    name: 'PPI final demand goods',
    family: 'ppi',
    category: 'goods',
    unit: 'index',
    exposure: 'goods-producer-price-pressure',
  },
];

async function collectBlsPricingContext({
  userId,
  apiKey,
  seriesIds,
  startYear = defaultStartYear(),
  endYear = new Date().getUTCFullYear(),
  timeoutMs = 8000,
  onEvent = () => {},
} = {}) {
  const resolvedApiKey = apiKey || getConfiguredApiKey(userId);
  const selected = selectSeries(seriesIds);
  const payload = {
    seriesid: selected.map((series) => series.id),
    startyear: String(startYear),
    endyear: String(endYear),
  };
  if (resolvedApiKey) payload.registrationkey = resolvedApiKey;

  try {
    const response = await postBls(payload, timeoutMs);
    const rows = normalizeBlsResponse(response, selected);
    emit(onEvent, 'bls-pricing', 34, 'debug', 'Fetched BLS CPI, selected average-price, and PPI timeseries.', {
      series: selected.length,
      rows: rows.length,
      apiKeyConfigured: Boolean(resolvedApiKey),
    });
    return evaluateBlsPricingContext({
      apiKeyConfigured: Boolean(resolvedApiKey),
      rows,
      selected,
      failures: [],
      request: { startYear, endYear, seriesIds: payload.seriesid },
    });
  } catch (error) {
    emit(onEvent, 'bls-pricing', 34, 'warn', 'BLS pricing context unavailable; continuing with remaining sources.', {
      error: error.message,
    });
    return evaluateBlsPricingContext({
      apiKeyConfigured: Boolean(resolvedApiKey),
      rows: [],
      selected,
      failures: [{ source: 'bls-public-api-v2-timeseries-data', error: error.message }],
      request: { startYear, endYear, seriesIds: payload.seriesid },
    });
  }
}

function getConfiguredApiKey(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'bls') : null;
  return saved?.apiKey || config.blsApiKey || '';
}

async function postBls(payload, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await resilientFetch(BLS_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 AutoTrader BLS pricing research bot',
      },
      body: JSON.stringify(payload),
    }, { bucket: 'bls-pricing', timeoutMs: 0 });
    if (!res.ok) throw new Error(`${BLS_API_URL} failed with ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBlsResponse(response, selected = BLS_PRICING_SERIES) {
  const seriesMeta = new Map(selected.map((item) => [item.id, item]));
  const series = response?.Results?.series || response?.results?.series || [];
  return series.flatMap((entry) => {
    const meta = seriesMeta.get(entry.seriesID) || {
      id: entry.seriesID,
      name: entry.seriesID,
      family: inferFamily(entry.seriesID),
      category: 'custom',
      unit: 'index',
      exposure: 'custom-bls-pricing-series',
    };
    return (entry.data || []).map((row) => normalizeRow(row, meta)).filter(Boolean);
  });
}

function normalizeRow(row, meta) {
  if (!/^M\d{2}$/.test(String(row.period || ''))) return null;
  const value = parseNumber(row.value);
  if (!Number.isFinite(value)) return null;
  return {
    id: meta.id,
    name: meta.name,
    family: meta.family,
    category: meta.category,
    exposure: meta.exposure,
    period: `${row.year}-${String(row.period).slice(1).padStart(2, '0')}`,
    year: Number(row.year),
    month: Number(String(row.period).slice(1)),
    periodName: row.periodName || null,
    value,
    unit: meta.unit,
    footnotes: (row.footnotes || [])
      .map((footnote) => footnote.text || footnote.code)
      .filter(Boolean),
    source: meta.family === 'ppi' ? 'BLS Producer Price Index'
      : meta.family === 'average-price' ? 'BLS CPI average price data'
        : 'BLS Consumer Price Index',
    url: meta.family === 'ppi' ? BLS_PPI_URL
      : meta.family === 'average-price' ? BLS_AVERAGE_PRICE_URL
        : BLS_CPI_URL,
  };
}

function evaluateBlsPricingContext({ apiKeyConfigured = false, rows = [], selected = BLS_PRICING_SERIES, failures = [], request = {} } = {}) {
  const latestSeries = latestRowsBySeries(rows);
  const familyGroups = {
    cpi: latestSeries.filter((row) => row.family === 'cpi'),
    averagePrice: latestSeries.filter((row) => row.family === 'average-price'),
    ppi: latestSeries.filter((row) => row.family === 'ppi'),
  };
  const cpiYoY = average(familyGroups.cpi.map((row) => row.yearOverYearChangePct).filter(Number.isFinite));
  const avgPriceYoY = average(familyGroups.averagePrice.map((row) => row.yearOverYearChangePct).filter(Number.isFinite));
  const ppiYoY = average(familyGroups.ppi.map((row) => row.yearOverYearChangePct).filter(Number.isFinite));
  const consumerInflationScore = clampScore(50 + cpiYoY * 4);
  const averagePricePressureScore = clampScore(50 + avgPriceYoY * 3.5);
  const producerCostPressureScore = clampScore(50 + ppiYoY * 4);
  const marginPressureScore = clampScore(50 + ppiYoY * 3 + Math.max(0, ppiYoY - cpiYoY) * 4);
  const affordabilityRiskScore = clampScore(50 + Math.max(cpiYoY, avgPriceYoY) * 4);
  const momentum = producerCostPressureScore >= 62 || consumerInflationScore >= 62 ? 'price-pressure-rising'
    : producerCostPressureScore <= 42 && consumerInflationScore <= 42 ? 'price-pressure-easing'
      : 'price-pressure-neutral';

  return {
    available: latestSeries.length > 0,
    fetchedAt: new Date().toISOString(),
    provider: 'bls-pricing',
    apiKeyConfigured,
    apiEndpoint: BLS_API_URL,
    sourceList: sourceList(),
    request,
    failures,
    selectedSeries: selected.map((series) => ({ id: series.id, name: series.name, family: series.family, category: series.category })),
    rowCount: rows.length,
    seriesCount: latestSeries.length,
    latestPeriod: latestSeries[0]?.period || null,
    latestSeries,
    scores: {
      consumerInflation: consumerInflationScore,
      averagePricePressure: averagePricePressureScore,
      producerCostPressure: producerCostPressureScore,
      marginPressure: marginPressureScore,
      affordabilityRisk: affordabilityRiskScore,
    },
    averageYearOverYearPct: {
      cpi: round(cpiYoY, 2),
      averagePrice: round(avgPriceYoY, 2),
      ppi: round(ppiYoY, 2),
    },
    momentum,
    caveat: 'BLS CPI, average-price, and PPI data are official price and inflation evidence. CPI is price-index movement, average-price data covers a limited selected-product basket, and PPI measures producer selling prices. These are not unit-sales volume, SKU/store-level sales, or company-specific revenue.',
    narrative: latestSeries.length
      ? `BLS pricing ${momentum}: CPI YoY ${round(cpiYoY, 2)}%, average-price YoY ${round(avgPriceYoY, 2)}%, PPI YoY ${round(ppiYoY, 2)}%. Margin pressure ${marginPressureScore}, affordability risk ${affordabilityRiskScore}.`
      : 'BLS pricing context unavailable; use BLS CPI, average-price, PPI, and public API source catalog entries.',
  };
}

function latestRowsBySeries(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  return [...byId.values()]
    .map((items) => latestWithMomentum(items))
    .filter(Boolean)
    .sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
}

function latestWithMomentum(items) {
  const sorted = items.slice().sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
  const latest = sorted[0];
  if (!latest) return null;
  const previous = sorted[1];
  const yearAgo = sorted.find((item) => monthDistance(latest.period, item.period) >= 11);
  const changePct = previous?.value ? ((latest.value - previous.value) / previous.value) * 100 : null;
  const yearOverYearChangePct = yearAgo?.value ? ((latest.value - yearAgo.value) / yearAgo.value) * 100 : null;
  return {
    ...latest,
    priorValue: previous?.value ?? null,
    changePct: Number.isFinite(changePct) ? round(changePct, 2) : null,
    yearAgoValue: yearAgo?.value ?? null,
    yearOverYearChangePct: Number.isFinite(yearOverYearChangePct) ? round(yearOverYearChangePct, 2) : null,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'bls-pricing',
    fetchedAt: context.fetchedAt,
    apiKeyConfigured: Boolean(context.apiKeyConfigured),
    momentum: context.momentum || 'unavailable',
    latestPeriod: context.latestPeriod || null,
    scores: context.scores || {},
    averageYearOverYearPct: context.averageYearOverYearPct || {},
    rowCount: context.rowCount || 0,
    seriesCount: context.seriesCount || 0,
    latestSeries: (context.latestSeries || []).slice(0, 12),
    selectedSeries: (context.selectedSeries || []).slice(0, 20),
    sources: sourceList(),
    failures: (context.failures || []).slice(0, 6),
    caveat: context.caveat,
    narrative: context.narrative,
    bmclUse: 'Share as official BLS consumer CPI, selected average-dollar-price, and producer PPI evidence. Compare CPI categories, limited average-price products, PPI final/intermediate demand, footnotes, YoY changes, and API-key/limit context before scoring affordability, pricing power, margin pressure, input-cost pressure, or demand risk. Do not treat BLS price series as unit-sales volume or company-specific revenue.',
  };
}

function sourceList() {
  return [
    { name: 'BLS Consumer Price Index data portal', type: 'bls-cpi-data-portal', url: BLS_CPI_URL },
    { name: 'BLS average price data for selected items', type: 'bls-average-price-data', url: BLS_AVERAGE_PRICE_URL },
    { name: 'BLS Producer Price Index data portal', type: 'bls-ppi-data-portal', url: BLS_PPI_URL },
    { name: 'BLS Public Data API developer documentation', type: 'bls-developer-docs', url: BLS_DEVELOPERS_URL },
    { name: 'BLS Public Data API v2 timeseries endpoint', type: 'bls-public-api-v2', url: BLS_API_URL },
  ];
}

function selectSeries(seriesIds) {
  if (!Array.isArray(seriesIds) || !seriesIds.length) return BLS_PRICING_SERIES;
  const selected = [];
  const byId = new Map(BLS_PRICING_SERIES.map((series) => [series.id, series]));
  for (const id of seriesIds.map((item) => String(item || '').trim()).filter(Boolean)) {
    selected.push(byId.get(id) || {
      id,
      name: id,
      family: inferFamily(id),
      category: 'custom',
      unit: id.startsWith('APU') ? 'dollars' : 'index',
      exposure: 'custom-bls-pricing-series',
    });
  }
  return selected.slice(0, 50);
}

function inferFamily(seriesId) {
  const id = String(seriesId || '').toUpperCase();
  if (id.startsWith('WPU') || id.startsWith('PCU')) return 'ppi';
  if (id.startsWith('APU')) return 'average-price';
  return 'cpi';
}

function defaultStartYear() {
  return new Date().getUTCFullYear() - 2;
}

function monthDistance(a, b) {
  const ad = new Date(`${a}-01T00:00:00Z`);
  const bd = new Date(`${b}-01T00:00:00Z`);
  if (Number.isNaN(ad.getTime()) || Number.isNaN(bd.getTime())) return 0;
  return Math.abs((ad.getUTCFullYear() - bd.getUTCFullYear()) * 12 + ad.getUTCMonth() - bd.getUTCMonth());
}

function parseNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(places));
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  BLS_API_URL,
  BLS_CPI_URL,
  BLS_AVERAGE_PRICE_URL,
  BLS_PPI_URL,
  BLS_DEVELOPERS_URL,
  BLS_PRICING_SERIES,
  collectBlsPricingContext,
  getConfiguredApiKey,
  postBls,
  normalizeBlsResponse,
  evaluateBlsPricingContext,
  compactForBmcl,
  sourceList,
};
