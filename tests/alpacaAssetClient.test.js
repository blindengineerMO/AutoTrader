const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-alpaca-assets.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const providerCredentialRepo = require('../src/db/repositories/providerCredentialRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const httpCache = require('../src/utils/httpCache');
const alpacaAssetClient = require('../src/services/marketData/alpacaAssetClient');

function newUser() {
  const user = userRepo.createUser({
    email: `alpaca-assets-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  });
  providerCredentialRepo.save({
    userId: user.id,
    providerType: 'broker',
    providerKey: 'alpaca',
    displayName: 'Alpaca',
    fields: { keyId: 'key', secretKey: 'secret', paper: 'true' },
  });
  return user.id;
}

describe('alpacaAssetClient', () => {
  afterEach(() => {
    alpacaAssetClient.__setClientFactoryForTests(null);
    httpCache.clearCache('alpaca:');
  });

  it('confirms a tradable Alpaca asset without excluding it', async () => {
    const userId = newUser();
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAsset: async () => ({ symbol: 'AAPL', name: 'Apple Inc.', status: 'active', tradable: true, exchange: 'NASDAQ' }),
    }));

    const result = await alpacaAssetClient.evaluateSymbol('aapl', { userId, companyName: 'Apple' });

    expect(result).toMatchObject({ eligible: true, symbol: 'AAPL', companyName: 'Apple Inc.' });
    expect(settingsRepo.getExcludedSymbols(userId)).toHaveLength(0);
  });

  it('persists Alpaca non-tradable symbols to user settings exclusions', async () => {
    const userId = newUser();
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAsset: async () => ({ symbol: 'BAD', name: 'Bad Asset', status: 'inactive', tradable: false, exchange: 'OTC' }),
    }));

    const result = await alpacaAssetClient.evaluateSymbol('BAD', { userId, companyName: 'Bad Asset', source: 'test' });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('inactive');
    expect(settingsRepo.getExcludedSymbols(userId)[0]).toMatchObject({
      symbol: 'BAD',
      companyName: 'Bad Asset',
      source: 'test',
      assetStatus: 'inactive',
      exchange: 'OTC',
    });
  });

  it('cross-checks the bulk active-asset list before excluding a symbol whose single-asset lookup 404s', async () => {
    const userId = newUser();
    const notFoundError = Object.assign(new Error('asset not found'), { statusCode: 404 });
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAsset: async () => { throw notFoundError; },
      getAssets: async () => [
        { symbol: 'GOOD', name: 'Genuinely Tradable Co', status: 'active', tradable: true, exchange: 'NASDAQ' },
      ],
    }));

    const result = await alpacaAssetClient.evaluateSymbol('GOOD', { userId, companyName: 'Genuinely Tradable Co' });

    expect(result.eligible).toBe(true);
    expect(settingsRepo.getExcludedSymbols(userId)).toHaveLength(0);
  });

  it('still excludes a symbol that 404s on single-asset lookup and is absent from the bulk active list', async () => {
    const userId = newUser();
    const notFoundError = Object.assign(new Error('asset not found'), { statusCode: 404 });
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAsset: async () => { throw notFoundError; },
      getAssets: async () => [
        { symbol: 'OTHER', name: 'Some Other Co', status: 'active', tradable: true, exchange: 'NASDAQ' },
      ],
    }));

    const result = await alpacaAssetClient.evaluateSymbol('MISSING', { userId, companyName: 'Missing Co' });

    expect(result.eligible).toBe(false);
    expect(settingsRepo.getExcludedSymbols(userId)[0]).toMatchObject({ symbol: 'MISSING' });
  });

  it('does not treat a non-404 error whose message happens to mention "not found" or "404" as a confirmed-missing asset', async () => {
    const userId = newUser();
    const rateLimitError = Object.assign(new Error('rate limited, retry after 404ms'), { statusCode: 429 });
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAsset: async () => { throw rateLimitError; },
    }));

    const result = await alpacaAssetClient.evaluateSymbol('RATE', { userId, companyName: 'Rate Limited Co' });

    // Treated as a degraded/unknown lookup (permissive), not excluded outright.
    expect(result.eligible).toBe(true);
    expect(result.degraded).toBe(true);
    expect(settingsRepo.getExcludedSymbols(userId)).toHaveLength(0);
  });

  it('uses Alpaca active assets to map company-name leads before Finnhub', async () => {
    const userId = newUser();
    alpacaAssetClient.__setClientFactoryForTests(() => ({
      getAssets: async () => [
        { symbol: 'MSFT', name: 'Microsoft Corporation', status: 'active', tradable: true, exchange: 'NASDAQ' },
        { symbol: 'MOO', name: 'Moonshot Private Shell', status: 'active', tradable: false, exchange: 'OTC' },
      ],
    }));

    const result = await alpacaAssetClient.evaluateCompanyLead({ name: 'Microsoft' }, { userId });

    expect(result).toMatchObject({ eligible: true, symbol: 'MSFT', companyName: 'Microsoft Corporation' });
  });
});
