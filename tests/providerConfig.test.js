const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-provider-config.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const providerConfigService = require('../src/services/providerConfigService');
const providerCredentialRepo = require('../src/db/repositories/providerCredentialRepo');

describe('providerConfigService', () => {
  it('merges provider fields so updating one value does not erase saved secrets', () => {
    const user = userRepo.createUser({
      email: `provider-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    providerConfigService.saveProvider(user.id, 'openai', { apiKey: 'sk-test-secret' });
    providerConfigService.saveProvider(user.id, 'openai', { model: 'gpt-4o-mini' });

    const stored = providerCredentialRepo.getSecret(user.id, 'openai');
    expect(stored.apiKey).toBe('sk-test-secret');
    expect(stored.model).toBe('gpt-4o-mini');
  });
});
