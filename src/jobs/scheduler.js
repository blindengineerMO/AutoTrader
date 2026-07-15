const cron = require('node-cron');
const logger = require('../utils/logger');
const { runTradingCycle } = require('../services/tradingCycle');
const autonomousResearchService = require('../services/autonomousResearchService');
const evaluationService = require('../services/evaluationService');
const eventOutcomeLabeling = require('../services/eventOutcomeLabelingService');
const challengerScorerService = require('../services/challengerScorerService');
const watcherAgentService = require('../services/watcherAgentService');
const watcherBehaviorService = require('../services/watcherBehaviorService');
const simulationModeService = require('../services/simulationModeService');
const personalityAgents = require('../services/personalityAgentService');
const MockBrokerClient = require('../services/broker/MockBrokerClient');
const AlpacaBrokerClient = require('../services/broker/AlpacaBrokerClient');
const settingsRepo = require('../db/repositories/settingsRepo');
const userRepo = require('../db/repositories/userRepo');
const researchRunRepo = require('../db/repositories/researchRunRepo');
const timeSettings = require('../services/timeSettingsService');
const idleResearchService = require('../services/idleResearchService');
const searchProviderHealthPersistence = require('../services/searchProviderHealthPersistenceService');
const alpacaDocumentService = require('../services/alpacaDocumentService');
const simulationCashFundingService = require('../services/simulationCashFundingService');
const excludedSymbolRecheckService = require('../services/excludedSymbolRecheckService');
const { config } = require('../config');

const scheduledTasks = new Map();
const scheduledEvaluationTasks = new Map();
const scheduledWatcherCycleTasks = new Map();
const scheduledWatcherGradingTasks = new Map();
const scheduledSimulationOpenTasks = new Map();
const scheduledSimulationCloseTasks = new Map();
const scheduledAgentRefreshTasks = new Map();
const scheduledPersonalityTickTasks = new Map();
const scheduledIdleResearchTasks = new Map();
const scheduledAlpacaDocumentTasks = new Map();
const scheduledSimulationFundingTasks = new Map();
const scheduledExcludedSymbolRecheckTasks = new Map();

// Fallback hours used only if a watcher_cycle_cadence_cron can't be parsed at all.
const DEFAULT_WATCHER_CYCLE_HOURS = [6, 10, 13, 16];

// Derives which hours a watcher-cycle cron actually fires on, straight from the
// cron string itself (the hour field of 'M H * * D'), so cycle-index detection
// never drifts out of sync with whatever cadence a user has configured —
// whether that's the legacy 4x/day default, hourly ('0 * * * *'), or a custom cron.
function watcherCycleHoursFromCron(cronExpression) {
  const hourField = String(cronExpression || '').trim().split(/\s+/)[1] || '';
  const hours = hourField
    .split(',')
    .flatMap((part) => {
      const range = part.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
      if (part === '*') return Array.from({ length: 24 }, (_, i) => i);
      return Number.isFinite(Number(part)) && part !== '' ? [Number(part)] : [];
    })
    .sort((a, b) => a - b);
  return hours.length ? hours : DEFAULT_WATCHER_CYCLE_HOURS;
}

async function resolveBroker(userId) {
  const alpaca = new AlpacaBrokerClient({ userId });
  if (!alpaca.isConfigured()) {
    logger.warn('Alpaca not configured - using MockBrokerClient simulation for this cycle');
    return { broker: new MockBrokerClient(), modeReason: 'Alpaca credentials are not configured.' };
  }
  try {
    await alpaca.connect();
    return { broker: alpaca, modeReason: null };
  } catch (err) {
    logger.warn('Alpaca live connection unavailable - using MockBrokerClient simulation for this cycle', { error: err.message });
    return { broker: new MockBrokerClient(), modeReason: `Alpaca live connection unavailable: ${err.message}` };
  }
}

