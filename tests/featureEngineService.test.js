const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-feature-engine.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const featureEngine = require('../src/services/spec/featureEngineService');

describe('featureEngineService fundamentals wiring', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `feature-engine-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  const bar = {
    symbol: 'AAPL',
    barDate: '2026-07-10',
    closeUnadjusted: 200,
    closeAdjusted: 200,
    highUnadjusted: 202,
    lowUnadjusted: 198,
    volume: 5_000_000,
    asOf: '2026-07-10T20:00:00.000Z',
    availableAt: '2026-07-10T20:05:00.000Z',
  };
  const security = { symbol: 'AAPL', security_type: 'common_stock', market_cap_usd: 3_000_000_000_000 };

  it('falls back to the proxy score and tags it when no EDGAR fundamentals are available', () => {
    const result = featureEngine.buildFeatureSet({
      userId,
      datasetVersion: 'dataset-test-1',
      bars: [bar],
      securities: [security],
      qualityReport: { status: 'ok', critical: false, id: 1 },
      persist: false,
    });
    const row = result.rows[0];
    expect(row.features.reasonCodes).toContain('proxy_value_score');
    expect(row.features.reasonCodes).toContain('proxy_quality_score');
  });

  it('uses SEC EDGAR-derived ratios and tags them when fundamentals are available', () => {
    const fundamentalsBySymbol = new Map([
      [
        'AAPL',
        {
          symbol: 'AAPL',
          ratios: {
            earningsYield: { value: 0.03, availableAt: '2025-11-01T00:00:00.000Z' },
            bookToMarket: { value: 0.5, availableAt: '2025-11-01T00:00:00.000Z' },
            returnOnEquity: { value: 1.5, availableAt: '2025-11-01T00:00:00.000Z' },
            operatingMargin: { value: 0.27, availableAt: '2025-11-01T00:00:00.000Z' },
            debtToEquity: { value: 3.3, availableAt: '2025-11-01T00:00:00.000Z' },
          },
        },
      ],
    ]);

    const result = featureEngine.buildFeatureSet({
      userId,
      datasetVersion: 'dataset-test-2',
      bars: [bar],
      securities: [security],
      qualityReport: { status: 'ok', critical: false, id: 1 },
      fundamentalsBySymbol,
      persist: false,
    });
    const row = result.rows[0];
    expect(row.features.reasonCodes).toContain('sec_edgar_value_score');
    expect(row.features.reasonCodes).toContain('sec_edgar_quality_score');
    expect(row.features.valueScore).toBeGreaterThan(0);
    expect(row.features.valueScore).toBeLessThanOrEqual(1);
  });

  it('blocks feature generation on critical data-quality failure regardless of fundamentals', () => {
    const result = featureEngine.buildFeatureSet({
      userId,
      datasetVersion: 'dataset-test-3',
      bars: [bar],
      securities: [security],
      qualityReport: { status: 'fail', critical: true, id: 2 },
      persist: false,
    });
    expect(result.status).toBe('blocked');
    expect(result.rows).toEqual([]);
  });
});
