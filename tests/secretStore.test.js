const secretStore = require('../src/services/secretStore');

describe('secretStore', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalCredentialKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalCredentialKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = originalCredentialKey;
  });

  it('round-trips an object through encryptJson/decryptJson', () => {
    const payload = { apiKey: 'sk-live-123', apiSecret: 'super-secret-value' };
    const encrypted = secretStore.encryptJson(payload);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain('super-secret-value');
    expect(secretStore.decryptJson(encrypted)).toEqual(payload);
  });

  it('produces a different ciphertext each time due to a random IV, even for the same input', () => {
    const payload = { apiKey: 'same-every-time' };
    const first = secretStore.encryptJson(payload);
    const second = secretStore.encryptJson(payload);
    expect(first).not.toEqual(second);
    expect(secretStore.decryptJson(first)).toEqual(payload);
    expect(secretStore.decryptJson(second)).toEqual(payload);
  });

  it('encrypts an empty/undefined value as an empty object', () => {
    const encrypted = secretStore.encryptJson(undefined);
    expect(secretStore.decryptJson(encrypted)).toEqual({});
  });

  it('returns an empty object for an empty or malformed payload rather than throwing', () => {
    expect(secretStore.decryptJson('')).toEqual({});
    expect(secretStore.decryptJson(null)).toEqual({});
    expect(secretStore.decryptJson('not-a-valid-payload')).toEqual({});
  });

  it('throws when the auth tag does not match a tampered ciphertext', () => {
    const encrypted = secretStore.encryptJson({ apiKey: 'sk-live-123' });
    const [iv, tag, ciphertext] = encrypted.split('.');
    const tamperedBuf = Buffer.from(ciphertext, 'base64');
    tamperedBuf[0] ^= 0xff;
    const tampered = [iv, tag, tamperedBuf.toString('base64')].join('.');
    expect(() => secretStore.decryptJson(tampered)).toThrow();
  });

  it('produces undecryptable output when the encryption key changes (derived from JWT_SECRET/CREDENTIAL_ENCRYPTION_KEY)', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'key-one';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/secretStore')];
    const storeWithKeyOne = require('../src/services/secretStore');
    const encrypted = storeWithKeyOne.encryptJson({ apiKey: 'sk-live-123' });

    process.env.CREDENTIAL_ENCRYPTION_KEY = 'key-two';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/services/secretStore')];
    const storeWithKeyTwo = require('../src/services/secretStore');

    expect(() => storeWithKeyTwo.decryptJson(encrypted)).toThrow();
  });
});
