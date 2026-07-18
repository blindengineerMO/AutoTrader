const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-agent-outcome-labeling.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const tradingAgentRepo = require('../src/db/repositories/tradingAgentRepo');
const agentRecommendationOutcomeRepo = require('../src/db/repositories/agentRecommendationOutcomeRepo');
const webScrapeClient = require('../src/services/marketData/webScrapeClient');
const agentOutcomeLabeling = require('../src/services/agentOutcomeLabelingService');
const db = require('../src/db/connection');

function seedUserAndRun(userId, { action = 'buy', symbol = 'ACME', conviction = 80, recommendedAt, price } = {}) {
  const agent = tradingAgentRepo.upsertAgent({
    userId,
    name: 'Test Agent',
    slug: `test-agent-${Math.random().toString(36).slice(2)}`,
    brainId: 'brain.test',
  });
  // Omitting price leaves baseline_price null so the service falls back to the
  // historical close at recommendation time, keeping baseline consistent with the
  // synthetic closes array used in these tests.
  const run = tradingAgentRepo.createCouncilRun({
    userId,
    summary: {},
    recommendations: [{ agentId: agent.id, symbol, action, conviction, evidence: { signal: { price, theme: 'broad-market' } } }],
  });
  agentRecommendationOutcomeRepo.createForRecommendations(userId, run.id, run.recommendations, {
    resolveSectorSymbol: () => 'SPY',
  });
  const [row] = db.prepare('SELECT * FROM agent_recommendation_outcomes WHERE council_run_id = ?').all(run.id);
  if (recommendedAt) {
    db.prepare('UPDATE agent_recommendation_outcomes SET recommended_at = ? WHERE id = ?').run(recommendedAt, row.id);
  }
  return { agent, run, row };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

describe('agentOutcomeLabelingService', () => {
  it('backfills 1d/5d/21d/63d returns only once each horizon is old enough and reachable', async () => {
    const user = userRepo.createUser({ email: `agent-outcome-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    // 200 daily closes; price rallies steadily so every horizon has a positive return.
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockImplementation(async () => closes);

    seedUserAndRun(user.id, { action: 'buy', symbol: 'ACME', recommendedAt: daysAgoIso(100) });

    const result = await agentOutcomeLabeling.backfillOutcomes({ userId: user.id });
    expect(result.updated).toBe(1);

    const [row] = db.prepare('SELECT * FROM agent_recommendation_outcomes WHERE user_id = ?').all(user.id);
    expect(row.return_1d).not.toBeNull();
    expect(row.return_5d).not.toBeNull();
    expect(row.return_21d).not.toBeNull();
    expect(row.return_63d).not.toBeNull();
    expect(row.return_63d).toBeGreaterThan(0);
    expect(row.correct_1d).toBe(1);
    expect(row.correct_63d).toBe(1);
    expect(row.outcome_backfilled_at).not.toBeNull();
  });

  it('leaves longer horizons null when the recommendation is not old enough yet', async () => {
    const user = userRepo.createUser({ email: `agent-outcome-young-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockImplementation(async () => closes);

    seedUserAndRun(user.id, { action: 'buy', symbol: 'YOUNG', recommendedAt: daysAgoIso(3) });

    await agentOutcomeLabeling.backfillOutcomes({ userId: user.id });

    const [row] = db.prepare('SELECT * FROM agent_recommendation_outcomes WHERE user_id = ?').all(user.id);
    expect(row.return_1d).not.toBeNull();
    expect(row.return_5d).toBeNull();
    expect(row.return_21d).toBeNull();
    expect(row.return_63d).toBeNull();
  });

  it('marks a sell recommendation correct when price falls, and hold/watch correct when price is flat', async () => {
    const user = userRepo.createUser({ email: `agent-outcome-actions-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const fallingCloses = Array.from({ length: 200 }, (_, i) => 200 - i * 0.5);
    const flatCloses = Array.from({ length: 200 }, () => 100);
    vi.spyOn(webScrapeClient, 'getDailyCloses').mockImplementation(async (symbol) => (symbol === 'FLAT' ? flatCloses : fallingCloses));

    seedUserAndRun(user.id, { action: 'sell', symbol: 'DROP', recommendedAt: daysAgoIso(100) });
    seedUserAndRun(user.id, { action: 'hold', symbol: 'FLAT', recommendedAt: daysAgoIso(100) });

    await agentOutcomeLabeling.backfillOutcomes({ userId: user.id });

    const rows = db.prepare('SELECT * FROM agent_recommendation_outcomes WHERE user_id = ?').all(user.id);
    const dropRow = rows.find((r) => r.symbol === 'DROP');
    const flatRow = rows.find((r) => r.symbol === 'FLAT');
    expect(dropRow.correct_1d).toBe(1);
    expect(flatRow.correct_1d).toBe(1);
  });
});
