const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-agent-review-queue.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const tradingAgentRepo = require('../src/db/repositories/tradingAgentRepo');
const agentReviewQueueRepo = require('../src/db/repositories/agentReviewQueueRepo');

describe('agentReviewQueueRepo', () => {
  it('creates an entry, lists it as pending, and transitions it on updateStatus', () => {
    const user = userRepo.createUser({ email: `review-queue-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const run = tradingAgentRepo.createCouncilRun({ userId: user.id, summary: {}, recommendations: [] });

    agentReviewQueueRepo.create(user.id, run.id, 'NVDA', 'high_disagreement', {
      meanConviction: 50, convictionStdDev: 35, disagreementFactor: 0.3, buyVotes: 1, sellVotes: 1,
    });

    const pending = agentReviewQueueRepo.listByUser(user.id, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].symbol).toBe('NVDA');
    expect(pending[0].reason).toBe('high_disagreement');

    const updated = agentReviewQueueRepo.updateStatus(pending[0].id, user.id, 'reviewed', 'looks fine, keeping position');
    expect(updated.status).toBe('reviewed');
    expect(updated.reviewed_note).toBe('looks fine, keeping position');

    expect(agentReviewQueueRepo.listByUser(user.id, { status: 'pending' })).toHaveLength(0);
    expect(agentReviewQueueRepo.listByUser(user.id, { status: 'reviewed' })).toHaveLength(1);
  });

  it('ignores a duplicate create for the same council_run_id + symbol', () => {
    const user = userRepo.createUser({ email: `review-queue-dup-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const run = tradingAgentRepo.createCouncilRun({ userId: user.id, summary: {}, recommendations: [] });

    agentReviewQueueRepo.create(user.id, run.id, 'NVDA', 'high_disagreement', { meanConviction: 50, convictionStdDev: 35, disagreementFactor: 0.3, buyVotes: 1, sellVotes: 1 });
    agentReviewQueueRepo.create(user.id, run.id, 'NVDA', 'split_vote', { meanConviction: 50, convictionStdDev: 35, disagreementFactor: 0.3, buyVotes: 1, sellVotes: 1 });

    expect(agentReviewQueueRepo.listByUser(user.id, { status: 'pending' })).toHaveLength(1);
  });
});
