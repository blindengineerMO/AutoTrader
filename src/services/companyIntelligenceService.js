const companyIntelligenceRepo = require('../db/repositories/companyIntelligenceRepo');
const webScrapeClient = require('./marketData/webScrapeClient');

const DEFENSE_SYMBOLS = new Set(['LMT', 'RTX', 'NOC', 'GD', 'HII', 'BA', 'ITA', 'XAR']);
const ENERGY_SYMBOLS = new Set(['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'XLE', 'VDE']);
const SHIPPING_SENSITIVE = new Set(['AMZN', 'WMT', 'TGT', 'COST', 'FDX', 'UPS', 'DAL', 'UAL', 'AAL', 'XLY']);
const SAAS_GROWTH = new Set(['DOCN', 'NET', 'DDOG', 'MDB', 'SNOW', 'BILL', 'HUBS', 'TEAM', 'CRM', 'SHOP']);
const POPULATION_BENEFIT = new Set(['WMT', 'COST', 'AMZN', 'HD', 'LOW', 'UNH', 'XLV', 'XLU', 'XLY', 'SPY']);

async function researchCompanies({ userId, candidates, macro, consumer, quotes = [], onEvent = () => {} }) {
  const uniqueSymbols = [...new Set(candidates.map((candidate) => candidate.symbol))].slice(0, 12);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const population = await collectPopulationContext();
  const oil = await collectOilContext();
  const records = [];
  for (const symbol of uniqueSymbols) {
    const quote = quoteBySymbol.get(symbol);
    const history = await webScrapeClient.getHistoricalStats(symbol).catch(() => null);
    const summary = buildCompanySummary({ symbol, quote, history, macro, consumer, population, oil });
    records.push(companyIntelligenceRepo.save({ userId, symbol, companyName: summary.companyName, summary }));
  }
  emit(onEvent, 'company-intel', 62, 'debug', 'Company intelligence workspace summaries updated.', {
    symbols: uniqueSymbols,
  });
  return { records, population, oil };
}

function buildCompanySummary({ symbol, quote, history, macro, consumer, population, oil }) {
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
      maxDrawdownPct: history?.maxDrawdownPct ?? null,
      rationale: 'Company history, trading trend, and market position should temper short-term signals.',
    },
  };
  const composite = Math.round(Object.values(factors).reduce((sum, factor) => sum + factor.score, 0) / Object.keys(factors).length);
  return {
    symbol,
    companyName: symbol,
    researchedAt: new Date().toISOString(),
    quote,
    history,
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
  if (!summary?.factors) return { normalized: 0.5, compositeScore: 50, explanations: [] };
  return {
    normalized: Math.max(0, Math.min(1, summary.compositeScore / 100)),
    compositeScore: summary.compositeScore,
    explanations: Object.values(summary.factors).map((factor) => `${factor.stance}: ${factor.rationale}`),
  };
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  researchCompanies,
  factorScoreForSymbol,
};
