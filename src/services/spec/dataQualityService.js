const specRepo = require('../../db/repositories/specResearchRepo');
const settingsRepo = require('../../db/repositories/settingsRepo');
const alertingService = require('../alertingService');

const MAX_DATA_AGE_MS = 72 * 60 * 60 * 1000;

function validateMarketBars({ userId, datasetVersion, bars, now = new Date(), persist = true }) {
  const items = Array.isArray(bars) ? bars : [];
  const warnings = [];
  const seen = new Set();
  let duplicateRows = 0;
  let missingClose = 0;
  let stalePrices = 0;
  let impossibleValues = 0;
  let timestampAnomalies = 0;

  for (const bar of items) {
    const key = `${bar.symbol}:${bar.barDate}:${bar.dataSource}:${bar.revisionVersion || 1}`;
    if (seen.has(key)) duplicateRows += 1;
    seen.add(key);

    if (!Number.isFinite(Number(bar.closeUnadjusted))) missingClose += 1;
    const high = Number(bar.highUnadjusted);
    const low = Number(bar.lowUnadjusted);
    const close = Number(bar.closeUnadjusted);
    const volume = Number(bar.volume || 0);
    if (close <= 0 || (Number.isFinite(high) && Number.isFinite(low) && high < low) || volume < 0) impossibleValues += 1;

    const availableAt = Date.parse(bar.availableAt);
    const asOf = Date.parse(bar.asOf);
    if (!Number.isFinite(availableAt) || !Number.isFinite(asOf) || availableAt < asOf) timestampAnomalies += 1;
    if (Number.isFinite(availableAt) && now.getTime() - availableAt > MAX_DATA_AGE_MS) stalePrices += 1;
  }

  const missingness = items.length ? missingClose / items.length : 1;
  const duplicateRatio = items.length ? duplicateRows / items.length : 0;
  const staleRatio = items.length ? stalePrices / items.length : 0;
  const impossibleRatio = items.length ? impossibleValues / items.length : 0;
  const timestampRatio = items.length ? timestampAnomalies / items.length : 0;

  if (!items.length) warnings.push('No point-in-time market bars were available.');
  if (missingClose) warnings.push(`${missingClose} rows are missing close prices.`);
  if (duplicateRows) warnings.push(`${duplicateRows} duplicate point-in-time rows were detected.`);
  if (stalePrices) warnings.push(`${stalePrices} rows exceeded the data freshness threshold.`);
  if (impossibleValues) warnings.push(`${impossibleValues} rows had impossible price/volume values.`);
  if (timestampAnomalies) warnings.push(`${timestampAnomalies} rows had invalid as_of/available_at ordering.`);

  const critical = !items.length || missingness > 0.05 || impossibleRatio > 0 || timestampRatio > 0.05;
  const status = critical ? 'fail' : warnings.length ? 'warn' : 'pass';
  const report = {
    userId,
    datasetVersion,
    scope: 'pit_market_bars',
    status,
    critical,
    metrics: {
      rowCount: items.length,
      missingness,
      duplicateRows,
      duplicateRatio,
      stalePrices,
      staleRatio,
      impossibleValues,
      impossibleRatio,
      timestampAnomalies,
      timestampRatio,
      maxDataAgeHours: MAX_DATA_AGE_MS / 36e5,
    },
    warnings,
  };

  if (persist && userId && critical) {
    const reason = `Market data quality check failed for dataset ${datasetVersion || 'unknown'}: ${warnings.join(' ') || 'no bars available'}`;
    settingsRepo.engageAutoKillSwitch(userId, 'market_data_kill_switch', reason);
    alertingService.alertKillSwitch({ userId, switchName: 'market_data_kill_switch', reason });
  }

  return persist ? specRepo.createQualityReport(report) : report;
}

module.exports = { validateMarketBars, MAX_DATA_AGE_MS };
