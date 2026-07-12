const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { config } = require('../config');
const userRepo = require('../db/repositories/userRepo');
const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');

const SALT_ROUNDS = 12;
const TOKEN_TTL = '7d';

async function register({ email, password }) {
  if (userRepo.findByEmail(email)) {
    throw new Error('An account with that email already exists');
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = userRepo.createUser({
    email,
    passwordHash,
    dailyLossLimitUsd: config.trading.dailyLossLimitUsd,
    maxTradesPerSymbolPer24h: config.trading.maxTradesPerSymbolPer24h,
  });
  brokerAccountRepo.ensureDefault(user.id);
  return issueToken(user);
}

async function login({ email, password }) {
  const user = userRepo.findByEmail(email);
  if (!user) throw new Error('Invalid email or password');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error('Invalid email or password');
  return issueToken(user);
}

function issueToken(user) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is not configured');
  const token = jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: TOKEN_TTL });
  return { token, user: { id: user.id, email: user.email } };
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { register, login, verifyToken };
