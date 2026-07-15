const { resilientFetch } = require('../utils/resilientFetch');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const API_BASE = 'https://api.eia.gov/v2';
const OPEN_DATA_URL = 'https://www.eia.gov/opendata/';
const GAS_DIESEL_URL = 'https://www.eia.gov/petroleum/gasdiesel/';

const API_SERIES_PACKS = [
  {
    id: 'weekly-regular-gasoline-price-us',
    name: 'U.S. weekly regular gasoline retail price',
    route: '/petroleum/pri/gnd/data/',
    frequency: 'weekly',
    data: ['value'],
    facets: {
      duoarea: ['NUS'],
      product: ['EPM0_PTE_NUS_DPG'],
    },
    metric: 'gasolinePrice',
    unit: 'dollars per gallon',
    exposure: 'consumer-fuel-pressure',
  },
  {
    id: 'weekly-on-highway-diesel-price-us',
    name: 'U.S. weekly on-highway diesel retail price',
    route: '/petroleum/pri/gnd/data/',
    frequency: 'weekly',
    data: ['value'],
    facets: {
      duoarea: ['NUS'],
      product: ['EPD2D_PTE_NUS_DPG'],
    },
    metric: 'dieselPrice',
    unit: 'dollars per gallon',
    exposure: 'shipping-logistics-cost-pressure',
  },
  {
    id: 'weekly-motor-gasoline-product-supplied-us',
    name: 'U.S. weekly motor gasoline product supplied',
    route: '/petroleum/sum/sndw/data/',
    frequency: 'weekly',
    data: ['value'],
    facets: {
      process: ['PSUP'],
      product: ['EPM0'],
      duoarea: ['NUS'],
    },
    metric: 'petroleumProductSupplied',
    unit: 'thousand barrels per day',
    exposure: 'fuel-demand-volume',
  },
  {
    id: 'monthly-electricity-retail-sales-price-us',
    name: 'U.S. monthly electricity retail sales and price',
    route: '/electricity/retail-sales/data/',
    frequency: 'monthly',
    data: ['price', 'sales'],
    facets: {
      stateid: ['US'],
      sectorid: ['ALL'],
    },
    metric: 'electricityRetail',
    unit: 'cents per kilowatthour and megawatthours',
    exposure: 'utility-demand-price',
  },
  {
    id: 'monthly-natural-gas-price-us',
    name: 'U.S. monthly natural gas price summary',
    route: '/natural-gas/pri/sum/data/',
    frequency: 'monthly',
    data: ['value'],
    facets: {
      duoarea: ['NUS'],
    },
    metric: 'naturalGasPrice',
    unit: 'dollars per thousand cubic feet',
    exposure: 'natural-gas-cost-pressure',
  },
];

async function collectEnergyFuelContext({ userId, apiKey, timeoutMs = 8000, onEvent = () => {} } = {}) {
  const resolvedApiKey = apiKey || getConfiguredApiKey(userId);
  const publicFuel = await collectPublicGasDieselFallback({ timeoutMs, onEvent });
  const apiSeries = [];
  const failures = [];
  const apiSources = [];

  if (!resolvedApiKey) {
    emit(onEvent, 'eia-energy', 33, 'warn', 'EIA API key is not configured; using public EIA fuel-price pages/downloads only.', {
      providerKey: 'eia',
      env: 'EIA_API_KEY',
    });
    return evaluateEnergyContext({
      apiConfigured: false,
      series: publicFuel.series,
      sourceList: sourceList(),
      failures: publicFuel.failures,
      fallbackUsed: true,
    });
  }

  const settled = await Promise.allSettled(
    API_SERIES_PACKS.map((pack) => fetchApiPack(pack, { apiKey: resolvedApiKey, timeoutMs }))
  );
  settled.forEach((result, index) => {
    const pack = API_SERIES_PACKS[index];
    if (result.status === 'fulfilled') {
      apiSeries.push(...result.value.series);
      apiSources.push(result.value.source);
      emit(onEvent, 'eia-energy', 34, 'debug', 'Fetched EIA API v2 energy/fuel series.', {
        pack: pack.id,
        rows: result.value.series.length,
      });
    } else {
      failures.push({ pack: pack.id, error: result.reason.message });
      emit(onEvent, 'eia-energy', 34, 'warn', 'EIA API v2 series unavailable; continuing with remaining energy packs.', {
        pack: pack.id,
        error: result.reason.message,
      });
    }
  });

  return evaluateEnergyContext({
    apiConfigured: true,
    series: [...apiSeries, ...publicFuel.series],
    sourceList: sourceList(...apiSources),
    failures: [...failures, ...publicFuel.failures],
    fallbackUsed: publicFuel.series.length > 0,
  });
}

