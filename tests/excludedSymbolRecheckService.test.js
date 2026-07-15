const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-excluded-symbol-recheck.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const alpacaAssetClient = require('../src/services/marketData/alpacaAssetClient');
const excludedSymbolRecheckService = require('../src/services/excludedSymbolRecheckService');

function newUser() {
  return userRepo.createUser({
    email: `excluded-recheck-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

describe('excludedSymbolRecheckService.recheckExcludedSymbolsForUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when Alpaca is not configured for the user', async () => {
    const userId = newUser();
    settingsRepo.addExcludedSymbol(userId, { symbol: 'NOPE', reason: 'Alpaca reports non-tradable.' });
    vi.spyOn(alpacaAssetClient, 'isConfigured').mockReturnValue(false);

    const result = await excludedSymbolRecheckService.recheckExcludedSymbolsForUser(userId);

    expect(result).toEqual({ checked: 0, restored: [] });
  });

  it('restores an auto-excluded symbol once Alpaca reports it tradable', async () => {
    const userId = newUser();
    settingsRepo.addExcludedSymbol(userId, { symbol: 'RSTR', reason: 'Alpaca reports non-tradable.', source: 'alpaca-asset-eligibility' });
    vi.spyOn(alpacaAssetClient, 'isConfigured').mockReturnValue(true);
    vi.spyOn(alpacaAssetClient, 'recheckAsset').mockResolvedValue({ available: true, tradable: true, symbol: 'RSTR' });

    const result = await excludedSymbolRecheckService.recheckExcludedSymbolsForUser(userId);

    expect(result).toEqual({ checked: 1, restored: ['RSTR'] });
    expect(settingsRepo.isSymbolExcluded(userId, 'RSTR')).toBe(false);
  });

  it('leaves a symbol excluded when Alpaca still reports it non-tradable', async () => {
    const userId = newUser();
    settingsRepo.addExcludedSymbol(userId, { symbol: 'STILL', reason: 'Alpaca reports non-tradable.', source: 'alpaca-asset-eligibility' });
    vi.spyOn(alpacaAssetClient, 'isConfigured').mockReturnValue(true);
    vi.spyOn(alpacaAssetClient, 'recheckAsset').mockResolvedValue({ available: true, tradable: false, symbol: 'STILL' });

    const result = await excludedSymbolRecheckService.recheckExcludedSymbolsForUser(userId);

    expect(result).toEqual({ checked: 1, restored: [] });
    expect(settingsRepo.isSymbolExcluded(userId, 'STILL')).toBe(true);
  });

  it('never re-checks or restores a manually excluded symbol', async () => {
    const userId = newUser();
    settingsRepo.addExcludedSymbol(userId, { symbol: 'MANUAL', reason: 'I do not want to trade this', source: 'manual-settings' });
    vi.spyOn(alpacaAssetClient, 'isConfigured').mockReturnValue(true);
    const recheckSpy = vi.spyOn(alpacaAssetClient, 'recheckAsset').mockResolvedValue({ available: true, tradable: true, symbol: 'MANUAL' });

    const result = await excludedSymbolRecheckService.recheckExcludedSymbolsForUser(userId);

    expect(result).toEqual({ checked: 0, restored: [] });
    expect(recheckSpy).not.toHaveBeenCalled();
    expect(settingsRepo.isSymbolExcluded(userId, 'MANUAL')).toBe(true);
  });
});
