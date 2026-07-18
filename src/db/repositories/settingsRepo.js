const db = require('../connection');

const getByUser = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');
const updateStmt = db.prepare(`
  UPDATE user_settings
  SET kill_switch_engaged = @killSwitchEngaged,
      daily_loss_limit_usd = @dailyLossLimitUsd,
      max_trades_per_symbol_per_24h = @maxTradesPerSymbolPer24h,
      day_trading_enabled = @dayTradingEnabled,
      research_cadence_cron = @researchCadenceCron,
      evaluation_cadence_cron = @evaluationCadenceCron,
      source_learning_enabled = @sourceLearningEnabled,
      trading_enabled = @tradingEnabled,
      watcher_cycle_cadence_cron = @watcherCycleCadenceCron,
      watcher_grading_cadence_cron = @watcherGradingCadenceCron,
      application_timezone = @applicationTimezone,
      trading_start_time = @tradingStartTime,
      trading_end_time = @tradingEndTime,
      simulation_mode_enabled = @simulationModeEnabled,
      simulation_starting_cash_usd = @simulationStartingCashUsd,
      agent_personality_refresh_enabled = @agentPersonalityRefreshEnabled,
      agent_personality_refresh_time = @agentPersonalityRefreshTime,
      personality_tick_cadence_cron = @personalityTickCadenceCron,
      agent_local_learning_enabled = @agentLocalLearningEnabled,
      dashboard_layout_json = @dashboardLayoutJson,
      excluded_symbols_json = @excludedSymbolsJson,
      fractional_trading_enabled = @fractionalTradingEnabled,
      fractional_min_notional_usd = @fractionalMinNotionalUsd,
      max_buy_order_notional_usd = @maxBuyOrderNotionalUsd,
      alpaca_statement_download_day = @alpacaStatementDownloadDay,
      investing_mode = @investingMode,
      council_sizing_enabled = @councilSizingEnabled,
      updated_at = datetime('now')
  WHERE user_id = @userId
`);
const insertKillSwitchEvent = db.prepare(`
  INSERT INTO kill_switch_events (user_id, engaged, triggered_by, reason) VALUES (?, ?, ?, ?)
`);
const markSimulationStartedStmt = db.prepare(`
  UPDATE user_settings
  SET simulation_mode_enabled = 1,
      simulation_started_at = datetime('now'),
      simulation_stopped_at = NULL,
      simulation_last_cycle_at = NULL,
      simulation_last_evaluation_at = NULL,
      updated_at = datetime('now')
  WHERE user_id = ?
`);
const markSimulationStoppedStmt = db.prepare(`
  UPDATE user_settings
  SET simulation_mode_enabled = 0,
      simulation_stopped_at = datetime('now'),
      updated_at = datetime('now')
  WHERE user_id = ?
`);
const markSimulationCycleStmt = db.prepare(`
  UPDATE user_settings SET simulation_last_cycle_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?
`);
const markSimulationEvaluationStmt = db.prepare(`
  UPDATE user_settings SET simulation_last_evaluation_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?
`);
const markAgentRefreshStmt = db.prepare(`
  UPDATE user_settings SET agent_personality_last_refreshed_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?
`);
const markWatcherTrainingBackfillStmt = db.prepare(`
  UPDATE user_settings SET watcher_training_backfill_30d_completed_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?
`);

// Auto-tripped switches, each independent of the manual kill_switch_engaged
// flag and of each other — any one of them blocks new orders on its own.
const AUTO_KILL_SWITCHES = [
  'model_drift_kill_switch',
  'broker_connection_kill_switch',
  'market_data_kill_switch',
  'reconciliation_failure_kill_switch',
  'automatic_strategy_kill_switch',
  'daily_loss_limit_kill_switch',
];

