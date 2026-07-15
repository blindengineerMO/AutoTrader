const settingsRepo = require('../db/repositories/settingsRepo');
const orderRepo = require('../db/repositories/orderRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const alertingService = require('./alertingService');
const alpacaRules = require('./alpacaRulesService');
const patternDayTradeService = require('./patternDayTradeService');
const logger = require('../utils/logger');
const { startOfTodayUtc } = require('../utils/time');

/**
 * Every check here runs against the DB/settings directly rather than trusting
 * the caller's view of state — this is the last line of defense before an
 * order reaches the broker, so it must not rely on the AI plan being honest.
 */
function checkTradeAllowed({ userId, symbol, side, estimatedUsd, quantity, asset, equityUsd }) {
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

  if (!settings.day_trading_enabled) {
    const recentCount = orderRepo.countRecentForSymbol(userId, symbol);
    if (recentCount >= settings.max_trades_per_symbol_per_24h) {
      return {
        allowed: false,
        reason: `Symbol ${symbol} already has ${recentCount} trades in the last 24h (limit ${settings.max_trades_per_symbol_per_24h})`,
      };
    }
  } else {
    const pdt = patternDayTradeService.checkPatternDayTradeLimit({ userId, symbol, side, settings, equityUsd });
    if (!pdt.allowed) {
      return { allowed: false, reason: pdt.reason };
    }
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

  const notional = Number(estimatedUsd || 0);
  const maxBuyNotional = Number(settings.max_buy_order_notional_usd || 100);
  if (String(side || '').toLowerCase() === 'buy' && notional > maxBuyNotional) {
    return {
      allowed: false,
      reason: `Buy order estimated $${notional.toFixed(2)} exceeds max buy per order $${maxBuyNotional.toFixed(2)}`,
    };
  }

  const qty = Number(quantity || 0);
  if (qty > 0) {
    const price = qty > 0 ? notional / qty : 0;
    const evaluation = alpacaRules.evaluateOrder({ userId, symbol, side, quantity: qty, price, asset });
    if (!evaluation.allowed) {
      return {
        allowed: false,
        reason: `Alpaca order rules blocked trade: ${evaluation.failed.join(', ')}`,
      };
    }
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
