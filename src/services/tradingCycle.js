const researchService = require('./researchService');
const { generateTradingPlan, generateRulesBasedPlan } = require('./strategy/aiClient');
const { tradingPlanSchema } = require('./strategy/planSchema');
const tradingPlanRepo = require('../db/repositories/tradingPlanRepo');
const orderRepo = require('../db/repositories/orderRepo');
const positionRepo = require('../db/repositories/positionRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const rulesEngine = require('./rulesEngine');
const { buildDecisionReport } = require('./decisionReportService');
const logger = require('../utils/logger');

/**
 * Runs one full research -> plan -> validate -> execute cycle for a user.
 * `broker` is injected so tests / dry runs can pass a MockBrokerClient
 * instead of a live Robinhood connection. `runResearchCycle`/`generatePlan`
 * are injectable for the same reason (tests substitute deterministic stubs
 * instead of hitting Finnhub/OpenAI).
 */
async function runTradingCycle({
  userId,
  broker,
  watchlist,
  runResearchCycle = researchService.runResearchCycle,
  generatePlan = generateTradingPlan,
  executionMode = 'auto',
  modeReason,
  onEvent = () => {},
}) {
  emit(onEvent, 'research', 5, 'debug', 'Starting research collection phase.');
  const researchSnapshot = await runResearchCycle(watchlist, { userId });
  emit(onEvent, 'research', 80, 'debug', 'Research snapshot ready for strategy evaluation.', {
    snapshotId: researchSnapshot.id,
    signals: researchSnapshot.signals.length,
  });

  const brokerAccount = brokerAccountRepo.ensureDefault(userId);
  emit(onEvent, 'broker', 82, 'debug', 'Loading account state and safety settings.');
  const accountState = await broker.getAccountState();
  const settings = require('../db/repositories/settingsRepo').get(userId);
  const liveReady =
    executionMode === 'live' ||
    (executionMode === 'auto' && settings?.trading_enabled && !settings?.kill_switch_engaged && broker?.live === true);
  const mode = liveReady ? 'live' : 'simulation';
  const resolvedReason =
    modeReason ||
    (mode === 'simulation'
      ? buildSimulationReason({ settings, broker })
      : 'Trading enabled, kill switch clear, and live broker is connected.');
  brokerAccountRepo.updateBalance(
    brokerAccount.id,
    accountState.cashUsd,
    accountState.buyingPowerUsd,
    mode === 'live' ? 'connected' : 'simulation'
  );

  const recentTradeCounts = {};
  for (const signal of researchSnapshot.signals) {
    recentTradeCounts[signal.symbol] = orderRepo.countRecentForSymbol(userId, signal.symbol);
  }

  emit(onEvent, 'strategy', 84, 'debug', 'Generating final buy/sell/hold strategy.');
  const { modelUsed, raw } = await generatePlan({ userId, researchSnapshot, accountState, recentTradeCounts, onEvent });

  let resolvedModelUsed = modelUsed;
  let resolvedRaw = raw;
  let parsed = tradingPlanSchema.safeParse(resolvedRaw);
  if (!parsed.success && mode === 'simulation') {
    logger.warn('AI plan failed schema validation in simulation, using rules-based fallback report', {
      errors: parsed.error.issues,
    });
    emit(onEvent, 'strategy', 89, 'warn', 'Strategy response failed validation; simulation mode is switching to rules-based fallback.', {
      errors: parsed.error.issues.slice(0, 4),
    });
    const fallback = generateRulesBasedPlan({
      researchSnapshot,
      accountState,
      recentTradeCounts,
      reason: 'The AI provider returned a malformed plan, so simulation mode used a transparent rules-based fallback.',
    });
    resolvedModelUsed = fallback.modelUsed;
    resolvedRaw = fallback.raw;
    parsed = tradingPlanSchema.safeParse(resolvedRaw);
  }

  if (!parsed.success) {
    logger.error('AI plan failed schema validation, rejecting', { errors: parsed.error.issues });
    const rejected = tradingPlanRepo.create({
      userId,
      researchSnapshotId: researchSnapshot.id,
      modelUsed: resolvedModelUsed,
      rawResponse: resolvedRaw,
      status: 'rejected',
      rejectionReason: 'Schema validation failed: ' + JSON.stringify(parsed.error.issues),
      actions: [],
      executionMode: mode,
    });
    buildDecisionReport({
      userId,
      plan: rejected,
      researchSnapshot,
      mode,
      liveReady,
      modeReason: resolvedReason,
      accountState,
      brokerAccount,
    });
    emit(onEvent, 'report', 100, 'error', 'Trading plan rejected; decision report generated with schema failure.', {
      planId: rejected.id,
    });
    return rejected;
  }

  const plan = tradingPlanRepo.create({
    userId,
    researchSnapshotId: researchSnapshot.id,
    modelUsed: resolvedModelUsed,
    rawResponse: resolvedRaw,
    status: 'validated',
    actions: parsed.data.actions,
    executionMode: mode,
  });

  for (const action of plan.actions) {
    emit(onEvent, 'execution', 90, 'debug', `Evaluating ${action.action.toUpperCase()} ${action.symbol}.`, {
      symbol: action.symbol,
      action: action.action,
      mode,
    });
    if (action.action === 'hold') {
      tradingPlanRepo.setActionStatus(action.id, mode === 'live' ? 'skipped_hold' : 'simulated_hold');
      continue;
    }
    if (mode === 'simulation') {
      tradingPlanRepo.setActionStatus(action.id, `simulated_would_${action.action}`);
      continue;
    }
    await executeAction({ userId, brokerAccount, broker, action, researchSnapshot });
  }

  const finalPlan = tradingPlanRepo.getById(plan.id);
  const report = buildDecisionReport({
    userId,
    plan: finalPlan,
    researchSnapshot,
    mode,
    liveReady,
    modeReason: resolvedReason,
    accountState,
    brokerAccount,
  });
  emit(onEvent, 'report', 98, 'info', 'Decision report generated.', {
    reportId: report.id,
    mode,
    liveReady,
  });
  finalPlan.decisionReport = report;
  return finalPlan;
}

function buildSimulationReason({ settings, broker }) {
  if (!settings?.trading_enabled) return 'Trading is disabled, so AutoTrader generated a simulation report only.';
  if (settings?.kill_switch_engaged) return 'The kill switch is engaged, so AutoTrader generated a simulation report only.';
  if (broker?.live !== true) return 'A live Robinhood broker connection is unavailable, so AutoTrader generated a simulation report only.';
  return 'Simulation mode was requested explicitly.';
}

async function executeAction({ userId, brokerAccount, broker, action, researchSnapshot }) {
  const signal = researchSnapshot.signals.find((s) => s.symbol === action.symbol);
  const estimatedUsd = (action.quantity || 1) * (signal?.price || 0);

  const check = rulesEngine.checkTradeAllowed({
    userId,
    symbol: action.symbol,
    side: action.action,
    estimatedUsd,
  });

  if (!check.allowed) {
    logger.warn('Trade blocked by rules engine', { userId, symbol: action.symbol, reason: check.reason });
    tradingPlanRepo.setActionStatus(action.id, `blocked: ${check.reason}`);
    return;
  }

  const order = orderRepo.create({
    userId,
    brokerAccountId: brokerAccount.id,
    planActionId: action.id,
    symbol: action.symbol,
    side: action.action,
    quantity: action.quantity || 0,
    orderType: 'market',
    status: 'submitted',
    brokerOrderId: null,
  });

  try {
    const result = await broker.placeMarketOrder({
      symbol: action.symbol,
      side: action.action,
      quantity: action.quantity || 0,
      price: signal?.price,
    });

    if (result.status !== 'filled') {
      orderRepo.markFailed(order.id);
      tradingPlanRepo.setActionStatus(action.id, `order_${result.status}`);
      return;
    }

    orderRepo.markFilled(order.id, result.fillPrice);
    const realizedPnl = positionRepo.applyFill({
      userId,
      brokerAccountId: brokerAccount.id,
      symbol: action.symbol,
      side: action.action,
      quantity: action.quantity || 0,
      fillPrice: result.fillPrice,
    });

    const newAccountState = await broker.getAccountState();
    pnlRepo.record({
      userId,
      brokerAccountId: brokerAccount.id,
      orderId: order.id,
      realizedPnlUsd: realizedPnl,
      balanceAfterUsd: newAccountState.cashUsd,
      note: `${action.action} ${action.quantity} ${action.symbol} @ ${result.fillPrice}`,
    });
    brokerAccountRepo.updateBalance(brokerAccount.id, newAccountState.cashUsd, newAccountState.buyingPowerUsd, 'connected');

    tradingPlanRepo.setActionStatus(action.id, 'executed');
  } catch (err) {
    logger.error('Order execution failed', { userId, symbol: action.symbol, error: err.message });
    orderRepo.markFailed(order.id);
    tradingPlanRepo.setActionStatus(action.id, 'execution_error');
  }
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = { runTradingCycle };
