const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-historical-pit.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const specRepo = require('../src/db/repositories/specResearchRepo');
const { ingestHistoricalDataset } = require('../src/services/spec/historicalPitIngestionService');
const backtestService = require('../src/services/spec/backtestService');

describe('historicalPitIngestionService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `pit-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('retains delisted securities, universe membership, corporate actions, and calendar provenance', () => {
    const result = ingestHistoricalDataset({
      userId,
      datasetVersion: 'dataset-pit-v1',
      sourceName: 'unit-pit-source',
      observedAt: '2026-07-12T00:00:00.000Z',
      availableAt: '2026-07-12T00:05:00.000Z',
      securities: [
        {
          symbol: 'OLD',
          permanentId: 'PERM-OLD',
          exchange: 'NYSE',
          listingDate: '2010-01-01',
          delistingDate: '2026-07-11',
        },
      ],
      bars: [
        {
          symbol: 'OLD',
          barDate: '2026-07-10',
          closeUnadjusted: 9,
          closeAdjusted: 9,
          volume: 1000000,
          asOf: '2026-07-10T20:00:00.000Z',
          availableAt: '2026-07-10T20:05:00.000Z',
        },
      ],
      corporateActions: [
        {
          symbol: 'OLD',
          actionType: 'delisting',
          exDate: '2026-07-11',
          effectiveAt: '2026-07-11T13:30:00.000Z',
          availableAt: '2026-07-11T13:30:00.000Z',
          details: { exchangeNotice: 'unit-test' },
        },
      ],
      calendarDays: [{ sessionDate: '2026-07-13', isOpen: false, reason: 'observed closure' }],
    });

    expect(result.rawSource.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(specRepo.getSecurity(userId, 'OLD').is_active).toBe(0);
    expect(specRepo.listUniverseMemberships(userId, 'dataset-pit-v1')[0].reason).toBe('retained_delisted_security');
    expect(specRepo.listCorporateActions(userId, ['OLD'])[0].action_type).toBe('delisting');
    expect(specRepo.getMarketCalendarDay('US', '2026-07-13').is_open).toBe(0);
  });

  it('rejects backtest fills on closed sessions and after delisting action is effective', () => {
    ingestHistoricalDataset({
      userId,
      datasetVersion: 'dataset-pit-v2',
      sourceName: 'unit-pit-source-2',
      securities: [{ symbol: 'DEAD', permanentId: 'PERM-DEAD', exchange: 'NYSE' }],
      bars: [
        {
          symbol: 'DEAD',
          barDate: '2026-07-10',
          closeUnadjusted: 10,
          closeAdjusted: 10,
          volume: 1000000,
          asOf: '2026-07-10T20:00:00.000Z',
          availableAt: '2026-07-10T20:05:00.000Z',
        },
        {
          symbol: 'DEAD',
          barDate: '2026-07-13',
          closeUnadjusted: 11,
          closeAdjusted: 11,
          volume: 1000000,
          asOf: '2026-07-13T20:00:00.000Z',
          availableAt: '2026-07-13T20:05:00.000Z',
        },
        {
          symbol: 'DEAD',
          barDate: '2026-07-14',
          closeUnadjusted: 12,
          closeAdjusted: 12,
          volume: 1000000,
          asOf: '2026-07-14T20:00:00.000Z',
          availableAt: '2026-07-14T20:05:00.000Z',
        },
      ],
      corporateActions: [
        {
          symbol: 'DEAD',
          actionType: 'delisting',
          exDate: '2026-07-14',
          effectiveAt: '2026-07-14T13:30:00.000Z',
          availableAt: '2026-07-14T13:30:00.000Z',
        },
      ],
      calendarDays: [
        { sessionDate: '2026-07-13', isOpen: false, reason: 'holiday' },
        { sessionDate: '2026-07-14', isOpen: true },
      ],
    });

    const run = backtestService.runEventDrivenBacktest({
      userId,
      datasetVersion: 'dataset-pit-v2',
      featureVersion: 'feature-pit',
      modelVersion: 'model-pit',
      strategyVersion: 'strategy-pit',
      initialCashUsd: 10000,
      portfolio: [
        {
          symbol: 'DEAD',
          target_weight: 0.02,
          expected_excess_return: 0.01,
          reason_codes: ['pit-test'],
        },
      ],
    });

    expect(run.metrics.filledOrders).toBe(0);
    expect(run.metrics.rejectedOrders).toBe(1);
    expect(run.metrics.corporateActionsApplied).toBe(1);
    expect(run.events.find((event) => event.event_type === 'corporate_action')).toBeTruthy();
    expect(run.events.find((event) => event.event_type === 'order_rejected').payload.reason).toMatch(/delisted/);
  });
});
