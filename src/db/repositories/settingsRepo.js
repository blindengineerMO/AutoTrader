const db = require('../connection');

const getByUser = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');
const updateStmt = db.prepare(`
  UPDATE user_settings
  SET kill_switch_engaged = @killSwitchEngaged,
      daily_loss_limit_usd = @dailyLossLimitUsd,
      max_trades_per_symbol_per_24h = @maxTradesPerSymbolPer24h,
      research_cadence_cron = @researchCadenceCron,
      evaluation_cadence_cron = @evaluationCadenceCron,
      source_learning_enabled = @sourceLearningEnabled,
      trading_enabled = @tradingEnabled,
      updated_at = datetime('now')
  WHERE user_id = @userId
`);
const insertKillSwitchEvent = db.prepare(`
  INSERT INTO kill_switch_events (user_id, engaged, triggered_by, reason) VALUES (?, ?, ?, ?)
`);

function get(userId) {
  return getByUser.get(userId);
}

function update(userId, patch) {
  const current = get(userId);
  if (!current) throw new Error(`No settings row for user ${userId}`);
  const merged = {
    userId,
    killSwitchEngaged: patch.killSwitchEngaged ?? current.kill_switch_engaged,
    dailyLossLimitUsd: patch.dailyLossLimitUsd ?? current.daily_loss_limit_usd,
    maxTradesPerSymbolPer24h: patch.maxTradesPerSymbolPer24h ?? current.max_trades_per_symbol_per_24h,
    researchCadenceCron: patch.researchCadenceCron ?? current.research_cadence_cron,
    evaluationCadenceCron: patch.evaluationCadenceCron ?? current.evaluation_cadence_cron,
    sourceLearningEnabled: patch.sourceLearningEnabled ?? current.source_learning_enabled,
    tradingEnabled: patch.tradingEnabled ?? current.trading_enabled,
  };
  updateStmt.run(merged);
  return get(userId);
}

function setKillSwitch(userId, engaged, triggeredBy, reason) {
  const tx = db.transaction(() => {
    update(userId, { killSwitchEngaged: engaged ? 1 : 0 });
    insertKillSwitchEvent.run(userId, engaged ? 1 : 0, triggeredBy, reason || null);
  });
  tx();
  return get(userId);
}

module.exports = { get, update, setKillSwitch };
