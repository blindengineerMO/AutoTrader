const settingsRepo = require('../../db/repositories/settingsRepo');
const pnlRepo = require('../../db/repositories/pnlRepo');
const { startOfTodayUtc } = require('../../utils/time');
const { riskCheckContract } = require('./interfaceContracts');
const modelRegistry = require('./modelRegistryService');
const { DEFAULT_LIMITS } = require('./portfolioConstructionService');

const DEFAULT_RISK_LIMITS = {
  ...DEFAULT_LIMITS,
  maxDataAgeHours: 72,
  maxDailyLossUsd: null,
  maxOrderNotionalUsd: 100,
  maxTurnoverWeight: 0.05,
};

function validateSafeMvpPortfolio({
  userId,
  runId,
  portfolio,
  securities = [],
  modelVersion,
  datasetVersion,
  accountState = {},
  limits = DEFAULT_RISK_LIMITS,
  now = new Date(),
}) {
  const securityMap = new Map((securities || []).map((security) => [security.symbol, security]));
  const settings = settingsRepo.get(userId);
  const checks = [];

  add(checks, null, 'paper-only-stage', 'pass', 'info', 'Safe MVP is restricted to research/paper simulation; no live brokerage order can be submitted.', {
    deploymentStage: 'Stage 0-1',
  });

  const modelCheck = modelRegistry.assertApprovedModel(userId, modelVersion);
  add(checks, null, 'approved-model-version', modelCheck.allowed ? 'pass' : 'fail', modelCheck.allowed ? 'info' : 'critical', modelCheck.reason, {
    modelVersion,
    datasetVersion,
    status: modelCheck.model?.status || 'missing',
  });

  if (settings?.kill_switch_engaged) {
    add(checks, null, 'manual-kill-switch', 'fail', 'critical', 'Manual kill switch is engaged.', {});
  } else {
    add(checks, null, 'manual-kill-switch', 'pass', 'info', 'Manual kill switch is clear.', {});
  }

  for (const switchName of settingsRepo.AUTO_KILL_SWITCHES) {
    const engaged = Boolean(settings?.[`${switchName}_engaged`]);
    add(
      checks,
      null,
      switchName.replace(/_/g, '-'),
      engaged ? 'fail' : 'pass',
      engaged ? 'critical' : 'info',
      engaged ? `${switchName} is engaged: ${settings[`${switchName}_reason`] || 'no reason recorded'}` : `${switchName} is clear.`,
      { engagedAt: settings?.[`${switchName}_at`] || null }
    );
  }

  const todaysPnl = pnlRepo.sumSince(userId, startOfTodayUtc());
  const dailyLossLimit = Math.abs(limits.maxDailyLossUsd || settings?.daily_loss_limit_usd || 10);
  if (todaysPnl <= -dailyLossLimit) {
    add(checks, null, 'daily-loss-limit', 'fail', 'critical', 'Daily loss limit reached; new orders must stop.', { todaysPnl, dailyLossLimit });
  } else {
    add(checks, null, 'daily-loss-limit', 'pass', 'info', 'Daily loss limit not reached.', { todaysPnl, dailyLossLimit });
  }

  const sectorWeights = new Map();
  let turnover = 0;
  for (const item of portfolio || []) {
    const security = securityMap.get(item.symbol);
    const failed = [];
    if (!security) failed.push('missing-security-master');
    if (security && !isEligibleSecurity(security)) failed.push('ineligible-security');
    if (item.target_weight > limits.maxPositionWeight) failed.push('position-weight-limit');
    if (dataAgeHours(item, now) > limits.maxDataAgeHours) failed.push('stale-signal');

    const notional = Number(accountState.buyingPowerUsd || accountState.cashUsd || 0) * Math.max(0, item.target_weight - item.current_weight);
    if (notional > limits.maxOrderNotionalUsd) failed.push('order-notional-limit');
    turnover += Math.abs(item.target_weight - item.current_weight);
    const sector = security?.sector || 'unknown';
    sectorWeights.set(sector, (sectorWeights.get(sector) || 0) + item.target_weight);

    add(
      checks,
      item.symbol,
      'pretrade-symbol-target',
      failed.length ? 'fail' : 'pass',
      failed.length ? 'critical' : 'info',
      failed.length ? `Rejected by ${failed.join(', ')}.` : 'Symbol target passed deterministic pre-trade checks.',
      { failed, targetWeight: item.target_weight, currentWeight: item.current_weight, notional }
    );
  }

  for (const [sector, weight] of sectorWeights.entries()) {
    add(
      checks,
      null,
      'sector-exposure-limit',
      weight > limits.maxSectorWeight ? 'fail' : 'pass',
      weight > limits.maxSectorWeight ? 'critical' : 'info',
      weight > limits.maxSectorWeight ? `Sector ${sector} exceeds maximum target weight.` : `Sector ${sector} is within exposure limit.`,
      { sector, weight, maxSectorWeight: limits.maxSectorWeight }
    );
  }

  add(
    checks,
    null,
    'daily-turnover-limit',
    turnover > limits.maxTurnoverWeight ? 'fail' : 'pass',
    turnover > limits.maxTurnoverWeight ? 'critical' : 'info',
    turnover > limits.maxTurnoverWeight ? 'Target turnover exceeds safe MVP limit.' : 'Target turnover is within safe MVP limit.',
    { turnover, maxTurnoverWeight: limits.maxTurnoverWeight }
  );

  return {
    runId,
    checks: checks.map((check) => riskCheckContract.parse(check)),
    rejectedTrades: buildRejectedTrades(portfolio || [], checks),
    allowed: !checks.some((check) => check.status === 'fail' && check.severity === 'critical'),
  };
}

