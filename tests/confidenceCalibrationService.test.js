const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-confidence-calibration.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const tradingAgentRepo = require('../src/db/repositories/tradingAgentRepo');
const agentCalibrationRepo = require('../src/db/repositories/agentCalibrationRepo');
const confidenceCalibration = require('../src/services/confidenceCalibrationService');
const db = require('../src/db/connection');

function seedAgent(userId) {
  return tradingAgentRepo.upsertAgent({
    userId,
    name: 'Calibration Agent',
    slug: `calibration-agent-${Math.random().toString(36).slice(2)}`,
    brainId: 'brain.test',
  });
}

// Directly inserts a labeled outcome row (bypassing recommendation creation) so tests
// can control conviction/correctness pairs precisely.
function seedOutcome(userId, agentId, { conviction, correct1d }) {
  const agent = { id: agentId };
  const run = tradingAgentRepo.createCouncilRun({
    userId,
    summary: {},
    recommendations: [{ agentId: agent.id, symbol: 'ACME', action: 'buy', conviction, evidence: {} }],
  });
  const rec = run.recommendations[0];
  db.prepare(`
    INSERT INTO agent_recommendation_outcomes (user_id, council_run_id, recommendation_id, agent_id, symbol, action, conviction, sector_symbol, correct_1d, outcome_backfilled_at)
    VALUES (?, ?, ?, ?, 'ACME', 'buy', ?, 'SPY', ?, datetime('now'))
  `).run(userId, run.id, rec.id, agentId, conviction, correct1d);
}

describe('confidenceCalibrationService', () => {
  it('computes hit rate, mean conviction, and Brier score per agent/horizon', () => {
    const user = userRepo.createUser({ email: `calibration-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const agent = seedAgent(user.id);

    // 5 samples at conviction=80: 4 correct, 1 wrong -> hitRate=0.8, meanConviction=80.
    for (let i = 0; i < 4; i += 1) seedOutcome(user.id, agent.id, { conviction: 80, correct1d: 1 });
    seedOutcome(user.id, agent.id, { conviction: 80, correct1d: 0 });

    const summaries = confidenceCalibration.runCalibration({ userId: user.id });
    expect(summaries.length).toBeGreaterThan(0);

    const rows = agentCalibrationRepo.listSummaryByUser(user.id);
    const row = rows.find((r) => r.horizon === '1d' && r.agent_id === agent.id);
    expect(row.samples).toBe(5);
    expect(row.hits).toBe(4);
    expect(row.hit_rate).toBeCloseTo(0.8, 4);
    expect(row.mean_conviction).toBeCloseTo(80, 4);
    // Brier = mean((0.8 - outcome)^2): 4x(0.8-1)^2 + 1x(0.8-0)^2, divided by 5.
    const expectedBrier = (4 * (0.8 - 1) ** 2 + (0.8 - 0) ** 2) / 5;
    expect(row.brier_score).toBeCloseTo(expectedBrier, 4);

    const buckets = agentCalibrationRepo.listBucketsByUser(user.id);
    const bucket = buckets.find((b) => b.horizon === '1d' && b.agent_id === agent.id);
    expect(bucket.bucket_low).toBe(80);
    expect(bucket.samples).toBe(5);
    expect(bucket.hits).toBe(4);
  });

  it('suppresses agents below the minimum sample size', () => {
    const user = userRepo.createUser({ email: `calibration-low-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const agent = seedAgent(user.id);

    seedOutcome(user.id, agent.id, { conviction: 90, correct1d: 1 });
    seedOutcome(user.id, agent.id, { conviction: 90, correct1d: 1 });

    confidenceCalibration.runCalibration({ userId: user.id });

    const rows = agentCalibrationRepo.listSummaryByUser(user.id);
    expect(rows.find((r) => r.agent_id === agent.id)).toBeUndefined();
  });
});
