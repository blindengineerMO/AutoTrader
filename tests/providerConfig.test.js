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

  it('exposes optional free data-source credentials in settings providers', () => {
    const user = userRepo.createUser({
      email: `data-source-provider-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const providers = providerConfigService.listProviders(user.id);
    const keys = providers.map((provider) => provider.providerKey);

    expect(keys).toEqual(expect.arrayContaining(['sec-edgar', 'census-bfs', 'census-bds', 'gdelt', 'openalex', 'openfda', 'reliefweb', 'nws-weather']));
    expect(providers.find((provider) => provider.providerKey === 'sec-edgar').fields[0].key).toBe('userAgent');
    expect(providers.find((provider) => provider.providerKey === 'census-bfs').fields[0].key).toBe('apiKey');
    expect(providers.find((provider) => provider.providerKey === 'census-bds').fields[0].key).toBe('apiKey');
    expect(providers.find((provider) => provider.providerKey === 'gdelt').fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(['enabled', 'maxRecords'])
    );
    expect(providers.find((provider) => provider.providerKey === 'reliefweb').fields[0].key).toBe('appName');
    expect(providers.find((provider) => provider.providerKey === 'nws-weather').fields[0].key).toBe('userAgent');
  });

  it('exposes Alpaca as the broker provider', () => {
    const user = userRepo.createUser({
      email: `alpaca-provider-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const providers = providerConfigService.listProviders(user.id);
    const alpaca = providers.find((provider) => provider.providerKey === 'alpaca');

    expect(alpaca).toBeDefined();
    expect(alpaca.providerType).toBe('broker');
    expect(alpaca.displayName).toBe('Alpaca');
    expect(alpaca.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(['keyId', 'secretKey', 'paper', 'baseUrl'])
    );
  });

  it('lists the local Ollama provider as env-configured by default (no API key required)', () => {
    const user = userRepo.createUser({
      email: `ollama-provider-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const providers = providerConfigService.listProviders(user.id);
    const ollama = providers.find((provider) => provider.providerKey === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama.providerType).toBe('ai');
    expect(ollama.envConfigured).toBe(true);
    expect(ollama.fields.map((field) => field.key)).toEqual(expect.arrayContaining(['baseUrl', 'model']));
  });
});
