const db = require('../connection');

const upsertSummaryStmt = db.prepare(`
  INSERT INTO agent_calibration_summary (user_id, agent_id, horizon, samples, hits, hit_rate, mean_conviction, brier_score)
  VALUES (@userId, @agentId, @horizon, @samples, @hits, @hitRate, @meanConviction, @brierScore)
  ON CONFLICT(user_id, agent_id, horizon) DO UPDATE SET
    samples = excluded.samples,
    hits = excluded.hits,
    hit_rate = excluded.hit_rate,
    mean_conviction = excluded.mean_conviction,
    brier_score = excluded.brier_score,
    updated_at = datetime('now')
`);

const upsertBucketStmt = db.prepare(`
  INSERT INTO agent_calibration_buckets (user_id, agent_id, horizon, bucket_low, bucket_high, samples, hits, hit_rate)
  VALUES (@userId, @agentId, @horizon, @bucketLow, @bucketHigh, @samples, @hits, @hitRate)
  ON CONFLICT(user_id, agent_id, horizon, bucket_low) DO UPDATE SET
    bucket_high = excluded.bucket_high,
    samples = excluded.samples,
    hits = excluded.hits,
    hit_rate = excluded.hit_rate,
    updated_at = datetime('now')
`);

const listSummaryStmt = db.prepare('SELECT * FROM agent_calibration_summary WHERE user_id = ? ORDER BY horizon ASC, agent_id ASC');
const listBucketsStmt = db.prepare('SELECT * FROM agent_calibration_buckets WHERE user_id = ? ORDER BY horizon ASC, agent_id ASC, bucket_low ASC');

function upsertSummary(userId, agentId, horizon, { samples, hits, hitRate, meanConviction, brierScore }) {
  upsertSummaryStmt.run({ userId, agentId, horizon, samples, hits, hitRate, meanConviction, brierScore });
}

function upsertBucket(userId, agentId, horizon, bucketLow, bucketHigh, { samples, hits, hitRate }) {
  upsertBucketStmt.run({ userId, agentId, horizon, bucketLow, bucketHigh, samples, hits, hitRate });
}

function listSummaryByUser(userId) {
  return listSummaryStmt.all(userId);
}

function listBucketsByUser(userId) {
  return listBucketsStmt.all(userId);
}

module.exports = { upsertSummary, upsertBucket, listSummaryByUser, listBucketsByUser };
