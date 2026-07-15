const db = require('../connection');

const insertEntryStmt = db.prepare(`
  INSERT INTO gl_entries (
    user_id, broker_account_id, order_id, plan_action_id, symbol, account_code, account_name,
    debit, credit, quantity, unit_price, currency, source_type, memo
  )
  VALUES (
    @userId, @brokerAccountId, @orderId, @planActionId, @symbol, @accountCode, @accountName,
    @debit, @credit, @quantity, @unitPrice, @currency, @sourceType, @memo
  )
`);

const listByUserStmt = db.prepare('SELECT * FROM gl_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
const listByCompanyStmt = db.prepare('SELECT * FROM gl_entries WHERE user_id = ? AND symbol = ? ORDER BY created_at DESC, id DESC LIMIT ?');
const listCompanySymbolsStmt = db.prepare(`
  SELECT symbol, COUNT(*) AS entry_count, MAX(created_at) AS latest_entry_at
  FROM gl_entries
  WHERE user_id = ?
  GROUP BY symbol
  ORDER BY latest_entry_at DESC, symbol
`);

function recordTrade({
  userId,
  brokerAccountId = null,
  orderId = null,
  planActionId = null,
  symbol,
  side,
  quantity = 0,
  unitPrice = 0,
  currency = 'USD',
  sourceType = 'order_fill',
  memo = null,
}) {
  const cleanSymbol = String(symbol || '').toUpperCase();
  const cleanSide = String(side || '').toLowerCase();
  if (!userId || !cleanSymbol || !['buy', 'sell'].includes(cleanSide)) return [];

  const qty = Number(quantity || 0);
  const price = Number(unitPrice || 0);
  const amount = roundMoney(qty * price);
  if (amount <= 0) return [];

  const common = {
    userId,
    brokerAccountId,
    orderId,
    planActionId,
    symbol: cleanSymbol,
    quantity: qty,
    unitPrice: price,
    currency,
    sourceType,
    memo: memo || `${sourceType} ${cleanSide} ${qty} ${cleanSymbol} @ ${price}`,
  };

  const cash = {
    ...common,
    accountCode: '1000',
    accountName: 'Cash',
    debit: cleanSide === 'sell' ? amount : 0,
    credit: cleanSide === 'buy' ? amount : 0,
  };
  const investment = {
    ...common,
    accountCode: `1200-${cleanSymbol}`,
    accountName: `Investments - ${cleanSymbol}`,
    debit: cleanSide === 'buy' ? amount : 0,
    credit: cleanSide === 'sell' ? amount : 0,
  };

  const tx = db.transaction(() => {
    const first = insertEntryStmt.run(cleanSide === 'buy' ? investment : cash).lastInsertRowid;
    const second = insertEntryStmt.run(cleanSide === 'buy' ? cash : investment).lastInsertRowid;
    return [first, second];
  });
  return tx();
}

function recordCashFunding({
  userId,
  brokerAccountId = null,
  amountUsd = 0,
  balanceAfterUsd = null,
  currency = 'USD',
  sourceType = 'simulation_cash_funding',
  memo = null,
}) {
  const amount = roundMoney(amountUsd);
  if (!userId || amount <= 0) return [];
  const common = {
    userId,
    brokerAccountId,
    orderId: null,
    planActionId: null,
    symbol: 'CASH',
    quantity: null,
    unitPrice: null,
    currency,
    sourceType,
    memo: memo || `Simulation cash funding +${amount}`,
  };
  const cash = {
    ...common,
    accountCode: '1000',
    accountName: 'Cash',
    debit: amount,
    credit: 0,
  };
  const funding = {
    ...common,
    accountCode: '3900',
    accountName: 'Simulation Funding',
    debit: 0,
    credit: amount,
  };
  const tx = db.transaction(() => {
    const first = insertEntryStmt.run(cash).lastInsertRowid;
    const second = insertEntryStmt.run(funding).lastInsertRowid;
    return [first, second];
  });
  return tx();
}

function listByUser(userId, limit = 100) {
  return listByUserStmt.all(userId, Number(limit) || 100);
}

function listByCompany(userId, symbol, limit = 100) {
  return listByCompanyStmt.all(userId, String(symbol || '').toUpperCase(), Number(limit) || 100);
}

function listCompanySymbols(userId) {
  return listCompanySymbolsStmt.all(userId);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  recordTrade,
  recordCashFunding,
  listByUser,
  listByCompany,
  listCompanySymbols,
};
