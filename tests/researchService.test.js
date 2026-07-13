const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-research-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const finnhub = require('../src/services/marketData/finnhubClient');
const webScrapeClient = require('../src/services/marketData/webScrapeClient');
const userRepo = require('../src/db/repositories/userRepo');
const researchService = require('../src/services/researchService');

function makeQuote(overrides) {
  return { symbol: 'AAPL', current: 190, open: 185, high: 195, low: 180, prevClose: 184, changePct: 2.5, ...overrides };
}

describe('researchService.computeSignals', () => {
  it('classifies momentum as bullish, bearish, or neutral based on changePct thresholds', () => {
    const signals = researchService.computeSignals([
      makeQuote({ symbol: 'UP', changePct: 1.5 }),
      makeQuote({ symbol: 'DOWN', changePct: -1.5 }),
      makeQuote({ symbol: 'FLAT', changePct: 0.2 }),
    ]);
    expect(signals.find((s) => s.symbol === 'UP').momentum).toBe('bullish');
    expect(signals.find((s) => s.symbol === 'DOWN').momentum).toBe('bearish');
    expect(signals.find((s) => s.symbol === 'FLAT').momentum).toBe('neutral');
  });

  it('computes intraday volatility as the high-low range relative to the open', () => {
    const [signal] = researchService.computeSignals([makeQuote({ open: 100, high: 110, low: 95 })]);
    expect(signal.volatilityPct).toBe(15);
  });

  it('treats a zero open price as zero volatility rather than dividing by zero', () => {
    const [signal] = researchService.computeSignals([makeQuote({ open: 0, high: 10, low: 5 })]);
    expect(signal.volatilityPct).toBe(0);
  });
});

describe('researchService.runResearchCycle', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `research-service-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses finnhub as the primary source when it returns quotes', async () => {
    const finnhubSpy = vi.spyOn(finnhub, 'getQuotes').mockResolvedValue([makeQuote()]);
    const webScrapeSpy = vi.spyOn(webScrapeClient, 'getQuotes').mockResolvedValue([]);

    const snapshot = await researchService.runResearchCycle(['AAPL'], { userId });

    expect(snapshot.source).toBe('finnhub');
    expect(snapshot.summary.fallbackUsed).toBe(false);
    expect(snapshot.signals).toHaveLength(1);
    expect(finnhubSpy).toHaveBeenCalled();
    expect(webScrapeSpy).not.toHaveBeenCalled();
  });

  it('falls back to web-scraping when finnhub returns no quotes', async () => {
    vi.spyOn(finnhub, 'getQuotes').mockResolvedValue([]);
    vi.spyOn(webScrapeClient, 'getQuotes').mockResolvedValue([makeQuote({ symbol: 'MSFT' })]);

    const snapshot = await researchService.runResearchCycle(['MSFT'], { userId });

    expect(snapshot.source).toBe('web-scrape:yahoo-stooq');
    expect(snapshot.summary.fallbackUsed).toBe(true);
    expect(snapshot.signals[0].symbol).toBe('MSFT');
  });

  it('skips finnhub entirely and goes straight to web-scraping when no finnhub API key is configured at all', async () => {
    const { config } = require('../src/config');
    const originalFinnhubApiKey = config.finnhubApiKey;
    config.finnhubApiKey = '';

    const finnhubSpy = vi.spyOn(finnhub, 'getQuotes').mockResolvedValue([]);
    vi.spyOn(webScrapeClient, 'getQuotes').mockResolvedValue([makeQuote({ symbol: 'GOOGL' })]);

    try {
      const snapshot = await researchService.runResearchCycle(['GOOGL'], {});
      expect(finnhubSpy).not.toHaveBeenCalled();
      expect(snapshot.source).toBe('web-scrape:yahoo-stooq');
    } finally {
      config.finnhubApiKey = originalFinnhubApiKey;
    }
  });
});
