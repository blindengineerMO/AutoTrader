const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-spec-backtest.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const specRepo = require('../src/db/repositories/specResearchRepo');
const backtestRepo = require('../src/db/repositories/specBacktestRepo');
const backtestService = require('../src/services/spec/backtestService');

describe('spec backtestService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `backtest-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    specRepo.upsertSecurity(userId, { symbol: 'AAPL', permanentId: 'AUTO-AAPL', exchange: 'NASDAQ', securityType: 'common_stock' });
  });

  it('records event-driven fills only on a later available bar and includes reproducibility metadata', () => {
    specRepo.saveMarketBars({
      userId,
      bars: [
        {
          symbol: 'AAPL',
          barDate: '2026-07-10',
          closeUnadjusted: 100,
          closeAdjusted: 100,
          volume: 10000000,
          dataSource: 'test',
          asOf: '2026-07-10T20:00:00.000Z',
          availableAt: '2026-07-10T20:05:00.000Z',
        },
        {
          symbol: 'AAPL',
          barDate: '2026-07-13',
          closeUnadjusted: 101,
          closeAdjusted: 101,
          volume: 10000000,
          dataSource: 'test',
          asOf: '2026-07-13T20:00:00.000Z',
          availableAt: '2026-07-13T20:05:00.000Z',
        },
      ],
    });

    const run = backtestService.runEventDrivenBacktest({
      userId,
      datasetVersion: 'dataset-test',
      featureVersion: 'feature-test',
      modelVersion: 'model-test',
      strategyVersion: 'strategy-test',
      initialCashUsd: 10000,
      portfolio: [
        {
          symbol: 'AAPL',
          target_weight: 0.02,
          current_weight: 0,
          expected_excess_return: 0.01,
          expected_volatility: 0.02,
          downside_probability: 0.4,
          confidence: 0.7,
          reason_codes: ['test'],
        },
      ],
    });

    expect(run.status).toBe('completed');
    expect(run.dependency_lock_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.metrics.filledOrders).toBe(1);
    expect(run.metrics.transactionCostsUsd).toBeGreaterThan(0);
    expect(run.events.map((event) => event.event_type)).toEqual(['signal', 'order_submitted', 'order_filled']);
    expect(backtestRepo.listMonitoring(userId).find((row) => row.status_key === 'backtest.latest').status).toBe('ok');
  });

  it('rejects same-close execution when no later available bar exists', () => {
    specRepo.upsertSecurity(userId, { symbol: 'MSFT', permanentId: 'AUTO-MSFT', exchange: 'NASDAQ', securityType: 'common_stock' });
    specRepo.saveMarketBars({
      userId,
      bars: [
        {
          symbol: 'MSFT',
          barDate: '2026-07-10',
          closeUnadjusted: 200,
          closeAdjusted: 200,
          volume: 10000000,
          dataSource: 'test',
          asOf: '2026-07-10T20:00:00.000Z',
          availableAt: '2026-07-10T20:05:00.000Z',
        },
      ],
    });

    const run = backtestService.runEventDrivenBacktest({
      userId,
      datasetVersion: 'dataset-test',
      featureVersion: 'feature-test',
      modelVersion: 'model-test',
      strategyVersion: 'strategy-test',
      initialCashUsd: 10000,
      portfolio: [
        {
          symbol: 'MSFT',
          target_weight: 0.02,
          current_weight: 0,
          expected_excess_return: 0.01,
          expected_volatility: 0.02,
          downside_probability: 0.4,
          confidence: 0.7,
          reason_codes: ['test'],
        },
      ],
    });

    expect(run.metrics.filledOrders).toBe(0);
    expect(run.metrics.rejectedOrders).toBe(1);
    expect(run.events.find((event) => event.event_type === 'order_rejected').payload.reason).toMatch(/same-close/);
  });

  it('caps fills by liquidity, records dividends, and computes benchmark relative return', () => {
    specRepo.upsertSecurity(userId, { symbol: 'LIQD', permanentId: 'AUTO-LIQD', exchange: 'NYSE', securityType: 'common_stock' });
    specRepo.upsertSecurity(userId, { symbol: 'SPY', permanentId: 'AUTO-SPY', exchange: 'NYSE', securityType: 'etf' });
    specRepo.saveMarketCalendarDays({
      market: 'US',
      days: [
        { sessionDate: '2026-07-13', isOpen: true, earlyClose: true },
        { sessionDate: '2026-07-14', isOpen: true },
      ],
    });
    specRepo.saveMarketBars({
      userId,
      bars: [
        {
          symbol: 'LIQD',
          barDate: '2026-07-10',
          closeUnadjusted: 10,
          closeAdjusted: 10,
          volume: 1000000,
          dataSource: 'test',
          asOf: '2026-07-10T20:00:00.000Z',
          availableAt: '2026-07-10T20:05:00.000Z',
        },
        {
          symbol: 'LIQD',
          barDate: '2026-07-13',
          closeUnadjusted: 10,
          closeAdjusted: 10,
          volume: 100,
          dataSource: 'test',
          asOf: '2026-07-13T17:00:00.000Z',
          availableAt: '2026-07-13T17:05:00.000Z',
        },
        {
          symbol: 'LIQD',
          barDate: '2026-07-14',
          closeUnadjusted: 12,
          closeAdjusted: 12,
          volume: 1000000,
          dataSource: 'test',
          asOf: '2026-07-14T20:00:00.000Z',
          availableAt: '2026-07-14T20:05:00.000Z',
        },
        {
          symbol: 'SPY',
          barDate: '2026-07-10',
          closeUnadjusted: 500,
          closeAdjusted: 500,
          volume: 10000000,
          dataSource: 'test',
          asOf: '2026-07-10T20:00:00.000Z',
          availableAt: '2026-07-10T20:05:00.000Z',
        },
        {
          symbol: 'SPY',
          barDate: '2026-07-14',
          closeUnadjusted: 510,
          closeAdjusted: 510,
          volume: 10000000,
          dataSource: 'test',
          asOf: '2026-07-14T20:00:00.000Z',
          availableAt: '2026-07-14T20:05:00.000Z',
        },
      ],
    });
    specRepo.saveCorporateActions({
      userId,
      actions: [
        {
          symbol: 'LIQD',
          actionType: 'cash_dividend',
          exDate: '2026-07-14',
          effectiveAt: '2026-07-14T13:30:00.000Z',
          availableAt: '2026-07-14T13:30:00.000Z',
          cashAmount: 1,
        },
      ],
    });

    const run = backtestService.runEventDrivenBacktest({
      userId,
      datasetVersion: 'dataset-test',
      featureVersion: 'feature-test',
      modelVersion: 'model-test',
      strategyVersion: 'strategy-test',
      initialCashUsd: 10000,
      portfolio: [
        {
          symbol: 'LIQD',
          target_weight: 0.5,
          expected_excess_return: 0.01,
          reason_codes: ['liquidity-test'],
        },
      ],
    });

    expect(run.metrics.filledOrders).toBe(1);
    expect(run.metrics.partiallyFilledOrders).toBe(1);
    expect(run.metrics.dividendCashflowUsd).toBeGreaterThan(0);
    expect(run.metrics.benchmark).toBe('SPY');
    expect(run.metrics.benchmarkReturn).toBeCloseTo(0.02, 6);
    expect(run.events.map((event) => event.event_type)).toContain('order_partially_filled');
    expect(run.events.map((event) => event.event_type)).toContain('dividend_cashflow');
  });

  it('persists walk-forward split metadata on the run record when provided', () => {
    const run = backtestService.runEventDrivenBacktest({
      userId,
      datasetVersion: 'dataset-test',
      featureVersion: 'feature-test',
      modelVersion: 'model-test',
      strategyVersion: 'strategy-test',
      initialCashUsd: 10000,
      portfolio: [],
      walkForwardSplit: {
        splitIndex: 0,
        train: { start: '2026-01-01', end: '2026-01-10' },
        purge: { start: '2026-01-11', end: '2026-01-12' },
        test: { start: '2026-01-13', end: '2026-01-17' },
        embargo: null,
      },
    });

    expect(run.splitMetadata.splitIndex).toBe(0);
    expect(run.splitMetadata.test.start).toBe('2026-01-13');

    const reloaded = backtestRepo.listRuns(userId, 1)[0];
    expect(reloaded.splitMetadata.train.end).toBe('2026-01-10');
  });

  it('leaves splitMetadata null when no walk-forward split is provided', () => {
    const run = backtestService.runEventDrivenBacktest({
      userId,
      datasetVersion: 'dataset-test',
      featureVersion: 'feature-test',
      modelVersion: 'model-test',
      strategyVersion: 'strategy-test',
      initialCashUsd: 10000,
      portfolio: [],
    });

    expect(run.splitMetadata).toBeNull();
  });
});
