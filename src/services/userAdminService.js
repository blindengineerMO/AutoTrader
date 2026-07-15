const bcrypt = require('bcrypt');
const { config } = require('../config');
const userRepo = require('../db/repositories/userRepo');
const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const authService = require('./authService');

const SALT_ROUNDS = 12;

async function ensureDefaultAdmin() {
  const emails = normalizeAdminEmails(config.defaultAdmin.emails || config.defaultAdmin.email);
  if (emails.length === 0 || !config.defaultAdmin.password) return null;

  const admins = [];
  for (const email of emails) {
    admins.push(await ensureDefaultAdminUser(email));
  }
  return admins[0] || null;
}

async function ensureDefaultAdminUser(email) {
  const existing = userRepo.findByEmail(email);
  if (existing) {
    const shouldPromote = existing.role !== 'admin' || existing.status !== 'active';
    const shouldResetPassword = Boolean(config.defaultAdmin.resetPassword);
    let updated = existing;
    if (shouldPromote) {
      updated = userRepo.updateUser(existing.id, { role: 'admin', status: 'active' });
    }
    if (shouldResetPassword) {
      const passwordHash = await bcrypt.hash(config.defaultAdmin.password, SALT_ROUNDS);
      updated = userRepo.updatePassword(existing.id, passwordHash);
    }
    brokerAccountRepo.ensureDefault(updated.id);
    return authService.serializeUser(updated);
  }

  const passwordHash = await bcrypt.hash(config.defaultAdmin.password, SALT_ROUNDS);
  const user = userRepo.createUser({
    email,
    passwordHash,
    dailyLossLimitUsd: config.trading.dailyLossLimitUsd,
    maxTradesPerSymbolPer24h: config.trading.maxTradesPerSymbolPer24h,
    role: 'admin',
    status: 'active',
  });
  brokerAccountRepo.ensureDefault(user.id);
  return authService.serializeUser(user);
}

function normalizeAdminEmails(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
}

async function createUser({ email, password, role = 'user', status = 'active' }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Email is required');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  if (userRepo.findByEmail(normalizedEmail)) throw new Error('An account with that email already exists');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = userRepo.createUser({
    email: normalizedEmail,
    passwordHash,
    dailyLossLimitUsd: config.trading.dailyLossLimitUsd,
    maxTradesPerSymbolPer24h: config.trading.maxTradesPerSymbolPer24h,
    role: normalizeRole(role),
    status: normalizeStatus(status),
  });
  brokerAccountRepo.ensureDefault(user.id);
  return serializeManagedUser(user);
}

function listUsers(query = {}) {
  if (!query || Object.keys(query).length === 0) return userRepo.list().map(serializeManagedUser);
  const result = userRepo.query(query);
  return {
    ...result,
    items: result.items.map(serializeManagedUser),
  };
}

function getUser(id) {
  const user = userRepo.findById(Number(id));
  if (!user) throw new Error('User not found');
  return user;
}

function updateUser(id, patch = {}) {
  const user = getUser(id);
  const nextRole = patch.role === undefined ? user.role : normalizeRole(patch.role);
  const nextStatus = patch.status === undefined ? user.status : normalizeStatus(patch.status);
  assertNotRemovingLastAdmin(user, { role: nextRole, status: nextStatus });

  const email = patch.email === undefined ? user.email : normalizeEmail(patch.email);
  if (!email) throw new Error('Email is required');
  const existing = userRepo.findByEmail(email);
  if (existing && existing.id !== user.id) throw new Error('An account with that email already exists');

  return serializeManagedUser(userRepo.updateUser(user.id, { email, role: nextRole, status: nextStatus }));
}

async function resetPassword(id, password) {
  const user = getUser(id);
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  return serializeManagedUser(userRepo.updatePassword(user.id, passwordHash));
}

function deleteUser(id, { actorId } = {}) {
  const user = getUser(id);
  if (Number(actorId) === Number(user.id)) throw new Error('You cannot delete your own account');
  assertNotRemovingLastAdmin(user, { role: 'user', status: 'disabled' });
  userRepo.deleteUser(user.id);
  return { deleted: true, id: user.id };
}

function assertNotRemovingLastAdmin(user, next) {
  const isActiveAdmin = user.role === 'admin' && user.status === 'active';
  const remainsActiveAdmin = next.role === 'admin' && next.status === 'active';
  if (isActiveAdmin && !remainsActiveAdmin && userRepo.countActiveAdmins() <= 1) {
    throw new Error('At least one active admin is required');
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeRole(role) {
  return role === 'admin' ? 'admin' : 'user';
}

function normalizeStatus(status) {
  return status === 'disabled' ? 'disabled' : 'active';
}

function serializeManagedUser(user) {
  return {
    ...authService.serializeUser(user),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
    passwordChangedAt: user.password_changed_at,
  };
}

module.exports = {
  ensureDefaultAdmin,
  createUser,
  listUsers,
  updateUser,
  resetPassword,
  deleteUser,
};
