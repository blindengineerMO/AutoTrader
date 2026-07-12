const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-trading-cycle.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const stubGeneratePlan = async () => ({
  modelUsed: 'stub:test-model',
  raw: {
    actions: [
      { symbol: 'NVDA', action: 'buy', quantity: 1, rationale: 'strong momentum' },
      { symbol: 'AAPL', action: 'hold', quantity: null, rationale: 'no signal' },
    ],
    overallRationale: 'Momentum favors NVDA today',
  },
});

const userRepo = require('../src/db/repositories/userRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const positionRepo = require('../src/db/repositories/positionRepo');
const orderRepo = require('../src/db/repositories/orderRepo');
const pnlRepo = require('../src/db/repositories/pnlRepo');
const researchRepo = require('../src/db/repositories/researchRepo');
const decisionReportRepo = require('../src/db/repositories/decisionReportRepo');
const MockBrokerClient = require('../src/services/broker/MockBrokerClient');
const { runTradingCycle } = require('../src/services/tradingCycle');

// research_snapshot_id is a real FK on trading_plans, so the stub must
// actually persist a snapshot rather than fabricating an id.
const stubRunResearchCycleFactory = () =>
  researchRepo.create({
    source: 'stub',
    summary: { watchlist: ['NVDA', 'AAPL'] },
    signals: [
      { symbol: 'NVDA', price: 100, changePct: 3, volatilityPct: 2, momentum: 'bullish' },
      { symbol: 'AAPL', price: 50, changePct: -0.2, volatilityPct: 1, momentum: 'neutral' },
    ],
  });

describe('runTradingCycle (mocked research + AI + broker)', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `cycle-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    settingsRepo.update(userId, { tradingEnabled: 1 });
  });

  it('executes the buy action, skips the hold action, and updates positions/orders/pnl', async () => {
    const broker = new MockBrokerClient({ startingCashUsd: 100 });
    const plan = await runTradingCycle({
      userId,
      broker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: stubGeneratePlan,
      executionMode: 'live',
    });

    expect(plan.status).toBe('validated');
    const buyAction = plan.actions.find((a) => a.symbol === 'NVDA');
    const holdAction = plan.actions.find((a) => a.symbol === 'AAPL');
    expect(buyAction.status).toBe('executed');
    expect(holdAction.status).toBe('skipped_hold');

    const positions = positionRepo.listByUser(userId);
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('NVDA');
    expect(positions[0].quantity).toBe(1);

    const orders = orderRepo.listByUser(userId, 10);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('filled');

    const accountState = await broker.getAccountState();
    expect(accountState.cashUsd).toBe(0); // 100 cash - 1 * $100 fill price
  });

  it('blocks further buys on the same symbol once the per-symbol 24h limit is hit', async () => {
    const broker = new MockBrokerClient({ startingCashUsd: 1000 });
    const stubs = { runResearchCycle: stubRunResearchCycleFactory, generatePlan: stubGeneratePlan, executionMode: 'live' };
    // Run 2 more cycles to reach the 3-trade limit on NVDA, then a 4th should be blocked.
    await runTradingCycle({ userId, broker, ...stubs });
    const thirdPlan = await runTradingCycle({ userId, broker, ...stubs });
    const fourthPlan = await runTradingCycle({ userId, broker, ...stubs });

    const ordersForNvda = orderRepo.countRecentForSymbol(userId, 'NVDA');
    expect(ordersForNvda).toBe(3);

    const fourthBuyAction = fourthPlan.actions.find((a) => a.symbol === 'NVDA');
    expect(fourthBuyAction.status).toMatch(/^blocked:/);
  });

  it('runs in simulation mode by default and writes a decision report without placing orders', async () => {
    const simUser = userRepo.createUser({
      email: `cycle-sim-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const broker = new MockBrokerClient({ startingCashUsd: 100 });
    const plan = await runTradingCycle({
      userId: simUser.id,
      broker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: stubGeneratePlan,
    });

    expect(plan.execution_mode).toBe('simulation');
    expect(plan.actions.find((a) => a.symbol === 'NVDA').status).toBe('simulated_would_buy');
    expect(orderRepo.listByUser(simUser.id, 10)).toHaveLength(0);

    const [report] = decisionReportRepo.listByUser(simUser.id, 1);
    expect(report.mode).toBe('simulation');
    expect(report.summary.actions[0].evidence.momentum).toBe('bullish');
  });
});
