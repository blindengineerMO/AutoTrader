const DEFAULT_TIMEZONE = 'America/New_York';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(timeZone) {
  const clean = String(timeZone || '').trim();
  return isValidTimeZone(clean) ? clean : DEFAULT_TIMEZONE;
}

function isValidTime(value) {
  return TIME_RE.test(String(value || ''));
}

function normalizeTime(value, fallback) {
  const clean = String(value || '').trim();
  return isValidTime(clean) ? clean : fallback;
}

function cronFromLocalTime(value) {
  const time = normalizeTime(value, '09:30');
  const [, hour, minute] = time.match(TIME_RE);
  return `${Number(minute)} ${Number(hour)} * * 1-5`;
}

function localParts(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return {
    weekday: part('weekday'),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

function isTradingWeekday(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const { weekday } = localParts(date, timeZone);
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function isWithinTradingHours(settings = {}, date = new Date()) {
  const timeZone = normalizeTimeZone(settings.application_timezone);
  if (!isTradingWeekday(date, timeZone)) return false;
  const start = minutesFromTime(normalizeTime(settings.trading_start_time, '09:30'));
  const end = minutesFromTime(normalizeTime(settings.trading_end_time, '16:00'));
  const { hour, minute } = localParts(date, timeZone);
  const current = hour * 60 + minute;
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function minutesFromTime(value) {
  const [, hour, minute] = normalizeTime(value, '00:00').match(TIME_RE);
  return Number(hour) * 60 + Number(minute);
}

module.exports = {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  normalizeTimeZone,
  isValidTime,
  normalizeTime,
  cronFromLocalTime,
  localParts,
  isTradingWeekday,
  isWithinTradingHours,
  minutesFromTime,
};