async function runCycleForUser(userId) {
  const settings = settingsRepo.get(userId);
  if (!settings) {
    logger.info('Skipping scheduled trading cycle (missing settings)', { userId });
    return;
  }
  if (!timeSettings.isWithinTradingHours(settings)) {
    logger.info('Skipping scheduled trading cycle outside configured weekday trading window', {
      userId,
      timeZone: settings.application_timezone,
      tradingStart: settings.trading_start_time,
      tradingEnd: settings.trading_end_time,
    });
    return;
  }
  let run;
  try {
    const { broker, modeReason } = await resolveBroker(userId);
    run = researchRunRepo.create(userId);
    researchRunRepo.markStarted(run.id);
    const onEvent = (event) => researchRunRepo.appendEvent(run.id, event);
    const plan = await runTradingCycle({
      userId,
      broker,
      modeReason,
      runResearchCycle: (_watchlist, context) =>
        autonomousResearchService.runAutonomousResearch({
          userId: context.userId,
          researchRunId: run.id,
          onEvent,
        }),
      onEvent,
    });
    researchRunRepo.markComplete(run.id, {
      snapshotId: plan.research_snapshot_id,
      planId: plan.id,
      reportId: plan.decisionReport?.id,
    });
  } catch (err) {
    logger.error('Scheduled trading cycle failed', { userId, error: err.message });
    if (run?.id) researchRunRepo.markFailed(run.id, err);
  } finally {
    // Snapshot search-provider health after every cycle (not just on clean
    // shutdown) so an unexpected kill loses at most one cycle's worth of
    // cooldown/success data rather than all of it.
    searchProviderHealthPersistence.persist();
  }
}

function scheduleForUser(userId, cronExpression, timeZone = timeSettings.DEFAULT_TIMEZONE) {
  const existing = scheduledTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid research cron expression', { userId, cronExpression });
    return;
  }

  const task = cron.schedule(cronExpression, () => runCycleForUser(userId), { timezone: timeSettings.normalizeTimeZone(timeZone) });
  scheduledTasks.set(userId, task);
  logger.info('Scheduled trading cycle', { userId, cronExpression, timeZone });
}

async function runEvaluationForUser(userId) {
  try {
    await evaluationService.runDailyEvaluation({ userId });
  } catch (err) {
    logger.error('Scheduled evaluation failed', { userId, error: err.message });
  }
  try {
    await eventOutcomeLabeling.backfillOutcomes({ userId });
    eventOutcomeLabeling.updateCategoryLearning({ userId });
  } catch (err) {
    logger.warn('Event training-label outcome backfill failed', { userId, error: err.message });
  }
  try {
    challengerScorerService.trainChallenger({ userId });
  } catch (err) {
    logger.warn('Event-outcome challenger training failed', { userId, error: err.message });
  }
}

function scheduleEvaluationForUser(userId, cronExpression, timeZone = timeSettings.DEFAULT_TIMEZONE) {
  const existing = scheduledEvaluationTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid evaluation cron expression', { userId, cronExpression });
    return;
  }
  const task = cron.schedule(cronExpression, () => runEvaluationForUser(userId), { timezone: timeSettings.normalizeTimeZone(timeZone) });
  scheduledEvaluationTasks.set(userId, task);
  logger.info('Scheduled evaluation cycle', { userId, cronExpression, timeZone });
}

function currentWatcherCycleIndex(timeZone = timeSettings.DEFAULT_TIMEZONE, cronExpression = null) {
  const hour = timeSettings.localParts(new Date(), timeZone).hour;
  const hours = watcherCycleHoursFromCron(cronExpression);
  const index = hours.indexOf(hour);
  return index === -1 ? 1 : index + 1;
}

async function runWatcherCycleForUser(userId, timeZone = timeSettings.DEFAULT_TIMEZONE, cronExpression = null) {
  try {
    await watcherAgentService.runWatcherCycle(userId, { cycleIndex: currentWatcherCycleIndex(timeZone, cronExpression) });
  } catch (err) {
    logger.error('Scheduled watcher research cycle failed', { userId, error: err.message });
  }
}

function scheduleWatcherCycleForUser(userId, cronExpression, timeZone = timeSettings.DEFAULT_TIMEZONE) {
  const existing = scheduledWatcherCycleTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid watcher cycle cron expression', { userId, cronExpression });
    return;
  }
  const normalizedTimeZone = timeSettings.normalizeTimeZone(timeZone);
  const task = cron.schedule(cronExpression, () => runWatcherCycleForUser(userId, normalizedTimeZone, cronExpression), { timezone: normalizedTimeZone });
  scheduledWatcherCycleTasks.set(userId, task);
  logger.info('Scheduled watcher research cycle', { userId, cronExpression, timeZone: normalizedTimeZone });
}

async function runIdleResearchForUser(userId) {
  try {
    await idleResearchService.runIdleResearchTick({ userId });
  } catch (err) {
    logger.error('Scheduled idle research tick failed', { userId, error: err.message });
  }
}

