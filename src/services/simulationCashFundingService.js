const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const glLedgerRepo = require('../db/repositories/glLedgerRepo');
const simulationCashFundingRepo = require('../db/repositories/simulationCashFundingRepo');
const timeSettings = require('./timeSettingsService');

function createFundingRule(userId, input = {}) {
  const settings = requireSimulationMode(userId);
  const amountUsd = normalizeAmount(input.amountUsd);
  const cadence = normalizeCadence(input.cadence);
  const timeOfDay = timeSettings.isValidTime(input.timeOfDay) ? input.timeOfDay : '09:00';
  const normalized = {
    userId,
    amountUsd,
    cadence,
    weekday: normalizeWeekday(input.weekday),
    monthDay: normalizeMonthDay(input.monthDay),
    timeOfDay,
    memo: cleanText(input.memo || `${cadence} simulation cash funding`),
  };
  normalized.nextRunAt = nextRunAt(normalized, settings.application_timezone, new Date());
  const rule = simulationCashFundingRepo.createRule(normalized);
  if (cadence === 'once' && input.runNow !== false) {
    const event = applyFundingEvent(userId, { rule, memo: normalized.memo });
    simulationCashFundingRepo.markRuleRun(rule.id, { status: 'completed', nextRunAt: null });
    return { rule: simulationCashFundingRepo.getRule(userId, rule.id), event };
  }
  return { rule, event: null };
}

function addCashNow(userId, { amountUsd, memo } = {}) {
  requireSimulationMode(userId);
  return applyFundingEvent(userId, {
    amountUsd: normalizeAmount(amountUsd),
    memo: cleanText(memo || 'One-time simulation cash add'),
  });
}

function applyDueFunding(userId, now = new Date()) {
  const settings = settingsRepo.get(userId);
  if (!settings?.simulation_mode_enabled) return { applied: [], skipped: true };
  const nowUtc = sqliteUtc(now);
  const rules = simulationCashFundingRepo.listDueRules(userId, nowUtc);
  const applied = [];
  for (const rule of rules) {
    const event = applyFundingEvent(userId, { rule, memo: rule.memo || `${rule.cadence} simulation funding` });
    const next = rule.cadence === 'once' ? null : nextRunAt({
      amountUsd: rule.amount_usd,
      cadence: rule.cadence,
      weekday: rule.weekday,
      monthDay: rule.month_day,
      timeOfDay: rule.time_of_day,
    }, settings.application_timezone, addMinutes(now, 1));
    simulationCashFundingRepo.markRuleRun(rule.id, {
      status: rule.cadence === 'once' ? 'completed' : 'active',
      nextRunAt: next,
    });
    applied.push({ ruleId: rule.id, event });
  }
  return { applied, skipped: false };
}

function getDashboardFunding(userId) {
  return {
    rules: simulationCashFundingRepo.listRules(userId, 5),
    events: simulationCashFundingRepo.listEvents(userId, 5),
    totalAddedUsd: roundMoney(simulationCashFundingRepo.sumEvents(userId)),
  };
}

function cancelRule(userId, id) {
  simulationCashFundingRepo.cancelRule(userId, id);
  return getDashboardFunding(userId);
}

function applyFundingEvent(userId, { rule = null, amountUsd = null, memo = null } = {}) {
  const amount = normalizeAmount(amountUsd ?? rule?.amount_usd ?? rule?.amountUsd);
  const account = brokerAccountRepo.ensureDefault(userId);
  const currentCash = Number(account.cash_balance_usd || 0);
  const nextCash = roundMoney(currentCash + amount);
  brokerAccountRepo.updateBalance(account.id, nextCash, nextCash, 'simulation');
  const event = simulationCashFundingRepo.recordEvent({
    userId,
    fundingRuleId: rule?.id || null,
    brokerAccountId: account.id,
    amountUsd: amount,
    balanceAfterUsd: nextCash,
    memo: memo || 'Simulation cash funding',
  });
  pnlRepo.record({
    userId,
    brokerAccountId: account.id,
    orderId: null,
    realizedPnlUsd: 0,
    balanceAfterUsd: nextCash,
    note: `${memo || 'Simulation cash funding'}: +$${amount.toFixed(2)} simulated cash`,
  });
  glLedgerRepo.recordCashFunding({
    userId,
    brokerAccountId: account.id,
    amountUsd: amount,
    balanceAfterUsd: nextCash,
    sourceType: 'simulation_cash_funding',
    memo: memo || 'Simulation cash funding',
  });
  return event;
}

function nextRunAt(rule, timeZone = timeSettings.DEFAULT_TIMEZONE, from = new Date()) {
  const tz = timeSettings.normalizeTimeZone(timeZone);
  const [hour, minute] = String(rule.timeOfDay || '09:00').split(':').map(Number);
  for (let offset = 0; offset < 370; offset += 1) {
    const probe = addDays(from, offset);
    const parts = localDateParts(probe, tz);
    const candidateParts = {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: Number.isFinite(hour) ? hour : 9,
      minute: Number.isFinite(minute) ? minute : 0,
    };
    if (!matchesCadence(rule, candidateParts, parts.weekdayIndex)) continue;
    const candidate = localPartsToUtc(candidateParts, tz);
    if (candidate > from) return sqliteUtc(candidate);
  }
  return null;
}

function matchesCadence(rule, parts, weekday) {
  if (rule.cadence === 'once') return true;
  if (rule.cadence === 'daily') return true;
  if (rule.cadence === 'weekly') {
    const configured = Number(rule.weekday);
    return weekday === (Number.isInteger(configured) ? configured : 1);
  }
  if (rule.cadence === 'monthly') return parts.day === Math.min(28, Math.max(1, Number(rule.monthDay || rule.month_day || 1)));
  return false;
}

function localPartsToUtc(parts, timeZone) {
  let guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  for (let i = 0; i < 3; i += 1) {
    const actual = localDateParts(guess, timeZone);
    const deltaMinutes =
      (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
        Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)) / 60000;
    if (!deltaMinutes) break;
    guess = new Date(guess.getTime() + deltaMinutes * 60000);
  }
  return guess;
}

function requireSimulationMode(userId) {
  const settings = settingsRepo.get(userId);
  if (!settings?.simulation_mode_enabled) {
    throw new Error('Simulation cash funding is available only while simulation mode is enabled.');
  }
  return settings;
}

function normalizeAmount(value) {
  const amount = roundMoney(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new Error('Simulation cash amount must be between $0.01 and $100,000,000.');
  return amount;
}

function normalizeCadence(value) {
  const cadence = String(value || 'once').toLowerCase();
  return ['once', 'daily', 'weekly', 'monthly'].includes(cadence) ? cadence : 'once';
}

function normalizeWeekday(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

function normalizeMonthDay(value) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(28, Math.max(1, n)) : 1;
}

function cleanText(value) {
  return String(value || '').trim().slice(0, 500);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function sqliteUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    weekday: part('weekday'),
    weekdayIndex: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

module.exports = {
  createFundingRule,
  addCashNow,
  applyDueFunding,
  getDashboardFunding,
  cancelRule,
  nextRunAt,
};
