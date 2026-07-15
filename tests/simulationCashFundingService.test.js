const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-simulation-cash-funding.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const glLedgerRepo = require('../src/db/repositories/glLedgerRepo');
const simulationModeService = require('../src/services/simulationModeService');
const simulationCashFunding = require('../src/services/simulationCashFundingService');
const { reconcileSimulationAccount } = require('../src/services/simulationAccountReconciliationService');

describe('simulationCashFundingService', () => {
  it('adds simulation-only cash and preserves it through reconciliation', () => {
    const user = userRepo.createUser({
      email: `sim-funding-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(user.id, {
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 100,
    });
    simulationModeService.startSimulation(user.id);

    const event = simulationCashFunding.addCashNow(user.id, { amountUsd: 25, memo: 'test add' });
    const account = brokerAccountRepo.getDefault(user.id);
    const reconciled = reconcileSimulationAccount(user.id);
    const gl = glLedgerRepo.listByCompany(user.id, 'CASH', 10);

    expect(event.amount_usd).toBe(25);
    expect(account.cash_balance_usd).toBe(125);
    expect(reconciled.cash_balance_usd).toBe(125);
    expect(gl).toHaveLength(2);
    expect(gl.map((entry) => entry.account_code)).toEqual(expect.arrayContaining(['1000', '3900']));
  });

  it('creates scheduled funding rules and applies due runs once', () => {
    const user = userRepo.createUser({
      email: `sim-funding-rule-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(user.id, {
      applicationTimezone: 'UTC',
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 50,
    });
    simulationModeService.startSimulation(user.id);

    const { rule } = simulationCashFunding.createFundingRule(user.id, {
      amountUsd: 10,
      cadence: 'daily',
      timeOfDay: '09:00',
      runNow: false,
      memo: 'daily test add',
    });
    expect(rule.status).toBe('active');

    const result = simulationCashFunding.applyDueFunding(user.id, new Date('2100-01-01T10:00:00Z'));
    const funding = simulationCashFunding.getDashboardFunding(user.id);

    expect(result.applied).toHaveLength(1);
    expect(funding.totalAddedUsd).toBe(10);
    expect(funding.rules[0].status).toBe('active');
    expect(funding.rules[0].next_run_at).toBeTruthy();
  });
});
