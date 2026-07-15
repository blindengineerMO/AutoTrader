const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-watcher-theme-learning.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const watcherAgentRepo = require('../src/db/repositories/watcherAgentRepo');
const brainMesh = require('../src/services/brainMeshService');
const watcherAgentService = require('../src/services/watcherAgentService');
const watcherBehaviorService = require('../src/services/watcherBehaviorService');
const db = require('../src/db/connection');

describe('watcher theme tagging and learning weights', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `watcher-theme-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.prepare('DELETE FROM watcher_agent_grades').run();
    db.prepare('DELETE FROM watcher_agent_research_runs').run();
    db.prepare('DELETE FROM watcher_agents').run();
  });

  it('persists the candidate theme at creation and does not clobber it on a themeless upsert', () => {
    const created = watcherAgentService.ensureWatcherAgent(userId, {
      symbol: 'NVDA',
      companyName: 'NVIDIA',
      price: 500,
      theme: 'semiconductors',
    });
    expect(created.theme).toBe('semiconductors');

    const reupserted = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'NVDA' });
    expect(reupserted.theme).toBe('semiconductors');
  });

  it('prefers same-theme siblings in chat, still capped at three', () => {
    const source = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'NVDA', theme: 'semiconductors' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'JPM', theme: 'financials' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'XOM', theme: 'energy' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'AMD', theme: 'semiconductors' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'AVGO', theme: 'semiconductors' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'MU', theme: 'semiconductors' });

    const tells = [];
    vi.spyOn(brainMesh, 'tell').mockImplementation((frame) => tells.push(frame));

    const all = watcherAgentRepo.listActiveByUser(userId);
    const run = { predicted_action: 'buy', local_ai_score: 70, rationale: {} };
    watcherAgentService.chatWithSiblingWatchers(userId, all.find((a) => a.symbol === 'NVDA'), run, all);

    expect(tells).toHaveLength(3);
    const targetBrainIds = tells.map((frame) => frame.to);
    const targets = all.filter((agent) => targetBrainIds.includes(agent.brain_id));
    expect(targets.every((agent) => agent.theme === 'semiconductors')).toBe(true);
    expect(tells.every((frame) => frame.body.theme === 'semiconductors' && frame.body.sameTheme)).toBe(true);
    expect(source.theme).toBe('semiconductors');
  });

  it('falls back to other watchers when there are not enough same-theme siblings', () => {
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'NVDA', theme: 'semiconductors' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'AMD', theme: 'semiconductors' });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'JPM', theme: 'financials' });

    const tells = [];
    vi.spyOn(brainMesh, 'tell').mockImplementation((frame) => tells.push(frame));

    const all = watcherAgentRepo.listActiveByUser(userId);
    watcherAgentService.chatWithSiblingWatchers(userId, all.find((a) => a.symbol === 'NVDA'), { predicted_action: 'buy', local_ai_score: 70, rationale: {} }, all);

    expect(tells).toHaveLength(2);
    const sameThemeFirst = all.find((agent) => agent.brain_id === tells[0].to);
    expect(sameThemeFirst.theme).toBe('semiconductors');
  });

  it('raises, lowers, and clamps watcher learning weights from grade history', () => {
    const winner = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'GOOD', theme: 'energy' });
    const loser = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'BAD', theme: 'energy' });
    const rookie = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'NEW', theme: 'energy' });

    const seedGrade = (agent, verdict) => {
      const run = watcherAgentRepo.recordResearchRun({
        watcherAgentId: agent.id,
        userId,
        symbol: agent.symbol,
        priceAtResearch: 100,
        predictedAction: 'buy',
        localAiScore: 60,
        rationale: {},
      });
      return watcherAgentRepo.recordGrade({
      watcherAgentId: agent.id,
      researchRunId: run.id,
      userId,
      symbol: agent.symbol,
      predictedAction: 'buy',
      startPrice: 100,
      closePrice: verdict === 'praise' ? 105 : 95,
      returnPct: verdict === 'praise' ? 5 : -5,
      verdict,
      rationale: 'test seed',
      });
    };

    for (let i = 0; i < 4; i += 1) seedGrade(winner, 'praise');
    for (let i = 0; i < 4; i += 1) seedGrade(loser, 'punish');
    seedGrade(rookie, 'praise');

    vi.spyOn(brainMesh, 'tell').mockImplementation(() => {});
    watcherBehaviorService.updateWatcherLearningWeights(userId);

    expect(watcherAgentRepo.getById(userId, winner.id).learning_weight).toBeCloseTo(1.1, 4);
    expect(watcherAgentRepo.getById(userId, loser.id).learning_weight).toBeCloseTo(0.9, 4);
    expect(watcherAgentRepo.getById(userId, rookie.id).learning_weight).toBe(1.0);

    for (let i = 0; i < 10; i += 1) watcherBehaviorService.updateWatcherLearningWeights(userId);
    expect(watcherAgentRepo.getById(userId, winner.id).learning_weight).toBeLessThanOrEqual(1.5);
    expect(watcherAgentRepo.getById(userId, loser.id).learning_weight).toBeGreaterThanOrEqual(0.5);
  });

  it('multiplies the watcher learning weight into the research score', async () => {
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'WGT', theme: 'energy' });
    const agent = watcherAgentRepo.getBySymbol(userId, 'WGT');
    watcherAgentRepo.updateLearningWeight(agent.id, 1.5);

    const autonomousResearch = require('../src/services/autonomousResearchService');
    const companyIntelligence = require('../src/services/companyIntelligenceService');
    vi.spyOn(autonomousResearch, 'collectQuotes').mockResolvedValue([{ symbol: 'WGT', current: 50 }]);
    vi.spyOn(companyIntelligence, 'researchCompanies').mockResolvedValue({ records: [] });
    vi.spyOn(autonomousResearch, 'scoreCandidates').mockReturnValue([{
      symbol: 'WGT',
      localAiScore: 60,
      actionBias: 'buy',
      price: 50,
      theme: 'energy',
      priceTierBonusApplied: 0,
      evidence: { explanation: 'test' },
    }]);
    vi.spyOn(brainMesh, 'tell').mockImplementation(() => {});

    const run = await watcherAgentService.researchOneAgent(userId, watcherAgentRepo.getBySymbol(userId, 'WGT'));

    expect(run.local_ai_score).toBe(90);
    expect(run.rationale.learningWeight).toBe(1.5);
  });
});
