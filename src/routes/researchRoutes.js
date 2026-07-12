const express = require('express');
const researchRepo = require('../db/repositories/researchRepo');
const tradingPlanRepo = require('../db/repositories/tradingPlanRepo');
const decisionReportRepo = require('../db/repositories/decisionReportRepo');
const researchRunRepo = require('../db/repositories/researchRunRepo');
const evaluationReportRepo = require('../db/repositories/evaluationReportRepo');
const specRepo = require('../db/repositories/specResearchRepo');
const specBacktestRepo = require('../db/repositories/specBacktestRepo');
const specOperationsRepo = require('../db/repositories/specOperationsRepo');
const researchService = require('../services/researchService');
const autonomousResearchService = require('../services/autonomousResearchService');
const evaluationService = require('../services/evaluationService');
const safeResearchMvpService = require('../services/spec/safeResearchMvpService');
const modelPromotionService = require('../services/spec/modelPromotionService');
const { runTradingCycle } = require('../services/tradingCycle');
const MockBrokerClient = require('../services/broker/MockBrokerClient');
const RobinhoodBrokerClient = require('../services/broker/RobinhoodBrokerClient');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/snapshots', (req, res) => {
  const limit = Number(req.query.limit) || 5;
  res.json(researchRepo.listByUser(req.user.id, limit));
});

router.get('/plans', (req, res) => {
  const limit = Number(req.query.limit) || 20;
  const plans = tradingPlanRepo.listByUser(req.user.id, limit).map((p) => tradingPlanRepo.getById(p.id));
  res.json(plans);
});

router.get('/reports', (req, res) => {
  const limit = Number(req.query.limit) || 20;
  res.json(decisionReportRepo.listByUser(req.user.id, limit));
});

router.get('/evaluations', (req, res) => {
  const limit = Number(req.query.limit) || 30;
  res.json(evaluationReportRepo.listByUser(req.user.id, limit));
});

router.get('/spec-monitoring', (req, res) => {
  res.json(specBacktestRepo.listMonitoring(req.user.id));
});

router.get('/spec-data-quality', (req, res) => {
  const limit = Number(req.query.limit) || 20;
  res.json(specRepo.listQualityReports(req.user.id, limit));
});

router.get('/safe-mvp/backtests', (req, res) => {
  const limit = Number(req.query.limit) || 20;
  res.json(specBacktestRepo.listRuns(req.user.id, limit));
});

router.get('/safe-mvp/backtests/:runId/events', (req, res) => {
  res.json(specBacktestRepo.listEvents(req.user.id, req.params.runId));
});

router.get('/spec-risk-checks/:runId', (req, res) => {
  res.json(specRepo.listRiskChecks(req.user.id, req.params.runId));
});

router.get('/spec-audit/:runId', (req, res) => {
  res.json(specRepo.listAuditEvents(req.user.id, req.params.runId));
});

router.get('/spec-paper-intents/:runId', (req, res) => {
  res.json(specRepo.listPaperOrderIntents(req.user.id, req.params.runId));
});

router.get('/spec-models', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json({
    models: specRepo.listModels(req.user.id, limit),
    promotionReviews: specRepo.listPromotionReviews(req.user.id, limit),
    trainingSnapshots: specRepo.listTrainingSnapshots(req.user.id, limit),
    rollbacks: specRepo.listRollbackEvents(req.user.id, limit),
  });
});

