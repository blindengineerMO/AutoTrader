// Approximates trading days from calendar days (no holiday calendar) — shared by
// services that backfill realized returns against a daily-closes array indexed
// oldest -> newest.
function tradingDaysSince(dateIso) {
  const calendarDays = Math.floor((Date.now() - new Date(dateIso).getTime()) / 86400000);
  return Math.max(0, Math.round(calendarDays * (5 / 7)));
}

function computeReturnPct(from, to) {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

module.exports = { tradingDaysSince, computeReturnPct };
