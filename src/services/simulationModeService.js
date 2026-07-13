const settingsRepo = require('../db/repositories/settingsRepo');
const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const positionRepo = require('../db/repositories/positionRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const researchRunRepo = require('../db/repositories/researchRunRepo');
const autonomousResearchService = require('./autonomousResearchService');
const personalityAgents = require('./personalityAgentService');
const evaluationService = require('./evaluationService');
const webScrapeClient = require('./marketData/webScrapeClient');
const MockBrokerClient = require('./broker/MockBrokerClient');
const { runTradingCycle } = require('./tradingCycle');
const logger = require('../utils/logger');

function startSimulation(userId, settings = settingsRepo.get(userId)) {
  const startingCash = Math.max(0, Number(settings?.simulation_starting_cash_usd || 0));
  const account = brokerAccountRepo.ensureDefault(userId);
  brokerAccountRepo.updateBalance(account.id, startingCash, startingCash, 'simulation');
  return settingsRepo.markSimulationStarted(userId);
}

function stopSimulation(userId) {
  const account = brokerAccountRepo.ensureDefault(userId);
  brokerAccountRepo.updateBalance(account.id, account.cash_balance_usd || 0, account.buying_power_usd || 0, 'simulation_stopped');
  return settingsRepo.markSimulationStopped(userId);
}

function ensureSimulationStarted(userId) {
  const settings = settingsRepo.get(userId);
  if (!settings?.simulation_mode_enabled) return settings;
  if (!settings.simulation_started_at) return startSimulation(userId, settings);
  return settings;
}

async function runMorningSimulation({ userId, onEvent = () => {} } = {}) {
  const settings = ensureSimulationStarted(userId);
  if (!settings?.simulation_mode_enabled) {
    logger.info('Skipping simulation morning cycle because simulation mode is disabled', { userId });
    return null;
  }

  let run;
  try {
    run = researchRunRepo.create(userId);
    researchRunRepo.markStarted(run.id);
    const appendEvent = (event) => {
      researchRunRepo.appendEvent(run.id, event);
      onEvent(event);
    };
    appendEvent({
      phase: 'simulation-board',
      progress: 4,
      level: 'info',
      message: 'Starting persistent simulation morning analysis and agent board meeting.',
      data: { startingCashUsd: settings.simulation_starting_cash_usd },
    });

    const snapshot = await autonomousResearchService.runAutonomousResearch({
      userId,
      researchRunId: run.id,
      onEvent: appendEvent,
    });
    appendEvent({
      phase: 'simulation-board',
      progress: 82,
      level: 'debug',
      message: 'Opening Agent Council board meeting from the morning research snapshot.',
      data: { snapshotId: snapshot.id },
    });
    const councilRun = await personalityAgents.runCouncil({ userId, snapshotId: snapshot.id, onEvent: appendEvent });
    const account = brokerAccountRepo.ensureDefault(userId);
    const plan = await runTradingCycle({
      userId,
      broker: new MockBrokerClient({ startingCashUsd: account.cash_balance_usd || 0 }),
      executionMode: 'simulation',
      modeReason: 'Persistent Settings simulation mode is enabled; orders are simulated against the configured starting capital cap.',
      runResearchCycle: async () => ({
        ...snapshot,
        summary: {
          ...snapshot.summary,
          agentCouncil: councilRun.summary,
          simulationMode: {
            enabled: true,
            startingCashUsd: settings.simulation_starting_cash_usd,
            accountCashUsd: account.cash_balance_usd || 0,
          },
        },
      }),
      onEvent: appendEvent,
    });

    researchRunRepo.markComplete(run.id, {
      snapshotId: snapshot.id,
      planId: plan.id,
      reportId: plan.decisionReport?.id,
    });
    settingsRepo.markSimulationCycle(userId);
    return { runId: run.id, snapshot, councilRun, plan };
  } catch (error) {
    logger.error('Persistent simulation morning cycle failed', { userId, error: error.message });
    if (run?.id) researchRunRepo.markFailed(run.id, error);
    throw error;
  }
}

async function runCloseEvaluation({ userId } = {}) {
  const settings = settingsRepo.get(userId);
  if (!settings?.simulation_mode_enabled) {
    logger.info('Skipping simulation close evaluation because simulation mode is disabled', { userId });
    return null;
  }
  const markToMarket = await markSimulationToMarket(userId);
  const evaluation = await evaluationService.runDailyEvaluation({ userId });
  settingsRepo.markSimulationEvaluation(userId);
  return { markToMarket, evaluation };
}

async function markSimulationToMarket(userId) {
  const account = brokerAccountRepo.ensureDefault(userId);
  const positions = positionRepo.listByUser(userId);
  if (!positions.length) {
    pnlRepo.record({
      userId,
      brokerAccountId: account.id,
      orderId: null,
      realizedPnlUsd: 0,
      balanceAfterUsd: account.cash_balance_usd || 0,
      note: 'Simulation close mark-to-market: no open simulated positions.',
    });
    return { equityUsd: Number(account.cash_balance_usd || 0), positions: [] };
  }
  const quotes = await webScrapeClient.getQuotes(positions.map((position) => position.symbol));
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const valued = positions.map((position) => {
    const quote = quoteBySymbol.get(position.symbol);
    const marketPrice = Number(quote?.current || position.avg_cost_usd || 0);
    const marketValue = Number(position.quantity || 0) * marketPrice;
    const costBasis = Number(position.quantity || 0) * Number(position.avg_cost_usd || 0);
    return {
      symbol: position.symbol,
      quantity: position.quantity,
      avgCostUsd: position.avg_cost_usd,
      marketPrice,
      marketValue,
      unrealizedPnlUsd: marketValue - costBasis,
    };
  });
  const equityUsd = Number(account.cash_balance_usd || 0) + valued.reduce((sum, item) => sum + item.marketValue, 0);
  pnlRepo.record({
    userId,
    brokerAccountId: account.id,
    orderId: null,
    realizedPnlUsd: 0,
    balanceAfterUsd: Number(equityUsd.toFixed(2)),
    note: `Simulation close mark-to-market equity $${equityUsd.toFixed(2)} across ${valued.length} open position(s).`,
  });
  return { equityUsd: Number(equityUsd.toFixed(2)), positions: valued };
}

module.exports = {
  startSimulation,
  stopSimulation,
  ensureSimulationStarted,
  runMorningSimulation,
  runCloseEvaluation,
  markSimulationToMarket,
};
