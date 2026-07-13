const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-sim-reconciliation.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const orderRepo = require('../src/db/repositories/orderRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const { reconcileSimulationAccount } = require('../src/services/simulationAccountReconciliationService');

function fillSimulatedOrder({ userId, brokerAccountId, symbol, side, quantity, fillPrice }) {
  const order = orderRepo.create({
    userId,
    brokerAccountId,
    planActionId: null,
    symbol,
    side,
    quantity,
    orderType: 'simulated_market',
    status: 'submitted',
    brokerOrderId: `sim-${Date.now()}-${Math.random()}`,
  });
  orderRepo.markFilled(order.id, fillPrice);
}

describe('simulationAccountReconciliationService.reconcileSimulationAccount', () => {
  let userId;
  let brokerAccountId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `sim-reconcile-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    brokerAccountId = brokerAccountRepo.ensureDefault(userId).id;
  });

  it('leaves the account untouched when simulation mode is disabled', () => {
    settingsRepo.update(userId, { simulationModeEnabled: 0 });
    const account = reconcileSimulationAccount(userId);
    expect(account.status).toBe('not_connected');
  });

  it('sets cash balance to the starting cash when no simulated orders have filled yet', () => {
    settingsRepo.update(userId, { simulationModeEnabled: 1, simulationStartingCashUsd: 10000 });
    const account = reconcileSimulationAccount(userId);
    expect(account.status).toBe('simulation');
    expect(account.cash_balance_usd).toBe(10000);
  });

  it('debits cash for a filled buy and credits cash for a filled sell', () => {
    fillSimulatedOrder({ userId, brokerAccountId, symbol: 'AAPL', side: 'buy', quantity: 10, fillPrice: 100 });
    let account = reconcileSimulationAccount(userId);
    expect(account.cash_balance_usd).toBe(10000 - 1000);

    fillSimulatedOrder({ userId, brokerAccountId, symbol: 'AAPL', side: 'sell', quantity: 4, fillPrice: 110 });
    account = reconcileSimulationAccount(userId);
    expect(account.cash_balance_usd).toBe(10000 - 1000 + 440);
  });

  it('ignores orders that are not filled simulated_market orders', () => {
    const before = reconcileSimulationAccount(userId).cash_balance_usd;

    const liveOrder = orderRepo.create({
      userId,
      brokerAccountId,
      planActionId: null,
      symbol: 'MSFT',
      side: 'buy',
      quantity: 5,
      orderType: 'market',
      status: 'filled',
      brokerOrderId: `live-${Date.now()}`,
    });
    orderRepo.markFilled(liveOrder.id, 300);

    const pendingSimOrder = orderRepo.create({
      userId,
      brokerAccountId,
      planActionId: null,
      symbol: 'TSLA',
      side: 'buy',
      quantity: 2,
      orderType: 'simulated_market',
      status: 'submitted',
      brokerOrderId: `pending-sim-${Date.now()}`,
    });
    expect(pendingSimOrder.status).toBe('submitted');

    const after = reconcileSimulationAccount(userId);
    expect(after.cash_balance_usd).toBe(before);
  });

  it('is idempotent: calling it twice in a row without new fills does not change the balance', () => {
    const first = reconcileSimulationAccount(userId);
    const second = reconcileSimulationAccount(userId);
    expect(second.cash_balance_usd).toBe(first.cash_balance_usd);
  });
});
