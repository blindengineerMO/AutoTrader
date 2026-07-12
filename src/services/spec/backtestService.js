const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const specRepo = require('../../db/repositories/specResearchRepo');
const backtestRepo = require('../../db/repositories/specBacktestRepo');
const costModel = require('./transactionCostModelService');
const marketCalendar = require('./marketCalendarService');

function runEventDrivenBacktest({
  userId,
  sourceRunId = null,
  datasetVersion,
  featureVersion,
  modelVersion,
  strategyVersion,
  portfolio,
  initialCashUsd = 10000,
  randomSeed = 42,
  benchmarkSymbol = 'SPY',
  assumptions = costModel.DEFAULT_COST_ASSUMPTIONS,
  walkForwardSplit = null,
}) {
  const runId = `bt_${crypto.randomUUID()}`;
  const symbols = [...new Set([...portfolio.map((item) => item.symbol), benchmarkSymbol].filter(Boolean))];
  const bars = specRepo.listBars(userId, symbols);
  const portfolioSymbols = portfolio.map((item) => item.symbol);
  const actionsBySymbol = groupBySymbol(specRepo.listCorporateActions(userId, portfolioSymbols));
  const calendarByDate = marketCalendar.indexCalendar(specRepo.listMarketCalendarDays('US'));
  const events = [];
  let cash = initialCashUsd;
  const holdings = new Map();
  let costs = 0;
  let filled = 0;
  let partiallyFilled = 0;
  let rejected = 0;
  let corporateActionsApplied = 0;
  let dividendCashflowUsd = 0;

  for (const target of portfolio) {
    const symbol = normalizeSymbol(target.symbol);
    const symbolBars = bars
      .filter((bar) => bar.symbol === symbol)
      .sort((a, b) => String(a.available_at).localeCompare(String(b.available_at)));
    const decisionBar = symbolBars[0];
    const fillBar = symbolBars.find((bar) =>
      decisionBar &&
      Date.parse(bar.available_at) > Date.parse(decisionBar.available_at) &&
      marketCalendar.isOpenBar(bar, calendarByDate)
    );
    const corporateActions = actionsBySymbol.get(symbol) || [];
    for (const action of corporateActions.filter((item) => !decisionBar || Date.parse(item.available_at) <= Date.parse(fillBar?.available_at || decisionBar.available_at))) {
      corporateActionsApplied += 1;
      events.push({
        ts: action.available_at,
        type: 'corporate_action',
        symbol,
        payload: {
          actionType: action.action_type,
          exDate: action.ex_date,
          ratio: action.ratio,
          cashAmount: action.cash_amount,
          newSymbol: action.new_symbol,
          details: action.details,
        },
      });
    }
    events.push({
      ts: decisionBar?.available_at || new Date().toISOString(),
      type: 'signal',
      symbol,
      payload: {
        targetWeight: target.target_weight,
        expectedExcessReturn: target.expected_excess_return,
        modelVersion,
        datasetVersion,
      },
    });

    if (!decisionBar || !fillBar) {
      rejected += 1;
      events.push({
        ts: decisionBar?.available_at || new Date().toISOString(),
        type: 'order_rejected',
        symbol,
        payload: { reason: 'No later available open-market bar for fill; same-close execution and closed-session fills are disallowed.' },
      });
      continue;
    }

    const delisting = corporateActions.find((action) =>
      action.action_type === 'delisting' &&
      Date.parse(action.effective_at) <= Date.parse(fillBar.available_at)
    );
    if (delisting) {
      rejected += 1;
      events.push({
        ts: fillBar.available_at,
        type: 'order_rejected',
        symbol,
        payload: { reason: 'Security is delisted before the candidate fill.', delisting },
      });
      continue;
    }

    const targetNotional = initialCashUsd * target.target_weight;
    if (targetNotional <= 0) continue;
    const liquidity = estimateLiquidity(targetNotional, fillBar, calendarByDate, assumptions);
    const participationPctAdv = liquidity.participationPctAdv;
    if (participationPctAdv > assumptions.maxParticipationPctAdv) {
      if (!liquidity.fillableNotionalUsd || liquidity.fillableNotionalUsd <= 0) {
        rejected += 1;
        events.push({
          ts: fillBar.available_at,
          type: 'order_rejected',
          symbol,
          payload: { reason: 'Volume participation limit exceeded with no fillable liquidity.', participationPctAdv },
        });
        continue;
      }
      partiallyFilled += 1;
      events.push({
        ts: fillBar.available_at,
        type: 'order_partially_filled',
        symbol,
        payload: {
          reason: 'Order capped by configured participation and early-close liquidity limits.',
          requestedNotional: targetNotional,
          fillableNotional: liquidity.fillableNotionalUsd,
          participationPctAdv,
          effectiveVolume: liquidity.effectiveVolume,
        },
      });
    }

    const executedNotional = Math.min(targetNotional, liquidity.fillableNotionalUsd || targetNotional);
    const estimatedCost = costModel.estimateTransactionCost({ notionalUsd: executedNotional, participationPctAdv: Math.min(participationPctAdv, assumptions.maxParticipationPctAdv), assumptions });
    const fillPrice = Number(fillBar.close_adjusted || fillBar.close_unadjusted);
    const quantity = fillPrice ? executedNotional / fillPrice : 0;
    const grossCost = quantity * fillPrice;
    if (cash < grossCost + estimatedCost.totalCostUsd) {
      rejected += 1;
      events.push({
        ts: fillBar.available_at,
        type: 'order_rejected',
        symbol,
        payload: { reason: 'Insufficient simulated cash.', required: grossCost + estimatedCost.totalCostUsd, cash },
      });
      continue;
    }

    events.push({
      ts: decisionBar.available_at,
      type: 'order_submitted',
      symbol,
      payload: { side: 'buy', quantity, targetNotional, executedNotional, reasonCodes: target.reason_codes },
    });
    cash -= grossCost + estimatedCost.totalCostUsd;
    holdings.set(symbol, { quantity, avgPrice: fillPrice });
    costs += estimatedCost.totalCostUsd;
    filled += 1;
    events.push({
      ts: fillBar.available_at,
      type: 'order_filled',
      symbol,
      payload: { side: 'buy', quantity, fillPrice, grossCost, transactionCost: estimatedCost },
    });

    for (const dividend of corporateActions.filter((action) =>
      ['cash_dividend', 'special_dividend'].includes(action.action_type) &&
      Date.parse(action.effective_at) > Date.parse(fillBar.available_at)
    )) {
      const cashAmount = Number(dividend.cash_amount || 0) * quantity;
      if (cashAmount <= 0) continue;
      cash += cashAmount;
      dividendCashflowUsd += cashAmount;
      corporateActionsApplied += 1;
      events.push({
        ts: dividend.effective_at,
        type: 'dividend_cashflow',
        symbol,
        payload: { cashAmount, perShare: Number(dividend.cash_amount || 0), quantity, exDate: dividend.ex_date },
      });
    }
  }

  const valuation = valueHoldings({ holdings, bars, cash, calendarByDate });
  const endValue = valuation.endValue;
  const totalReturn = initialCashUsd ? (endValue - initialCashUsd) / initialCashUsd : 0;
  const benchmarkReturn = calculateBenchmarkReturn({ bars, benchmarkSymbol, calendarByDate });
  const maximumDrawdown = calculateMaximumDrawdown(valuation.equityCurve);
  const metrics = {
    totalReturn: round(totalReturn),
    annualizedReturn: round(totalReturn),
    annualizedVolatility: round(calculateVolatility(valuation.equityCurve)),
    sharpeRatio: round(calculateSharpe(totalReturn, valuation.equityCurve)),
    sortinoRatio: 0,
    calmarRatio: 0,
    maximumDrawdown: round(maximumDrawdown),
    turnover: round((initialCashUsd - cash + dividendCashflowUsd) / initialCashUsd),
    transactionCostsUsd: round(costs),
    slippageUsd: round(costs),
    fillRate: filled + rejected ? round(filled / (filled + rejected)) : 0,
    rejectedOrders: rejected,
    filledOrders: filled,
    partiallyFilledOrders: partiallyFilled,
    corporateActionsApplied,
    dividendCashflowUsd: round(dividendCashflowUsd),
    benchmark: benchmarkSymbol,
    benchmarkReturn: round(benchmarkReturn),
    excessReturnVsBenchmark: round(totalReturn - benchmarkReturn),
    confidenceIntervalMethod: 'deterministic_single_path_safe_mvp',
  };

  const run = backtestRepo.saveRun({
    userId,
    runId,
    sourceRunId,
    datasetVersion,
    featureVersion,
    modelVersion,
    strategyVersion,
    randomSeed,
    dependencyLockHash: hashLockfile(),
    gitCommit: process.env.GIT_COMMIT || null,
    status: 'completed',
    metrics,
    assumptions,
    splitMetadata: walkForwardSplit,
  });
  backtestRepo.appendEvents({ userId, runId, events });
  backtestRepo.upsertStatus({
    userId,
    statusKey: 'backtest.latest',
    status: rejected > filled ? 'warn' : 'ok',
    details: { runId, metrics },
  });
  return {
    ...run,
    events: backtestRepo.listEvents(userId, runId),
  };
}

