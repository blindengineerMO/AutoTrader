const { resilientFetch } = require('../utils/resilientFetch');
const DATASET_SOURCES = [
  { id: 'currency-usd', category: 'currency', name: 'Exchange Rate API USD', url: 'https://api.exchangerate-api.com/v4/latest/USD' },
  { id: 'currency-gbp', category: 'currency', name: 'Exchange Rate API GBP', url: 'https://api.exchangerate-api.com/v4/latest/GBP' },
  {
    id: 'climate-temperature',
    category: 'climate',
    name: 'NOAA US annual average temperature anomaly',
    url: 'https://www.ncdc.noaa.gov/cag/time-series/us/110/00/tavg/ytd/12/1895-2016.json?base_prd=true&begbaseyear=1901&endbaseyear=2000',
  },
  {
    id: 'climate-precipitation',
    category: 'climate',
    name: 'NOAA contiguous US annual precipitation',
    url: 'https://www.ncdc.noaa.gov/cag/time-series/us/110/00/pcp/ytd/12/1895-2016.json?base_prd=true&begbaseyear=1901&endbaseyear=2000',
  },
  { id: 'food-recalls', category: 'food', name: 'FDA food product recalls', url: 'https://api.fda.gov/food/enforcement.json?limit=25' },
  {
    id: 'food-product-profile',
    category: 'food',
    name: 'Open Food Facts product profile',
    url: 'https://world.openfoodfacts.org/api/v0/product/5060292302201.json',
  },
  {
    id: 'natural-disasters-earthquakes',
    category: 'naturalDisasters',
    name: 'USGS earthquakes all hour',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  },
  {
    id: 'population-usa',
    category: 'population',
    name: 'World Bank USA population',
    url: 'https://api.worldbank.org/countries/USA/indicators/SP.POP.TOTL?per_page=5000&format=json',
  },
  {
    id: 'population-china',
    category: 'population',
    name: 'World Bank China population',
    url: 'https://api.worldbank.org/countries/CHN/indicators/SP.POP.TOTL?per_page=5000&format=json',
  },
  {
    id: 'population-india',
    category: 'population',
    name: 'World Bank India population',
    url: 'https://api.worldbank.org/countries/IND/indicators/SP.POP.TOTL?per_page=5000&format=json',
  },
  {
    id: 'gdp-usa',
    category: 'gdp',
    name: 'World Bank USA GDP',
    url: 'https://api.worldbank.org/countries/USA/indicators/NY.GDP.MKTP.CD?per_page=5000&format=json',
  },
  {
    id: 'gdp-china',
    category: 'gdp',
    name: 'World Bank China GDP',
    url: 'https://api.worldbank.org/countries/CHN/indicators/NY.GDP.MKTP.CD?per_page=5000&format=json',
  },
  {
    id: 'gdp-india',
    category: 'gdp',
    name: 'World Bank India GDP',
    url: 'https://api.worldbank.org/countries/IND/indicators/NY.GDP.MKTP.CD?per_page=5000&format=json',
  },
  {
    id: 'travel-airline-delays',
    category: 'travel',
    name: 'Monthly airline delays by airport',
    url: 'https://think.cs.vt.edu/corgis/datasets/json/airlines/airlines.json',
  },
  { id: 'travel-jfk', category: 'travel', name: 'FAA JFK airport status', url: 'https://services.faa.gov/airport/status/JFK?format=application/json' },
  { id: 'travel-atl', category: 'travel', name: 'FAA ATL airport status', url: 'https://services.faa.gov/airport/status/ATL?format=application/json' },
  { id: 'travel-lax', category: 'travel', name: 'FAA LAX airport status', url: 'https://services.faa.gov/airport/status/LAX?format=application/json' },
  { id: 'travel-ord', category: 'travel', name: 'FAA ORD airport status', url: 'https://services.faa.gov/airport/status/ORD?format=application/json' },
];

