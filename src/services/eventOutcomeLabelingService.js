const eventTrainingLabelRepo = require('../db/repositories/eventTrainingLabelRepo');
const webScrapeClient = require('./marketData/webScrapeClient');
const finnhubClient = require('./marketData/finnhubClient');
const { ETF_PROXIES } = require('./companyDiscoveryService');
const { config } = require('../config');
const logger = require('../utils/logger');
const { tradingDaysSince, computeReturnPct } = require('../utils/tradingCalendar');

const MAX_EVENTS_PER_CANDIDATE = 8;
const MIN_ABS_EVENT_SCORE = 0.5;
const RETURN_BACKFILL_BATCH = 40;
const FUNDAMENTAL_BACKFILL_BATCH = 20;
const T21_MIN_AGE_CALENDAR_DAYS = 30;
const MIN_SAMPLES_FOR_LEARNING = 5;
const ACCURACY_UP_THRESHOLD = 0.6;
const ACCURACY_DOWN_THRESHOLD = 0.4;
const WEIGHT_STEP = 0.1;
const MULTIPLIER_MIN = 0.5;
const MULTIPLIER_MAX = 1.5;

function resolveSectorProxy(theme) {
  const needle = String(theme || '').toLowerCase();
  if (!needle) return 'SPY';
  if (needle.includes('defense')) return 'ITA';
  if (needle.includes('semiconductor') || needle.includes('chip')) return 'SOXX';
  for (const proxy of ETF_PROXIES) {
    if (proxy.tags.some((tag) => tag !== 'sector-proxy' && needle.includes(tag.split('-')[0]))) return proxy.symbol;
  }
  return 'SPY';
}

