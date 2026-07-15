const db = require('../connection');

const insertRuleStmt = db.prepare(`
  INSERT INTO simulation_cash_funding_rules (
    user_id, amount_usd, cadence, weekday, month_day, time_of_day, status, next_run_at, memo
  )
  VALUES (
    @userId, @amountUsd, @cadence, @weekday, @monthDay, @timeOfDay, @status, @nextRunAt, @memo
  )
`);
const getRuleStmt = db.prepare('SELECT * FROM simulation_cash_funding_rules WHERE user_id = ? AND id = ?');
const listRulesStmt = db.prepare(`
  SELECT * FROM simulation_cash_funding_rules
  WHERE user_id = ?
  ORDER BY status = 'active' DESC, next_run_at IS NULL, next_run_at ASC, created_at DESC
  LIMIT ?
`);
const listDueRulesStmt = db.prepare(`
  SELECT * FROM simulation_cash_funding_rules
  WHERE user_id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
  ORDER BY next_run_at ASC, id ASC
  LIMIT 25
`);
const updateRuleRunStmt = db.prepare(`
  UPDATE simulation_cash_funding_rules
  SET status = @status,
      next_run_at = @nextRunAt,
      last_run_at = datetime('now'),
      updated_at = datetime('now')
  WHERE id = @id
`);
const cancelRuleStmt = db.prepare(`
  UPDATE simulation_cash_funding_rules
  SET status = 'cancelled', next_run_at = NULL, updated_at = datetime('now')
  WHERE user_id = ? AND id = ?
`);

const insertEventStmt = db.prepare(`
  INSERT INTO simulation_cash_funding_events (
    user_id, funding_rule_id, broker_account_id, amount_usd, balance_after_usd, memo
  )
  VALUES (
    @userId, @fundingRuleId, @brokerAccountId, @amountUsd, @balanceAfterUsd, @memo
  )
`);
const listEventsStmt = db.prepare(`
  SELECT * FROM simulation_cash_funding_events
  WHERE user_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);
const sumEventsStmt = db.prepare(`
  SELECT COALESCE(SUM(amount_usd), 0) AS total
  FROM simulation_cash_funding_events
  WHERE user_id = ?
`);

function createRule(rule) {
  const { lastInsertRowid } = insertRuleStmt.run(normalizeRule(rule));
  return getRuleStmt.get(rule.userId, lastInsertRowid);
}

function recordEvent(event) {
  const { lastInsertRowid } = insertEventStmt.run({
    userId: event.userId,
    fundingRuleId: event.fundingRuleId || null,
    brokerAccountId: event.brokerAccountId,
    amountUsd: roundMoney(event.amountUsd),
    balanceAfterUsd: roundMoney(event.balanceAfterUsd),
    memo: event.memo || null,
  });
  return db.prepare('SELECT * FROM simulation_cash_funding_events WHERE id = ?').get(lastInsertRowid);
}

function markRuleRun(ruleId, { status, nextRunAt }) {
  updateRuleRunStmt.run({ id: ruleId, status, nextRunAt });
}

function normalizeRule(rule) {
  return {
    userId: rule.userId,
    amountUsd: roundMoney(rule.amountUsd),
    cadence: ['once', 'daily', 'weekly', 'monthly'].includes(rule.cadence) ? rule.cadence : 'once',
    weekday: rule.weekday === undefined || rule.weekday === null ? null : Number(rule.weekday),
    monthDay: rule.monthDay === undefined || rule.monthDay === null ? null : Number(rule.monthDay),
    timeOfDay: rule.timeOfDay || '09:00',
    status: rule.status || 'active',
    nextRunAt: rule.nextRunAt || null,
    memo: rule.memo || null,
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  createRule,
  getRule: (userId, id) => getRuleStmt.get(userId, id),
  listRules: (userId, limit = 20) => listRulesStmt.all(userId, Number(limit) || 20),
  listDueRules: (userId, nowUtc) => listDueRulesStmt.all(userId, nowUtc),
  markRuleRun,
  cancelRule: (userId, id) => cancelRuleStmt.run(userId, id),
  recordEvent,
  listEvents: (userId, limit = 10) => listEventsStmt.all(userId, Number(limit) || 10),
  sumEvents: (userId) => sumEventsStmt.get(userId).total,
};
