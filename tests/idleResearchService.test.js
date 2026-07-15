const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-idle-research.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const companyIntelligenceRepo = require('../src/db/repositories/companyIntelligenceRepo');
const timeSettings = require('../src/services/timeSettingsService');
const locationCoordinator = require('../src/services/locationCoordinatorService');
const watcherAgentService = require('../src/services/watcherAgentService');
const finnhub = require('../src/services/marketData/finnhubClient');
const researchQuestionReasoning = require('../src/services/researchQuestionReasoningService');
const crawleeCrawler = require('../src/services/crawleeResearchCrawlerService');
const eventOutcomeLabeling = require('../src/services/eventOutcomeLabelingService');
const { config } = require('../src/config');
const idleResearch = require('../src/services/idleResearchService');

function stubDeepeningDependencies() {
  vi.spyOn(finnhub, 'researchCompany').mockResolvedValue({ symbol: 'AAA', available: true, errors: [] });
  vi.spyOn(researchQuestionReasoning, 'reasonFollowUpQuestions').mockResolvedValue({ reasoning: '', questions: [] });
  vi.spyOn(crawleeCrawler, 'crawlAutonomousResearch').mockResolvedValue({ pages: [], entityLeads: [] });
  vi.spyOn(eventOutcomeLabeling, 'backfillOutcomes').mockResolvedValue({});
}

describe('idleResearchService.runIdleResearchTick', () => {
  let userId;

  beforeAll(() => {
    userId = userRepo.createUser({
      email: `idle-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    }).id;
    for (const symbol of ['AAA', 'BBB', 'CCC', 'DDD']) {
      companyIntelligenceRepo.save({ userId, symbol, companyName: `${symbol} Corp`, summary: { symbol } });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.idleResearch.enabled = true;
    config.idleResearch.maxCompaniesPerTick = 3;
  });

  it('does nothing during trading hours', async () => {
    vi.spyOn(timeSettings, 'isWithinTradingHours').mockReturnValue(true);
    const spy = vi.spyOn(locationCoordinator, 'coordinateLocations').mockResolvedValue({ mapping: {}, researched: [] });

    const result = await idleResearch.runIdleResearchTick({ userId });

    expect(result).toMatchObject({ ran: false, reason: 'within-trading-hours' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('deepens a capped batch of the stalest companies off-hours', async () => {
    vi.spyOn(timeSettings, 'isWithinTradingHours').mockReturnValue(false);
    const spy = vi.spyOn(locationCoordinator, 'coordinateLocations').mockResolvedValue({ mapping: { AAA: {} }, researched: ['AAA'] });
    stubDeepeningDependencies();
    config.idleResearch.maxCompaniesPerTick = 2;

    const result = await idleResearch.runIdleResearchTick({ userId });

    expect(result.ran).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].candidates).toHaveLength(2);
    expect(result.deepened).toHaveLength(2);
  });

  it('runs the one-time watcher training backfill during idle off-hours', async () => {
    vi.spyOn(timeSettings, 'isWithinTradingHours').mockReturnValue(false);
    vi.spyOn(locationCoordinator, 'coordinateLocations').mockResolvedValue({ mapping: {}, researched: [] });
    stubDeepeningDependencies();
    const backfill = vi.spyOn(watcherAgentService, 'runThirtyDayTrainingBackfill').mockResolvedValue({
      ran: true,
      generatedRuns: 2,
      gradesCreated: 2,
    });

    const result = await idleResearch.runIdleResearchTick({ userId });

    expect(backfill).toHaveBeenCalledWith(userId, { force: false });
    expect(result.watcherTrainingBackfill).toMatchObject({ ran: true, generatedRuns: 2, gradesCreated: 2 });
  });

  it('pre-warms Finnhub, asks Ollama for follow-up questions, and crawls them for a deepened company', async () => {
    vi.spyOn(timeSettings, 'isWithinTradingHours').mockReturnValue(false);
    vi.spyOn(locationCoordinator, 'coordinateLocations').mockResolvedValue({ mapping: {}, researched: [] });
    vi.spyOn(watcherAgentService, 'runThirtyDayTrainingBackfill').mockResolvedValue({ ran: false, reason: 'no-watchers' });
    const finnhubSpy = vi.spyOn(finnhub, 'researchCompany').mockResolvedValue({ symbol: 'AAA', available: true, errors: [] });
    vi.spyOn(researchQuestionReasoning, 'reasonFollowUpQuestions').mockResolvedValue({
      reasoning: 'x',
      questions: ['who supplies AAA Corp'],
    });
    const crawlSpy = vi.spyOn(crawleeCrawler, 'crawlAutonomousResearch').mockResolvedValue({
      pages: [{ title: 'Supplier news', excerpt: 'AAA Corp supplier update', url: 'https://example.com/aaa' }],
      entityLeads: [],
    });
    vi.spyOn(eventOutcomeLabeling, 'backfillOutcomes').mockResolvedValue({});
    config.idleResearch.maxCompaniesPerTick = 1;

    const result = await idleResearch.runIdleResearchTick({ userId });

    expect(result.deepened).toEqual(['AAA']);
    expect(finnhubSpy).toHaveBeenCalledWith('AAA', expect.any(Object));
    expect(crawlSpy).toHaveBeenCalledWith(expect.objectContaining({ queries: ['who supplies AAA Corp'] }));
    const saved = companyIntelligenceRepo.getBySymbol(userId, 'AAA');
    expect(saved.summary.idleObservations).toHaveLength(1);
    expect(saved.summary.finnhub.available).toBe(true);
  });

  it('is a no-op when disabled', async () => {
    config.idleResearch.enabled = false;
    const spy = vi.spyOn(locationCoordinator, 'coordinateLocations');

    const result = await idleResearch.runIdleResearchTick({ userId });

    expect(result).toMatchObject({ ran: false, reason: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
  });
});