async function collectJsonDatasetIndicators({ onEvent = () => {}, timeoutMs = 6500 } = {}) {
  emit(onEvent, 'json-datasets', 26, 'debug', 'Importing public JSON datasets for currency, climate, food, disaster, population, GDP, and travel rules.', {
    sources: DATASET_SOURCES.length,
  });

  const settled = await Promise.allSettled(DATASET_SOURCES.map((source) => fetchDataset(source, timeoutMs)));
  const datasets = settled.map((result, index) => {
    const source = DATASET_SOURCES[index];
    if (result.status === 'fulfilled') return { source, ok: true, data: result.value };
    emit(onEvent, 'json-datasets', 27, 'warn', 'JSON dataset unavailable; continuing with partial indicator context.', {
      source: source.name,
      url: source.url,
      error: result.reason.message,
    });
    return { source, ok: false, error: result.reason.message };
  });

  const context = evaluateDatasets(datasets);
  emit(onEvent, 'json-datasets', 32, 'debug', 'Public JSON dataset evaluation complete.', {
    available: datasets.filter((item) => item.ok).length,
    categories: Object.keys(context.categories),
    compositeRiskScore: context.compositeRiskScore,
  });
  return context;
}

function evaluateDatasets(datasets) {
  const byId = Object.fromEntries(datasets.map((item) => [item.source.id, item]));
  const categories = {
    currency: evaluateCurrency(byId),
    climate: evaluateClimate(byId),
    food: evaluateFood(byId),
    naturalDisasters: evaluateNaturalDisasters(byId),
    population: evaluatePopulation(byId),
    gdp: evaluateGdp(byId),
    travel: evaluateTravel(byId),
  };
  const compositeRiskScore = Math.round(
    average([
      categories.currency.riskScore,
      categories.climate.riskScore,
      categories.food.riskScore,
      categories.naturalDisasters.riskScore,
      categories.population.riskScore,
      categories.gdp.riskScore,
      categories.travel.riskScore,
    ])
  );
  const opportunityScore = Math.round(
    average([
      categories.population.opportunityScore,
      categories.gdp.opportunityScore,
      categories.currency.opportunityScore,
      categories.food.opportunityScore,
      categories.travel.opportunityScore,
      100 - categories.climate.riskScore,
      100 - categories.naturalDisasters.riskScore,
    ])
  );
  return {
    fetchedAt: new Date().toISOString(),
    sourceList: DATASET_SOURCES.map((source) => ({
      name: source.name,
      type: `json-dataset:${source.category}`,
      url: source.url,
    })),
    datasets: datasets.map((item) => ({
      id: item.source.id,
      category: item.source.category,
      name: item.source.name,
      url: item.source.url,
      ok: item.ok,
      error: item.error || null,
    })),
    categories,
    compositeRiskScore,
    opportunityScore,
    narrative: buildNarrative(categories, compositeRiskScore, opportunityScore),
  };
}

function scoreCandidate({ candidate, companyRecord, datasetContext }) {
  if (!datasetContext?.categories) return { normalized: 0.5, compositeScore: 50, explanations: [] };
  const symbol = candidate.symbol;
  const theme = candidate.theme || '';
  const factors = companyRecord?.summary?.factors || {};
  const category = datasetContext.categories;
  const exposures = {
    currency: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META'].includes(symbol) || theme.includes('mega-cap') ? 0.75 : 0.45,
    climate: ['XLE', 'XOM', 'CVX', 'COST', 'WMT', 'TGT', 'FDX', 'UPS'].includes(symbol) || theme.includes('energy') || theme.includes('consumer') ? 0.7 : 0.42,
    food: ['WMT', 'COST', 'TGT', 'AMZN', 'XLY'].includes(symbol) || theme.includes('consumer') ? 0.74 : 0.35,
    naturalDisasters: ['XLU', 'XLE', 'FDX', 'UPS', 'DAL', 'UAL', 'AAL'].includes(symbol) || theme.includes('energy') ? 0.7 : 0.36,
    population: factors.populationDemand?.score ? factors.populationDemand.score / 100 : ['SPY', 'WMT', 'COST', 'AMZN', 'HD', 'LOW', 'UNH'].includes(symbol) ? 0.7 : 0.45,
    gdp: ['SPY', 'QQQ', 'DIA', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMD', 'GOOGL', 'AMZN'].includes(symbol) ? 0.78 : 0.48,
    travel: ['DAL', 'UAL', 'AAL', 'JETS', 'BA', 'FDX', 'UPS'].includes(symbol) || theme.includes('industrial') ? 0.76 : 0.38,
  };

  const categoryImpacts = Object.entries(exposures).map(([key, exposure]) => {
    const item = category[key];
    const riskDrag = (item.riskScore / 100) * exposure * 0.5;
    const opportunityLift = (item.opportunityScore / 100) * exposure * 0.55;
    const score = clamp01(0.5 - riskDrag + opportunityLift);
    return {
      category: key,
      score: Math.round(score * 100),
      exposure: Math.round(exposure * 100),
      riskScore: item.riskScore,
      opportunityScore: item.opportunityScore,
      rationale: item.rationale,
    };
  });

  const normalized = average(categoryImpacts.map((item) => item.score / 100));
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    categoryImpacts: categoryImpacts.sort((a, b) => Math.abs(50 - b.score) - Math.abs(50 - a.score)).slice(0, 5),
    explanations: categoryImpacts
      .sort((a, b) => Math.abs(50 - b.score) - Math.abs(50 - a.score))
      .slice(0, 4)
      .map((item) => `${item.category} dataset impact ${item.score}: ${item.rationale}`),
  };
}

