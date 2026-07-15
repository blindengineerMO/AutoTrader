const db = require('../connection');

const insertUser = db.prepare(`
  INSERT INTO users (email, password_hash, role, status, updated_at, password_changed_at)
  VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
`);
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const listUsers = db.prepare("SELECT * FROM users ORDER BY role = 'admin' DESC, status = 'active' DESC, email");
const deleteUserStmt = db.prepare('DELETE FROM users WHERE id = ?');
const updateUserStmt = db.prepare(`
  UPDATE users
  SET email = @email,
      role = @role,
      status = @status,
      updated_at = datetime('now')
  WHERE id = @id
`);
const updatePasswordStmt = db.prepare(`
  UPDATE users
  SET password_hash = @passwordHash,
      password_changed_at = datetime('now'),
      updated_at = datetime('now')
  WHERE id = @id
`);
const markLoginStmt = db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?");
const countActiveAdminsStmt = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'");
const countUsersStmt = db.prepare('SELECT COUNT(*) AS count FROM users');
const insertSettings = db.prepare(
  `INSERT INTO user_settings (
     user_id, daily_loss_limit_usd, max_trades_per_symbol_per_24h,
     research_cadence_cron, watcher_cycle_cadence_cron, personality_tick_cadence_cron
   ) VALUES (?, ?, ?, ?, ?, ?)`
);

function normalizeUserPatch(patch = {}) {
  return {
    email: String(patch.email || '').trim().toLowerCase(),
    role: patch.role === 'admin' ? 'admin' : 'user',
    status: patch.status === 'disabled' ? 'disabled' : 'active',
  };
}

function createUser({ email, passwordHash, dailyLossLimitUsd, maxTradesPerSymbolPer24h, role = 'user', status = 'active' }) {
  const normalized = normalizeUserPatch({ email, role, status });
  const createTx = db.transaction(() => {
    const { lastInsertRowid } = insertUser.run(normalized.email, passwordHash, normalized.role, normalized.status);
    insertSettings.run(lastInsertRowid, dailyLossLimitUsd, maxTradesPerSymbolPer24h, '0 * * * *', '0 * * * *', '0 * * * *');
    return lastInsertRowid;
  });
  const id = createTx();
  return findById.get(id);
}

function updateUser(id, patch = {}) {
  const existing = findById.get(id);
  if (!existing) return null;
  const normalized = normalizeUserPatch({
    email: patch.email || existing.email,
    role: patch.role || existing.role,
    status: patch.status || existing.status,
  });
  updateUserStmt.run({ id, ...normalized });
  return findById.get(id);
}

function updatePassword(id, passwordHash) {
  updatePasswordStmt.run({ id, passwordHash });
  return findById.get(id);
}

const USER_SORT_COLUMNS = {
  email: 'email',
  role: 'role',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
  last_login_at: 'last_login_at',
  password_changed_at: 'password_changed_at',
};

function queryUsers({
  page = 1,
  pageSize = 25,
  search = '',
  role = '',
  status = '',
  sortBy = 'created_at',
  sortDir = 'desc',
} = {}) {
  const limit = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;
  const where = [];
  const params = { limit, offset };

  if (search) {
    params.search = `%${String(search).trim().toLowerCase()}%`;
    where.push('(LOWER(email) LIKE @search OR CAST(id AS TEXT) LIKE @search)');
  }
  if (role) {
    params.role = role === 'admin' ? 'admin' : 'user';
    where.push('role = @role');
  }
  if (status) {
    params.status = status === 'disabled' ? 'disabled' : 'active';
    where.push('status = @status');
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumn = USER_SORT_COLUMNS[sortBy] || USER_SORT_COLUMNS.created_at;
  const direction = sortDir === 'asc' ? 'ASC' : 'DESC';
  const secondarySort = sortColumn === 'email' ? 'id DESC' : 'email COLLATE NOCASE ASC';
  const rows = db.prepare(`
    SELECT *
    FROM users
    ${whereClause}
    ORDER BY ${sortColumn} ${direction}, ${secondarySort}
    LIMIT @limit OFFSET @offset
  `).all(params);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${whereClause}`).get(params).count;

  return {
    items: rows,
    total,
    page: currentPage,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

function deleteUser(id) {
  return deleteUserStmt.run(id).changes;
}

module.exports = {
  createUser,
  findByEmail: (email) => findByEmail.get(email),
  findById: (id) => findById.get(id),
  list: () => listUsers.all(),
  query: queryUsers,
  updateUser,
  updatePassword,
  deleteUser,
  markLogin: (id) => markLoginStmt.run(id),
  countActiveAdmins: () => countActiveAdminsStmt.get().count,
  countUsers: () => countUsersStmt.get().count,
};
