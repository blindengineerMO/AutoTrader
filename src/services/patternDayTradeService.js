const orderRepo = require('../db/repositories/orderRepo');
const timeSettingsService = require('./timeSettingsService');
const { toSqliteUtc } = require('../utils/time');

// FINRA's pattern-day-trader rule: an account with equity under $25,000 may
// not place more than 3 day trades (same-symbol buy+sell same trading day) in
// a rolling 5-business-day window. Above that equity there's no cap. This is
// the real regulatory constraint the user asked to keep obeying once the app
// stops relying on the flat max_trades_per_symbol_per_24h guardrail.
const PDT_EQUITY_THRESHOLD_USD = 25000;
const MAX_DAY_TRADES_IN_WINDOW = 3;
const WINDOW_TRADING_DAYS = 5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Fills only ever happen inside trading_start_time/trading_end_time (gated by
// isWithinTradingHours), which never spans a UTC midnight for any US trading
// timezone, so grouping by the UTC calendar date of filled_at is equivalent
// to grouping by local trading day and avoids reimplementing local-midnight
// conversion.
function dateKey(isoString) {
  return String(isoString).slice(0, 10);
}

function windowStartIso(settings, now = new Date()) {
  const timeZone = timeSettingsService.normalizeTimeZone(settings.application_timezone);
  let cursor = new Date(now);
  let tradingDaysSeen = 0;
  while (tradingDaysSeen < WINDOW_TRADING_DAYS) {
    if (timeSettingsService.isTradingWeekday(cursor, timeZone)) tradingDaysSeen += 1;
    if (tradingDaysSeen >= WINDOW_TRADING_DAYS) break;
    cursor = new Date(cursor.getTime() - ONE_DAY_MS);
  }
  return `${dateKey(cursor.toISOString())} 00:00:00`;
}

// Groups fills by (symbol, trading day) and sums min(buys, sells) per group —
// each buy can pair with at most one sell as a single day trade.
function countDayTrades(fills) {
  const groups = new Map();
  for (const fill of fills) {
    const key = `${fill.symbol}:${dateKey(fill.filled_at)}`;
    const entry = groups.get(key) || { buys: 0, sells: 0 };
    if (fill.side === 'buy') entry.buys += 1;
    else if (fill.side === 'sell') entry.sells += 1;
    groups.set(key, entry);
  }
  let total = 0;
  for (const { buys, sells } of groups.values()) {
    total += Math.min(buys, sells);
  }
  return total;
}

function countDayTradesInWindow(userId, settings, now = new Date()) {
  const fills = orderRepo.listFilledSince(userId, windowStartIso(settings, now));
  return countDayTrades(fills);
}

// Would filling this order complete a new same-day round trip for the
// symbol, given fills already recorded today?
function wouldCreateDayTrade(userId, symbol, side, settings, now = new Date()) {
  const todayStart = `${dateKey(toSqliteUtc(now))} 00:00:00`;
  const todaysFills = orderRepo.listFilledSince(userId, todayStart).filter((fill) => fill.symbol === symbol);
  const buys = todaysFills.filter((fill) => fill.side === 'buy').length;
  const sells = todaysFills.filter((fill) => fill.side === 'sell').length;
  const pairedToday = Math.min(buys, sells);
  const nextBuys = side === 'buy' ? buys + 1 : buys;
  const nextSells = side === 'sell' ? sells + 1 : sells;
  return Math.min(nextBuys, nextSells) > pairedToday;
}

function checkPatternDayTradeLimit({ userId, symbol, side, settings, equityUsd, now = new Date() }) {
  if (Number(equityUsd) >= PDT_EQUITY_THRESHOLD_USD) {
    return { allowed: true };
  }

  const existing = countDayTradesInWindow(userId, settings, now);
  const prospective = existing + (wouldCreateDayTrade(userId, symbol, side, settings, now) ? 1 : 0);
  if (prospective > MAX_DAY_TRADES_IN_WINDOW) {
    return {
      allowed: false,
      reason: `Pattern day trader rule: account equity is under $${PDT_EQUITY_THRESHOLD_USD.toLocaleString()} and this order would be day trade ${prospective} in the last ${WINDOW_TRADING_DAYS} trading days (limit ${MAX_DAY_TRADES_IN_WINDOW})`,
    };
  }
  return { allowed: true };
}

module.exports = {
  PDT_EQUITY_THRESHOLD_USD,
  MAX_DAY_TRADES_IN_WINDOW,
  WINDOW_TRADING_DAYS,
  windowStartIso,
  countDayTradesInWindow,
  wouldCreateDayTrade,
  checkPatternDayTradeLimit,
};
