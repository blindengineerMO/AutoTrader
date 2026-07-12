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

  it('queries research URL memory with pagination, search, filters, and sort order', () => {
    const user = userRepo.createUser({
      email: `sources-query-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    researchSourceRepo.upsert({
      userId: user.id,
      url: 'https://sec.example.com/edgar-xbrl',
      title: 'SEC EDGAR XBRL',
      sourceType: 'seed',
      status: 'active',
      discoveryMethod: 'spec-catalog',
      tags: ['sec', 'filings'],
      relevanceScore: 91,
      credibilityScore: 96,
    });
    researchSourceRepo.upsert({
      userId: user.id,
      url: 'https://macro.example.com/fred',
      title: 'FRED Macro',
      sourceType: 'seed',
      status: 'paused',
      discoveryMethod: 'spec-catalog',
      tags: ['macro'],
      relevanceScore: 84,
      credibilityScore: 94,
    });
    researchSourceRepo.upsert({
      userId: user.id,
      url: 'https://news.example.com/markets',
      title: 'Market News',
      sourceType: 'learned',
      status: 'active',
      discoveryMethod: 'crawlee',
      tags: ['news'],
      relevanceScore: 55,
      credibilityScore: 42,
    });

    const searched = researchSourceRepo.queryByUser(user.id, {
      search: 'EDGAR',
      page: 1,
      pageSize: 5,
    });
    expect(searched.total).toBe(1);
    expect(searched.items[0].title).toBe('SEC EDGAR XBRL');

    const filtered = researchSourceRepo.queryByUser(user.id, {
      status: 'active',
      sourceType: 'seed',
      sortBy: 'credibility_score',
      sortDir: 'desc',
    });
    expect(filtered.items.map((source) => source.title)).toEqual(['SEC EDGAR XBRL']);

    const paged = researchSourceRepo.queryByUser(user.id, {
      page: 2,
      pageSize: 1,
      sortBy: 'relevance_score',
      sortDir: 'desc',
    });
    expect(paged.total).toBe(3);
    expect(paged.totalPages).toBe(3);
    expect(paged.items).toHaveLength(1);
    expect(paged.items[0].title).toBe('FRED Macro');
  });
});
