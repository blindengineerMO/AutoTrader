const db = require('../connection');

const insertUser = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare('SELECT * FROM users WHERE id = ?');
const listUsers = db.prepare('SELECT * FROM users ORDER BY id');
const insertSettings = db.prepare(
  'INSERT INTO user_settings (user_id, daily_loss_limit_usd, max_trades_per_symbol_per_24h) VALUES (?, ?, ?)'
);

function createUser({ email, passwordHash, dailyLossLimitUsd, maxTradesPerSymbolPer24h }) {
  const createTx = db.transaction(() => {
    const { lastInsertRowid } = insertUser.run(email, passwordHash);
    insertSettings.run(lastInsertRowid, dailyLossLimitUsd, maxTradesPerSymbolPer24h);
    return lastInsertRowid;
  });
  const id = createTx();
  return findById.get(id);
}

module.exports = {
  createUser,
  findByEmail: (email) => findByEmail.get(email),
  findById: (id) => findById.get(id),
  list: () => listUsers.all(),
};
