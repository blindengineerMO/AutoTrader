const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-location-coordinator.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const companyLocationProfileRepo = require('../src/db/repositories/companyLocationProfileRepo');
const companyLocationAwareness = require('../src/services/companyLocationAwarenessService');
const brainMesh = require('../src/services/brainMeshService');
const financialWeights = require('../src/services/financialEventWeightingService');
const locationCoordinator = require('../src/services/locationCoordinatorService');
const db = require('../src/db/connection');

function taiwanProfile(symbol) {
  return {
    symbol,
    companyName: symbol,
    researchedAt: new Date().toISOString(),
    exposures: [
      { type: 'supply_chain', location: 'Taiwan', canonical: 'taiwan', score: 0.9, evidence: [] },
      { type: 'customer_market', location: 'United States', canonical: 'united states', score: 0.8, evidence: [] },
    ],
    primaryLocations: ['Taiwan', 'United States'],
    confidence: 0.8,
  };
}

describe('locationCoordinatorService', () => {
  let userId;

  beforeAll(() => {
    userId = userRepo.createUser({
      email: `loc-coord-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    }).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.prepare('DELETE FROM company_location_profiles').run();
  });

  it('researches, caches, and broadcasts a compact location mapping', async () => {
    const spy = vi.spyOn(companyLocationAwareness, 'researchCompanyLocations').mockResolvedValue({
      profilesBySymbol: new Map([['TSM', taiwanProfile('TSM')]]),
      crawl: null,
    });
    const tells = [];
    vi.spyOn(brainMesh, 'tell').mockImplementation((frame) => tells.push(frame));

    const { mapping } = await locationCoordinator.coordinateLocations({
      userId,
      candidates: [{ symbol: 'TSM', companyName: 'Taiwan Semiconductor' }],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(mapping.TSM.manufacturing).toContain('Taiwan');
    expect(companyLocationProfileRepo.getBySymbol(userId, 'TSM').profile.primaryLocations).toContain('Taiwan');
    const readyFrame = tells.find((frame) => frame.op === 'location.mapping.ready');
    expect(readyFrame.body.symbols).toContain('TSM');
  });

  it('uses the cached profile without re-researching when fresh', async () => {
    companyLocationProfileRepo.save({ userId, symbol: 'TSM', companyName: 'Taiwan Semi', profile: taiwanProfile('TSM') });
    const spy = vi.spyOn(companyLocationAwareness, 'researchCompanyLocations');
    vi.spyOn(brainMesh, 'tell').mockImplementation(() => {});

    const { mapping, researched } = await locationCoordinator.coordinateLocations({
      userId,
      candidates: [{ symbol: 'TSM' }],
    });

    expect(spy).not.toHaveBeenCalled();
    expect(researched).toEqual([]);
    expect(mapping.TSM.manufacturing).toContain('Taiwan');
  });

  it('raises event relevance for a geographically-exposed company not named in the event', () => {
    // A production-disruption event in Taiwan that never names the company. Only
    // the location profile ties the event to the company.
    const geoEventNews = {
      items: [{
        title: 'Taiwan plant shutdown triggers production disruption',
        description: 'A major plant shutdown and production disruption hit Taiwan facilities this week.',
        link: 'https://www.reuters.com/world/taiwan-plant-shutdown',
      }],
    };
    const candidate = { symbol: 'ACME', companyName: 'Acme Components', theme: 'components-maker' };

    const withGeo = financialWeights.scoreCandidateEvidence({
      candidate: { ...candidate, locationProfile: taiwanProfile('ACME') },
      news: geoEventNews,
      learned: { observations: [] },
    });
    const withoutGeo = financialWeights.scoreCandidateEvidence({
      candidate,
      news: geoEventNews,
      learned: { observations: [] },
    });

    expect(Math.abs(withGeo.aggregateScore)).toBeGreaterThan(Math.abs(withoutGeo.aggregateScore));
  });
});
