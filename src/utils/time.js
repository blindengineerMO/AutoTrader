/**
 * SQLite's datetime('now') stores UTC timestamps as "YYYY-MM-DD HH:MM:SS"
 * (space-separated, no ms, no 'Z'). JS's toISOString() uses "T" and "Z",
 * which sorts differently as a string ('T' > ' ' lexicographically) and
 * silently breaks >= comparisons against that column. Always compare using
 * this format instead of toISOString() when querying datetime('now') columns.
 */
function startOfTodayUtc() {
  const now = new Date();
  return `${now.toISOString().slice(0, 10)} 00:00:00`;
}

/** Formats a Date as SQLite's datetime('now') string ("YYYY-MM-DD HH:MM:SS", UTC) for safe >= / <= comparisons against those columns. */
function toSqliteUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { startOfTodayUtc, toSqliteUtc };
