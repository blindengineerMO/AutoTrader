const settingsRepo = require('../db/repositories/settingsRepo');
const orderRepo = require('../db/repositories/orderRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const alertingService = require('./alertingService');
const logger = require('../utils/logger');
const { startOfTodayUtc } = require('../utils/time');

/**
 * Every check here runs against the DB/settings directly rather than trusting
 * the caller's view of state — this is the last line of defense before an
 * order reaches the broker, so it must not rely on the AI plan being honest.
 */
function checkTradeAllowed({ userId, symbol, side, estimatedUsd }) {
  const settings = settingsRepo.get(userId);
  if (!settings) {
    return { allowed: false, reason: 'No settings found for user' };
  }

  if (settings.kill_switch_engaged) {
    return { allowed: false, reason: 'Kill switch is engaged' };
  }

  for (const switchName of settingsRepo.AUTO_KILL_SWITCHES) {
    if (settings[`${switchName}_engaged`]) {
      return {
        allowed: false,
        reason: `${switchName} is engaged: ${settings[`${switchName}_reason`] || 'no reason recorded'}`,
      };
    }
  }

  if (!settings.trading_enabled) {
    return { allowed: false, reason: 'Trading is not enabled for this user' };
  }

  const recentCount = orderRepo.countRecentForSymbol(userId, symbol);
  if (recentCount >= settings.max_trades_per_symbol_per_24h) {
    return {
      allowed: false,
      reason: `Symbol ${symbol} already has ${recentCount} trades in the last 24h (limit ${settings.max_trades_per_symbol_per_24h})`,
    };
  }

  const todaysPnl = pnlRepo.sumSince(userId, startOfTodayUtc());
  if (todaysPnl <= -Math.abs(settings.daily_loss_limit_usd)) {
    const reason = `Daily loss limit reached ($${todaysPnl.toFixed(2)} vs limit $${settings.daily_loss_limit_usd})`;
    // Latches like the other six auto kill switches: once tripped, stays
    // engaged (including into the next trading day) until an operator
    // explicitly calls clearAutoKillSwitch, rather than silently clearing
    // itself the moment today's running P&L ticks back above the limit.
    settingsRepo.engageAutoKillSwitch(userId, 'daily_loss_limit_kill_switch', reason);
    alertingService.alertKillSwitch({ userId, switchName: 'daily_loss_limit_kill_switch', reason });
    return { allowed: false, reason };
  }

  if (side === 'deposit' || side === 'transfer_in') {
    return { allowed: false, reason: 'Adding funds to the broker account is never permitted' };
  }

  return { allowed: true };
}

function engageKillSwitch(userId, triggeredBy, reason) {
  logger.warn('Kill switch engaged', { userId, triggeredBy, reason });
  const result = settingsRepo.setKillSwitch(userId, true, triggeredBy, reason);
  alertingService.alertKillSwitch({ userId, switchName: 'kill_switch_engaged', reason: reason || `Triggered by ${triggeredBy}` });
  return result;
}

function releaseKillSwitch(userId, triggeredBy, reason) {
  logger.warn('Kill switch released', { userId, triggeredBy, reason });
  return settingsRepo.setKillSwitch(userId, false, triggeredBy, reason);
}

module.exports = { checkTradeAllowed, engageKillSwitch, releaseKillSwitch };
