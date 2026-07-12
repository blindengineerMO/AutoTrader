const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-agent-learning.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const tradingAgentRepo = require('../src/db/repositories/tradingAgentRepo');
const agentLearningService = require('../src/services/agentLearningService');

function newUser() {
  return userRepo.createUser({
    email: `agent-learning-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

function createAgent(userId, slug) {
  return tradingAgentRepo.upsertAgent({
    userId,
    name: slug,
    slug,
    status: 'active',
    brainId: `agent.personality.${slug}`,
    persona: {},
    bias: {},
    sourceUrls: [],
    model: {},
  });
}

function seedCouncilRun(userId, agent, recs) {
  return tradingAgentRepo.createCouncilRun({
    userId,
    status: 'complete',
    summary: {},
    recommendations: recs.map((rec) => ({
      agentId: agent.id,
      symbol: rec.symbol,
      action: rec.action,
      conviction: rec.conviction || 80,
      rationale: 'test',
    })),
  });
}

function evaluationsFor(symbolsAndReturns) {
  return [
    {
      actionEvaluations: symbolsAndReturns.map(([symbol, returnPct]) => ({
        symbol,
        returnPct,
        outcome: returnPct > 0 ? 'correct' : 'incorrect',
      })),
    },
  ];
}

describe('agentLearningService.updateAgentWeightsFromEvaluations', () => {
  it('increases an agent\'s weight within bounds after a run of accurate calls', () => {
    const userId = newUser();
    const agent = createAgent(userId, 'accurate-agent');
    seedCouncilRun(userId, agent, [
      { symbol: 'AAPL', action: 'buy' },
      { symbol: 'MSFT', action: 'buy' },
      { symbol: 'GOOGL', action: 'sell' },
    ]);

    const evaluations = evaluationsFor([
      ['AAPL', 5],
      ['MSFT', 3],
      ['GOOGL', -2],
    ]);

    const results = agentLearningService.updateAgentWeightsFromEvaluations(userId, evaluations);
    const result = results.find((item) => item.agentId === agent.id);
    expect(result).toBeDefined();
    expect(result.accuracy).toBe(100);
    expect(result.newWeight).toBeGreaterThan(1);
    expect(result.newWeight).toBeLessThanOrEqual(agentLearningService.WEIGHT_CEILING);

    const reloaded = tradingAgentRepo.getAgent(userId, agent.id);
    expect(reloaded.model.learningWeight).toBe(result.newWeight);
  });

  it('decreases an agent\'s weight within bounds after a run of inaccurate calls', () => {
    const userId = newUser();
    const agent = createAgent(userId, 'inaccurate-agent');
    seedCouncilRun(userId, agent, [
      { symbol: 'AAPL', action: 'buy' },
      { symbol: 'MSFT', action: 'buy' },
      { symbol: 'GOOGL', action: 'sell' },
    ]);

    const evaluations = evaluationsFor([
      ['AAPL', -5],
      ['MSFT', -3],
      ['GOOGL', 2],
    ]);

    const results = agentLearningService.updateAgentWeightsFromEvaluations(userId, evaluations);
    const result = results.find((item) => item.agentId === agent.id);
    expect(result).toBeDefined();
    expect(result.accuracy).toBe(0);
    expect(result.newWeight).toBeLessThan(1);
    expect(result.newWeight).toBeGreaterThanOrEqual(agentLearningService.WEIGHT_FLOOR);

    const reloaded = tradingAgentRepo.getAgent(userId, agent.id);
    expect(reloaded.model.learningWeight).toBe(result.newWeight);
  });

  it('never pushes weight past the configured floor or ceiling across repeated cycles', () => {
    const userId = newUser();
    const agent = createAgent(userId, 'ceiling-agent');
    seedCouncilRun(userId, agent, [
      { symbol: 'AAPL', action: 'buy' },
      { symbol: 'MSFT', action: 'buy' },
      { symbol: 'GOOGL', action: 'buy' },
    ]);

    const evaluations = evaluationsFor([
      ['AAPL', 5],
      ['MSFT', 5],
      ['GOOGL', 5],
    ]);

    for (let i = 0; i < 20; i += 1) {
      agentLearningService.updateAgentWeightsFromEvaluations(userId, evaluations);
    }

    const reloaded = tradingAgentRepo.getAgent(userId, agent.id);
    expect(reloaded.model.learningWeight).toBeLessThanOrEqual(agentLearningService.WEIGHT_CEILING);
  });

  it('does not adjust weight when sample size is below the minimum threshold', () => {
    const userId = newUser();
    const agent = createAgent(userId, 'small-sample-agent');
    seedCouncilRun(userId, agent, [{ symbol: 'AAPL', action: 'buy' }]);

    const evaluations = evaluationsFor([['AAPL', 5]]);
    const results = agentLearningService.updateAgentWeightsFromEvaluations(userId, evaluations);
    expect(results.find((item) => item.agentId === agent.id)).toBeUndefined();

    const reloaded = tradingAgentRepo.getAgent(userId, agent.id);
    expect(reloaded.model.learningWeight).toBeUndefined();
  });
});