function evaluateCurrency(byId) {
  const usd = byId['currency-usd']?.data?.rates || {};
  const gbp = byId['currency-gbp']?.data?.rates || {};
  const majors = ['EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CAD', 'MXN'];
  const present = majors.filter((code) => Number(usd[code]) > 0);
  const dispersion = standardDeviation(present.map((code) => Math.log(Number(usd[code]))));
  const riskScore = present.length ? clampScore(28 + dispersion * 28) : 50;
  const opportunityScore = present.length ? clampScore(62 - riskScore * 0.25 + (Number(gbp.USD) > 1 ? 4 : 0)) : 45;
  return {
    riskScore,
    opportunityScore,
    indicators: { base: 'USD', majorRatesAvailable: present, gbpUsd: gbp.USD || null, dispersion: Number(dispersion.toFixed(3)) },
    rationale: present.length
      ? 'Currency data gauges global purchasing power, import costs, export translation risk, and multinational earnings pressure.'
      : 'Currency endpoint was unavailable, so FX risk defaults to neutral.',
  };
}

function evaluateClimate(byId) {
  const temp = latestNoaaValue(byId['climate-temperature']?.data);
  const precip = latestNoaaValue(byId['climate-precipitation']?.data);
  const heatRisk = temp?.anomaly !== null && temp?.anomaly !== undefined ? Math.min(35, Math.abs(temp.anomaly) * 8) : 15;
  const precipRisk = precip?.anomaly !== null && precip?.anomaly !== undefined ? Math.min(35, Math.abs(precip.anomaly) * 5) : 15;
  const riskScore = clampScore(25 + heatRisk + precipRisk);
  return {
    riskScore,
    opportunityScore: clampScore(70 - riskScore * 0.35),
    indicators: { temperature: temp, precipitation: precip },
    rationale: 'Climate anomaly data influences agricultural yield risk, insurance losses, energy demand, logistics reliability, and commodity pricing.',
  };
}

function evaluateFood(byId) {
  const recalls = byId['food-recalls']?.data?.results || [];
  const product = byId['food-product-profile']?.data?.product || null;
  const serious = recalls.filter((item) => /class i|class ii/i.test(item.classification || '')).length;
  const riskScore = clampScore(22 + recalls.length * 1.5 + serious * 4);
  return {
    riskScore,
    opportunityScore: clampScore(58 - riskScore * 0.2 + (product ? 3 : 0)),
    indicators: {
      recallCount: recalls.length,
      seriousRecallCount: serious,
      sampleProductCategories: product?.categories_tags?.slice?.(0, 5) || [],
    },
    rationale: 'Food recall and product data highlight consumer staples risk, supply-chain quality pressure, and brand/reputation vulnerability.',
  };
}

function evaluateNaturalDisasters(byId) {
  const features = byId['natural-disasters-earthquakes']?.data?.features || [];
  const significant = features.filter((feature) => Number(feature.properties?.mag || 0) >= 4.5).length;
  const riskScore = clampScore(18 + features.length * 1.2 + significant * 8);
  return {
    riskScore,
    opportunityScore: clampScore(55 - riskScore * 0.18),
    indicators: { earthquakeCountLastHour: features.length, significantEarthquakes: significant },
    rationale: 'Natural-disaster feeds influence travel interruption, utility outages, insurance exposure, commodity logistics, and regional consumer demand.',
  };
}

function evaluatePopulation(byId) {
  const countries = ['usa', 'china', 'india'].map((country) => worldBankTrend(byId[`population-${country}`]?.data, 'population'));
  const avgGrowth = average(countries.map((item) => item.changePct).filter(Number.isFinite));
  return {
    riskScore: clampScore(42 - avgGrowth * 8),
    opportunityScore: clampScore(50 + avgGrowth * 10),
    indicators: { countries },
    rationale: 'Population trend data estimates long-run demand expansion for consumer, healthcare, housing, infrastructure, and broad-market exposure.',
  };
}

