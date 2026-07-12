const crypto = require('crypto');
const specRepo = require('../../db/repositories/specResearchRepo');
const modelRegistry = require('./modelRegistryService');

function createTrainingSnapshot({ userId, modelVersion, datasetVersion, featureVersion, artifact = {}, metrics = {}, createdBy = 'system-offline-trainer' }) {
  if (!modelVersion || !datasetVersion || !featureVersion) {
    throw new Error('modelVersion, datasetVersion, and featureVersion are required');
  }
  const artifactHash = crypto.createHash('sha256').update(JSON.stringify(artifact || {})).digest('hex');
  const snapshotId = `train_${crypto.createHash('sha256').update(JSON.stringify({ userId, modelVersion, datasetVersion, featureVersion, artifactHash })).digest('hex').slice(0, 18)}`;
  return specRepo.saveTrainingSnapshot({
    userId,
    snapshotId,
    modelVersion,
    datasetVersion,
    featureVersion,
    artifactHash,
    artifact,
    metrics,
    createdBy,
  });
}

function registerChallenger({ userId, modelVersion, modelType, artifact, metrics = {} }) {
  if (!modelVersion) throw new Error('modelVersion is required');
  const artifactHash = crypto.createHash('sha256').update(JSON.stringify(artifact || { modelVersion, modelType })).digest('hex');
  return specRepo.upsertModel({
    userId,
    modelVersion,
    modelType: modelType || 'challenger',
    artifactHash,
    status: 'candidate',
    promotionReport: { registeredAt: new Date().toISOString(), source: 'offline_challenger_registry' },
    metrics,
  });
}

function evaluateChallenger({ userId, challengerModelVersion, challengerMetrics = {}, backtestRunId = null }) {
  const challenger = specRepo.getModel(userId, challengerModelVersion);
  if (!challenger) throw new Error(`Challenger model ${challengerModelVersion} not found`);
  const champion = modelRegistry.ensureSafeMvpChampion(userId);
  const championMetrics = champion.metrics || {};
  const mergedMetrics = { ...(challenger.metrics || {}), ...challengerMetrics };
  const gates = [
    gate('offline_only', true, 'Promotion review was produced by offline evaluation.'),
    gate('beats_champion_return', Number(mergedMetrics.totalReturn || 0) > Number(championMetrics.totalReturn || championMetrics.outOfSampleInformationCoefficient || 0), 'Challenger must beat champion return proxy.'),
    gate('drawdown_limit', Math.abs(Number(mergedMetrics.maximumDrawdown || 0)) <= 0.2, 'Maximum drawdown must be <= 20%.'),
    gate('fill_rate_floor', Number(mergedMetrics.fillRate ?? 1) >= 0.85, 'Fill rate must be at least 85%.'),
    gate('turnover_limit', Number(mergedMetrics.turnover || 0) <= 2, 'Turnover must be <= 200%.'),
  ];
  const passed = gates.every((item) => item.status === 'pass');
  const review = specRepo.savePromotionReview({
    userId,
    challengerModelVersion,
    championModelVersion: champion.model_version,
    reviewStatus: passed ? 'pending_approval' : 'rejected',
    gateResults: gates,
    backtestRunId,
  });
  specRepo.upsertModel({
    userId,
    modelVersion: challenger.model_version,
    modelType: challenger.model_type,
    artifactHash: challenger.artifact_hash,
    status: passed ? 'approved' : 'rejected',
    promotionReport: { reviewId: review.id, gates },
    metrics: mergedMetrics,
  });
  return review;
}

function approvePromotion({ userId, challengerModelVersion, approvedBy }) {
  const review = specRepo.getPromotionReview(userId, challengerModelVersion);
  if (!review || review.review_status !== 'pending_approval') {
    throw new Error(`Challenger ${challengerModelVersion} does not have a pending approved gate review.`);
  }
  if (!approvedBy) throw new Error('approvedBy is required');

  const champion = specRepo.getActiveChampion(userId);
  const challenger = specRepo.getModel(userId, challengerModelVersion);
  const approvedAt = new Date().toISOString();
  if (champion) {
    specRepo.upsertModel({
      userId,
      modelVersion: champion.model_version,
      modelType: champion.model_type,
      artifactHash: champion.artifact_hash,
      status: 'retired',
      approvedBy: champion.approved_by,
      approvedAt: champion.approved_at,
      promotionReport: { ...champion.promotionReport, retiredAt: approvedAt, retiredFor: challengerModelVersion },
      metrics: champion.metrics,
    });
  }
  const promoted = specRepo.upsertModel({
    userId,
    modelVersion: challenger.model_version,
    modelType: challenger.model_type,
    artifactHash: challenger.artifact_hash,
    status: 'champion',
    approvedBy,
    approvedAt,
    promotionReport: { reviewId: review.id, gates: review.gateResults, approvedAt },
    metrics: challenger.metrics,
  });
  specRepo.savePromotionReview({
    userId,
    challengerModelVersion,
    championModelVersion: review.champion_model_version,
    reviewStatus: 'approved',
    gateResults: review.gateResults,
    backtestRunId: review.backtest_run_id,
    approvedBy,
    approvedAt,
  });
  return promoted;
}

function rollbackChampion({ userId, targetModelVersion, approvedBy, reason = 'Operator requested model rollback.' }) {
  if (!approvedBy) throw new Error('approvedBy is required');
  const current = specRepo.getActiveChampion(userId);
  const target = specRepo.getModel(userId, targetModelVersion);
  if (!target) throw new Error(`Rollback target model ${targetModelVersion} not found`);
  if (current?.model_version === targetModelVersion) return target;
  const rollbackId = `rollback_${crypto.randomUUID()}`;
  const approvedAt = new Date().toISOString();
  if (current) {
    specRepo.upsertModel({
      userId,
      modelVersion: current.model_version,
      modelType: current.model_type,
      artifactHash: current.artifact_hash,
      status: 'retired',
      approvedBy: current.approved_by,
      approvedAt: current.approved_at,
      promotionReport: { ...current.promotionReport, rolledBackAt: approvedAt, rolledBackTo: targetModelVersion },
      metrics: current.metrics,
    });
  }
  const promoted = specRepo.upsertModel({
    userId,
    modelVersion: target.model_version,
    modelType: target.model_type,
    artifactHash: target.artifact_hash,
    status: 'champion',
    approvedBy,
    approvedAt,
    promotionReport: { ...target.promotionReport, rollbackId, rollbackReason: reason, approvedAt },
    metrics: target.metrics,
  });
  specRepo.saveRollbackEvent({
    userId,
    rollbackId,
    fromModelVersion: current?.model_version || 'none',
    toModelVersion: targetModelVersion,
    approvedBy,
    reason,
  });
  return promoted;
}

function gate(name, passed, reason) {
  return { gate: name, status: passed ? 'pass' : 'fail', reason };
}

module.exports = {
  createTrainingSnapshot,
  registerChallenger,
  evaluateChallenger,
  approvePromotion,
  rollbackChampion,
};
