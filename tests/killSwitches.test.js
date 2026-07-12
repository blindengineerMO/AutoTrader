const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-kill-switches.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const specRepo = require('../src/db/repositories/specResearchRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const rulesEngine = require('../src/services/rulesEngine');
const riskEngineService = require('../src/services/spec/riskEngineService');
const dataQuality = require('../src/services/spec/dataQualityService');
const { reconcilePaperRun } = require('../src/services/spec/reconciliationService');
const evaluationService = require('../src/services/evaluationService');
const evaluationReportRepo = require('../src/db/repositories/evaluationReportRepo');

function newUser() {
  return userRepo.createUser({
    email: `killswitch-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

describe('kill switches', () => {
  it('each auto switch blocks trades via rulesEngine independently of the manual switch and of each other', () => {
    for (const switchName of settingsRepo.AUTO_KILL_SWITCHES) {
      const userId = newUser();
      settingsRepo.update(userId, { tradingEnabled: 1 });

      const before = rulesEngine.checkTradeAllowed({ userId, symbol: 'AAPL', side: 'buy', estimatedUsd: 10 });
      expect(before.allowed).toBe(true);

      settingsRepo.engageAutoKillSwitch(userId, switchName, 'test trip');
      const settings = settingsRepo.get(userId);
      expect(settings.kill_switch_engaged).toBe(0);
      for (const other of settingsRepo.AUTO_KILL_SWITCHES) {
        if (other !== switchName) expect(settings[`${other}_engaged`]).toBe(0);
      }

      const after = rulesEngine.checkTradeAllowed({ userId, symbol: 'AAPL', side: 'buy', estimatedUsd: 10 });
      expect(after.allowed).toBe(false);
      expect(after.reason).toContain(switchName);
    }
  });

  it('riskEngineService.validateSafeMvpPortfolio reports a critical failed check for each engaged auto switch', () => {
    for (const switchName of settingsRepo.AUTO_KILL_SWITCHES) {
      const userId = newUser();
      settingsRepo.engageAutoKillSwitch(userId, switchName, 'test trip');

      const result = riskEngineService.validateSafeMvpPortfolio({
        userId,
        runId: 'kill-switch-risk-run',
        portfolio: [],
        securities: [],
        modelVersion: 'unapproved-test-version',
        datasetVersion: 'test-v1',
      });

      const switchCheck = result.checks.find((check) => check.checkName === switchName.replace(/_/g, '-'));
      expect(switchCheck).toBeTruthy();
      expect(switchCheck.status).toBe('fail');
      expect(switchCheck.severity).toBe('critical');
    }
  });

  it('reconciliationService auto-trips reconciliation_failure_kill_switch on a critical diff', () => {
    const userId = newUser();
    const runId = 'kill-switch-recon-run';
    specRepo.savePaperOrderIntents({
      userId,
      runId,
      intents: [{
        clientOrderId: 'missing-order',
        symbol: 'MSFT',
        side: 'buy',
        quantity: 1,
        notionalUsd: 50,
        status: 'planned',
      }],
    });

    const result = reconcilePaperRun({ userId, runId });
    expect(result.status).toBe('fail');

    const settings = settingsRepo.get(userId);
    expect(settings.reconciliation_failure_kill_switch_engaged).toBe(1);
    expect(settings.reconciliation_failure_kill_switch_reason).toBeTruthy();
  });

  it('dataQualityService auto-trips market_data_kill_switch when bars fail quality checks', () => {
    const userId = newUser();
    dataQuality.validateMarketBars({
      userId,
      datasetVersion: 'test-v1',
      bars: [],
      persist: true,
    });

    const settings = settingsRepo.get(userId);
    expect(settings.market_data_kill_switch_engaged).toBe(1);
  });

  it('evaluationService.checkModelDrift auto-trips model_drift_kill_switch on a sharp accuracy drop', () => {
    const userId = newUser();
    const actionEvaluations = (accuracyPct) =>
      Array.from({ length: 10 }, (_, index) => ({ outcome: index < accuracyPct / 10 ? 'correct' : 'incorrect' }));

    for (let i = 0; i < 3; i += 1) {
      evaluationReportRepo.create({
        userId,
        reportDate: `2026-01-0${i + 1}`,
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        summary: { accuracy: 80, evaluatedActions: 10 },
      });
    }

    evaluationService.checkModelDrift(userId, { accuracy: 20, evaluatedActions: 10 });

    const settings = settingsRepo.get(userId);
    expect(settings.model_drift_kill_switch_engaged).toBe(1);
  });

  it('does not trip model drift when sample size is too small', () => {
    const userId = newUser();
    evaluationService.checkModelDrift(userId, { accuracy: 0, evaluatedActions: 1 });
    const settings = settingsRepo.get(userId);
    expect(settings.model_drift_kill_switch_engaged).toBe(0);
  });

  it('clearAutoKillSwitch requires an explicit call and does not silently auto-clear', () => {
    const userId = newUser();
    settingsRepo.engageAutoKillSwitch(userId, 'broker_connection_kill_switch', 'connect() failed');
    expect(settingsRepo.get(userId).broker_connection_kill_switch_engaged).toBe(1);

    settingsRepo.clearAutoKillSwitch(userId, 'broker_connection_kill_switch', 'operator-ack');
    const settings = settingsRepo.get(userId);
    expect(settings.broker_connection_kill_switch_engaged).toBe(0);
    expect(settings.broker_connection_kill_switch_reason).toBeNull();
  });
});
