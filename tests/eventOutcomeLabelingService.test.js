const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-event-outcome-labeling.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const eventTrainingLabelRepo = require('../src/db/repositories/eventTrainingLabelRepo');
const webScrapeClient = require('../src/services/marketData/webScrapeClient');
const finnhubClient = require('../src/services/marketData/finnhubClient');
const eventOutcomeLabeling = require('../src/services/eventOutcomeLabelingService');
const db = require('../src/db/connection');

function makeEvent(overrides = {}) {
  return {
    document_id: overrides.documentId || 'doc-1',
    published_at: overrides.publishedAt || new Date().toISOString(),
    source: { domain: 'sec.gov', type: 'company_filing', reliability: 1.0 },
    event: {
      category: overrides.category || 'guidance',
      type: overrides.type || 'raised_guidance',
      base_weight: overrides.baseWeight ?? 8,
      direction: overrides.direction || 'positive',
    },
    statement: { text: 'Company raised guidance above consensus.', certainty: 'confirmed' },
    financial_effect: { affected_metric: 'revenue', surprise_relative_to_consensus: 'above' },
    final_event_score: overrides.finalEventScore ?? 5.5,
    evidence_urls: ['https://www.sec.gov/Archives/example'],
  };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

describe('eventOutcomeLabelingService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `event-labels-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.prepare('DELETE FROM event_training_labels').run();
    db.prepare('DELETE FROM event_category_learning').run();
  });

  it('records candidate events as training labels and dedupes on re-run', () => {
    const candidate = { symbol: 'NVDA', theme: 'semiconductors' };
    const events = [makeEvent()];

    const first = eventOutcomeLabeling.recordCandidateEvents({ userId, candidate, events });
    const second = eventOutcomeLabeling.recordCandidateEvents({ userId, candidate, events });

    expect(first).toBe(1);
    expect(second).toBe(0);
    const [label] = eventTrainingLabelRepo.listRecent(userId);
    expect(label).toMatchObject({
      symbol: 'NVDA',
      event_category: 'guidance',
      event_type: 'raised_guidance',
      event_direction: 'positive',
      certainty: 'confirmed',
      source_type: 'company_filing',
      surprise_direction: 'above',
      sector_symbol: 'SOXX',
    });
  });

  it('skips low-magnitude noise events', () => {
    const inserted = eventOutcomeLabeling.recordCandidateEvents({
      userId,
      candidate: { symbol: 'ACME', theme: 'consumer' },
      events: [makeEvent({ finalEventScore: 0.1 })],
    });
    expect(inserted).toBe(0);
  });

  it('backfills 1-day, 21-day, and sector-adjusted returns and marks prediction correctness', async () => {
    // 120 daily closes; stock rallies after the event, sector stays flat.
    const stockCloses = Array.from({ length: 120 }, (_, i) => (i < 90 ? 100 : 100 + (i - 90) * 2));
    const sectorCloses = Array.from({ length: 120 }, () => 400);
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockImplementation(async (symbol) =>
      symbol === 'SPY' ? sectorCloses : stockCloses
    );

    eventOutcomeLabeling.recordCandidateEvents({
      userId,
      candidate: { symbol: 'WINNER', theme: 'broad-market' },
      events: [makeEvent({ publishedAt: daysAgoIso(42), direction: 'positive' })],
    });

    const result = await eventOutcomeLabeling.backfillOutcomes({ userId });

    expect(result.updated).toBe(1);
    const [label] = eventTrainingLabelRepo.listRecent(userId);
    expect(label.stock_return_1_day).not.toBeNull();
    expect(label.stock_return_21_days).toBeGreaterThan(0);
    expect(label.sector_return_21_days).toBe(0);
    expect(label.sector_adjusted_return_21_days).toBeGreaterThan(0);
    expect(label.original_model_prediction_correct).toBe(1);
  });

  it('marks a positive event incorrect when the sector-adjusted return is negative', async () => {
    const stockCloses = Array.from({ length: 120 }, (_, i) => (i < 90 ? 100 : 100 - (i - 90)));
    const sectorCloses = Array.from({ length: 120 }, () => 400);
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockImplementation(async (symbol) =>
      symbol === 'SPY' ? sectorCloses : stockCloses
    );

    eventOutcomeLabeling.recordCandidateEvents({
      userId,
      candidate: { symbol: 'LOSER', theme: 'broad-market' },
      events: [makeEvent({ publishedAt: daysAgoIso(42), direction: 'positive' })],
    });

    await eventOutcomeLabeling.backfillOutcomes({ userId });

    const [label] = eventTrainingLabelRepo.listRecent(userId);
    expect(label.sector_adjusted_return_21_days).toBeLessThan(0);
    expect(label.original_model_prediction_correct).toBe(0);
  });

  it('labels fundamentals from quarterly EPS two quarters after the event', () => {
    const eventDate = '2025-06-01T00:00:00.000Z';
    const earnings = [
      { period: '2025-03-31', actual: 1.0 },
      { period: '2025-06-30', actual: 1.1 },
      { period: '2025-09-30', actual: 1.4 },
    ];

    expect(eventOutcomeLabeling.fundamentalResultFromEarnings(earnings, eventDate)).toBe('eps_grew');
    expect(eventOutcomeLabeling.fundamentalResultFromEarnings(earnings.slice(0, 2), eventDate)).toBeNull();
    expect(eventOutcomeLabeling.fundamentalResultFromEarnings([
      { period: '2025-03-31', actual: 1.0 },
      { period: '2025-06-30', actual: 0.9 },
      { period: '2025-09-30', actual: 0.5 },
    ], eventDate)).toBe('eps_declined');
  });

  it('updates per-category multipliers with clamping and a minimum sample size', () => {
    // 6 correct guidance labels -> accuracy 1.0 -> multiplier up 10%.
    for (let i = 0; i < 6; i += 1) {
      eventOutcomeLabeling.recordCandidateEvents({
        userId,
        candidate: { symbol: `SYM${i}`, theme: 'broad-market' },
        events: [makeEvent({ documentId: `doc-${i}` })],
      });
    }
    for (const label of eventTrainingLabelRepo.listRecent(userId, 10)) {
      eventTrainingLabelRepo.updateOutcomes(label.id, { original_model_prediction_correct: 1 });
    }
    // Only 2 samples in another category -> no learning yet.
    eventOutcomeLabeling.recordCandidateEvents({
      userId,
      candidate: { symbol: 'FEW', theme: 'broad-market' },
      events: [makeEvent({ category: 'liquidity', type: 'liquidity_concern', documentId: 'doc-few' })],
    });

    const rows = eventOutcomeLabeling.updateCategoryLearning({ userId });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'guidance', multiplier: 1.1 });

    // Repeated cycles clamp at 1.5.
    for (let i = 0; i < 10; i += 1) eventOutcomeLabeling.updateCategoryLearning({ userId });
    expect(eventTrainingLabelRepo.getCategoryMultipliers(userId).guidance).toBeLessThanOrEqual(1.5);
  });

  it('resolves sector ETF proxies from candidate themes', () => {
    expect(eventOutcomeLabeling.resolveSectorProxy('semiconductors')).toBe('SOXX');
    expect(eventOutcomeLabeling.resolveSectorProxy('industrial-defense')).toBe('ITA');
    expect(eventOutcomeLabeling.resolveSectorProxy('energy')).toBe('XLE');
    expect(eventOutcomeLabeling.resolveSectorProxy('broad-market')).toBe('SPY');
    expect(eventOutcomeLabeling.resolveSectorProxy(undefined)).toBe('SPY');
  });
});
