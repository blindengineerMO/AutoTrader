const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-safe-research-mvp.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const specRepo = require('../src/db/repositories/specResearchRepo');
const researchRepo = require('../src/db/repositories/researchRepo');
const safeResearchMvp = require('../src/services/spec/safeResearchMvpService');
const dataQuality = require('../src/services/spec/dataQualityService');
const riskEngine = require('../src/services/spec/riskEngineService');

function stubResearch(_watchlist, { userId } = {}) {
  return researchRepo.create({
    userId,
    source: 'stub-point-in-time',
    summary: {
      watchlist: ['AAPL', 'SPY', 'OTCXYZ'],
      evidence: [
        { symbol: 'AAPL', current: 101, prevClose: 100, open: 100, high: 102, low: 99, volume: 50000000 },
        { symbol: 'SPY', current: 502, prevClose: 500, open: 500, high: 503, low: 499, volume: 80000000 },
        { symbol: 'OTCXYZ', current: 1, prevClose: 1, open: 1, high: 1, low: 1, volume: 1000 },
      ],
    },
    signals: [
      { symbol: 'AAPL', price: 101, changePct: 1, volatilityPct: 3, momentum: 'bullish' },
      { symbol: 'SPY', price: 502, changePct: 0.4, volatilityPct: 1, momentum: 'neutral' },
      { symbol: 'OTCXYZ', price: 1, changePct: 0, volatilityPct: 0, momentum: 'neutral' },
    ],
  });
}

describe('safeResearchMvpService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `safe-mvp-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    const account = brokerAccountRepo.ensureDefault(userId);
    brokerAccountRepo.updateBalance(account.id, 1000, 1000, 'paper');
  });

  it('runs the SPEC safe research MVP without live brokerage and records audit/risk evidence', async () => {
    const result = await safeResearchMvp.runSafeResearchMvp({
      userId,
      watchlist: ['AAPL', 'SPY', 'OTCXYZ'],
      runResearchCycle: stubResearch,
      now: new Date('2026-07-10T16:00:00.000Z'),
    });

    expect(result.run_id).toMatch(/^safe_/);
    expect(result.model_version).toBe('safe-mvp-equal-weight-factor-baseline-v1');
    expect(result.strategy_version).toBe('safe-mvp-long-only-conservative-v1');
    expect(result.portfolio.map((item) => item.symbol)).toEqual(expect.arrayContaining(['AAPL', 'SPY', 'OTCXYZ']));
    expect(result.risk_checks.some((check) => check.checkName === 'approved-model-version' && check.status === 'pass')).toBe(true);
    expect(result.rejected_trades.find((trade) => trade.symbol === 'OTCXYZ')).toBeTruthy();
    expect(result.paper_order_intents.length).toBeGreaterThan(0);
    expect(result.paper_order_intents.find((intent) => intent.symbol === 'OTCXYZ').status).toBe('risk_rejected');
    expect(result.warnings).toContain('Safe research MVP does not connect to live brokerage.');

    const auditEvents = specRepo.listAuditEvents(userId, result.run_id);
    expect(auditEvents.map((event) => event.event_type)).toEqual(expect.arrayContaining(['started', 'quality_reported', 'risk_checked', 'completed']));
  });

  it('fails data quality when impossible prices appear', () => {
    const report = dataQuality.validateMarketBars({
      userId,
      datasetVersion: 'bad-dataset',
      now: new Date('2026-07-10T16:00:00.000Z'),
      persist: false,
      bars: [
        {
          symbol: 'AAPL',
          barDate: '2026-07-10',
          closeUnadjusted: -1,
          highUnadjusted: 10,
          lowUnadjusted: 11,
          volume: 100,
          dataSource: 'test',
          asOf: '2026-07-10T16:00:00.000Z',
          availableAt: '2026-07-10T16:01:00.000Z',
        },
      ],
    });

    expect(report.status).toBe('fail');
    expect(report.critical).toBe(true);
    expect(report.metrics.impossibleValues).toBe(1);
  });

  it('requires an approved model version before target weights can pass risk', () => {
    const result = riskEngine.validateSafeMvpPortfolio({
      userId,
      runId: 'risk-model-test',
      modelVersion: 'unapproved-model',
      datasetVersion: 'dataset-test',
      securities: [{ symbol: 'AAPL', is_active: 1, is_tradeable: 1, security_type: 'common_stock', exchange: 'NASDAQ' }],
      accountState: { cashUsd: 1000, buyingPowerUsd: 1000 },
      portfolio: [
        {
          symbol: 'AAPL',
          current_weight: 0,
          target_weight: 0.01,
          expected_excess_return: 0.01,
          expected_volatility: 0.02,
          downside_probability: 0.4,
          confidence: 0.7,
          reason_codes: ['test'],
        },
      ],
    });

    expect(result.allowed).toBe(false);
    expect(result.checks.find((check) => check.checkName === 'approved-model-version').status).toBe('fail');
  });
});
