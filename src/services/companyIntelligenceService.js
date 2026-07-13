const companyIntelligenceRepo = require('../db/repositories/companyIntelligenceRepo');
const webScrapeClient = require('./marketData/webScrapeClient');
const locationAwareness = require('./companyLocationAwarenessService');

const DEFENSE_SYMBOLS = new Set(['LMT', 'RTX', 'NOC', 'GD', 'HII', 'BA', 'ITA', 'XAR']);
const ENERGY_SYMBOLS = new Set(['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'XLE', 'VDE']);
const SHIPPING_SENSITIVE = new Set(['AMZN', 'WMT', 'TGT', 'COST', 'FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'XLY']);
const SAAS_GROWTH = new Set(['DOCN', 'NET', 'DDOG', 'MDB', 'SNOW', 'BILL', 'HUBS', 'TEAM', 'CRM', 'SHOP']);
const POPULATION_BENEFIT = new Set(['WMT', 'COST', 'AMZN', 'HD', 'LOW', 'UNH', 'XLV', 'XLU', 'XLY', 'SPY']);

async function researchCompanies({ userId, candidates, macro, consumer, quotes = [], news = { items: [] }, learned = { observations: [] }, onEvent = () => {} }) {
  const uniqueSymbols = [...new Set(candidates.map((candidate) => candidate.symbol))].slice(0, 12);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const candidateBySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
  const population = await collectPopulationContext();
  const oil = await collectOilContext();
  const locationIntel = await locationAwareness.researchCompanyLocations({
    userId,
    candidates: uniqueSymbols.map((symbol) => candidateBySymbol.get(symbol) || { symbol }),
    news,
    learned,
    onEvent,
  });
  const records = [];
  for (const symbol of uniqueSymbols) {
    const quote = quoteBySymbol.get(symbol);
    const history = await webScrapeClient.getHistoricalStats(symbol).catch(() => null);
    const summary = buildCompanySummary({
      symbol,
      companyName: candidateBySymbol.get(symbol)?.companyName,
      quote,
      history,
      macro,
      consumer,
      population,
      oil,
      locationProfile: locationIntel.profilesBySymbol.get(symbol),
    });
    records.push(companyIntelligenceRepo.save({ userId, symbol, companyName: summary.companyName, summary }));
  }
  emit(onEvent, 'company-intel', 62, 'debug', 'Company intelligence workspace summaries updated.', {
    symbols: uniqueSymbols,
    locationProfiles: locationIntel.profilesBySymbol.size,
  });
  return { records, population, oil };
}

function buildCompanySummary({ symbol, companyName, quote, history, macro, consumer, population, oil, locationProfile }) {
  const localEventExposure = locationProfile?.localEventExposure || { score: 50, explanation: 'No location profile available yet.', impacts: [] };
  const factors = {
    warDefense: {
      score: DEFENSE_SYMBOLS.has(symbol) ? 82 : 38,
      stance: DEFENSE_SYMBOLS.has(symbol) ? 'benefits-from-defense-spend' : 'watch-conflict-risk',
      rationale: DEFENSE_SYMBOLS.has(symbol)
        ? 'War is economically destructive for affected regions, but defense suppliers may see order and revenue expansion.'
        : 'Conflict raises global risk and can pressure exposed supply chains unless the company sells into defense demand.',
    },
    oilShipping: {
      score: ENERGY_SYMBOLS.has(symbol) ? 78 : SHIPPING_SENSITIVE.has(symbol) ? 32 : 50,
      stance: ENERGY_SYMBOLS.has(symbol) ? 'benefits-from-energy-pricing' : SHIPPING_SENSITIVE.has(symbol) ? 'margin-risk-from-fuel' : 'neutral-fuel-exposure',
      oilChangePct: oil.changePct,
      rationale: ENERGY_SYMBOLS.has(symbol)
        ? 'Oil and gas availability/prices can lift energy producer cash flow and valuation.'
        : SHIPPING_SENSITIVE.has(symbol)
          ? 'Shipping, freight, and delivery costs are directly exposed to oil and gas prices.'
          : 'Fuel cost exposure appears indirect in the current factor map.',
    },
    requiredEnergyValuation: {
      score: ENERGY_SYMBOLS.has(symbol) ? 76 : 45,
      stance: ENERGY_SYMBOLS.has(symbol) ? 'required-service-premium' : 'not-energy-utility',
      rationale: 'Energy companies often hold resilient valuation support because energy is required infrastructure for most economies.',
    },
    lowCostHighYield: {
      score: SAAS_GROWTH.has(symbol) ? 72 : quote?.current && quote.current < 50 ? 64 : 38,
      stance: SAAS_GROWTH.has(symbol) ? 'saas-growth-profile' : quote?.current && quote.current < 50 ? 'low-share-price-candidate' : 'not-small-low-cost',
      rationale: 'Early capital should favor small, lower-cost positions with asymmetric upside, especially SaaS-like recurring revenue profiles.',
    },
    populationDemand: {
      score: POPULATION_BENEFIT.has(symbol) ? 68 : 48,
      stance: POPULATION_BENEFIT.has(symbol) ? 'benefits-from-population-growth' : 'population-secondary',
      populationGrowthPct: population.usPopulationGrowthPct,
      rationale: 'Growing populations tend to increase addressable demand for consumer, housing, healthcare, utility, and logistics products.',
    },
    deepHistoryTrend: {
      score: history?.fiveYearReturnPct > 25 ? 72 : history?.fiveYearReturnPct < -10 ? 30 : 50,
      stance: history?.fiveYearReturnPct > 25 ? 'long-term-uptrend' : history?.fiveYearReturnPct < -10 ? 'long-term-downtrend' : 'mixed-history',
      fiveYearReturnPct: history?.fiveYearReturnPct ?? null,
      annualizedReturnPct: history?.annualizedReturnPct ?? null,
      maxDrawdownPct: history?.maxDrawdownPct ?? null,
      rationale: 'Company history, trading trend, and market position should temper short-term signals.',
    },
    companyGrowthTrend: buildCompanyGrowthTrendFactor(history),
    companyValueTrend: buildCompanyValueTrendFactor(history),
    fiveYearSplitActivity: buildFiveYearSplitActivityFactor(history),
    localEventExposure: {
      score: localEventExposure.score,
      stance: localEventExposure.score < 42 ? 'material-local-event-overlap' : localEventExposure.score > 56 ? 'limited-local-event-overlap' : 'location-impact-watch',
      locations: locationProfile?.primaryLocations || [],
      impacts: localEventExposure.impacts || [],
      rationale: localEventExposure.explanation,
    },
  };
  const composite = Math.round(Object.values(factors).reduce((sum, factor) => sum + factor.score, 0) / Object.keys(factors).length);
  return {
    symbol,
    companyName: companyName || symbol,
    researchedAt: new Date().toISOString(),
    quote,
    history,
    locationProfile,
    macro: {
      riskBias: macro?.riskBias,
      consumerBias: consumer?.consumerBias,
    },
    population,
    oil,
    factors,
    compositeScore: composite,
    summary: `${symbol} composite intelligence score ${composite}. Key drivers: ${Object.values(factors)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((factor) => factor.stance)
      .join(', ')}.`,
  };
}

function buildCompanyGrowthTrendFactor(history) {
  if (!history) {
    return {
      score: 45,
      stance: 'growth-history-unavailable',
      fiveYearReturnPct: null,
      annualizedReturnPct: null,
      rationale: 'No five-year price history was available, so growth/decline over time is a watch item rather than a score driver.',
    };
  }
  const annualized = Number(history.annualizedReturnPct ?? 0);
  const total = Number(history.fiveYearReturnPct ?? 0);
  const score = annualized >= 15 ? 78 : annualized >= 6 ? 66 : annualized <= -8 ? 24 : annualized < 0 ? 38 : 52;
  return {
    score,
    stance: annualized >= 6 ? 'sustained-growth-over-time' : annualized < 0 ? 'declining-over-time' : 'flat-to-moderate-growth',
    fiveYearReturnPct: total,
    annualizedReturnPct: annualized,
    rationale: 'Company growth/decline over time is measured from five-year price trend and annualized return, then used as a ranking factor.',
  };
}

function buildCompanyValueTrendFactor(history) {
  if (!history) {
    return {
      score: 45,
      stance: 'value-history-unavailable',
      firstClose: null,
      lastClose: null,
      valueChangePct: null,
      rationale: 'No five-year value trend was available, so the company value-over-time factor remains conservative.',
    };
  }
  const first = Number(history.firstClose || 0);
  const last = Number(history.lastClose || 0);
  const valueChangePct = first ? ((last - first) / first) * 100 : 0;
  const drawdown = Number(history.maxDrawdownPct ?? 0);
  const score = valueChangePct >= 60 && drawdown > -55 ? 76
    : valueChangePct >= 20 ? 64
      : valueChangePct <= -25 ? 24
        : valueChangePct < 0 ? 38
          : 52;
  return {
    score,
    stance: valueChangePct >= 20 ? 'value-expanded-over-time' : valueChangePct < 0 ? 'value-eroded-over-time' : 'value-rangebound-over-time',
    firstClose: first || null,
    lastClose: last || null,
    valueChangePct: Number(valueChangePct.toFixed(2)),
    maxDrawdownPct: history.maxDrawdownPct ?? null,
    rationale: 'Company value over time uses the five-year first-to-last close trend with drawdown context as a valuation stability signal.',
  };
}

function buildFiveYearSplitActivityFactor(history) {
  const splitCount = Number(history?.stockSplitsPast5Years || 0);
  return {
    score: splitCount > 0 ? Math.min(74, 58 + splitCount * 4) : 50,
    stance: splitCount > 0 ? 'recent-stock-split-activity' : 'no-recent-stock-splits',
    stockSplitsPast5Years: splitCount,
    splitEvents: history?.splitEvents || [],
    rationale: splitCount > 0
      ? 'Recent stock splits can indicate sustained appreciation, accessibility changes, or corporate actions worth watching in ranking.'
      : 'No stock splits were found in the past five years, so split activity is neutral.',
  };
}

async function collectPopulationContext() {
  const url = 'https://api.worldbank.org/v2/country/US/indicator/SP.POP.GROW?format=json&per_page=3';
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const latest = Array.isArray(data?.[1]) ? data[1].find((row) => row.value !== null) : null;
    return {
      source: url,
      usPopulationGrowthPct: latest ? Number(latest.value.toFixed(2)) : null,
      period: latest?.date || null,
    };
  } catch {
    return { source: url, usPopulationGrowthPct: null, period: null };
  }
}

async function collectOilContext() {
  try {
    const oil = await webScrapeClient.getQuote('CL=F');
    return { symbol: 'CL=F', price: oil.current, changePct: Number((oil.changePct || 0).toFixed(2)) };
  } catch {
    return { symbol: 'CL=F', price: null, changePct: 0 };
  }
}

function factorScoreForSymbol(companyRecord) {
  const summary = companyRecord?.summary;
  if (!summary?.factors) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      historicalWatchNormalized: 0.5,
      historicalWatchFactors: [],
      explanations: [],
    };
  }
  const historicalWatchFactors = extractHistoricalWatchFactors(summary);
  const historicalWatchNormalized = historicalWatchFactors.length
    ? Math.max(0, Math.min(1, historicalWatchFactors.reduce((sum, factor) => sum + factor.score, 0) / historicalWatchFactors.length / 100))
    : 0.5;
  return {
    normalized: Math.max(0, Math.min(1, summary.compositeScore / 100)),
    compositeScore: summary.compositeScore,
    historicalWatchNormalized,
    historicalWatchFactors,
    explanations: Object.values(summary.factors).map((factor) => `${factor.stance}: ${factor.rationale}`),
  };
}

function extractHistoricalWatchFactors(summary) {
  const factors = summary?.factors || {};
  return [
    ['companyGrowthTrend', 'Company growth/decline over time'],
    ['companyValueTrend', 'Company value over time'],
    ['fiveYearSplitActivity', 'Stock splits past 5 years'],
  ]
    .map(([key, label]) => {
      const factor = factors[key];
      if (!factor) return null;
      return { key, label, ...factor };
    })
    .filter(Boolean);
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  researchCompanies,
  factorScoreForSymbol,
  buildCompanySummary,
  extractHistoricalWatchFactors,
};
