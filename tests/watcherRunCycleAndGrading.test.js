const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-watcher-run-cycle.db');
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
const watcherBehaviorService = require('../src/services/watcherBehaviorService');
const autonomousResearchService = require('../src/services/autonomousResearchService');
const companyIntelligenceService = require('../src/services/companyIntelligenceService');
const webScrapeClient = require('../src/services/marketData/webScrapeClient');
const brainMesh = require('../src/services/brainMeshService');

function newUser() {
  return userRepo.createUser({
    email: `watcher-cycle-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

const originalCollectQuotes = autonomousResearchService.collectQuotes;
const originalScoreCandidates = autonomousResearchService.scoreCandidates;
const originalResearchCompanies = companyIntelligenceService.researchCompanies;
const originalGetQuotes = webScrapeClient.getQuotes;

function stubResearchPipeline({ pricesBySymbol, actionBySymbol = {} } = {}) {
  autonomousResearchService.collectQuotes = async (symbols) =>
    symbols.map((symbol) => ({ symbol, current: pricesBySymbol[symbol], changePct: 0, open: pricesBySymbol[symbol], high: pricesBySymbol[symbol], low: pricesBySymbol[symbol], prevClose: pricesBySymbol[symbol] }));
  autonomousResearchService.scoreCandidates = ({ candidates, quotes }) =>
    candidates
      .map((candidate) => {
        const quote = quotes.find((q) => q.symbol === candidate.symbol);
        if (!quote) return null;
        return {
          symbol: candidate.symbol,
          price: quote.current,
          actionBias: actionBySymbol[candidate.symbol] || 'buy-candidate',
          localAiScore: 70,
          priceTierBonusApplied: false,
          theme: 'mock-theme',
          evidence: { explanation: ['mock evidence'] },
        };
      })
      .filter(Boolean);
  companyIntelligenceService.researchCompanies = async () => [];
}

afterEach(() => {
  autonomousResearchService.collectQuotes = originalCollectQuotes;
  autonomousResearchService.scoreCandidates = originalScoreCandidates;
  companyIntelligenceService.researchCompanies = originalResearchCompanies;
  webScrapeClient.getQuotes = originalGetQuotes;
});

describe('watcherAgentService.runWatcherCycle', () => {
  it('researches priority-tier watchers every cycle and standard-tier watchers only on even cycles', async () => {
    const userId = newUser();
    const priorityAgent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'CHEAP1', companyName: 'Cheap Co', price: 10 });
    const standardAgent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'PRICEY1', companyName: 'Pricey Co', price: 100 });

    stubResearchPipeline({ pricesBySymbol: { CHEAP1: 10, PRICEY1: 100 } });

    const oddCycleRuns = await watcherAgentService.runWatcherCycle(userId, { cycleIndex: 1 });
    expect(oddCycleRuns.map((r) => r.symbol).sort()).toEqual(['CHEAP1']);

    const evenCycleRuns = await watcherAgentService.runWatcherCycle(userId, { cycleIndex: 2 });
    expect(evenCycleRuns.map((r) => r.symbol).sort()).toEqual(['CHEAP1', 'PRICEY1']);

    expect(watcherAgentRepo.listResearchRuns(priorityAgent.id, 10)).toHaveLength(2);
    expect(watcherAgentRepo.listResearchRuns(standardAgent.id, 10)).toHaveLength(1);
  });

  it('reports findings to the top-level research agent and chats with sibling watchers via BrainMesh', async () => {
    const userId = newUser();
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'ALPHA', companyName: 'Alpha Co', price: 5 });
    watcherAgentService.ensureWatcherAgent(userId, { symbol: 'BETA', companyName: 'Beta Co', price: 6 });

    stubResearchPipeline({ pricesBySymbol: { ALPHA: 5, BETA: 6 } });

    await watcherAgentService.runWatcherCycle(userId, { cycleIndex: 1 });

    const messages = brainMesh.listMessages({ userId });
    const reportedToTopLevel = messages.filter((m) => m.op === 'watcher.research.reported');
    const sharedWithSiblings = messages.filter((m) => m.op === 'watcher.research.shared');

    expect(reportedToTopLevel.length).toBeGreaterThanOrEqual(2);
    expect(sharedWithSiblings.length).toBeGreaterThanOrEqual(1);
  });

  it('never exceeds the configured concurrency cap', async () => {
    const userId = newUser();
    const symbols = Array.from({ length: 8 }, (_, i) => `SYM${i}`);
    for (const symbol of symbols) watcherAgentService.ensureWatcherAgent(userId, { symbol, companyName: symbol, price: 5 });

    let active = 0;
    let maxActive = 0;
    const pricesBySymbol = Object.fromEntries(symbols.map((s) => [s, 5]));

    autonomousResearchService.collectQuotes = async (querySymbols) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return querySymbols.map((symbol) => ({ symbol, current: pricesBySymbol[symbol], changePct: 0, open: 5, high: 5, low: 5, prevClose: 5 }));
    };
    autonomousResearchService.scoreCandidates = ({ candidates, quotes }) =>
      candidates.map((candidate) => ({
        symbol: candidate.symbol,
        price: quotes.find((q) => q.symbol === candidate.symbol).current,
        actionBias: 'hold-watch',
        localAiScore: 50,
        priceTierBonusApplied: false,
        theme: 'mock-theme',
        evidence: { explanation: [] },
      }));
    companyIntelligenceService.researchCompanies = async () => [];

    await watcherAgentService.runWatcherCycle(userId, { cycleIndex: 1, concurrency: 3 });
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe('watcherBehaviorService.runDailyGrading', () => {
  it('praises a correct buy-candidate prediction and punishes an incorrect one', async () => {
    const userId = newUser();
    const goodAgent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'GOODCALL', companyName: 'Good Co', price: 10 });
    const badAgent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'BADCALL', companyName: 'Bad Co', price: 10 });

    const goodRun = watcherAgentRepo.recordResearchRun({
      watcherAgentId: goodAgent.id,
      userId,
      symbol: 'GOODCALL',
      priceAtResearch: 10,
      predictedAction: 'buy-candidate',
      localAiScore: 75,
      rationale: {},
    });
    const badRun = watcherAgentRepo.recordResearchRun({
      watcherAgentId: badAgent.id,
      userId,
      symbol: 'BADCALL',
      priceAtResearch: 10,
      predictedAction: 'buy-candidate',
      localAiScore: 75,
      rationale: {},
    });

    webScrapeClient.getQuotes = async (symbols) =>
      symbols.map((symbol) => ({ symbol, current: symbol === 'GOODCALL' ? 12 : 8, changePct: 0 }));

    const grades = await watcherBehaviorService.runDailyGrading(userId);
    const goodGrade = grades.find((g) => g.symbol === 'GOODCALL');
    const badGrade = grades.find((g) => g.symbol === 'BADCALL');

    expect(goodGrade.verdict).toBe('praise');
    expect(badGrade.verdict).toBe('punish');

    expect(watcherAgentRepo.listResearchRuns(goodAgent.id, 10).find((r) => r.id === goodRun.id).graded).toBe(1);
    expect(watcherAgentRepo.listResearchRuns(badAgent.id, 10).find((r) => r.id === badRun.id).graded).toBe(1);

    expect(watcherAgentRepo.getScorecard(goodAgent.id)).toMatchObject({ praiseCount: 1, punishCount: 0, totalGraded: 1 });
    expect(watcherAgentRepo.getScorecard(badAgent.id)).toMatchObject({ praiseCount: 0, punishCount: 1, totalGraded: 1 });
  });

  it('never re-grades an already-graded research run', async () => {
    const userId = newUser();
    const agent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'ONCE', companyName: 'Once Co', price: 10 });
    watcherAgentRepo.recordResearchRun({
      watcherAgentId: agent.id,
      userId,
      symbol: 'ONCE',
      priceAtResearch: 10,
      predictedAction: 'buy-candidate',
      localAiScore: 70,
      rationale: {},
    });

    webScrapeClient.getQuotes = async (symbols) => symbols.map((symbol) => ({ symbol, current: 11, changePct: 0 }));

    const firstPass = await watcherBehaviorService.runDailyGrading(userId);
    expect(firstPass).toHaveLength(1);

    const secondPass = await watcherBehaviorService.runDailyGrading(userId);
    expect(secondPass).toHaveLength(0);
    expect(watcherAgentRepo.getScorecard(agent.id).totalGraded).toBe(1);
  });

  it('posts the grading verdict into the watcher agent BrainMesh conversation', async () => {
    const userId = newUser();
    const agent = watcherAgentService.ensureWatcherAgent(userId, { symbol: 'CHATGRADE', companyName: 'Chat Co', price: 10 });
    watcherAgentRepo.recordResearchRun({
      watcherAgentId: agent.id,
      userId,
      symbol: 'CHATGRADE',
      priceAtResearch: 10,
      predictedAction: 'sell-or-avoid',
      localAiScore: 20,
      rationale: {},
    });

    webScrapeClient.getQuotes = async (symbols) => symbols.map((symbol) => ({ symbol, current: 9, changePct: 0 }));

    await watcherBehaviorService.runDailyGrading(userId);

    const messages = brainMesh.listMessages({ userId }).filter((m) => m.op === 'watcher.grade.issued');
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});
