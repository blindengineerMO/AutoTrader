const { resilientFetch } = require('../utils/resilientFetch');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const BEA_ITABLE_URL = 'https://apps.bea.gov/iTable/';
const BEA_API_URL = 'https://apps.bea.gov/api/';
const FRED_CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

const FRED_VEHICLE_SERIES = [
  {
    id: 'TOTALSA',
    name: 'Total vehicle sales',
    url: `${FRED_CSV_BASE}?id=TOTALSA`,
    metric: 'totalVehicleSales',
    unit: 'millions of units, seasonally adjusted annual rate',
    exposure: 'aggregate-auto-demand',
  },
  {
    id: 'ALTSALES',
    name: 'Light weight vehicle sales',
    url: `${FRED_CSV_BASE}?id=ALTSALES`,
    metric: 'lightVehicleSales',
    unit: 'millions of units, seasonally adjusted annual rate',
    exposure: 'light-vehicle-demand',
  },
  {
    id: 'DAUTOSAAR',
    name: 'Domestic auto sales',
    url: `${FRED_CSV_BASE}?id=DAUTOSAAR`,
    metric: 'domesticAutoSales',
    unit: 'millions of units, seasonally adjusted annual rate',
    exposure: 'domestic-auto-demand',
  },
];

async function collectVehicleSalesContext({ userId, beaApiKey, timeoutMs = 8000, onEvent = () => {} } = {}) {
  const resolvedBeaKey = beaApiKey || getConfiguredBeaApiKey(userId);
  const settled = await Promise.allSettled(
    FRED_VEHICLE_SERIES.map((series) => fetchFredSeries(series, { timeoutMs }))
  );
  const series = [];
  const failures = [];

  settled.forEach((result, index) => {
    const pack = FRED_VEHICLE_SERIES[index];
    if (result.status === 'fulfilled') {
      series.push(...result.value);
      emit(onEvent, 'vehicle-sales', 35, 'debug', 'Fetched FRED vehicle-sales CSV series.', {
        series: pack.id,
        rows: result.value.length,
      });
    } else {
      failures.push({ pack: pack.id, error: result.reason.message });
      emit(onEvent, 'vehicle-sales', 35, 'warn', 'FRED vehicle-sales CSV series unavailable; continuing with remaining series.', {
        series: pack.id,
        error: result.reason.message,
      });
    }
  });

  if (!resolvedBeaKey) {
    emit(onEvent, 'vehicle-sales', 34, 'warn', 'BEA API key is not configured; using FRED direct CSV vehicle-sales series only.', {
      providerKey: 'bea',
      env: 'BEA_API_KEY',
    });
  }

  return evaluateVehicleSalesContext({
    beaApiConfigured: Boolean(resolvedBeaKey),
    beaDirectApiUsed: false,
    series,
    failures,
  });
}

function getConfiguredBeaApiKey(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'bea') : null;
  return saved?.apiKey || config.beaApiKey || '';
}

async function fetchFredSeries(series, { timeoutMs = 8000 } = {}) {
  const csv = await fetchText(series.url, timeoutMs);
  return parseFredCsv(csv, series);
}