function scheduleIdleResearchForUser(userId, timeZone = timeSettings.DEFAULT_TIMEZONE) {
  const existing = scheduledIdleResearchTasks.get(userId);
  if (existing) existing.stop();
  if (!config.idleResearch.enabled) return;
  const cronExpression = config.idleResearch.cadenceCron;
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid idle research cron expression', { userId, cronExpression });
    return;
  }
  const normalizedTimeZone = timeSettings.normalizeTimeZone(timeZone);
  const task = cron.schedule(cronExpression, () => runIdleResearchForUser(userId), { timezone: normalizedTimeZone });
  scheduledIdleResearchTasks.set(userId, task);
  logger.info('Scheduled idle background research', { userId, cronExpression, timeZone: normalizedTimeZone });
}

async function runAlpacaDocumentSyncForUser(userId) {
  try {
    const result = await alpacaDocumentService.syncMonthlyDocuments(userId);
    logger.info('Scheduled Alpaca document sync complete', {
      userId,
      skipped: result.skipped,
      count: result.items?.length || 0,
      errors: result.errors?.length || 0,
    });
  } catch (err) {
    logger.error('Scheduled Alpaca document sync failed', { userId, error: err.message });
  }
}

function scheduleAlpacaDocumentSyncForUser(userId, settings = settingsRepo.get(userId)) {
  const existing = scheduledAlpacaDocumentTasks.get(userId);
  if (existing) existing.stop();
  scheduledAlpacaDocumentTasks.delete(userId);
  if (!settings) return;
  const timeZone = timeSettings.normalizeTimeZone(settings.application_timezone);
  const day = Math.min(28, Math.max(1, Number(settings.alpaca_statement_download_day) || 5));
  const cronExpression = `20 3 ${day} * *`;
  const task = cron.schedule(cronExpression, () => runAlpacaDocumentSyncForUser(userId), { timezone: timeZone });
  scheduledAlpacaDocumentTasks.set(userId, task);
  logger.info('Scheduled Alpaca statement/document sync', { userId, cronExpression, timeZone });
}

async function runExcludedSymbolRecheckForUser(userId) {
  try {
    const result = await excludedSymbolRecheckService.recheckExcludedSymbolsForUser(userId);
    if (result.restored.length) {
      logger.info('Excluded-symbol recheck restored symbols now tradable via Alpaca', { userId, restored: result.restored });
    }
  } catch (err) {
    logger.error('Scheduled excluded-symbol recheck failed', { userId, error: err.message });
  }
}

function scheduleExcludedSymbolRecheckForUser(userId, settings = settingsRepo.get(userId)) {
  const existing = scheduledExcludedSymbolRecheckTasks.get(userId);
  if (existing) existing.stop();
  scheduledExcludedSymbolRecheckTasks.delete(userId);
  if (!settings) return;
  const timeZone = timeSettings.normalizeTimeZone(settings.application_timezone);
  const cronExpression = '0 1 * * *';
  const task = cron.schedule(cronExpression, () => runExcludedSymbolRecheckForUser(userId), { timezone: timeZone });
  scheduledExcludedSymbolRecheckTasks.set(userId, task);
  logger.info('Scheduled daily excluded-symbol recheck', { userId, cronExpression, timeZone });
}

async function runSimulationFundingForUser(userId) {
  try {
    const result = simulationCashFundingService.applyDueFunding(userId);
    if (result.applied?.length) {
      logger.info('Applied scheduled simulation cash funding', { userId, count: result.applied.length });
    }
  } catch (err) {
    logger.error('Scheduled simulation cash funding failed', { userId, error: err.message });
  }
}

function scheduleSimulationFundingForUser(userId, settings = settingsRepo.get(userId)) {
  const existing = scheduledSimulationFundingTasks.get(userId);
  if (existing) existing.stop();
  scheduledSimulationFundingTasks.delete(userId);
  if (!settings?.simulation_mode_enabled) return;
  const timeZone = timeSettings.normalizeTimeZone(settings.application_timezone);
  const task = cron.schedule('*/15 * * * *', () => runSimulationFundingForUser(userId), { timezone: timeZone });
  scheduledSimulationFundingTasks.set(userId, task);
  logger.info('Scheduled simulation cash funding watcher', { userId, cronExpression: '*/15 * * * *', timeZone });
}

