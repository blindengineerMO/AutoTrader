const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-research-sources.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const researchSourceRepo = require('../src/db/repositories/researchSourceRepo');

describe('researchSourceRepo', () => {
  it('retires repeatedly failed learned URLs and reactivates them when re-learned', () => {
    const user = userRepo.createUser({
      email: `sources-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const source = researchSourceRepo.upsert({
      userId: user.id,
      url: 'https://example.com/flaky-market-source',
      title: 'Flaky market source',
      sourceType: 'learned',
      discoveryMethod: 'test',
      tags: ['test'],
    });

    let updated = source;
    for (let i = 0; i < 10; i += 1) {
      updated = researchSourceRepo.updateStats(source.id, { success: false, relevanceDelta: -1, credibilityDelta: -1 });
    }

    expect(updated.failure_count).toBe(10);
    expect(updated.status).toBe('failed');
    expect(researchSourceRepo.listActiveByUser(user.id, 20).map((item) => item.id)).not.toContain(source.id);

    const relearned = researchSourceRepo.upsert({
      userId: user.id,
      url: 'https://example.com/flaky-market-source',
      title: 'Flaky market source rediscovered',
      sourceType: 'learned',
      status: 'active',
      discoveryMethod: 'crawlee-search-follow-up',
      tags: ['relearned'],
    });

    expect(relearned.status).toBe('active');
    expect(relearned.failure_count).toBe(0);
    expect(researchSourceRepo.listActiveByUser(user.id, 20).map((item) => item.id)).toContain(source.id);
  });
});