router.post('/spec-models/:modelVersion/rollback', (req, res) => {
  try {
    const model = modelPromotionService.rollbackChampion({
      userId: req.user.id,
      targetModelVersion: req.params.modelVersion,
      approvedBy: req.user.email || `user:${req.user.id}`,
      reason: req.body?.reason || 'Operator rollback from Research Desk.',
    });
    res.json(model);
  } catch (err) {
    logger.error('SPEC model rollback failed', { userId: req.user.id, modelVersion: req.params.modelVersion, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/spec-reconciliations', (req, res) => {
  const limit = Number(req.query.limit) || 20;
  res.json(specOperationsRepo.listReconciliations(req.user.id, limit));
});

router.get('/spec-reconciliations/:runId', (req, res) => {
  const reconciliation = specOperationsRepo.getReconciliation(req.user.id, req.params.runId);
  if (!reconciliation) return res.status(404).json({ error: 'Reconciliation run not found' });
  res.json(reconciliation);
});

router.post('/evaluate', async (req, res) => {
  try {
    const report = await evaluationService.runDailyEvaluation({
      userId: req.user.id,
      reportDate: req.body?.reportDate,
      periodStart: req.body?.periodStart,
      periodEnd: req.body?.periodEnd,
    });
    res.json(report);
  } catch (err) {
    logger.error('Manual evaluation failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/runs', (req, res) => {
  const limit = Number(req.query.limit) || 10;
  res.json(researchRunRepo.listByUser(req.user.id, limit));
});

router.get('/runs/:id', (req, res) => {
  const run = researchRunRepo.getById(Number(req.params.id));
  if (!run || run.user_id !== req.user.id) return res.status(404).json({ error: 'Research run not found' });
  res.json(run);
});

function startCollectProcess(req, res) {
  const run = researchRunRepo.create(req.user.id);
  const queued = researchRunRepo.appendEvent(run.id, {
    status: 'queued',
    phase: 'queued',
    progress: 1,
    level: 'info',
    message: 'Collect/process request accepted; autonomous Brain terminal attached.',
    data: { entrypoint: 'POST /api/research/collect-process' },
  });
  setImmediate(() => {
    runAutonomousResearchOperation({ userId: req.user.id, runId: run.id }).catch((err) => {
      logger.error('Autonomous research operation failed', { userId: req.user.id, runId: run.id, error: err.message });
      researchRunRepo.markFailed(run.id, err);
    });
  });
  res.status(202).json(queued || run);
}

router.post('/collect-process', startCollectProcess);
router.post('/collect/process', startCollectProcess);
router.post('/collect-process-research', startCollectProcess);

// Manual trigger for a research + strategy cycle. Runs against a mock broker
// unless a real Robinhood account has been wired up, so this is safe to call
// while testing.
router.post('/run-cycle', async (req, res) => {
  try {
    const robinhood = new RobinhoodBrokerClient({ userId: req.user.id });
    let broker = new MockBrokerClient();
    let modeReason = 'Robinhood credentials are not configured.';
    if (robinhood.isConfigured()) {
      try {
        await robinhood.connect();
        robinhood.live = true;
        broker = robinhood;
        modeReason = null;
      } catch (err) {
        modeReason = `Robinhood live connection unavailable: ${err.message}`;
      }
    }
    const plan = await runTradingCycle({ userId: req.user.id, broker, modeReason });
    res.json(plan);
  } catch (err) {
    logger.error('Manual trading cycle failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/run-research-only', async (req, res) => {
  try {
    const snapshot = await researchService.runResearchCycle(undefined, { userId: req.user.id });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/safe-mvp', async (req, res) => {
  try {
    const watchlist = Array.isArray(req.body?.watchlist) && req.body.watchlist.length
      ? req.body.watchlist
      : undefined;
    const result = await safeResearchMvpService.runSafeResearchMvp({
      userId: req.user.id,
      watchlist,
    });
    res.json(result);
  } catch (err) {
    logger.error('Safe research MVP failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

async function runAutonomousResearchOperation({ userId, runId }) {
  researchRunRepo.markStarted(runId);
  const onEvent = (event) => researchRunRepo.appendEvent(runId, event);
  const { broker, modeReason } = await resolveBroker(userId, onEvent);
  const plan = await runTradingCycle({
    userId,
    broker,
    modeReason,
    runResearchCycle: (_watchlist, context) =>
      autonomousResearchService.runAutonomousResearch({
        userId: context.userId,
        researchRunId: runId,
        onEvent,
      }),
    onEvent,
  });
  researchRunRepo.markComplete(runId, {
    snapshotId: plan.research_snapshot_id,
    planId: plan.id,
    reportId: plan.decisionReport?.id,
  });
}

async function resolveBroker(userId, onEvent = () => {}) {
  const robinhood = new RobinhoodBrokerClient({ userId });
  let broker = new MockBrokerClient();
  let modeReason = 'Robinhood credentials are not configured.';
  onEvent({
    phase: 'broker',
    progress: 4,
    level: 'debug',
    message: 'Checking Robinhood live-readiness before deciding live vs simulation mode.',
  });
  if (robinhood.isConfigured()) {
    try {
      await robinhood.connect();
      robinhood.live = true;
      broker = robinhood;
      modeReason = null;
      onEvent({
        phase: 'broker',
        progress: 5,
        level: 'info',
        message: 'Robinhood connection is configured; live mode remains subject to kill switch and settings.',
      });
    } catch (err) {
      modeReason = `Robinhood live connection unavailable: ${err.message}`;
      onEvent({
        phase: 'broker',
        progress: 5,
        level: 'warn',
        message: 'Robinhood connection failed; operation will produce a simulation report.',
        data: { error: err.message },
      });
    }
  } else {
    onEvent({
      phase: 'broker',
      progress: 5,
      level: 'warn',
      message: 'Robinhood credentials missing; operation will produce a simulation report.',
    });
  }
  return { broker, modeReason };
}
