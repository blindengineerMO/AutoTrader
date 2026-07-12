const db = require('../connection');

const getPosition = db.prepare('SELECT * FROM positions WHERE broker_account_id = ? AND symbol = ?');
const upsert = db.prepare(`
  INSERT INTO positions (user_id, broker_account_id, symbol, quantity, avg_cost_usd, updated_at)
  VALUES (@userId, @brokerAccountId, @symbol, @quantity, @avgCostUsd, datetime('now'))
  ON CONFLICT (broker_account_id, symbol)
  DO UPDATE SET quantity = @quantity, avg_cost_usd = @avgCostUsd, updated_at = datetime('now')
`);
const listByUser = db.prepare('SELECT * FROM positions WHERE user_id = ? AND quantity > 0');

/** Applies a fill to the position, using weighted-average cost for buys and FIFO-average for sell P&L. Returns realized P&L (0 for buys). */
function applyFill({ userId, brokerAccountId, symbol, side, quantity, fillPrice }) {
  const existing = getPosition.get(brokerAccountId, symbol);
  let realizedPnl = 0;

  if (side === 'buy') {
    const priorQty = existing?.quantity || 0;
    const priorCost = existing?.avg_cost_usd || 0;
    const newQty = priorQty + quantity;
    const newAvgCost = newQty > 0 ? (priorQty * priorCost + quantity * fillPrice) / newQty : 0;
    upsert.run({ userId, brokerAccountId, symbol, quantity: newQty, avgCostUsd: newAvgCost });
  } else {
    const priorQty = existing?.quantity || 0;
    const priorCost = existing?.avg_cost_usd || 0;
    const newQty = Math.max(0, priorQty - quantity);
    realizedPnl = (fillPrice - priorCost) * Math.min(quantity, priorQty);
    upsert.run({ userId, brokerAccountId, symbol, quantity: newQty, avgCostUsd: newQty > 0 ? priorCost : 0 });
  }

  return realizedPnl;
}

module.exports = {
  get: (brokerAccountId, symbol) => getPosition.get(brokerAccountId, symbol),
  listByUser: (userId) => listByUser.all(userId),
  applyFill,
};