async function runWatcherGradingForUser(userId) {
  try {
    await watcherBehaviorService.runDailyGrading(userId);
  } catch (err) {
    logger.error('Scheduled watcher grading failed', { userId, error: err.message });
  }
}

function scheduleWatcherGradingForUser(userId, cronExpression, timeZone = timeSettings.DEFAULT_TIMEZONE) {
  const existing = scheduledWatcherGradingTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid watcher grading cron expression', { userId, cronExpression });
    return;
  }
  const task = cron.schedule(cronExpression, () => runWatcherGradingForUser(userId), { timezone: timeSettings.normalizeTimeZone(timeZone) });
  scheduledWatcherGradingTasks.set(userId, task);
  logger.info('Scheduled watcher grading cycle', { userId, cronExpression, timeZone });
}

async function runSimulationMorningForUser(userId) {
  const settings = settingsRepo.get(userId);
  if (!settings?.simulation_mode_enabled) return null;
  if (!timeSettings.isTradingWeekday(new Date(), settings.application_timezone)) {
    logger.info('Skipping simulation morning cycle on weekend', { userId, timeZone: settings.application_timezone });
    return null;
  }
  return simulationModeService.runMorningSimulation({ userId });
}

async function runSimulationCloseForUser(userId) {
  const settings = settingsRepo.get(userId);
  if (!settings?.simulation_mode_enabled) return null;
  if (!timeSettings.isTradingWeekday(new Date(), settings.application_timezone)) {
    logger.info('Skipping simulation close evaluation on weekend', { userId, timeZone: settings.application_timezone });
    return null;
  }
  return simulationModeService.runCloseEvaluation({ userId });
}

function scheduleSimulationForUser(userId, settings = settingsRepo.get(userId)) {
  const openExisting = scheduledSimulationOpenTasks.get(userId);
  const closeExisting = scheduledSimulationCloseTasks.get(userId);
  if (openExisting) openExisting.stop();
  if (closeExisting) closeExisting.stop();
  scheduledSimulationOpenTasks.delete(userId);
  scheduledSimulationCloseTasks.delete(userId);
  if (!settings?.simulation_mode_enabled) return;
  const timeZone = timeSettings.normalizeTimeZone(settings.application_timezone);
  const openCron = timeSettings.cronFromLocalTime(settings.trading_start_time || '09:30');
  const closeCron = timeSettings.cronFromLocalTime(settings.trading_end_time || '16:00');
  scheduledSimulationOpenTasks.set(userId, cron.schedule(openCron, () => runSimulationMorningForUser(userId), { timezone: timeZone }));
  scheduledSimulationCloseTasks.set(userId, cron.schedule(closeCron, () => runSimulationCloseForUser(userId), { timezone: timeZone }));
  logger.info('Scheduled persistent simulation mode', { userId, openCron, closeCron, timeZone });
}

async function runAgentPersonalityRefreshForUser(userId) {
  const settings = settingsRepo.get(userId);
  if (!settings?.agent_personality_refresh_enabled) return [];
  const runs = personalityAgents.refreshAgentPersonalities(userId);
  settingsRepo.markAgentPersonalityRefreshed(userId);
  logger.info('Scheduled personality-agent refresh started', { userId, runs: runs.length });
  return runs;
}

function scheduleAgentPersonalityRefreshForUser(userId, settings = settingsRepo.get(userId)) {
  const existing = scheduledAgentRefreshTasks.get(userId);
  if (existing) existing.stop();
  scheduledAgentRefreshTasks.delete(userId);
  if (!settings?.agent_personality_refresh_enabled) return;
  const timeZone = timeSettings.normalizeTimeZone(settings.application_timezone);
  const refreshCron = timeSettings.cronFromLocalTime(settings.agent_personality_refresh_time || '20:00');
  scheduledAgentRefreshTasks.set(userId, cron.schedule(refreshCron, () => runAgentPersonalityRefreshForUser(userId), { timezone: timeZone }));
  logger.info('Scheduled personality-agent refresh', { userId, refreshCron, timeZone });
}

async function runPersonalityTickForUser(userId) {
  try {
    await personalityAgents.runCouncil({ userId });
  } catch (err) {
    logger.error('Scheduled personality tick failed', { userId, error: err.message });
  }
}

