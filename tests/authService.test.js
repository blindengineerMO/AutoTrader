const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-auth-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const authService = require('../src/services/authService');

describe('authService', () => {
  it('registers a new user and issues a verifiable token', async () => {
    const { token, user } = await authService.register({ email: `auth-${Date.now()}@example.com`, password: 'correct-horse' });
    expect(token).toEqual(expect.any(String));
    expect(user.id).toEqual(expect.any(Number));
    const decoded = authService.verifyToken(token);
    expect(decoded.sub).toBe(user.id);
    expect(decoded.email).toBe(user.email);
  });

  it('rejects registration with a duplicate email', async () => {
    const email = `auth-dup-${Date.now()}@example.com`;
    await authService.register({ email, password: 'correct-horse' });
    await expect(authService.register({ email, password: 'another-password' })).rejects.toThrow(/already exists/);
  });

  it('logs in with correct credentials and rejects the wrong password', async () => {
    const email = `auth-login-${Date.now()}@example.com`;
    await authService.register({ email, password: 'correct-horse' });

    const { token } = await authService.login({ email, password: 'correct-horse' });
    expect(token).toEqual(expect.any(String));

    await expect(authService.login({ email, password: 'wrong-password' })).rejects.toThrow(/Invalid email or password/);
  });

  it('rejects login for an email that was never registered', async () => {
    await expect(
      authService.login({ email: `never-registered-${Date.now()}@example.com`, password: 'whatever' })
    ).rejects.toThrow(/Invalid email or password/);
  });

  it('rejects an invalid or tampered token', () => {
    expect(() => authService.verifyToken('not-a-real-token')).toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await authService.register({ email: `auth-wrongsecret-${Date.now()}@example.com`, password: 'correct-horse' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token);
    const forged = jwt.sign({ sub: decoded.sub, email: decoded.email }, 'a-different-secret', { expiresIn: '7d' });
    expect(() => authService.verifyToken(forged)).toThrow();
  });

  it('rejects an expired token', async () => {
    const jwt = require('jsonwebtoken');
    const { config } = require('../src/config');
    const expiredToken = jwt.sign({ sub: 1, email: 'expired@example.com' }, config.jwtSecret, { expiresIn: -10 });
    expect(() => authService.verifyToken(expiredToken)).toThrow(/expired/);
  });
});