function getConfiguredApiKey(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'eia') : null;
  return saved?.apiKey || config.eiaApiKey || '';
}

async function fetchApiPack(pack, { apiKey, timeoutMs = 8000 } = {}) {
  const url = buildEiaQueryUrl(pack, { apiKey });
  const data = await fetchJson(url, timeoutMs);
  const rows = Array.isArray(data?.response?.data) ? data.response.data : [];
  return {
    source: {
      name: pack.name,
      type: 'eia-api-v2-query',
      url: stripKey(url),
      route: pack.route,
      frequency: pack.frequency,
      metric: pack.metric,
    },
    series: normalizeApiRows(rows, pack, stripKey(url)),
  };
}

function buildEiaQueryUrl(pack, { apiKey, offset = 0, length = 12 } = {}) {
  const url = new URL(`${API_BASE}${pack.route}`);
  url.searchParams.set('frequency', pack.frequency);
  for (const field of pack.data || ['value']) url.searchParams.append('data[0]', field);
  let dataIndex = 0;
  url.searchParams.delete('data[0]');
  for (const field of pack.data || ['value']) {
    url.searchParams.append(`data[${dataIndex}]`, field);
    dataIndex += 1;
  }
  for (const [facet, values] of Object.entries(pack.facets || {})) {
    for (const value of values) url.searchParams.append(`facets[${facet}][]`, value);
  }
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('length', String(length));
  if (apiKey) url.searchParams.set('api_key', apiKey);
  return url.toString().replace(/\+/g, '%20');
}

function normalizeApiRows(rows, pack, queryUrl) {
  return rows
    .map((row) => {
      const value = parseNumber(row.value ?? row.price ?? row.sales);
      if (!Number.isFinite(value)) return null;
      return {
        id: pack.id,
        name: pack.name,
        metric: pack.metric,
        exposure: pack.exposure,
        period: row.period || row.date || null,
        value,
        unit: row['value-units'] || row.units || row.unit || pack.unit,
        region: row.duoarea || row.duoareaName || row.stateid || row.stateDescription || 'US',
        product: row.product || row.productName || row.sectorid || row.sectorName || null,
        frequency: pack.frequency,
        source: 'EIA API v2',
        url: queryUrl,
      };
    })
    .filter(Boolean);
}

async function collectPublicGasDieselFallback({ timeoutMs = 8000, onEvent = () => {} } = {}) {
  try {
    const html = await fetchText(GAS_DIESEL_URL, timeoutMs);
    const series = parseGasDieselPage(html);
    emit(onEvent, 'eia-energy', 33, 'debug', 'Parsed public EIA Gasoline and Diesel Fuel Update fallback.', {
      series: series.length,
    });
    return { series, failures: [] };
  } catch (error) {
    emit(onEvent, 'eia-energy', 33, 'warn', 'Public EIA Gasoline and Diesel Fuel Update unavailable.', {
      error: error.message,
    });
    return { series: [], failures: [{ pack: 'gasoline-diesel-fuel-update', error: error.message }] };
  }
}

