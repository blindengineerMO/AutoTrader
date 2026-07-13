const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-price-tier-bonus.db');
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
    email: `price-tier-bonus-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

function baseArgs(userId, candidates, quotes) {
  return {
    userId,
    candidates,
    quotes,
    news: { items: [] },
    macro: { riskBias: 'neutral' },
    consumer: { consumerBias: 'neutral' },
    learned: { observations: [] },
    companyIntel: { records: [] },
    jsonDatasets: [],
    onEvent: () => {},
  };
}

function quote(symbol, current) {
  return {
    symbol,
    current,
    open: current,
    high: current * 1.01,
    low: current * 0.99,
    prevClose: current,
    changePct: 0,
  };
}

describe('sub-$20 price-tier scoring bonus', () => {
  it('ranks an otherwise-identical sub-$20 candidate above a $20+ candidate', () => {
    const userId = newUser();
    const candidates = [
      { symbol: 'CHEAP', theme: 'watchlist', themeHits: 0 },
      { symbol: 'PRICEY', theme: 'watchlist', themeHits: 0 },
    ];
    const quotes = [quote('CHEAP', 15), quote('PRICEY', 25)];

    const scored = scoreCandidates(baseArgs(userId, candidates, quotes));
    const cheap = scored.find((s) => s.symbol === 'CHEAP');
    const pricey = scored.find((s) => s.symbol === 'PRICEY');

    expect(cheap.priceTierBonusApplied).toBe(true);
    expect(pricey.priceTierBonusApplied).toBe(false);
    expect(cheap.localAiScore).toBeGreaterThan(cheap.baseLocalAiScore);
    expect(pricey.localAiScore).toBe(pricey.baseLocalAiScore);
    expect(cheap.localAiScore).toBeGreaterThanOrEqual(pricey.localAiScore);
  });

  it('caps the bonus and never pushes the score above 100', () => {
    const userId = newUser();
    const candidates = [{ symbol: 'HOT', theme: 'watchlist', themeHits: 0 }];
    const quotes = [{ ...quote('HOT', 5), changePct: 10 }];

    const [signal] = scoreCandidates(baseArgs(userId, candidates, quotes));
    expect(signal.localAiScore).toBeLessThanOrEqual(100);
    expect(signal.localAiScore - signal.baseLocalAiScore).toBeLessThanOrEqual(5);
  });

  it('does not invert a strong signal from a more expensive stock', () => {
    const userId = newUser();
    const candidates = [
      { symbol: 'WEAKCHEAP', theme: 'watchlist', themeHits: 0 },
      { symbol: 'STRONGPRICEY', theme: 'watchlist', themeHits: 0 },
    ];
    const quotes = [
      { ...quote('WEAKCHEAP', 10), changePct: -8 },
      { ...quote('STRONGPRICEY', 200), changePct: 8 },
    ];

    const scored = scoreCandidates(baseArgs(userId, candidates, quotes));
    const weakCheap = scored.find((s) => s.symbol === 'WEAKCHEAP');
    const strongPricey = scored.find((s) => s.symbol === 'STRONGPRICEY');

    expect(strongPricey.localAiScore).toBeGreaterThan(weakCheap.localAiScore);
  });
});
