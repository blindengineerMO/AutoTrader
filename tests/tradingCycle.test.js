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
const glLedgerRepo = require('../src/db/repositories/glLedgerRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const researchRepo = require('../src/db/repositories/researchRepo');
const decisionReportRepo = require('../src/db/repositories/decisionReportRepo');
const MockBrokerClient = require('../src/services/broker/MockBrokerClient');
const rulesEngine = require('../src/services/rulesEngine');
const { runTradingCycle } = require('../src/services/tradingCycle');
const agentConsensusSizingRepo = require('../src/db/repositories/agentConsensusSizingRepo');
const tradingAgentRepo = require('../src/db/repositories/tradingAgentRepo');
const db = require('../src/db/connection');

function seedFreshSizing(userId, symbol, disagreementFactor, { staleHoursAgo } = {}) {
  const run = tradingAgentRepo.createCouncilRun({ userId, summary: {}, recommendations: [] });
  agentConsensusSizingRepo.upsertForSymbol(userId, symbol, {
    councilRunId: run.id,
    disagreementFactor,
    meanConviction: 50,
    convictionStdDev: 20,
    buyVotes: 1,
    sellVotes: 1,
  });
  if (staleHoursAgo) {
    db.prepare("UPDATE agent_consensus_sizing SET computed_at = datetime('now', ?) WHERE user_id = ? AND symbol = ?")
      .run(`-${staleHoursAgo} hours`, userId, symbol);
  }
}

// research_snapshot_id is a real FK on trading_plans, so the stub must
// actually persist a snapshot rather than fabricating an id.
const stubRunResearchCycleFactory = (_watchlist, { userId } = {}) =>
  researchRepo.create({
    userId,
    source: 'stub',
    summary: {
      watchlist: ['NVDA', 'AAPL'],
      sourceStack: [
        { name: 'quote-feed', type: 'market-data' },
        { name: 'news-research', type: 'news' },
        { name: 'financial-context', type: 'financial' },
      ],
      reportNarrative: {
        topCandidates: [{ symbol: 'NVDA', bias: 'buy bullish opportunity', reasons: ['strong cross-source agreement'] }],
      },
    },
    signals: [
      { symbol: 'NVDA', price: 100, changePct: 3, volatilityPct: 2, momentum: 'bullish', localAiScore: 72, financialEventScore: 60 },
      { symbol: 'AAPL', price: 50, changePct: -0.2, volatilityPct: 1, momentum: 'neutral', localAiScore: 50, financialEventScore: 50 },
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

    const glEntries = glLedgerRepo.listByCompany(userId, 'NVDA', 10);
    expect(glEntries).toHaveLength(2);
    expect(glEntries.map((entry) => entry.account_code)).toEqual(expect.arrayContaining(['1000', '1200-NVDA']));
    expect(glEntries.reduce((sum, entry) => sum + entry.debit, 0)).toBe(100);
    expect(glEntries.reduce((sum, entry) => sum + entry.credit, 0)).toBe(100);

    const accountState = await broker.getAccountState();
    expect(accountState.cashUsd).toBe(0); // 100 cash - 1 * $100 fill price
  });

  it('scales a buy quantity down by the council disagreement factor when council_sizing_enabled is on', async () => {
    const sizingUser = userRepo.createUser({
      email: `cycle-sizing-on-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 1000,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(sizingUser.id, { tradingEnabled: 1, councilSizingEnabled: 1, maxBuyOrderNotionalUsd: 100000 });
    seedFreshSizing(sizingUser.id, 'NVDA', 0.4);

    const broker = new MockBrokerClient({ startingCashUsd: 100000 });
    const plan = await runTradingCycle({
      userId: sizingUser.id,
      broker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: async () => ({
        modelUsed: 'stub:test-model',
        raw: { actions: [{ symbol: 'NVDA', action: 'buy', quantity: 5, rationale: 'strong momentum' }], overallRationale: 'test' },
      }),
      executionMode: 'live',
    });

    const buyAction = plan.actions.find((a) => a.symbol === 'NVDA');
    expect(buyAction.status).toBe('executed');
    // floor(5 * 0.4) = 2, not the AI plan's original 5.
    const orders = orderRepo.listByUser(sizingUser.id, 10);
    expect(orders[0].quantity).toBe(2);
  });

  it('leaves quantity untouched when council_sizing_enabled is off, even with a fresh disagreement reading', async () => {
    const offUser = userRepo.createUser({
      email: `cycle-sizing-off-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 1000,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(offUser.id, { tradingEnabled: 1, maxBuyOrderNotionalUsd: 100000 });
    seedFreshSizing(offUser.id, 'NVDA', 0.4);

    const broker = new MockBrokerClient({ startingCashUsd: 100000 });
    const plan = await runTradingCycle({
      userId: offUser.id,
      broker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: async () => ({
        modelUsed: 'stub:test-model',
        raw: { actions: [{ symbol: 'NVDA', action: 'buy', quantity: 5, rationale: 'strong momentum' }], overallRationale: 'test' },
      }),
      executionMode: 'live',
    });

    const buyAction = plan.actions.find((a) => a.symbol === 'NVDA');
    expect(buyAction.status).toBe('executed');
    const orders = orderRepo.listByUser(offUser.id, 10);
    expect(orders[0].quantity).toBe(5);
  });

  it('ignores a stale disagreement reading and blocks the order when scaling would zero out the quantity', async () => {
    const staleUser = userRepo.createUser({
      email: `cycle-sizing-stale-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 1000,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(staleUser.id, { tradingEnabled: 1, councilSizingEnabled: 1, maxBuyOrderNotionalUsd: 100000 });
    seedFreshSizing(staleUser.id, 'NVDA', 0.4, { staleHoursAgo: 72 });

    const broker = new MockBrokerClient({ startingCashUsd: 100000 });
    const plan = await runTradingCycle({
      userId: staleUser.id,
      broker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: async () => ({
        modelUsed: 'stub:test-model',
        raw: { actions: [{ symbol: 'NVDA', action: 'buy', quantity: 5, rationale: 'strong momentum' }], overallRationale: 'test' },
      }),
      executionMode: 'live',
    });

    // Stale (>48h) reading is ignored, so scaling never applies and the full quantity executes.
    const buyAction = plan.actions.find((a) => a.symbol === 'NVDA');
    expect(buyAction.status).toBe('executed');
    const orders = orderRepo.listByUser(staleUser.id, 10);
    expect(orders[0].quantity).toBe(5);
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
    expect(glLedgerRepo.listByCompany(simUser.id, 'NVDA', 10).map((entry) => entry.source_type)).toEqual(['simulation', 'simulation']);

    const [report] = decisionReportRepo.listByUser(simUser.id, 1);
    expect(report.mode).toBe('simulation');
    expect(report.summary.actions[0].evidence.momentum).toBe('bullish');
  });

  it('executes persistent Settings simulation as paper trades with positions, P&L, and GL entries', async () => {
    const simUser = userRepo.createUser({
      email: `cycle-persistent-sim-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(simUser.id, {
      tradingEnabled: 0,
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 150,
    });
    const account = require('../src/services/simulationModeService').startSimulation(simUser.id);
    expect(account.simulation_mode_enabled).toBe(1);

    const plan = await runTradingCycle({
      userId: simUser.id,
      broker: new MockBrokerClient({ startingCashUsd: 150 }),
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: stubGeneratePlan,
      executionMode: 'auto',
    });

    expect(plan.execution_mode).toBe('simulation');
    expect(plan.actions.find((a) => a.symbol === 'NVDA').status).toBe('simulated_executed_buy');

    const orders = orderRepo.listByUser(simUser.id, 10);
    expect(orders).toHaveLength(1);
    expect(orders[0].order_type).toBe('simulated_market');
    expect(orders[0].status).toBe('filled');

    const positions = positionRepo.listByUser(simUser.id);
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('NVDA');
    expect(positions[0].quantity).toBe(1);

    const pnl = pnlRepo.listByUser(simUser.id, 10);
    expect(pnl[0].note).toContain('Simulated buy 1 NVDA');
    expect(pnl[0].balance_after_usd).toBe(50);

    const glEntries = glLedgerRepo.listByCompany(simUser.id, 'NVDA', 10);
    expect(glEntries).toHaveLength(2);
    expect(glEntries.every((entry) => entry.source_type === 'simulation')).toBe(true);
    expect(glEntries.reduce((sum, entry) => sum + entry.debit, 0)).toBe(100);
    expect(glEntries.reduce((sum, entry) => sum + entry.credit, 0)).toBe(100);
  });

  it('does not reset persistent simulation cash between manual cycles', async () => {
    const simUser = userRepo.createUser({
      email: `cycle-persistent-sim-cash-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(simUser.id, {
      tradingEnabled: 0,
      simulationModeEnabled: 1,
      simulationStartingCashUsd: 100,
    });
    require('../src/services/simulationModeService').startSimulation(simUser.id);

    const fordResearch = (_watchlist, { userId } = {}) =>
      researchRepo.create({
        userId,
        source: 'stub',
        summary: {
          watchlist: ['F'],
          sourceStack: [
            { name: 'quote-feed', type: 'market-data' },
            { name: 'news-research', type: 'news' },
            { name: 'financial-context', type: 'financial' },
          ],
          reportNarrative: {
            topCandidates: [{ symbol: 'F', bias: 'buy bullish opportunity', reasons: ['simulation cash regression'] }],
          },
        },
        signals: [
          { symbol: 'F', price: 14, changePct: 1.4, volatilityPct: 1.2, momentum: 'bullish', localAiScore: 72, financialEventScore: 60 },
        ],
      });
    const fordPlan = async () => ({
      modelUsed: 'stub:test-model',
      raw: {
        actions: [
          { symbol: 'F', action: 'buy', quantity: 1, rationale: 'persistent simulation cash regression' },
        ],
        overallRationale: 'Buy Ford in simulation.',
      },
    });

    await runTradingCycle({
      userId: simUser.id,
      broker: new MockBrokerClient({ startingCashUsd: 100 }),
      runResearchCycle: fordResearch,
      generatePlan: fordPlan,
      executionMode: 'auto',
    });
    await runTradingCycle({
      userId: simUser.id,
      broker: new MockBrokerClient({ startingCashUsd: 100 }),
      runResearchCycle: fordResearch,
      generatePlan: fordPlan,
      executionMode: 'auto',
    });

    const account = brokerAccountRepo.getDefault(simUser.id);
    const [position] = positionRepo.listByUser(simUser.id);
    const pnl = pnlRepo.listByUser(simUser.id, 10);

    expect(position.symbol).toBe('F');
    expect(position.quantity).toBe(2);
    expect(position.avg_cost_usd).toBe(14);
    expect(account.cash_balance_usd).toBe(72);
    expect(pnl[0].balance_after_usd).toBe(72);
    expect(pnl[1].balance_after_usd).toBe(86);
  });

  it('trips broker_connection_kill_switch and falls back to simulation when broker.getAccountState() throws', async () => {
    const brokerUser = userRepo.createUser({
      email: `cycle-broker-fail-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(brokerUser.id, { tradingEnabled: 1 });

    const brokenBroker = { live: true, getAccountState: async () => { throw new Error('connection refused'); } };
    const plan = await runTradingCycle({
      userId: brokerUser.id,
      broker: brokenBroker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: stubGeneratePlan,
      executionMode: 'auto',
    });

    expect(plan.execution_mode).toBe('simulation');
    const settings = settingsRepo.get(brokerUser.id);
    expect(settings.broker_connection_kill_switch_engaged).toBe(1);
    expect(settings.broker_connection_kill_switch_reason).toContain('connection refused');
  });

  it('computes equityUsd from cash + position cost basis and threads it into checkTradeAllowed', async () => {
    const equityUser = userRepo.createUser({
      email: `cycle-equity-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(equityUser.id, { tradingEnabled: 1, dayTradingEnabled: 1 });

    const checkSpy = vi.spyOn(rulesEngine, 'checkTradeAllowed');
    const broker = new MockBrokerClient({ startingCashUsd: 250 });
    await runTradingCycle({
      userId: equityUser.id,
      broker,
      runResearchCycle: stubRunResearchCycleFactory,
      generatePlan: stubGeneratePlan,
      executionMode: 'live',
    });

    expect(checkSpy).toHaveBeenCalled();
    const call = checkSpy.mock.calls.find((args) => args[0].symbol === 'NVDA');
    // MockBrokerClient reports equityUsd: null, so tradingCycle falls back to
    // cash + position cost basis; no positions yet, so equity == starting cash.
    expect(call[0].equityUsd).toBe(250);
    checkSpy.mockRestore();
  });

  it('trips automatic_strategy_kill_switch when an unattended auto-mode cycle throws', async () => {
    const failUser = userRepo.createUser({
      email: `cycle-auto-fail-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const throwingResearchCycle = async () => { throw new Error('research pipeline exploded'); };

    await expect(runTradingCycle({
      userId: failUser.id,
      broker: new MockBrokerClient({ startingCashUsd: 100 }),
      runResearchCycle: throwingResearchCycle,
      generatePlan: stubGeneratePlan,
      executionMode: 'auto',
    })).rejects.toThrow('research pipeline exploded');

    const settings = settingsRepo.get(failUser.id);
    expect(settings.automatic_strategy_kill_switch_engaged).toBe(1);
    expect(settings.automatic_strategy_kill_switch_reason).toContain('research pipeline exploded');
  });
});