function recordCandidateEvents({ userId, candidate, events = [] }) {
  const labels = (events || [])
    .filter((event) => Math.abs(event.final_event_score || 0) >= MIN_ABS_EVENT_SCORE)
    .slice(0, MAX_EVENTS_PER_CANDIDATE)
    .map((event) => ({
      symbol: candidate.symbol,
      eventCategory: event.event?.category || 'general',
      eventType: event.event?.type || 'unknown',
      eventDirection: event.event?.direction || (event.final_event_score >= 0 ? 'positive' : 'negative'),
      baseWeight: event.event?.base_weight ?? 0,
      certainty: event.statement?.certainty ?? null,
      sourceType: event.source?.type ?? null,
      sourceReliability: event.source?.reliability ?? null,
      sourceDomain: event.source?.domain ?? null,
      statementText: event.statement?.text ?? null,
      affectedMetric: event.financial_effect?.affected_metric ?? null,
      marketExpectation: null,
      surpriseDirection: event.financial_effect?.surprise_relative_to_consensus ?? null,
      finalEventScore: event.final_event_score ?? 0,
      evidenceUrl: event.evidence_urls?.[0] ?? null,
      documentId: event.document_id || '',
      sectorSymbol: resolveSectorProxy(candidate.theme),
      eventDate: normalizeDate(event.published_at) || new Date().toISOString(),
    }));
  if (!labels.length) return 0;
  return eventTrainingLabelRepo.saveLabels(userId, labels);
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function computeReturn(from, to) {
  const pct = computeReturnPct(from, to);
  return pct == null ? null : Number(pct.toFixed(3));
}

async function backfillOutcomes({ userId }) {
  const pending = eventTrainingLabelRepo.listAwaitingReturns(userId, { minAgeDays: 1, limit: RETURN_BACKFILL_BATCH });
  if (!pending.length) return { updated: 0 };

  const symbols = [...new Set(pending.flatMap((label) => [label.symbol, label.sector_symbol]))];
  const closesBySymbol = new Map();
  await Promise.allSettled(symbols.map(async (symbol) => {
    try {
      closesBySymbol.set(symbol, await webScrapeClient.getDailyCloses(symbol, '6mo'));
    } catch (err) {
      logger.warn('Outcome backfill could not fetch closes', { symbol, error: err.message });
    }
  }));

  let updated = 0;
  for (const label of pending) {
    const closes = closesBySymbol.get(label.symbol);
    if (!Array.isArray(closes) || closes.length < 3) continue;

    const daysSince = tradingDaysSince(label.event_date);
    // Index the event day as daysSince trading days back from the latest close.
    const eventIndex = closes.length - 1 - daysSince;
    if (eventIndex < 0 || eventIndex >= closes.length) continue;
    const baseline = closes[eventIndex];
    const fields = { baseline_close: baseline };

    if (label.stock_return_1_day == null && eventIndex + 1 < closes.length) {
      fields.stock_return_1_day = computeReturn(baseline, closes[eventIndex + 1]);
    }

    const calendarAgeDays = Math.floor((Date.now() - new Date(label.event_date).getTime()) / 86400000);
    if (label.stock_return_21_days == null && calendarAgeDays >= T21_MIN_AGE_CALENDAR_DAYS && eventIndex + 21 < closes.length) {
      const stockReturn21 = computeReturn(baseline, closes[eventIndex + 21]);
      fields.stock_return_21_days = stockReturn21;

      const sectorCloses = closesBySymbol.get(label.sector_symbol);
      if (Array.isArray(sectorCloses) && sectorCloses.length > daysSince + 1) {
        const sectorEventIndex = sectorCloses.length - 1 - daysSince;
        if (sectorEventIndex >= 0 && sectorEventIndex + 21 < sectorCloses.length) {
          const sectorReturn21 = computeReturn(sectorCloses[sectorEventIndex], sectorCloses[sectorEventIndex + 21]);
          fields.sector_return_21_days = sectorReturn21;
          if (stockReturn21 != null && sectorReturn21 != null) {
            const adjusted = Number((stockReturn21 - sectorReturn21).toFixed(3));
            fields.sector_adjusted_return_21_days = adjusted;
            fields.original_model_prediction_correct = (label.event_direction === 'positive') === (adjusted > 0) ? 1 : 0;
          }
        }
      }
    }

    if (Object.keys(fields).length > 1 || label.baseline_close == null) {
      eventTrainingLabelRepo.updateOutcomes(label.id, fields);
      updated += 1;
    }
  }

  await backfillFundamentals({ userId });
  return { updated };
}

async function backfillFundamentals({ userId }) {
  if (!config.finnhubApiKey) return { updated: 0 };
  const pending = eventTrainingLabelRepo.listAwaitingFundamentals(userId, { limit: FUNDAMENTAL_BACKFILL_BATCH });
  let updated = 0;
  for (const label of pending) {
    try {
      const earnings = await finnhubClient.getEarnings(label.symbol);
      const result = fundamentalResultFromEarnings(earnings, label.event_date);
      if (result) {
        eventTrainingLabelRepo.updateOutcomes(label.id, { fundamental_result_2_quarters_later: result });
        updated += 1;
      }
    } catch (err) {
      logger.warn('Fundamental backfill failed for label', { symbol: label.symbol, error: err.message });
    }
  }
  return { updated };
}

function fundamentalResultFromEarnings(earnings, eventDate) {
  if (!Array.isArray(earnings)) return null;
  const eventTime = new Date(eventDate).getTime();
  const sorted = earnings
    .filter((row) => row?.period && Number.isFinite(row?.actual))
    .sort((a, b) => new Date(a.period) - new Date(b.period));
  const before = sorted.filter((row) => new Date(row.period).getTime() <= eventTime);
  const after = sorted.filter((row) => new Date(row.period).getTime() > eventTime);
  if (!before.length || after.length < 2) return null;
  const baselineEps = before[before.length - 1].actual;
  const secondQuarterEps = after[1].actual;
  const delta = secondQuarterEps - baselineEps;
  if (Math.abs(delta) < Math.max(0.01, Math.abs(baselineEps) * 0.02)) return 'eps_flat';
  return delta > 0 ? 'eps_grew' : 'eps_declined';
}

function updateCategoryLearning({ userId }) {
  const accuracy = eventTrainingLabelRepo.accuracyByCategory(userId);
  const current = eventTrainingLabelRepo.getCategoryMultipliers(userId);
  const rows = [];
  for (const entry of accuracy) {
    if (entry.samples < MIN_SAMPLES_FOR_LEARNING) continue;
    let multiplier = current[entry.category] ?? 1.0;
    if (entry.accuracy >= ACCURACY_UP_THRESHOLD) multiplier *= 1 + WEIGHT_STEP;
    else if (entry.accuracy <= ACCURACY_DOWN_THRESHOLD) multiplier *= 1 - WEIGHT_STEP;
    multiplier = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, Number(multiplier.toFixed(4))));
    rows.push({ category: entry.category, multiplier, samples: entry.samples, accuracy: Number(entry.accuracy.toFixed(4)) });
  }
  if (rows.length) eventTrainingLabelRepo.upsertCategoryLearning(userId, rows);
  return rows;
}

module.exports = {
  recordCandidateEvents,
  backfillOutcomes,
  backfillFundamentals,
  updateCategoryLearning,
  resolveSectorProxy,
  fundamentalResultFromEarnings,
};
