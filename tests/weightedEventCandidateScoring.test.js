const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-weighted-event-candidates.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const { scoreCandidates } = require('../src/services/autonomousResearchService');

function newUser() {
  return userRepo.createUser({
    email: `weighted-events-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

function quote(symbol) {
  return {
    symbol,
    current: 100,
    open: 100,
    high: 101,
    low: 99,
    prevClose: 100,
    changePct: 0,
  };
}

describe('weighted event candidate scoring', () => {
  it('feeds WEIGHT.md event evidence into candidate scoring and reports', () => {
    const userId = newUser();
    const scored = scoreCandidates({
      userId,
      candidates: [
        { symbol: 'BULL', companyName: 'Bull Systems', theme: 'watchlist', themeHits: 1 },
        { symbol: 'BEAR', companyName: 'Bear Systems', theme: 'watchlist', themeHits: 1 },
      ],
      quotes: [quote('BULL'), quote('BEAR')],
      news: {
        items: [
          {
            title: 'Bull Systems raised guidance above consensus',
            description: 'BULL reported revenue beat, margin expansion, and free cash flow exceeded expectations.',
            link: 'https://www.sec.gov/Archives/bull',
          },
          {
            title: 'Bear Systems guidance reduced below expectations',
            description: 'BEAR reported cash burn increased, going concern warning, and liquidity concern.',
            link: 'https://www.sec.gov/Archives/bear',
          },
        ],
      },
      macro: { riskBias: 'neutral' },
      consumer: { consumerBias: 'neutral' },
      learned: { observations: [] },
      companyIntel: { records: [] },
      jsonDatasets: [],
      onEvent: () => {},
    });

    const bull = scored.find((item) => item.symbol === 'BULL');
    const bear = scored.find((item) => item.symbol === 'BEAR');

    expect(bull.financialEventScore).toBeGreaterThan(0);
    expect(bear.financialEventScore).toBeLessThan(0);
    expect(bull.localAiScore).toBeGreaterThan(bear.localAiScore);
    expect(bull.evidence.financialEvents.topEvents.length).toBeGreaterThan(0);
    expect(bull.evidence.financialEvents.note).toContain('do not directly authorize');
  });
});
