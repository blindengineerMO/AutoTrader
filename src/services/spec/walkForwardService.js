/**
 * Generates non-overlapping rolling walk-forward train/test splits with
 * purge and embargo gaps (Lopez de Prado-style) so that no trading date ever
 * appears in both a train window and a test window across the whole split
 * sequence — the purge gap removes training rows whose label window would
 * bleed into the test period, the embargo gap keeps serially-correlated
 * post-test data out of the *next* split's training window.
 */
function generateWalkForwardSplits(dates, { trainWindowDays, testWindowDays, purgeDays = 0, embargoDays = 0 } = {}) {
  if (!Array.isArray(dates) || !trainWindowDays || !testWindowDays) return [];
  const sorted = [...new Set(dates)].sort();
  const stepSize = trainWindowDays + purgeDays + testWindowDays + embargoDays;
  const splits = [];

  let trainStartIdx = 0;
  while (true) {
    const trainEndIdx = trainStartIdx + trainWindowDays - 1;
    const purgeStartIdx = trainEndIdx + 1;
    const purgeEndIdx = trainEndIdx + purgeDays;
    const testStartIdx = purgeEndIdx + 1;
    const testEndIdx = testStartIdx + testWindowDays - 1;
    const embargoStartIdx = testEndIdx + 1;
    const embargoEndIdx = testEndIdx + embargoDays;
    if (testEndIdx >= sorted.length) break;

    splits.push({
      splitIndex: splits.length,
      train: { start: sorted[trainStartIdx], end: sorted[trainEndIdx] },
      purge: purgeDays > 0 ? { start: sorted[purgeStartIdx], end: sorted[purgeEndIdx] } : null,
      test: { start: sorted[testStartIdx], end: sorted[testEndIdx] },
      embargo: embargoDays > 0 && embargoStartIdx < sorted.length
        ? { start: sorted[embargoStartIdx], end: sorted[Math.min(embargoEndIdx, sorted.length - 1)] }
        : null,
    });

    trainStartIdx += stepSize;
  }

  return splits;
}

module.exports = { generateWalkForwardSplits };
