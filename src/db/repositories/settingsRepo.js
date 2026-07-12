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

// Auto-tripped switches, each independent of the manual kill_switch_engaged
// flag and of each other — any one of them blocks new orders on its own.
const AUTO_KILL_SWITCHES = [
  'model_drift_kill_switch',
  'broker_connection_kill_switch',
  'market_data_kill_switch',
  'reconciliation_failure_kill_switch',
  'automatic_strategy_kill_switch',
];

function get(userId) {
  return getByUser.get(userId);
}

function assertKnownSwitch(switchName) {
  if (!AUTO_KILL_SWITCHES.includes(switchName)) {
    throw new Error(`Unknown auto kill switch: ${switchName}`);
  }
}

/**
 * Trips one of the auto kill switches independently of the manual one and of
 * every other auto switch. Clearing always requires an explicit operator
 * call to clearAutoKillSwitch — nothing here auto-clears.
 */
function engageAutoKillSwitch(userId, switchName, reason) {
  assertKnownSwitch(switchName);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE user_settings SET ${switchName}_engaged = 1, ${switchName}_reason = ?, ${switchName}_at = datetime('now') WHERE user_id = ?`
    ).run(reason || null, userId);
    insertKillSwitchEvent.run(userId, 1, switchName, reason || null);
  });
  tx();
  return get(userId);
}

function clearAutoKillSwitch(userId, switchName, triggeredBy = 'operator') {
  assertKnownSwitch(switchName);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE user_settings SET ${switchName}_engaged = 0, ${switchName}_reason = NULL, ${switchName}_at = NULL WHERE user_id = ?`
    ).run(userId);
    insertKillSwitchEvent.run(userId, 0, triggeredBy, `Cleared ${switchName}`);
  });
  tx();
  return get(userId);
}

function isAnyKillSwitchEngaged(settings) {
  if (!settings) return true;
  return Boolean(settings.kill_switch_engaged) || AUTO_KILL_SWITCHES.some((name) => settings[`${name}_engaged`]);
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

module.exports = {
  get,
  update,
  setKillSwitch,
  AUTO_KILL_SWITCHES,
  engageAutoKillSwitch,
  clearAutoKillSwitch,
  isAnyKillSwitchEngaged,
};