function schedulePersonalityTickForUser(userId, cronExpression, timeZone = timeSettings.DEFAULT_TIMEZONE) {
  const existing = scheduledPersonalityTickTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid personality tick cron expression', { userId, cronExpression });
    return;
  }
  const normalizedTimeZone = timeSettings.normalizeTimeZone(timeZone);
  const task = cron.schedule(cronExpression, () => runPersonalityTickForUser(userId), { timezone: normalizedTimeZone });
  scheduledPersonalityTickTasks.set(userId, task);
  logger.info('Scheduled personality tick', { userId, cronExpression, timeZone: normalizedTimeZone });
}

function scheduleUserAutomation(userId, settings = settingsRepo.get(userId)) {
  if (!settings) return;
  const timeZone = timeSettings.normalizeTimeZone(settings.application_timezone);
  scheduleForUser(userId, settings.research_cadence_cron, timeZone);
  scheduleEvaluationForUser(userId, settings.evaluation_cadence_cron || '0 0 * * *', timeZone);
  scheduleWatcherCycleForUser(userId, settings.watcher_cycle_cadence_cron || '0 * * * *', timeZone);
  scheduleWatcherGradingForUser(userId, settings.watcher_grading_cadence_cron || '30 16 * * 1-5', timeZone);
  scheduleSimulationForUser(userId, settings);
  scheduleAgentPersonalityRefreshForUser(userId, settings);
  schedulePersonalityTickForUser(userId, settings.personality_tick_cadence_cron || '0 * * * *', timeZone);
  scheduleIdleResearchForUser(userId, timeZone);
  scheduleAlpacaDocumentSyncForUser(userId, settings);
  scheduleSimulationFundingForUser(userId, settings);
  scheduleExcludedSymbolRecheckForUser(userId, settings);
}

function scheduleAllUsers() {
  for (const user of userRepo.list()) {
    const settings = settingsRepo.get(user.id);
    if (!settings) continue;
    scheduleUserAutomation(user.id, settings);
  }
}

function stopAll() {
  for (const task of scheduledTasks.values()) task.stop();
  for (const task of scheduledEvaluationTasks.values()) task.stop();
  for (const task of scheduledWatcherCycleTasks.values()) task.stop();
  for (const task of scheduledWatcherGradingTasks.values()) task.stop();
  for (const task of scheduledSimulationOpenTasks.values()) task.stop();
  for (const task of scheduledSimulationCloseTasks.values()) task.stop();
  for (const task of scheduledAgentRefreshTasks.values()) task.stop();
  for (const task of scheduledPersonalityTickTasks.values()) task.stop();
  for (const task of scheduledIdleResearchTasks.values()) task.stop();
  for (const task of scheduledAlpacaDocumentTasks.values()) task.stop();
  for (const task of scheduledSimulationFundingTasks.values()) task.stop();
  for (const task of scheduledExcludedSymbolRecheckTasks.values()) task.stop();
  scheduledTasks.clear();
  scheduledEvaluationTasks.clear();
  scheduledWatcherCycleTasks.clear();
  scheduledWatcherGradingTasks.clear();
  scheduledSimulationOpenTasks.clear();
  scheduledSimulationCloseTasks.clear();
  scheduledAgentRefreshTasks.clear();
  scheduledPersonalityTickTasks.clear();
  scheduledIdleResearchTasks.clear();
  scheduledAlpacaDocumentTasks.clear();
  scheduledSimulationFundingTasks.clear();
  scheduledExcludedSymbolRecheckTasks.clear();
}

module.exports = {
  currentWatcherCycleIndex,
  watcherCycleHoursFromCron,
  scheduleForUser,
  scheduleEvaluationForUser,
  scheduleWatcherCycleForUser,
  scheduleWatcherGradingForUser,
  scheduleSimulationForUser,
  scheduleAgentPersonalityRefreshForUser,
  schedulePersonalityTickForUser,
  runPersonalityTickForUser,
  scheduleIdleResearchForUser,
  runIdleResearchForUser,
  scheduleAlpacaDocumentSyncForUser,
  runAlpacaDocumentSyncForUser,
  scheduleSimulationFundingForUser,
  runSimulationFundingForUser,
  scheduleExcludedSymbolRecheckForUser,
  runExcludedSymbolRecheckForUser,
  scheduleUserAutomation,
  scheduleAllUsers,
  stopAll,
  runCycleForUser,
  runEvaluationForUser,
  runWatcherCycleForUser,
  runWatcherGradingForUser,
  runSimulationMorningForUser,
  runSimulationCloseForUser,
  runAgentPersonalityRefreshForUser,
};