function parseFredCsv(csv, seriesMeta = {}) {
  const lines = String(csv || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const dateIndex = header.findIndex((item) => item.toLowerCase() === 'observation_date');
  const valueIndex = header.findIndex((item) => item.toUpperCase() === seriesMeta.id);
  if (dateIndex === -1 || valueIndex === -1) return [];

  return lines.slice(1)
    .map((line) => {
      const row = splitCsvLine(line);
      const value = parseNumber(row[valueIndex]);
      if (!Number.isFinite(value)) return null;
      return {
        id: seriesMeta.id,
        name: seriesMeta.name,
        metric: seriesMeta.metric,
        exposure: seriesMeta.exposure,
        period: row[dateIndex],
        value,
        unit: seriesMeta.unit,
        frequency: 'monthly',
        source: 'FRED direct CSV',
        sourceOriginal: 'Bureau of Economic Analysis / official aggregate vehicle-sales data',
        url: seriesMeta.url,
      };
    })
    .filter(Boolean);
}

function evaluateVehicleSalesContext({ beaApiConfigured = false, beaDirectApiUsed = false, series = [], failures = [] } = {}) {
  const byMetric = new Map();
  for (const item of series) {
    if (!byMetric.has(item.metric)) byMetric.set(item.metric, []);
    byMetric.get(item.metric).push(item);
  }
  const latestSeries = [...byMetric.values()].map((items) => latestWithMomentum(items)).filter(Boolean);
  const total = latestSeries.find((item) => item.metric === 'totalVehicleSales');
  const light = latestSeries.find((item) => item.metric === 'lightVehicleSales');
  const domestic = latestSeries.find((item) => item.metric === 'domesticAutoSales');
  const averageRecentChangePct = average(latestSeries.map((item) => item.changePct).filter(Number.isFinite));
  const averageYoYChangePct = average(latestSeries.map((item) => item.yearOverYearChangePct).filter(Number.isFinite));
  const domesticShare = total?.value ? clamp01((domestic?.value || 0) / total.value) : 0;
  const lightShare = total?.value ? clamp01((light?.value || 0) / total.value) : 0;
  const demandMomentumScore = clampScore(50 + averageRecentChangePct * 5 + averageYoYChangePct * 3);
  const domesticDemandScore = clampScore(45 + domesticShare * 35 + (domestic?.yearOverYearChangePct || 0) * 2.5);
  const lightVehicleDemandScore = clampScore(45 + lightShare * 25 + (light?.yearOverYearChangePct || 0) * 2.5);
  const opportunityScore = clampScore(50 + (demandMomentumScore - 50) * 0.55 + (lightVehicleDemandScore - 50) * 0.25 + (domesticDemandScore - 50) * 0.2);
  const riskScore = clampScore(50 - averageRecentChangePct * 4 - averageYoYChangePct * 3);
  const momentum = demandMomentumScore >= 60 ? 'vehicle-demand-expanding'
    : demandMomentumScore <= 42 ? 'vehicle-demand-contracting'
      : 'vehicle-demand-neutral';

  return {
    available: latestSeries.length > 0,
    fetchedAt: new Date().toISOString(),
    beaApiConfigured,
    beaDirectApiUsed,
    fredCsvUsed: series.length > 0,
    sourceList: sourceList(),
    failures,
    latestPeriod: latestSeries[0]?.period || null,
    latestSeries,
    seriesCount: series.length,
    averageRecentChangePct: round(averageRecentChangePct, 2),
    averageYoYChangePct: round(averageYoYChangePct, 2),
    demandMomentumScore,
    domesticDemandScore,
    lightVehicleDemandScore,
    opportunityScore,
    riskScore,
    momentum,
    narrative: latestSeries.length
      ? `Vehicle sales ${momentum}: total ${formatSeries(total)}, light vehicles ${formatSeries(light)}, domestic autos ${formatSeries(domestic)}. Opportunity ${opportunityScore}, demand momentum ${demandMomentumScore}.`
      : 'Vehicle-sales context unavailable; use BEA iTable/API or FRED vehicle-sales CSV sources.',
  };
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

function scoreCandidate({ candidate, vehicleSalesContext }) {
  if (!vehicleSalesContext?.available) {
    return { normalized: 0.5, compositeScore: 50, exposure: 0, explanation: 'Vehicle-sales context unavailable.' };
  }
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const theme = String(candidate?.theme || '').toLowerCase();
  const automakers = new Set(['F', 'GM', 'TSLA', 'RIVN', 'LCID', 'TM', 'HMC', 'STLA']);
  const suppliers = new Set(['APTV', 'BWA', 'LEA', 'MGA', 'DAN', 'GT']);
  const dealers = new Set(['AN', 'LAD', 'PAG', 'KMX', 'CVNA']);
  const fleetRental = new Set(['HTZ', 'CAR', 'R', 'URI']);
  const financeInsurance = new Set(['ALLY', 'COF', 'AFL', 'TRV']);
  let exposure = 0.25;
  let direction = 0.2;
  let label = 'limited direct vehicle-sales exposure';

  if (automakers.has(symbol) || /auto|vehicle|ev|electric vehicle|car maker|automaker/.test(theme)) {
    exposure = 0.88;
    direction = 1;
    label = 'directly exposed to aggregate vehicle demand';
  } else if (suppliers.has(symbol) || /auto supplier|parts|tires|transportation equipment|battery/.test(theme)) {
    exposure = 0.76;
    direction = 0.82;
    label = 'exposed to production and supplier volume from vehicle demand';
  } else if (dealers.has(symbol) || /dealer|used car|auto retail/.test(theme)) {
    exposure = 0.72;
    direction = 0.72;
    label = 'exposed to auto retail unit volume and affordability';
  } else if (fleetRental.has(symbol) || /fleet|rental|truck rental/.test(theme)) {
    exposure = 0.58;
    direction = 0.45;
    label = 'partly exposed through fleet refresh and used-vehicle residual values';
  } else if (financeInsurance.has(symbol) || /auto finance|vehicle loan|insurance/.test(theme)) {
    exposure = 0.52;
    direction = vehicleSalesContext.riskScore >= 58 ? -0.35 : 0.35;
    label = 'sensitive to auto-loan and insurance demand plus credit risk';
  }

  const demandDelta = (vehicleSalesContext.opportunityScore - 50) / 50;
  const riskDelta = (vehicleSalesContext.riskScore - 50) / 60;
  const raw = 0.5 + demandDelta * exposure * direction - Math.max(0, riskDelta) * exposure * 0.24;
  const normalized = clamp01(raw);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    explanation: `BEA/FRED vehicle-sales ${vehicleSalesContext.momentum}; ${symbol || 'candidate'} ${label}. Opportunity ${vehicleSalesContext.opportunityScore}, risk ${vehicleSalesContext.riskScore}, YoY demand ${vehicleSalesContext.averageYoYChangePct}%.`,
    latestSeries: vehicleSalesContext.latestSeries?.slice(0, 5) || [],
  };
}

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, timeoutMs, {
    Accept: 'text/csv,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 AutoTrader vehicle sales research bot',
  });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, { signal: controller.signal, headers }, { bucket: 'vehicle-sales', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceList() {
  return [
    { name: 'BEA iTable', type: 'bea-itable', url: BEA_ITABLE_URL },
    { name: 'BEA API', type: 'bea-api', url: BEA_API_URL },
    ...FRED_VEHICLE_SERIES.map((series) => ({
      name: `FRED ${series.id} ${series.name}`,
      type: 'fred-vehicle-sales-csv',
      url: series.url,
      seriesId: series.id,
    })),
  ];
}

function compactForBmcl(context) {
  return {
    available: Boolean(context?.available),
    fetchedAt: context?.fetchedAt,
    beaApiConfigured: Boolean(context?.beaApiConfigured),
    beaDirectApiUsed: Boolean(context?.beaDirectApiUsed),
    fredCsvUsed: Boolean(context?.fredCsvUsed),
    momentum: context?.momentum || 'unavailable',
    latestPeriod: context?.latestPeriod || null,
    scores: {
      opportunity: context?.opportunityScore || 50,
      risk: context?.riskScore || 50,
      demandMomentum: context?.demandMomentumScore || 50,
      domesticDemand: context?.domesticDemandScore || 50,
      lightVehicleDemand: context?.lightVehicleDemandScore || 50,
    },
    averageRecentChangePct: context?.averageRecentChangePct ?? null,
    averageYoYChangePct: context?.averageYoYChangePct ?? null,
    latestSeries: (context?.latestSeries || []).slice(0, 8),
    sources: (context?.sourceList || []).slice(0, 10),
    failures: (context?.failures || []).slice(0, 5),
    narrative: context?.narrative || '',
    bmclUse: 'Use as official BEA/FRED aggregate vehicle-sales evidence. Share compact monthly demand, YoY, and source URLs; do not treat it as manufacturer/model registration data.',
  };
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (const char of String(line || '')) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function monthDistance(a, b) {
  const ad = new Date(`${a}T00:00:00Z`);
  const bd = new Date(`${b}T00:00:00Z`);
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

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(places));
}

function formatSeries(item) {
  if (!item) return 'unavailable';
  const yoy = Number.isFinite(item.yearOverYearChangePct) ? ` (${item.yearOverYearChangePct >= 0 ? '+' : ''}${item.yearOverYearChangePct}% YoY)` : '';
  return `${item.value} ${item.unit || ''}${yoy}`.trim();
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  BEA_ITABLE_URL,
  BEA_API_URL,
  FRED_CSV_BASE,
  FRED_VEHICLE_SERIES,
  collectVehicleSalesContext,
  getConfiguredBeaApiKey,
  fetchFredSeries,
  parseFredCsv,
  evaluateVehicleSalesContext,
  scoreCandidate,
  compactForBmcl,
};
