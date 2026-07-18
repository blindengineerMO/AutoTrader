const agentRecommendationOutcomeRepo = require('../db/repositories/agentRecommendationOutcomeRepo');
const agentCalibrationRepo = require('../db/repositories/agentCalibrationRepo');
const { HORIZONS } = require('./agentOutcomeLabelingService');

const MIN_SAMPLES_FOR_CALIBRATION = 5;
const BUCKET_WIDTH = 10;

function bucketFor(conviction) {
  const low = Math.min(90, Math.floor(conviction / BUCKET_WIDTH) * BUCKET_WIDTH);
  return { low, high: low + BUCKET_WIDTH };
}

function runCalibration({ userId }) {
  const summaries = [];
  for (const horizon of HORIZONS) {
    const rows = agentRecommendationOutcomeRepo.listLabeledByHorizon(userId, horizon.key);
    const byAgent = new Map();
    for (const row of rows) {
      const list = byAgent.get(row.agent_id) || [];
      list.push(row);
      byAgent.set(row.agent_id, list);
    }
    for (const [agentId, agentRows] of byAgent) {
      if (agentRows.length < MIN_SAMPLES_FOR_CALIBRATION) continue;

      const hits = agentRows.reduce((sum, r) => sum + (r.correct ? 1 : 0), 0);
      const hitRate = hits / agentRows.length;
      const meanConviction = agentRows.reduce((sum, r) => sum + Number(r.conviction || 0), 0) / agentRows.length;
      const brierScore = agentRows.reduce((sum, r) => {
        const predicted = Number(r.conviction || 0) / 100;
        const outcome = r.correct ? 1 : 0;
        return sum + (predicted - outcome) ** 2;
      }, 0) / agentRows.length;

      agentCalibrationRepo.upsertSummary(userId, agentId, horizon.key, {
        samples: agentRows.length,
        hits,
        hitRate: Number(hitRate.toFixed(4)),
        meanConviction: Number(meanConviction.toFixed(2)),
        brierScore: Number(brierScore.toFixed(4)),
      });
      summaries.push({ agentId, horizon: horizon.key, samples: agentRows.length, hitRate, brierScore });

      const byBucket = new Map();
      for (const row of agentRows) {
        const { low, high } = bucketFor(Number(row.conviction || 0));
        const key = low;
        const bucket = byBucket.get(key) || { low, high, samples: 0, hits: 0 };
        bucket.samples += 1;
        bucket.hits += row.correct ? 1 : 0;
        byBucket.set(key, bucket);
      }
      for (const bucket of byBucket.values()) {
        agentCalibrationRepo.upsertBucket(userId, agentId, horizon.key, bucket.low, bucket.high, {
          samples: bucket.samples,
          hits: bucket.hits,
          hitRate: Number((bucket.hits / bucket.samples).toFixed(4)),
        });
      }
    }
  }
  return summaries;
}

module.exports = { runCalibration, MIN_SAMPLES_FOR_CALIBRATION };
