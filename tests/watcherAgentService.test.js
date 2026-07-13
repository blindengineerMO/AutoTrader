const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-watcher-agent.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const watcherAgentRepo = require('../src/db/repositories/watcherAgentRepo');
const watcherAgentService = require('../src/services/watcherAgentService');
const brainMesh = require('../src/services/brainMeshService');

function newUser() {
  return userRepo.createUser({
    email: `watcher-agent-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

describe('watcherAgentService.classifyPriceTier', () => {
  it('classifies prices under $20 as priority', () => {
    expect(watcherAgentService.classifyPriceTier(19.99)).toBe('priority');
    expect(watcherAgentService.classifyPriceTier(0.5)).toBe('priority');
  });

  it('classifies $20 and above as standard', () => {
    expect(watcherAgentService.classifyPriceTier(20)).toBe('standard');
    expect(watcherAgentService.classifyPriceTier(150)).toBe('standard');
  });

  it('falls back to standard for non-numeric price input', () => {
    expect(watcherAgentService.classifyPriceTier(undefined)).toBe('standard');
    expect(watcherAgentService.classifyPriceTier(null)).toBe('standard');
    expect(watcherAgentService.classifyPriceTier('n/a')).toBe('standard');
  });
});

describe('watcherAgentService.ensureWatcherAgent', () => {
  it('creates a new watcher agent on first sighting of a symbol', () => {
    const userId = newUser();
    const agent = watcherAgentService.ensureWatcherAgent(userId, {
      symbol: 'ABCD',
      companyName: 'ABC Corp',
      price: 12.5,
    });

    expect(agent.symbol).toBe('ABCD');
    expect(agent.company_name).toBe('ABC Corp');
    expect(agent.price_tier).toBe('priority');
    expect(agent.status).toBe('active');
    expect(agent.brain_id).toBe('agent.watcher.abcd');
  });

  it('is idempotent on repeat sightings of the same symbol', () => {
    const userId = newUser();
    const first = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'XYZ', companyName: 'XYZ Inc', price: 50 });
    const second = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'XYZ', companyName: 'XYZ Inc', price: 55 });

    expect(second.id).toBe(first.id);
    expect(watcherAgentRepo.listActiveByUser(userId)).toHaveLength(1);
    expect(second.price_tier).toBe('standard');
  });

  it('registers the watcher agent with BrainMesh', () => {
    const userId = newUser();
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'MESH', companyName: 'Mesh Co', price: 5 });

    const meshAgents = brainMesh.listAgents(userId);
    const meshAgent = meshAgents.find((a) => a.id === 'agent.watcher.mesh');
    expect(meshAgent).toBeDefined();
    expect(meshAgent.role).toBe('company-watcher');
  });

  it('throws when userId or symbol is missing', () => {
    expect(() => watcherAgentService.ensureWatcherAgent(null, { symbol: 'AAA' })).toThrow();
    expect(() => watcherAgentService.ensureWatcherAgent(1, {})).toThrow();
  });
});

describe('watcherAgentService sibling peer signals', () => {
  it('registers a watcher.research.shared handler per watcher agent that persists sibling signals via peer_signal_json', () => {
    const userId = newUser();
    const nvda = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'NVDA', companyName: 'NVIDIA', price: 120 });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'AMD', companyName: 'AMD', price: 90 });

    brainMesh.tell({
      from: 'agent.watcher.amd',
      to: nvda.brain_id,
      kind: 'event',
      op: 'watcher.research.shared',
      ctx: { userId },
      body: { symbol: 'AMD', predictedAction: 'buy', localAiScore: 72 },
    });

    const signals = watcherAgentRepo.listPeerSignals(nvda.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ symbol: 'AMD', predictedAction: 'buy', localAiScore: 72 });
    expect(signals[0].receivedAt).toBeDefined();
  });

  it('caps stored peer signals to the most recent 5', () => {
    const userId = newUser();
    const nvda = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'CAPD', companyName: 'Cap Co', price: 20 });

    for (let i = 0; i < 8; i += 1) {
      brainMesh.tell({
        from: 'agent.watcher.other',
        to: nvda.brain_id,
        kind: 'event',
        op: 'watcher.research.shared',
        ctx: { userId },
        body: { symbol: 'OTHER', predictedAction: 'buy', localAiScore: i },
      });
    }

    const signals = watcherAgentRepo.listPeerSignals(nvda.id);
    expect(signals).toHaveLength(5);
    expect(signals.map((s) => s.localAiScore)).toEqual([3, 4, 5, 6, 7]);
  });
});

describe('watcherAgentRepo scorecard', () => {
  it('aggregates praise/punish grades into a ratio', () => {
    const userId = newUser();
    const agent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'GRAD', companyName: 'Grade Co', price: 10 });

    const run1 = watcherAgentRepo.recordResearchRun({
      watcherAgentId: agent.id,
      userId,
      symbol: 'GRAD',
      priceAtResearch: 10,
      predictedAction: 'buy-candidate',
      localAiScore: 70,
      rationale: { note: 'test' },
    });
    const run2 = watcherAgentRepo.recordResearchRun({
      watcherAgentId: agent.id,
      userId,
      symbol: 'GRAD',
      priceAtResearch: 10.5,
      predictedAction: 'sell-or-avoid',
      localAiScore: 30,
      rationale: { note: 'test2' },
    });

    watcherAgentRepo.recordGrade({
      watcherAgentId: agent.id,
      researchRunId: run1.id,
      userId,
      symbol: 'GRAD',
      predictedAction: 'buy-candidate',
      startPrice: 10,
      closePrice: 10.8,
      returnPct: 8,
      verdict: 'praise',
      rationale: 'correct within margin',
    });
    watcherAgentRepo.recordGrade({
      watcherAgentId: agent.id,
      researchRunId: run2.id,
      userId,
      symbol: 'GRAD',
      predictedAction: 'sell-or-avoid',
      startPrice: 10.5,
      closePrice: 11.2,
      returnPct: 6.7,
      verdict: 'punish',
      rationale: 'wrong direction',
    });

    const scorecard = watcherAgentRepo.getScorecard(agent.id);
    expect(scorecard.totalGraded).toBe(2);
    expect(scorecard.praiseCount).toBe(1);
    expect(scorecard.punishCount).toBe(1);
    expect(scorecard.ratio).toBe(0.5);

    expect(watcherAgentRepo.getById(userId, run1.watcher_agent_id).id).toBe(agent.id);
    const reloadedRun1 = watcherAgentRepo.listResearchRuns(agent.id, 10).find((r) => r.id === run1.id);
    expect(reloadedRun1.graded).toBe(1);
  });

  it('returns null ratio when no grades exist yet', () => {
    const userId = newUser();
    const agent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'NEWA', companyName: 'New Co', price: 8 });
    const scorecard = watcherAgentRepo.getScorecard(agent.id);
    expect(scorecard.totalGraded).toBe(0);
    expect(scorecard.ratio).toBeNull();
  });
});
