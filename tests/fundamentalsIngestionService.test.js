const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-fundamentals-ingestion.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.SEC_EDGAR_USER_AGENT = 'AutoTrader test test@example.com';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const secEdgarClient = require('../src/services/marketData/secEdgarClient');
const fundamentalsIngestion = require('../src/services/spec/fundamentalsIngestionService');

describe('fundamentalsIngestionService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `fundamentals-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('derives point-in-time ratios and persists the raw payload first', async () => {
    vi.spyOn(secEdgarClient, 'getFundamentalFacts').mockResolvedValue({
      symbol: 'AAPL',
      cik: '0000320193',
      facts: {
        EarningsPerShareDiluted: { value: 6.5, filedAt: '2025-11-01', form: '10-K' },
        StockholdersEquity: { value: 60000000000, filedAt: '2025-11-01', form: '10-K' },
        CommonStockSharesOutstanding: { value: 15000000000, filedAt: '2025-11-01', form: '10-K' },
        NetIncomeLoss: { value: 90000000000, filedAt: '2025-11-01', form: '10-K' },
        Revenues: { value: 400000000000, filedAt: '2025-11-01', form: '10-K' },
        OperatingIncomeLoss: { value: 110000000000, filedAt: '2025-11-01', form: '10-K' },
        Liabilities: { value: 200000000000, filedAt: '2025-11-01', form: '10-K' },
      },
      availableAt: '2025-11-01T00:00:00.000Z',
    });

    const result = await fundamentalsIngestion.ingestFundamentals({ userId, symbol: 'AAPL', priceUsd: 200 });

    expect(result.symbol).toBe('AAPL');
    expect(result.sourceRawId).toBeGreaterThan(0);
    expect(result.ratios.earningsYield.value).toBeCloseTo(6.5 / 200, 6);
    expect(result.ratios.returnOnEquity.value).toBeCloseTo(90000000000 / 60000000000, 6);
    expect(result.ratios.debtToEquity.value).toBeCloseTo(200000000000 / 60000000000, 6);
    expect(result.ratios.operatingMargin.value).toBeCloseTo(110000000000 / 400000000000, 6);
  });

  it('returns null instead of throwing when EDGAR has no facts for a symbol', async () => {
    vi.spyOn(secEdgarClient, 'getFundamentalFacts').mockResolvedValue(null);
    const result = await fundamentalsIngestion.ingestFundamentals({ userId, symbol: 'ZZZZ', priceUsd: 10 });
    expect(result).toBeNull();
  });

  it('does not throw when the EDGAR client itself throws (e.g. rate-limited)', async () => {
    vi.spyOn(secEdgarClient, 'getFundamentalFacts').mockRejectedValue(new Error('SEC EDGAR request failed: 429'));
    const result = await fundamentalsIngestion.ingestFundamentals({ userId, symbol: 'MSFT', priceUsd: 400 });
    expect(result).toBeNull();
  });
});
