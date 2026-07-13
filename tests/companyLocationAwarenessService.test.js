const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-company-location-awareness.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const crawleeResearchCrawler = require('../src/services/crawleeResearchCrawlerService');
const locationAwareness = require('../src/services/companyLocationAwarenessService');

describe('companyLocationAwarenessService', () => {
  it('emits progress while researching company locations', async () => {
    const user = userRepo.createUser({
      email: `location-emit-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const originalCrawl = crawleeResearchCrawler.crawlAutonomousResearch;
    crawleeResearchCrawler.crawlAutonomousResearch = async () => ({ pages: [], discovered: [], failures: [], entityLeads: [] });
    const events = [];
    try {
      await locationAwareness.researchCompanyLocations({
        userId: user.id,
        candidates: [{ symbol: 'WMT', companyName: 'Walmart' }],
        onEvent: (event) => events.push(event),
      });
    } finally {
      crawleeResearchCrawler.crawlAutonomousResearch = originalCrawl;
    }

    expect(events.some((event) => event.phase === 'location-intel')).toBe(true);
  });

  it('builds company geography research questions', () => {
    const queries = locationAwareness.buildLocationResearchQueries({ symbol: 'WMT', companyName: 'Walmart' });

    expect(queries).toEqual(expect.arrayContaining([
      'Where does Walmart have corporate offices',
      'What retail locations does Walmart have',
      'What area of the world has the most customers for Walmart',
    ]));
  });

  it('extracts company offices, retail locations, and customer markets into a location profile', () => {
    const profile = locationAwareness.extractLocationProfile({
      candidate: { symbol: 'WMT', companyName: 'Walmart' },
      documents: [
        {
          title: 'Walmart footprint',
          url: 'https://example.com/wmt-locations',
          text: 'Walmart is based in Bentonville. Walmart retail stores are concentrated across Texas and Florida. Walmart customers are concentrated across the United States.',
        },
      ],
    });

    expect(profile.primaryLocations).toEqual(expect.arrayContaining(['Bentonville', 'Texas', 'Florida']));
    expect(profile.exposures.some((item) => item.type === 'retail')).toBe(true);
    expect(profile.confidence).toBeGreaterThan(0);
  });

  it('weights local events by overlap with company footprint', () => {
    const profile = locationAwareness.extractLocationProfile({
      candidate: { symbol: 'WMT', companyName: 'Walmart' },
      documents: [{
        title: 'Walmart footprint',
        url: 'https://example.com/wmt-locations',
        text: 'Walmart retail stores and customers are concentrated across Florida and Texas.',
      }],
    });
    const floridaImpact = locationAwareness.scoreLocalEventRelevance({
      candidate: { symbol: 'WMT', companyName: 'Walmart' },
      locationProfile: profile,
      documents: [{
        title: 'Florida hurricane',
        url: 'https://example.com/florida-weather',
        text: 'A major hurricane in Florida may disrupt retail traffic and distribution routes.',
      }],
    });
    const distantImpact = locationAwareness.scoreLocalEventRelevance({
      candidate: { symbol: 'WMT', companyName: 'Walmart' },
      locationProfile: profile,
      documents: [{
        title: 'Berlin housing',
        url: 'https://example.com/berlin-housing',
        text: 'Berlin housing permits declined as mortgage rates rose.',
      }],
    });

    expect(floridaImpact.score).toBeLessThan(distantImpact.score);
    expect(floridaImpact.impacts[0].locationRelevance).toBe(1);
    expect(distantImpact.impacts).toHaveLength(0);
  });
});
