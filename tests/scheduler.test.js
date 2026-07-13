const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-scheduler.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const scheduler = require('../src/jobs/scheduler');
const personalityAgents = require('../src/services/personalityAgentService');

describe('scheduler.currentWatcherCycleIndex', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the cycle index from the local hour in the given timezone, not server-local time', () => {
    // 14:00 UTC is 10:00 in America/New_York (cycle 2) but 06:00 in
    // America/Los_Angeles (cycle 1) on the same instant — proves the
    // computation is timezone-aware rather than using server-local time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T14:00:00.000Z'));

    expect(scheduler.currentWatcherCycleIndex('America/New_York')).toBe(2);
    expect(scheduler.currentWatcherCycleIndex('America/Los_Angeles')).toBe(1);
  });

  it('falls back to cycle index 1 (run everything) when the local hour matches none of the configured cycle hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T15:00:00.000Z')); // 11:00 America/New_York — not in [6, 10, 13, 16]

    expect(scheduler.currentWatcherCycleIndex('America/New_York')).toBe(1);
  });

  it('treats every hour as due under an hourly cron, proving the WATCHER_CYCLE_HOURS sync footgun is fixed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T15:00:00.000Z')); // 11:00 America/New_York

    expect(scheduler.currentWatcherCycleIndex('America/New_York', '0 * * * *')).toBe(12);
  });
});

describe('scheduler.watcherCycleHoursFromCron', () => {
  it('parses a comma-separated hour list', () => {
    expect(scheduler.watcherCycleHoursFromCron('0 6,10,13,16 * * 1-5')).toEqual([6, 10, 13, 16]);
  });

  it('parses an hour range', () => {
    expect(scheduler.watcherCycleHoursFromCron('0 9-12 * * 1-5')).toEqual([9, 10, 11, 12]);
  });

  it('expands a wildcard hour field to all 24 hours', () => {
    expect(scheduler.watcherCycleHoursFromCron('0 * * * *')).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('falls back to the legacy default hours when the cron cannot be parsed', () => {
    expect(scheduler.watcherCycleHoursFromCron(null)).toEqual([6, 10, 13, 16]);
    expect(scheduler.watcherCycleHoursFromCron('not a cron')).toEqual([6, 10, 13, 16]);
    expect(scheduler.watcherCycleHoursFromCron('')).toEqual([6, 10, 13, 16]);
  });
});

describe('scheduler.runPersonalityTickForUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes personalityAgents.runCouncil for the user', async () => {
    const spy = vi.spyOn(personalityAgents, 'runCouncil').mockResolvedValue(undefined);

    await scheduler.runPersonalityTickForUser(42);

    expect(spy).toHaveBeenCalledWith({ userId: 42 });
  });

  it('swallows errors from runCouncil instead of throwing', async () => {
    vi.spyOn(personalityAgents, 'runCouncil').mockRejectedValue(new Error('boom'));

    await expect(scheduler.runPersonalityTickForUser(42)).resolves.toBeUndefined();
  });
});
