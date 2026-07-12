const { portfolioItemContract } = require('./interfaceContracts');

const STRATEGY_VERSION = 'safe-mvp-long-only-conservative-v1';
const DEFAULT_LIMITS = {
  maxPositionWeight: 0.02,
  maxSectorWeight: 0.2,
  minCashBufferWeight: 0.2,
  maxPortfolioWeight: 0.8,
  maxNames: 40,
};

function constructLongOnlyPortfolio({ featureRows, positions = [], accountState = {}, limits = DEFAULT_LIMITS }) {
  const currentValue = estimateAccountValue({ positions, accountState });
  const positionMap = new Map((positions || []).map((position) => [position.symbol, position]));
  const eligibleRows = (featureRows || [])
    .filter((row) => row.features?.confidence >= 0.35)
    .sort((a, b) => b.features.compositeScore - a.features.compositeScore)
    .slice(0, limits.maxNames);

  const maxInvestedWeight = Math.max(0, Math.min(limits.maxPortfolioWeight, 1 - limits.minCashBufferWeight));
  const perNameWeight = eligibleRows.length
    ? Math.min(limits.maxPositionWeight, maxInvestedWeight / eligibleRows.length)
    : 0;
  const portfolio = eligibleRows.map((row) => {
    const position = positionMap.get(row.symbol);
    const currentNotional = Number(position?.quantity || 0) * Number(position?.avg_cost_usd || 0);
    const currentWeight = currentValue ? currentNotional / currentValue : 0;
    const uncertaintyPenalty = 1 - Math.min(0.5, row.features.downsideProbability * 0.35 + (1 - row.features.confidence) * 0.25);
    const targetWeight = Math.max(0, Math.min(limits.maxPositionWeight, perNameWeight * uncertaintyPenalty));
    return portfolioItemContract.parse({
      symbol: row.symbol,
      current_weight: round(currentWeight),
      target_weight: round(targetWeight),
      expected_excess_return: row.features.expectedExcessReturn,
      expected_volatility: row.features.expectedVolatility,
      downside_probability: row.features.downsideProbability,
      confidence: row.features.confidence,
      reason_codes: [...new Set(['safe_mvp_long_only', ...(row.features.reasonCodes || [])])],
    });
  });

  return {
    strategyVersion: STRATEGY_VERSION,
    marketRegime: classifyRegime(portfolio),
    portfolio,
    warnings: eligibleRows.length < 20 ? [`Only ${eligibleRows.length} eligible names were available; SPEC default minimum is 20 holdings.`] : [],
    limits,
  };
}

function estimateAccountValue({ positions, accountState }) {
  const cash = Number(accountState.cashUsd ?? accountState.cash_balance_usd ?? 0);
  const positionValue = (positions || []).reduce((sum, position) => {
    return sum + Number(position.quantity || 0) * Number(position.avg_cost_usd || 0);
  }, 0);
  return Math.max(1, cash + positionValue);
}

function classifyRegime(portfolio) {
  if (!portfolio.length) return 'insufficient-data';
  const avgVol = portfolio.reduce((sum, item) => sum + item.expected_volatility, 0) / portfolio.length;
  const avgReturn = portfolio.reduce((sum, item) => sum + item.expected_excess_return, 0) / portfolio.length;
  if (avgVol > 0.06) return 'high-volatility';
  if (avgReturn > 0.01) return 'constructive';
  if (avgReturn < -0.01) return 'defensive';
  return 'mixed';
}

function round(value) {
  return Number(Math.max(0, value || 0).toFixed(6));
}

module.exports = { constructLongOnlyPortfolio, STRATEGY_VERSION, DEFAULT_LIMITS };
