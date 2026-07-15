const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-user-admin-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.DEFAULT_ADMIN_EMAIL = 'root-admin@example.com';
process.env.DEFAULT_ADMIN_EMAILS = 'root-admin@example.com,ops-admin@example.com';
process.env.DEFAULT_ADMIN_PASSWORD = 'root-password';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const authService = require('../src/services/authService');
const userAdminService = require('../src/services/userAdminService');
const userRepo = require('../src/db/repositories/userRepo');

describe('userAdminService', () => {
  it('creates a configured default admin and can log in with it', async () => {
    const admin = await userAdminService.ensureDefaultAdmin();
    expect(admin.email).toBe('root-admin@example.com');
    expect(admin.role).toBe('admin');
    expect(admin.isAdmin).toBe(true);

    const login = await authService.login({ email: 'root-admin@example.com', password: 'root-password' });
    expect(login.user.isAdmin).toBe(true);

    const aliasLogin = await authService.login({ email: 'ops-admin@example.com', password: 'root-password' });
    expect(aliasLogin.user.isAdmin).toBe(true);
  });

  it('creates managed users and resets passwords without sharing accounts', async () => {
    await userAdminService.ensureDefaultAdmin();
    const user = await userAdminService.createUser({
      email: 'managed-user@example.com',
      password: 'first-password',
      role: 'user',
    });
    expect(user.role).toBe('user');
    expect(user.status).toBe('active');

    const login = await authService.login({ email: 'managed-user@example.com', password: 'first-password' });
    expect(login.user.id).toBe(user.id);

    await userAdminService.resetPassword(user.id, 'second-password');
    await expect(authService.login({ email: 'managed-user@example.com', password: 'first-password' })).rejects.toThrow(/Invalid email or password/);
    await expect(authService.login({ email: 'managed-user@example.com', password: 'second-password' })).resolves.toBeTruthy();
  });

  it('rejects disabled users at login and token hydration time', async () => {
    await userAdminService.ensureDefaultAdmin();
    const user = await userAdminService.createUser({
      email: 'disabled-user@example.com',
      password: 'user-password',
    });
    const login = await authService.login({ email: 'disabled-user@example.com', password: 'user-password' });
    expect(login.token).toEqual(expect.any(String));

    userAdminService.updateUser(user.id, { status: 'disabled' });
    await expect(authService.login({ email: 'disabled-user@example.com', password: 'user-password' })).rejects.toThrow(/Account is disabled/);
    expect(userRepo.findById(user.id).status).toBe('disabled');
  });

  it('does not allow the last active admin to be disabled or demoted', async () => {
    const admin = await userAdminService.ensureDefaultAdmin();
    const aliasAdmin = userRepo.findByEmail('ops-admin@example.com');
    if (aliasAdmin?.role === 'admin') {
      userAdminService.updateUser(aliasAdmin.id, { role: 'user' });
    }
    expect(() => userAdminService.updateUser(admin.id, { role: 'user' })).toThrow(/At least one active admin/);
    expect(() => userAdminService.updateUser(admin.id, { status: 'disabled' })).toThrow(/At least one active admin/);

    const secondAdmin = await userAdminService.createUser({
      email: 'second-admin@example.com',
      password: 'second-admin-password',
      role: 'admin',
    });
    expect(userAdminService.updateUser(admin.id, { role: 'user' }).role).toBe('user');
    expect(userRepo.findById(secondAdmin.id).role).toBe('admin');
  });

  it('queries users with search, filters, sort, and pagination', async () => {
    await userAdminService.ensureDefaultAdmin();
    await userAdminService.createUser({
      email: 'alpha-user@example.com',
      password: 'alpha-password',
      role: 'user',
    });
    await userAdminService.createUser({
      email: 'zeta-admin@example.com',
      password: 'zeta-password',
      role: 'admin',
    });
    await userAdminService.createUser({
      email: 'disabled-match@example.com',
      password: 'disabled-password',
      status: 'disabled',
    });

    const searched = userAdminService.listUsers({
      search: 'example.com',
      status: 'active',
      sortBy: 'email',
      sortDir: 'asc',
      page: 1,
      pageSize: 2,
    });

    expect(searched.items).toHaveLength(2);
    expect(searched.total).toBeGreaterThanOrEqual(2);
    expect(searched.totalPages).toBeGreaterThanOrEqual(1);
    expect(searched.items.map((user) => user.email)).toEqual([...searched.items.map((user) => user.email)].sort());

    const admins = userAdminService.listUsers({ role: 'admin', search: 'zeta' });
    expect(admins.items.map((user) => user.email)).toContain('zeta-admin@example.com');
  });

  it('deletes users while protecting the current account and last active admin', async () => {
    const admin = await userAdminService.ensureDefaultAdmin();
    const disposable = await userAdminService.createUser({
      email: 'delete-me@example.com',
      password: 'delete-password',
      role: 'user',
    });

    expect(() => userAdminService.deleteUser(admin.id, { actorId: admin.id })).toThrow(/own account/);
    expect(userAdminService.deleteUser(disposable.id, { actorId: admin.id })).toEqual({ deleted: true, id: disposable.id });
    expect(userRepo.findById(disposable.id)).toBeUndefined();

    for (const otherAdmin of userAdminService.listUsers().filter((user) => user.id !== admin.id && user.role === 'admin' && user.status === 'active')) {
      userAdminService.updateUser(otherAdmin.id, { role: 'user' });
    }
    expect(() => userAdminService.deleteUser(admin.id, { actorId: 999999 })).toThrow(/At least one active admin/);
  });
});
