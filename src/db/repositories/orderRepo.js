const db = require('../connection');

const insertOrder = db.prepare(`
  INSERT INTO orders (user_id, broker_account_id, plan_action_id, symbol, side, quantity, order_type, status, broker_order_id)
  VALUES (@userId, @brokerAccountId, @planActionId, @symbol, @side, @quantity, @orderType, @status, @brokerOrderId)
`);
const markFilled = db.prepare(`
  UPDATE orders SET status = 'filled', fill_price = ?, filled_at = datetime('now') WHERE id = ?
`);
const markFailed = db.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?`);
const countRecentForSymbol = db.prepare(`
  SELECT COUNT(*) AS n FROM orders
  WHERE user_id = ? AND symbol = ? AND submitted_at >= datetime('now', '-24 hours')
`);
const listByUser = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY submitted_at DESC LIMIT ?');
const listFilledSimulationByUser = db.prepare(`
  SELECT * FROM orders
  WHERE user_id = ? AND order_type = 'simulated_market' AND status = 'filled'
  ORDER BY filled_at ASC, submitted_at ASC, id ASC
`);
const getById = db.prepare('SELECT * FROM orders WHERE id = ?');

function create(order) {
  const { lastInsertRowid } = insertOrder.run(order);
  return getById.get(lastInsertRowid);
}

module.exports = {
  create,
  markFilled: (id, fillPrice) => markFilled.run(fillPrice, id),
  markFailed: (id) => markFailed.run(id),
  countRecentForSymbol: (userId, symbol) => countRecentForSymbol.get(userId, symbol).n,
  listByUser: (userId, limit = 50) => listByUser.all(userId, limit),
  listFilledSimulationByUser: (userId) => listFilledSimulationByUser.all(userId),
  getById: (id) => getById.get(id),
};
