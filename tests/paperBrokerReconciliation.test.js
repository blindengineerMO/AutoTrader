const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-paper-broker.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const positionRepo = require('../src/db/repositories/positionRepo');
const specRepo = require('../src/db/repositories/specResearchRepo');
const PaperBrokerClient = require('../src/services/broker/PaperBrokerClient');
const { reconcilePaperRun } = require('../src/services/spec/reconciliationService');

describe('paper broker reconciliation', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `paper-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('submits paper orders idempotently and reconciles filled positions', async () => {
    const runId = 'paper-run-ok';
    specRepo.savePaperOrderIntents({
      userId,
      runId,
      intents: [{
        clientOrderId: 'client-1',
        symbol: 'AAPL',
        side: 'buy',
        quantity: 2,
        limitPrice: 100,
        notionalUsd: 200,
        status: 'planned',
      }],
    });

    const broker = new PaperBrokerClient({ userId, startingCashUsd: 1000 });
    await broker.connect();
    const first = await broker.placeMarketOrder({ runId, clientOrderId: 'client-1', symbol: 'AAPL', side: 'buy', quantity: 2, price: 100 });
    const retry = await broker.placeMarketOrder({ runId, clientOrderId: 'client-1', symbol: 'AAPL', side: 'buy', quantity: 2, price: 100 });

    expect(first.status).toBe('filled');
    expect(retry.idempotent).toBe(true);
    expect(brokerAccountRepo.getDefault(userId, 'paper').cash_balance_usd).toBe(800);
    expect(positionRepo.listByUser(userId).find((position) => position.symbol === 'AAPL').quantity).toBe(2);

    const reconciliation = reconcilePaperRun({ userId, runId });
    expect(reconciliation.status).toBe('ok');
    expect(reconciliation.differences).toEqual([]);
  });

  it('flags missing submitted paper orders for planned intents', () => {
    const runId = 'paper-run-missing';
    specRepo.savePaperOrderIntents({
      userId,
      runId,
      intents: [{
        clientOrderId: 'client-missing',
        symbol: 'MSFT',
        side: 'buy',
        quantity: 1,
        notionalUsd: 50,
        status: 'planned',
      }],
    });

    const reconciliation = reconcilePaperRun({ userId, runId });
    expect(reconciliation.status).toBe('fail');
    expect(reconciliation.differences[0].difference_type).toBe('missing_paper_order');
  });
});
