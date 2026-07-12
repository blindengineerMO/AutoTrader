const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-paper-broker-failure-injection.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const PaperBrokerClient = require('../src/services/broker/PaperBrokerClient');

function newUser() {
  return userRepo.createUser({
    email: `paper-injection-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

describe('PaperBrokerClient failure injection', () => {
  it('is disabled by default: no rejects, no latency, no outage', async () => {
    const broker = new PaperBrokerClient({ userId: newUser(), startingCashUsd: 1000 });
    await broker.connect();
    const result = await broker.placeMarketOrder({ clientOrderId: 'ok-1', symbol: 'AAPL', side: 'buy', quantity: 1, price: 100 });
    expect(result.status).toBe('filled');
  });

  it('forces a reject when rejectRate is 1', async () => {
    const broker = new PaperBrokerClient({ userId: newUser(), startingCashUsd: 1000, failureInjection: { rejectRate: 1 } });
    await broker.connect();
    const result = await broker.placeMarketOrder({ clientOrderId: 'reject-1', symbol: 'AAPL', side: 'buy', quantity: 1, price: 100 });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/Simulated failure injection/);
  });

  it('adds the configured latency before an order resolves', async () => {
    const broker = new PaperBrokerClient({ userId: newUser(), startingCashUsd: 1000, failureInjection: { latencyMs: 50 } });
    await broker.connect();
    const start = Date.now();
    await broker.placeMarketOrder({ clientOrderId: 'latency-1', symbol: 'AAPL', side: 'buy', quantity: 1, price: 100 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('throws a simulated outage error for calls inside an outage window', async () => {
    const now = new Date();
    const broker = new PaperBrokerClient({
      userId: newUser(),
      startingCashUsd: 1000,
      failureInjection: { outageWindows: [{ start: new Date(now.getTime() - 60000), end: new Date(now.getTime() + 60000) }] },
    });
    await expect(broker.connect()).rejects.toThrow(/Simulated broker outage/);
  });

  it('does not throw for calls outside any outage window', async () => {
    const now = new Date();
    const broker = new PaperBrokerClient({
      userId: newUser(),
      startingCashUsd: 1000,
      failureInjection: { outageWindows: [{ start: new Date(now.getTime() - 120000), end: new Date(now.getTime() - 60000) }] },
    });
    await expect(broker.connect()).resolves.toBe(true);
  });

  it('is force-disabled in production regardless of configuration', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const broker = new PaperBrokerClient({ userId: newUser(), startingCashUsd: 1000, failureInjection: { rejectRate: 1 } });
      await broker.connect();
      const result = await broker.placeMarketOrder({ clientOrderId: 'prod-1', symbol: 'AAPL', side: 'buy', quantity: 1, price: 100 });
      expect(result.status).toBe('filled');
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
