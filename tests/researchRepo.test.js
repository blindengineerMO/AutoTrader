const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-research-repo.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const researchRepo = require('../src/db/repositories/researchRepo');

describe('researchRepo', () => {
  it('lists research snapshots only for the owning user', () => {
    const alice = userRepo.createUser({ email: `alice-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });
    const bob = userRepo.createUser({ email: `bob-${Date.now()}@example.com`, passwordHash: 'x', dailyLossLimitUsd: 10, maxTradesPerSymbolPer24h: 3 });

    researchRepo.create({ userId: alice.id, source: 'alice', summary: { owner: 'alice' }, signals: [] });
    researchRepo.create({ userId: bob.id, source: 'bob', summary: { owner: 'bob' }, signals: [] });

    expect(researchRepo.listByUser(alice.id, 5).map((item) => item.source)).toEqual(['alice']);
    expect(researchRepo.listByUser(bob.id, 5).map((item) => item.source)).toEqual(['bob']);
  });
});
