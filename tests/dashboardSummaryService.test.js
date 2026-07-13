const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-dashboard-summary.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const researchRepo = require('../src/db/repositories/researchRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const MockBrokerClient = require('../src/services/broker/MockBrokerClient');
const simulationModeService = require('../src/services/simulationModeService');
const { runTradingCycle } = require('../src/services/tradingCycle');
const dashboardSummary = require('../src/services/dashboardSummaryService');

const stubGeneratePlan = async () => ({
  modelUsed: 'stub:test-model',
  raw: {
    actions: [
      { symbol: 'NVDA', action: 'buy', quantity: 1, rationale: 'simulation dashboard candidate' },
    ],
    overallRationale: 'Simulation should show as account state.',
  },
});

const stubRunResearchCycle = (_watchlist, { userId } = {}) =>
  researchRepo.create({
    userId,
    source: 'stub',
    summary: { watchlist: ['NVDA'] },
    signals: [
      { symbol: 'NVDA', price: 100, changePct: 3, volatilityPct: 2, momentum: 'bullish' },
    ],
  });

describe('dashboardSummaryService', () => {
  it('marks persistent simulation positions into dashboard cash, equity, P&L, orders, and position widgets', async () => {
    const user = userRepo.createUser({
      email: `dashboard-sim-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(user.id, {
      tradingEnabled: 0,
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 150,
    });
    simulationModeService.startSimulation(user.id);

    await runTradingCycle({
      userId: user.id,
      broker: new MockBrokerClient({ startingCashUsd: 150 }),
      runResearchCycle: stubRunResearchCycle,
      generatePlan: stubGeneratePlan,
      executionMode: 'auto',
    });

    const summary = await dashboardSummary.buildDashboardSummary(user.id, {
      quoteProvider: {
        getQuotes: async () => [{ symbol: 'NVDA', current: 120, source: 'test-quote' }],
      },
    });

    expect(summary.operatingMode).toBe('simulation');
    expect(summary.brokerAccount.cash_balance_usd).toBe(50);
    expect(summary.recentOrders).toHaveLength(1);
    expect(summary.recentOrders[0].order_type).toBe('simulated_market');
    expect(summary.positions).toHaveLength(1);
    expect(summary.positions[0].market_price_usd).toBe(120);
    expect(summary.positions[0].market_value_usd).toBe(120);
    expect(summary.positions[0].unrealized_pnl_usd).toBe(20);
    expect(summary.positionsMarketValueUsd).toBe(120);
    expect(summary.portfolioValueUsd).toBe(170);
    expect(summary.todaysPnl).toBe(20);
  });

  it('reconciles stale persistent simulation cash from filled simulated orders', async () => {
    const user = userRepo.createUser({
      email: `dashboard-sim-reconcile-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(user.id, {
      tradingEnabled: 0,
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 100,
    });
    simulationModeService.startSimulation(user.id);

    const fordPlan = async () => ({
      modelUsed: 'stub:test-model',
      raw: {
        actions: [{ symbol: 'F', action: 'buy', quantity: 1, rationale: 'cash reconcile candidate' }],
        overallRationale: 'Regression for persistent simulation cash.',
      },
    });
    const fordResearch = (_watchlist, { userId } = {}) =>
      researchRepo.create({
        userId,
        source: 'stub',
        summary: { watchlist: ['F'] },
        signals: [{ symbol: 'F', price: 14, changePct: 1, volatilityPct: 1, momentum: 'bullish' }],
      });

    await runTradingCycle({
      userId: user.id,
      broker: new MockBrokerClient({ startingCashUsd: 100 }),
      runResearchCycle: fordResearch,
      generatePlan: fordPlan,
      executionMode: 'auto',
    });
    await runTradingCycle({
      userId: user.id,
      broker: new MockBrokerClient({ startingCashUsd: 100 }),
      runResearchCycle: fordResearch,
      generatePlan: fordPlan,
      executionMode: 'auto',
    });

    const account = brokerAccountRepo.getDefault(user.id);
    brokerAccountRepo.updateBalance(account.id, 86, 86, 'simulation');

    const summary = await dashboardSummary.buildDashboardSummary(user.id, {
      quoteProvider: {
        getQuotes: async () => [{ symbol: 'F', current: 14, source: 'test-quote' }],
      },
    });

    expect(summary.brokerAccount.cash_balance_usd).toBe(72);
    expect(summary.positions[0].quantity).toBe(2);
    expect(summary.positions[0].cost_basis_usd).toBe(28);
    expect(brokerAccountRepo.getDefault(user.id).cash_balance_usd).toBe(72);
  });
});
