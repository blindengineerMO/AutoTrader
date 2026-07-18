const agentRecommendationOutcomeRepo = require('../db/repositories/agentRecommendationOutcomeRepo');
const webScrapeClient = require('./marketData/webScrapeClient');
const logger = require('../utils/logger');
const { tradingDaysSince, computeReturnPct } = require('../utils/tradingCalendar');

const RETURN_BACKFILL_BATCH = 50;
const CLOSES_RANGE = '1y';

// Trading-day horizons a recommendation is labeled at, generalizing the
// 1-day/21-day split used by eventOutcomeLabelingService to also cover a
// mid-range (5d) and quarterly (63d) view of realized outcomes.
const HORIZONS = [
  { key: '1d', tradingDays: 1, minAgeCalendarDays: 2 },
  { key: '5d', tradingDays: 5, minAgeCalendarDays: 8 },
  { key: '21d', tradingDays: 21, minAgeCalendarDays: 30 },
  { key: '63d', tradingDays: 63, minAgeCalendarDays: 90 },
];

function computeReturn(from, to) {
  const pct = computeReturnPct(from, to);
  return pct == null ? null : Number(pct.toFixed(3));
}

function isHit(action, returnPct) {
  if (returnPct == null) return null;
  if (action === 'buy' || action === 'buy_more') return returnPct > 0 ? 1 : 0;
  if (action === 'sell') return returnPct < 0 ? 1 : 0;
  if (action === 'watch' || action === 'hold') return Math.abs(returnPct) < 1.5 ? 1 : 0;
  return null;
}

async function backfillOutcomes({ userId }) {
  const pending = agentRecommendationOutcomeRepo.listAwaitingReturns(userId, {
    minAgeCalendarDays: 1,
    limit: RETURN_BACKFILL_BATCH,
  });
  if (!pending.length) return { updated: 0 };

  const symbols = new Set();
  for (const row of pending) {
    symbols.add(row.symbol);
    symbols.add(row.sector_symbol);
  }
  const closesBySymbol = new Map();
  const results = await Promise.allSettled(
    [...symbols].map(async (symbol) => [symbol, await webScrapeClient.getDailyCloses(symbol, CLOSES_RANGE)])
  );
  for (const result of results) {
    if (result.status === 'fulfilled') closesBySymbol.set(result.value[0], result.value[1]);
    else logger.warn('Recommendation outcome backfill: closes fetch failed', { error: result.reason?.message });
  }

  let updated = 0;
  for (const row of pending) {
    const closes = closesBySymbol.get(row.symbol);
    const sectorCloses = closesBySymbol.get(row.sector_symbol);
    if (!closes || !closes.length) continue;

    const calendarAgeDays = Math.floor((Date.now() - new Date(row.recommended_at).getTime()) / 86400000);
    const daysSince = tradingDaysSince(row.recommended_at);
    const baseIndex = closes.length - 1 - daysSince;
    if (baseIndex < 0) continue;
    const baseline = row.baseline_price || closes[baseIndex];
    const sectorBaseline = sectorCloses ? sectorCloses[sectorCloses.length - 1 - daysSince] : null;

    const fields = {};
    for (const horizon of HORIZONS) {
      const returnField = `return_${horizon.key}`;
      const correctField = `correct_${horizon.key}`;
      if (row[returnField] != null) continue;
      if (calendarAgeDays < horizon.minAgeCalendarDays) continue;
      const targetIndex = baseIndex + horizon.tradingDays;
      if (targetIndex >= closes.length) continue;
      const returnPct = computeReturn(baseline, closes[targetIndex]);
      fields[returnField] = returnPct;
      fields[correctField] = isHit(row.action, returnPct);
      if (sectorCloses && sectorBaseline != null) {
        const sectorTargetIndex = sectorCloses.length - 1 - daysSince + horizon.tradingDays;
        if (sectorTargetIndex < sectorCloses.length) {
          fields[`sector_return_${horizon.key}`] = computeReturn(sectorBaseline, sectorCloses[sectorTargetIndex]);
        }
      }
    }
    if (Object.keys(fields).length) {
      agentRecommendationOutcomeRepo.updateOutcomes(row.id, fields);
      updated += 1;
    }
  }
  return { updated };
}

module.exports = { backfillOutcomes, HORIZONS };
