const cron = require('node-cron');
const logger = require('../utils/logger');
const { runTradingCycle } = require('../services/tradingCycle');
const autonomousResearchService = require('../services/autonomousResearchService');
const evaluationService = require('../services/evaluationService');
const MockBrokerClient = require('../services/broker/MockBrokerClient');
const RobinhoodBrokerClient = require('../services/broker/RobinhoodBrokerClient');
const settingsRepo = require('../db/repositories/settingsRepo');
const userRepo = require('../db/repositories/userRepo');
const researchRunRepo = require('../db/repositories/researchRunRepo');

const scheduledTasks = new Map();
const scheduledEvaluationTasks = new Map();

async function resolveBroker(userId) {
  const robinhood = new RobinhoodBrokerClient({ userId });
  if (!robinhood.isConfigured()) {
    logger.warn('Robinhood not configured — using MockBrokerClient simulation for this cycle');
    return { broker: new MockBrokerClient(), modeReason: 'Robinhood credentials are not configured.' };
  }
  try {
    await robinhood.connect();
    robinhood.live = true;
    return { broker: robinhood, modeReason: null };
  } catch (err) {
    logger.warn('Robinhood live connection unavailable — using MockBrokerClient simulation for this cycle', { error: err.message });
    return { broker: new MockBrokerClient(), modeReason: `Robinhood live connection unavailable: ${err.message}` };
  }
}

async function runCycleForUser(userId) {
  if (!settingsRepo.get(userId)) {
    logger.info('Skipping scheduled trading cycle (missing settings)', { userId });
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
  }
}

function scheduleForUser(userId, cronExpression) {
  const existing = scheduledTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid research cron expression', { userId, cronExpression });
    return;
  }

  const task = cron.schedule(cronExpression, () => runCycleForUser(userId), { timezone: 'America/New_York' });
  scheduledTasks.set(userId, task);
  logger.info('Scheduled trading cycle', { userId, cronExpression });
}

async function runEvaluationForUser(userId) {
  try {
    await evaluationService.runDailyEvaluation({ userId });
  } catch (err) {
    logger.error('Scheduled evaluation failed', { userId, error: err.message });
  }
}

function scheduleEvaluationForUser(userId, cronExpression) {
  const existing = scheduledEvaluationTasks.get(userId);
  if (existing) existing.stop();
  if (!cron.validate(cronExpression)) {
    logger.warn('Skipping invalid evaluation cron expression', { userId, cronExpression });
    return;
  }
  const task = cron.schedule(cronExpression, () => runEvaluationForUser(userId), { timezone: 'America/New_York' });
  scheduledEvaluationTasks.set(userId, task);
  logger.info('Scheduled evaluation cycle', { userId, cronExpression });
}

function scheduleAllUsers() {
  for (const user of userRepo.list()) {
    const settings = settingsRepo.get(user.id);
    if (!settings) continue;
    scheduleForUser(user.id, settings.research_cadence_cron);
    scheduleEvaluationForUser(user.id, settings.evaluation_cadence_cron || '0 0 * * *');
  }
}

function stopAll() {
  for (const task of scheduledTasks.values()) task.stop();
  for (const task of scheduledEvaluationTasks.values()) task.stop();
  scheduledTasks.clear();
  scheduledEvaluationTasks.clear();
}

module.exports = {
  scheduleForUser,
  scheduleEvaluationForUser,
  scheduleAllUsers,
  stopAll,
  runCycleForUser,
  runEvaluationForUser,
};