function evaluateGdp(byId) {
  const countries = ['usa', 'china', 'india'].map((country) => worldBankTrend(byId[`gdp-${country}`]?.data, 'gdp'));
  const avgGrowth = average(countries.map((item) => item.changePct).filter(Number.isFinite));
  return {
    riskScore: clampScore(48 - avgGrowth * 4),
    opportunityScore: clampScore(48 + avgGrowth * 7),
    indicators: { countries },
    rationale: 'GDP trend data informs macro demand, earnings-cycle strength, capital spending, and broad equity risk appetite.',
  };
}

function evaluateTravel(byId) {
  const airlineRows = byId['travel-airline-delays']?.data || [];
  const airports = ['jfk', 'atl', 'lax', 'ord'].map((code) => byId[`travel-${code}`]?.data).filter(Boolean);
  const delayedAirports = airports.filter((airport) => airport.delay === true || airport.delay === 'true').length;
  const rows = Array.isArray(airlineRows) ? airlineRows.slice(-500) : [];
  const avgDelay = average(rows.map((row) => Number(row?.Statistics?.Flights?.Delayed || row?.Statistics?.['Flights']?.['Delayed'] || 0)).filter(Number.isFinite));
  const riskScore = clampScore(24 + delayedAirports * 12 + Math.min(28, avgDelay / 150));
  return {
    riskScore,
    opportunityScore: clampScore(62 - delayedAirports * 8 - Math.min(18, avgDelay / 280)),
    indicators: {
      faaAirportsChecked: airports.map((airport) => ({ airport: airport.IATA, delay: airport.delay, status: airport.status?.reason || airport.status?.type || null })),
      historicalDelayRows: rows.length,
      avgHistoricalDelayedFlights: Math.round(avgDelay || 0),
    },
    rationale: 'Travel delay and airport status data affect airlines, logistics, fuel demand, hospitality, business travel, and time-sensitive freight.',
  };
}

async function fetchDataset(source, timeoutMs) {
  const res = await fetchWithTimeout(source.url, timeoutMs);
  if (!res.ok) throw new Error(`${source.url} failed with ${res.status}`);
  return res.json();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await resilientFetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,application/geo+json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 AutoTrader JSON dataset evaluator',
      },
    }, { bucket: 'json-dataset', timeoutMs: 0 });
  } finally {
    clearTimeout(timeout);
  }
}

function latestNoaaValue(data) {
  const rows = data?.data || {};
  const latestKey = Object.keys(rows).sort().at(-1);
  if (!latestKey) return null;
  const row = rows[latestKey];
  const value = Number(row.value ?? row);
  const anomaly = Number(row.anomaly ?? row.departure ?? 0);
  return { period: latestKey, value: Number(value.toFixed(2)), anomaly: Number(anomaly.toFixed(2)) };
}

function worldBankTrend(data, metric) {
  const rows = Array.isArray(data?.[1]) ? data[1].filter((row) => row.value !== null) : [];
  const sorted = rows.sort((a, b) => Number(b.date) - Number(a.date));
  const latest = sorted[0];
  const prior = sorted.find((row) => Number(latest?.date) - Number(row.date) >= 5) || sorted[5];
  const latestValue = Number(latest?.value || 0);
  const priorValue = Number(prior?.value || 0);
  const changePct = latestValue && priorValue ? ((latestValue - priorValue) / priorValue) * 100 : 0;
  return {
    metric,
    country: latest?.country?.value || null,
    latestYear: latest?.date || null,
    latestValue,
    comparisonYear: prior?.date || null,
    changePct: Number(changePct.toFixed(2)),
  };
}

function buildNarrative(categories, compositeRiskScore, opportunityScore) {
  const riskLeaders = Object.entries(categories)
    .sort((a, b) => b[1].riskScore - a[1].riskScore)
    .slice(0, 3)
    .map(([key, value]) => `${key} risk ${value.riskScore}`)
    .join(', ');
  return `JSON dataset evaluator found composite risk ${compositeRiskScore} and opportunity ${opportunityScore}; highest pressure areas: ${riskLeaders}.`;
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const avg = average(values);
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)));
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
  DATASET_SOURCES,
  collectJsonDatasetIndicators,
  evaluateDatasets,
  scoreCandidate,
};
