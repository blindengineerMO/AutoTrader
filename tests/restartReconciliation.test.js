const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-restart-reconciliation.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const researchRunRepo = require('../src/db/repositories/researchRunRepo');
const db = require('../src/db/connection');

describe('restart reconciliation', () => {
  let userId;

  beforeAll(() => {
    userId = userRepo.createUser({
      email: `restart-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    }).id;
  });

  afterEach(() => {
    db.prepare('DELETE FROM research_runs').run();
  });

  it('marks an interrupted running run as failed on reconciliation', () => {
    const run = researchRunRepo.create(userId);
    researchRunRepo.markStarted(run.id);

    const reconciled = researchRunRepo.markStaleRunning({ olderThanMinutes: 0 });

    expect(reconciled).toContain(run.id);
    const row = researchRunRepo.getById(run.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('terminated_by_restart');
    expect(row.completed_at).not.toBeNull();
  });

  it('does not touch runs younger than the age threshold', () => {
    const run = researchRunRepo.create(userId);
    researchRunRepo.markStarted(run.id);

    const reconciled = researchRunRepo.markStaleRunning({ olderThanMinutes: 30 });

    expect(reconciled).not.toContain(run.id);
    expect(researchRunRepo.getById(run.id).status).toBe('running');
  });

  it('leaves already-completed runs untouched', () => {
    const run = researchRunRepo.create(userId);
    researchRunRepo.markStarted(run.id);
    researchRunRepo.markComplete(run.id, {});

    researchRunRepo.markStaleRunning({ olderThanMinutes: 0 });

    expect(researchRunRepo.getById(run.id).status).toBe('complete');
  });
});