function estimateLiquidity(notionalUsd, bar, calendarByDate, assumptions) {
  const price = Number(bar.close_adjusted || bar.close_unadjusted || 0);
  const session = calendarByDate.get(bar.bar_date);
  const volumeMultiplier = session?.early_close ? 0.5 : 1;
  const volume = Number(bar.volume || 0) * volumeMultiplier;
  const advUsd = price * volume;
  if (!advUsd) return { participationPctAdv: 0, fillableNotionalUsd: 0, effectiveVolume: volume };
  const maxParticipation = assumptions.maxParticipationPctAdv || 0.05;
  return {
    participationPctAdv: notionalUsd / advUsd,
    fillableNotionalUsd: advUsd * maxParticipation,
    effectiveVolume: volume,
  };
}

function hashLockfile() {
  const file = path.join(__dirname, '..', '..', '..', 'package-lock.json');
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function round(value) {
  return Number((Number(value) || 0).toFixed(6));
}

function valueHoldings({ holdings, bars, cash, calendarByDate }) {
  const dates = [...new Set(bars.filter((bar) => marketCalendar.isOpenBar(bar, calendarByDate)).map((bar) => bar.bar_date))].sort();
  const equityCurve = [];
  for (const date of dates) {
    let value = cash;
    for (const [symbol, holding] of holdings.entries()) {
      const bar = bars
        .filter((item) => item.symbol === symbol && item.bar_date <= date && marketCalendar.isOpenBar(item, calendarByDate))
        .sort((a, b) => String(a.bar_date).localeCompare(String(b.bar_date)))
        .at(-1);
      value += holding.quantity * Number(bar?.close_adjusted || bar?.close_unadjusted || holding.avgPrice || 0);
    }
    equityCurve.push({ date, value });
  }
  const endValue = equityCurve.at(-1)?.value ?? cash;
  return { endValue, equityCurve };
}

function calculateBenchmarkReturn({ bars, benchmarkSymbol, calendarByDate }) {
  const symbol = normalizeSymbol(benchmarkSymbol);
  const benchmarkBars = bars
    .filter((bar) => bar.symbol === symbol && marketCalendar.isOpenBar(bar, calendarByDate))
    .sort((a, b) => String(a.bar_date).localeCompare(String(b.bar_date)));
  if (benchmarkBars.length < 2) return 0;
  const start = Number(benchmarkBars[0].close_adjusted || benchmarkBars[0].close_unadjusted || 0);
  const end = Number(benchmarkBars.at(-1).close_adjusted || benchmarkBars.at(-1).close_unadjusted || 0);
  return start ? (end - start) / start : 0;
}

function calculateMaximumDrawdown(equityCurve) {
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equityCurve || []) {
    peak = Math.max(peak, point.value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.value) / peak);
  }
  return maxDrawdown;
}

function calculateVolatility(equityCurve) {
  const returns = [];
  for (let index = 1; index < (equityCurve || []).length; index += 1) {
    const previous = equityCurve[index - 1].value;
    const current = equityCurve[index].value;
    if (previous) returns.push((current - previous) / previous);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function calculateSharpe(totalReturn, equityCurve) {
  const volatility = calculateVolatility(equityCurve);
  return volatility ? totalReturn / volatility : 0;
}

function groupBySymbol(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const symbol = normalizeSymbol(row.symbol);
    if (!map.has(symbol)) map.set(symbol, []);
    map.get(symbol).push(row);
  }
  return map;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

module.exports = { runEventDrivenBacktest };