function parseGasDieselPage(html) {
  const text = cleanText(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const releaseDate = firstMatch(text, /Gasoline Release Date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)
    || firstMatch(text, /Release Date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  const gasolineBlock = sliceBetween(text, 'U.S. Regular Gasoline Prices', 'U.S. On-Highway Diesel Fuel Prices');
  const dieselBlock = sliceBetween(text, 'U.S. On-Highway Diesel Fuel Prices', 'Residential Propane');
  return [
    parseFuelRow(gasolineBlock, {
      id: 'public-weekly-regular-gasoline-price-us',
      name: 'U.S. public weekly regular gasoline retail price',
      metric: 'gasolinePrice',
      exposure: 'consumer-fuel-pressure',
      releaseDate,
    }),
    parseFuelRow(dieselBlock, {
      id: 'public-weekly-on-highway-diesel-price-us',
      name: 'U.S. public weekly on-highway diesel retail price',
      metric: 'dieselPrice',
      exposure: 'shipping-logistics-cost-pressure',
      releaseDate,
    }),
  ].filter(Boolean);
}

function parseFuelRow(block, meta) {
  const row = String(block || '').match(/\bU\.S\.\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(?:NA|-?\d+(?:\.\d+)?)\s+(?:NA|-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i);
  if (!row) return null;
  return {
    id: meta.id,
    name: meta.name,
    metric: meta.metric,
    exposure: meta.exposure,
    period: meta.releaseDate,
    value: Number(row[3]),
    priorValue: Number(row[2]),
    weekAgoValue: Number(row[2]),
    weekOverWeekChange: Number(row[4]),
    unit: 'dollars per gallon',
    region: 'US',
    product: meta.metric === 'dieselPrice' ? 'on-highway diesel fuel' : 'regular gasoline',
    frequency: 'weekly',
    source: 'EIA Gasoline and Diesel Fuel Update',
    url: GAS_DIESEL_URL,
  };
}

function evaluateEnergyContext({ apiConfigured, series = [], sourceList: sources = sourceList(), failures = [], fallbackUsed = false } = {}) {
  const byMetric = new Map();
  for (const item of series) {
    if (!byMetric.has(item.metric)) byMetric.set(item.metric, []);
    byMetric.get(item.metric).push(item);
  }
  const latestSeries = [...byMetric.values()].map((items) => latestForMetric(items)).filter(Boolean);
  const gasoline = latestSeries.find((item) => item.metric === 'gasolinePrice');
  const diesel = latestSeries.find((item) => item.metric === 'dieselPrice');
  const productSupplied = latestSeries.find((item) => item.metric === 'petroleumProductSupplied');
  const electricity = latestSeries.find((item) => item.metric === 'electricityRetail');
  const naturalGas = latestSeries.find((item) => item.metric === 'naturalGasPrice');
  const fuelChange = average([gasoline?.weekOverWeekChange, diesel?.weekOverWeekChange].filter(Number.isFinite));
  const priceLevelPressure = average([
    gasoline?.value ? (gasoline.value - 3.25) * 16 : null,
    diesel?.value ? (diesel.value - 4.0) * 14 : null,
  ].filter(Number.isFinite));
  const energyPricePressureScore = clampScore(50 + priceLevelPressure + fuelChange * 35);
  const shippingCostPressureScore = clampScore(50 + (diesel?.value ? (diesel.value - 4.0) * 18 : 0) + (diesel?.weekOverWeekChange || 0) * 45);
  const consumerFuelPressureScore = clampScore(50 + (gasoline?.value ? (gasoline.value - 3.25) * 18 : 0) + (gasoline?.weekOverWeekChange || 0) * 35);
  const energyDemandScore = clampScore(50 + (productSupplied?.value ? 3 : 0) + (electricity?.value ? 2 : 0) + (naturalGas?.value ? 2 : 0));
  const opportunityScore = clampScore(50 + (energyPricePressureScore - 50) * 0.55 + (energyDemandScore - 50) * 0.35);
  const riskScore = clampScore(50 + (shippingCostPressureScore - 50) * 0.65 + (consumerFuelPressureScore - 50) * 0.35);
  const momentum = energyPricePressureScore >= 62 ? 'energy-cost-pressure-rising'
    : energyPricePressureScore <= 42 ? 'energy-cost-pressure-easing'
      : 'energy-cost-pressure-neutral';

  return {
    available: latestSeries.length > 0,
    fetchedAt: new Date().toISOString(),
    apiConfigured,
    fallbackUsed,
    sourceList: sources,
    failures,
    latestPeriod: latestSeries[0]?.period || null,
    latestSeries,
    seriesCount: series.length,
    energyPricePressureScore,
    shippingCostPressureScore,
    consumerFuelPressureScore,
    energyDemandScore,
    opportunityScore,
    riskScore,
    momentum,
    narrative: latestSeries.length
      ? `EIA ${momentum}: gasoline ${formatFuel(gasoline)}, diesel ${formatFuel(diesel)}, shipping pressure ${shippingCostPressureScore}, consumer fuel pressure ${consumerFuelPressureScore}.`
      : 'EIA energy/fuel context unavailable; use public EIA pages or configure an EIA API key.',
  };
}

function latestForMetric(items) {
  return items.slice().sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')))[0];
}

function scoreCandidate({ candidate, energyContext }) {
  if (!energyContext?.available) return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'EIA energy/fuel context unavailable.' };
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const energyBenefit = new Set(['XOM', 'CVX', 'COP', 'OXY', 'XLE', 'VLO', 'MPC']);
  const utilityBenefit = new Set(['XLU', 'NEE', 'DUK', 'SO', 'AEP']);
  const fuelSensitive = new Set(['FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'LUV', 'JBLU', 'AMZN', 'WMT', 'TGT', 'COST']);
  const evSensitive = new Set(['TSLA', 'RIVN', 'LCID']);
  let exposure = 0.35;
  let direction = 0;
  let label = 'limited direct fuel exposure';
  if (energyBenefit.has(symbol) || /energy|oil|gas|refiner|petroleum/.test(theme)) {
    exposure = 0.86;
    direction = 1;
    label = 'benefits from higher fuel/energy price pressure';
  } else if (utilityBenefit.has(symbol) || /utility|electricity|power/.test(theme)) {
    exposure = 0.66;
    direction = energyContext.energyDemandScore >= 52 ? 0.45 : -0.15;
    label = 'sensitive to electricity/natural-gas demand and pricing';
  } else if (fuelSensitive.has(symbol) || /shipping|logistics|airline|retail|restaurant|consumer/.test(theme)) {
    exposure = 0.78;
    direction = -1;
    label = 'hurt by higher shipping and consumer fuel costs';
  } else if (evSensitive.has(symbol) || /ev|electric vehicle/.test(theme)) {
    exposure = 0.54;
    direction = energyContext.consumerFuelPressureScore >= 55 ? 0.35 : -0.15;
    label = 'partly supported when fuel costs push EV substitution narratives';
  }
  const pressureDelta = (energyContext.opportunityScore - 50) / 50;
  const riskDelta = (energyContext.riskScore - 50) / 60;
  const raw = 0.5 + pressureDelta * exposure * direction - Math.max(0, riskDelta) * exposure * (direction < 0 ? 0.55 : 0.12);
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `EIA ${energyContext.momentum}; ${symbol || 'candidate'} ${label}. Opportunity ${energyContext.opportunityScore}, risk ${energyContext.riskScore}, shipping pressure ${energyContext.shippingCostPressureScore}.`,
    latestSeries: energyContext.latestSeries?.slice(0, 5) || [],
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, { Accept: 'application/json,text/plain,*/*' });
  if (!res.ok) throw new Error(`${stripKey(url)} failed with ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await res.text();
    throw new Error(`${stripKey(url)} returned non-JSON response: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  return res.json();
}

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader EIA energy research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'eia', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList(...querySources) {
  return [
    { name: 'EIA Open Data', type: 'eia-open-data', url: OPEN_DATA_URL },
    { name: 'EIA API v2', type: 'eia-api-v2', url: API_BASE },
    { name: 'EIA Gasoline and Diesel Fuel Update', type: 'eia-public-fuel-prices', url: GAS_DIESEL_URL },
    ...querySources,
  ];
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    apiConfigured: Boolean(context?.apiConfigured),
    fallbackUsed: Boolean(context?.fallbackUsed),
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    scores: {
      opportunity: context?.opportunityScore || 50,
      risk: context?.riskScore || 50,
      energyPricePressure: context?.energyPricePressureScore || 50,
      shippingCostPressure: context?.shippingCostPressureScore || 50,
      consumerFuelPressure: context?.consumerFuelPressureScore || 50,
      energyDemand: context?.energyDemandScore || 50,
    },
    latestSeries: (context?.latestSeries || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official EIA fuel and energy price/volume context. Share compact observations and source URLs; do not send full archives through BMCL.',
  };
}

function stripKey(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('api_key');
    parsed.searchParams.delete('key');
    return parsed.toString().replace(/\+/g, '%20');
  } catch {
    return String(url || '').replace(/([?&](?:api_key|key)=)[^&]+/i, '$1[redacted]');
  }
}

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  if (start === -1) return '';
  const end = endNeedle ? text.indexOf(endNeedle, start + startNeedle.length) : -1;
  return text.slice(start, end === -1 ? undefined : end);
}

function firstMatch(text, pattern) {
  return String(text || '').match(pattern)?.[1] || null;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function formatFuel(item) {
  if (!item) return 'unavailable';
  const change = Number.isFinite(item.weekOverWeekChange) ? ` (${item.weekOverWeekChange >= 0 ? '+' : ''}${item.weekOverWeekChange} w/w)` : '';
  return `$${Number(item.value).toFixed(3)}/gal${change}`;
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  API_BASE,
  OPEN_DATA_URL,
  GAS_DIESEL_URL,
  API_SERIES_PACKS,
  collectEnergyFuelContext,
  getConfiguredApiKey,
  buildEiaQueryUrl,
  normalizeApiRows,
  parseGasDieselPage,
  evaluateEnergyContext,
  scoreCandidate,
  compactForBmcl,
  stripKey,
};