function buildPaperOrderIntents({ userId, runId, portfolio, riskResult, accountState = {} }) {
  const failedSymbols = new Set(riskResult.checks.filter((check) => check.symbol && check.status === 'fail').map((check) => check.symbol));
  const buyingPower = Number(accountState.buyingPowerUsd || accountState.cashUsd || 0);
  return (portfolio || [])
    .filter((item) => Math.abs(item.target_weight - item.current_weight) > 0.0001)
    .map((item) => {
      const deltaWeight = item.target_weight - item.current_weight;
      const side = deltaWeight >= 0 ? 'buy' : 'sell';
      const notionalUsd = Math.abs(deltaWeight) * buyingPower;
      return {
        userId,
        runId,
        clientOrderId: `paper_${runId}_${item.symbol}_${side}`,
        symbol: item.symbol,
        side,
        quantity: 0,
        limitPrice: null,
        notionalUsd: Number(notionalUsd.toFixed(2)),
        status: failedSymbols.has(item.symbol) ? 'risk_rejected' : 'simulated',
        reasonCodes: item.reason_codes,
        riskResult: {
          allowed: !failedSymbols.has(item.symbol),
          checks: riskResult.checks.filter((check) => !check.symbol || check.symbol === item.symbol).map((check) => check.checkName),
        },
      };
    });
}

function buildRejectedTrades(portfolio, checks) {
  const bySymbol = new Map();
  for (const check of checks) {
    if (check.symbol && check.status === 'fail') {
      if (!bySymbol.has(check.symbol)) bySymbol.set(check.symbol, []);
      bySymbol.get(check.symbol).push(check.checkName);
    }
  }
  return [...bySymbol.entries()].map(([symbol, failedChecks]) => {
    const item = portfolio.find((row) => row.symbol === symbol);
    return {
      symbol,
      side: (item?.target_weight || 0) >= (item?.current_weight || 0) ? 'buy' : 'sell',
      reason: `Rejected by ${failedChecks.join(', ')}.`,
      failed_checks: failedChecks,
    };
  });
}

function isEligibleSecurity(security) {
  if (!security.is_active || !security.is_tradeable) return false;
  if (!['common_stock', 'etf'].includes(security.security_type)) return false;
  if (security.exclusion_reason) return false;
  if (/OTC|PINK/i.test(security.exchange || '')) return false;
  if (/2X|3X|LEVERAGED|INVERSE|BEAR|ULTRA/i.test(`${security.symbol} ${security.industry || ''}`)) return false;
  return true;
}

function dataAgeHours(item, now) {
  const ts = Date.parse(item.available_at || item.generated_at || now.toISOString());
  if (!Number.isFinite(ts)) return Infinity;
  return (now.getTime() - ts) / 36e5;
}

function add(checks, symbol, checkName, status, severity, reason, details) {
  checks.push({ symbol, checkName, status, severity, reason, details });
}

module.exports = {
  validateSafeMvpPortfolio,
  buildPaperOrderIntents,
  DEFAULT_RISK_LIMITS,
};