function get(userId) {
  const row = getByUser.get(userId);
  return row ? hydrate(row) : row;
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
    dayTradingEnabled: patch.dayTradingEnabled ?? current.day_trading_enabled ?? 0,
    researchCadenceCron: patch.researchCadenceCron ?? current.research_cadence_cron,
    evaluationCadenceCron: patch.evaluationCadenceCron ?? current.evaluation_cadence_cron,
    sourceLearningEnabled: patch.sourceLearningEnabled ?? current.source_learning_enabled,
    tradingEnabled: patch.tradingEnabled ?? current.trading_enabled,
    watcherCycleCadenceCron: patch.watcherCycleCadenceCron ?? current.watcher_cycle_cadence_cron,
    watcherGradingCadenceCron: patch.watcherGradingCadenceCron ?? current.watcher_grading_cadence_cron,
    applicationTimezone: patch.applicationTimezone ?? current.application_timezone,
    tradingStartTime: patch.tradingStartTime ?? current.trading_start_time,
    tradingEndTime: patch.tradingEndTime ?? current.trading_end_time,
    simulationModeEnabled: patch.simulationModeEnabled ?? current.simulation_mode_enabled,
    simulationStartingCashUsd: patch.simulationStartingCashUsd ?? current.simulation_starting_cash_usd,
    agentPersonalityRefreshEnabled: patch.agentPersonalityRefreshEnabled ?? current.agent_personality_refresh_enabled,
    agentPersonalityRefreshTime: patch.agentPersonalityRefreshTime ?? current.agent_personality_refresh_time,
    personalityTickCadenceCron: patch.personalityTickCadenceCron ?? current.personality_tick_cadence_cron,
    agentLocalLearningEnabled: patch.agentLocalLearningEnabled ?? current.agent_local_learning_enabled,
    dashboardLayoutJson: patch.dashboardLayoutJson ?? current.dashboard_layout_json,
    excludedSymbolsJson: patch.excludedSymbolsJson ?? current.excluded_symbols_json ?? '[]',
    fractionalTradingEnabled: patch.fractionalTradingEnabled ?? current.fractional_trading_enabled ?? 1,
    fractionalMinNotionalUsd: patch.fractionalMinNotionalUsd ?? current.fractional_min_notional_usd ?? 1,
    maxBuyOrderNotionalUsd: patch.maxBuyOrderNotionalUsd ?? current.max_buy_order_notional_usd ?? 100,
    alpacaStatementDownloadDay: patch.alpacaStatementDownloadDay ?? current.alpaca_statement_download_day ?? 5,
    investingMode: patch.investingMode ?? current.investing_mode ?? 'balanced',
    councilSizingEnabled: patch.councilSizingEnabled ?? current.council_sizing_enabled ?? 0,
  };
  updateStmt.run(merged);
  return get(userId);
}

function getExcludedSymbols(userId) {
  if (!userId) return [];
  return parseExcludedSymbols(get(userId)?.excluded_symbols_json);
}

function isSymbolExcluded(userId, symbol) {
  if (!userId) return false;
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  return getExcludedSymbols(userId).some((entry) => entry.symbol === normalized);
}

function setExcludedSymbols(userId, entries) {
  if (!userId) throw new Error('userId is required to set excluded symbols');
  const normalized = normalizeExcludedSymbols(entries);
  return update(userId, { excludedSymbolsJson: JSON.stringify(normalized) });
}

function addExcludedSymbol(userId, entry) {
  if (!userId) return null;
  const normalized = normalizeExcludedSymbol(entry);
  if (!normalized) return get(userId);
  const existing = getExcludedSymbols(userId);
  const merged = [
    normalized,
    ...existing.filter((item) => item.symbol !== normalized.symbol),
  ].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return update(userId, { excludedSymbolsJson: JSON.stringify(merged) });
}

function removeExcludedSymbol(userId, symbol) {
  if (!userId) return null;
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return get(userId);
  const filtered = getExcludedSymbols(userId).filter((entry) => entry.symbol !== normalized);
  return update(userId, { excludedSymbolsJson: JSON.stringify(filtered) });
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
  getExcludedSymbols,
  isSymbolExcluded,
  setExcludedSymbols,
  addExcludedSymbol,
  removeExcludedSymbol,
  markSimulationStarted: (userId) => {
    markSimulationStartedStmt.run(userId);
    return get(userId);
  },
  markSimulationStopped: (userId) => {
    markSimulationStoppedStmt.run(userId);
    return get(userId);
  },
  markSimulationCycle: (userId) => {
    markSimulationCycleStmt.run(userId);
    return get(userId);
  },
  markSimulationEvaluation: (userId) => {
    markSimulationEvaluationStmt.run(userId);
    return get(userId);
  },
  markAgentPersonalityRefreshed: (userId) => {
    markAgentRefreshStmt.run(userId);
    return get(userId);
  },
  markWatcherTrainingBackfill30d: (userId) => {
    markWatcherTrainingBackfillStmt.run(userId);
    return get(userId);
  },
};

function hydrate(row) {
  return {
    ...row,
    excluded_symbols_json: row.excluded_symbols_json || '[]',
    excluded_symbols: parseExcludedSymbols(row.excluded_symbols_json),
  };
}

function parseExcludedSymbols(value) {
  try {
    return normalizeExcludedSymbols(JSON.parse(value || '[]'));
  } catch {
    return [];
  }
}

function normalizeExcludedSymbols(entries) {
  if (!Array.isArray(entries)) return [];
  const bySymbol = new Map();
  for (const entry of entries) {
    const normalized = normalizeExcludedSymbol(entry);
    if (normalized) bySymbol.set(normalized.symbol, normalized);
  }
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function normalizeExcludedSymbol(entry) {
  const symbol = normalizeSymbol(typeof entry === 'string' ? entry : entry?.symbol);
  if (!symbol) return null;
  const now = new Date().toISOString();
  return {
    symbol,
    companyName: cleanText(entry?.companyName || entry?.company_name || ''),
    reason: cleanText(entry?.reason || 'Not tradable via Alpaca asset lookup.'),
    source: cleanText(entry?.source || 'alpaca-asset-eligibility'),
    addedAt: cleanText(entry?.addedAt || entry?.added_at || now),
    assetStatus: cleanText(entry?.assetStatus || entry?.status || ''),
    exchange: cleanText(entry?.exchange || ''),
  };
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 16);
}

function cleanText(value) {
  return String(value || '').trim().slice(0, 500);
}
