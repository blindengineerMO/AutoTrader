const crypto = require('crypto');
const specRepo = require('../../db/repositories/specResearchRepo');

const SAFE_MVP_MODEL_VERSION = 'safe-mvp-equal-weight-factor-baseline-v1';

function ensureSafeMvpChampion(userId) {
  const existing = specRepo.getActiveChampion(userId);
  if (existing) return existing;
  const artifact = {
    modelVersion: SAFE_MVP_MODEL_VERSION,
    modelType: 'equal-weight-factor-baseline',
    features: ['valueScore', 'qualityScore', 'momentumScore', 'riskScore', 'liquidityScore'],
    trainingMode: 'deterministic_baseline_no_live_learning',
  };
  const artifactHash = crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
  return specRepo.upsertModel({
    userId,
    modelVersion: SAFE_MVP_MODEL_VERSION,
    modelType: 'equal-weight-factor-baseline',
    artifactHash,
    status: 'champion',
    approvedBy: 'system-safe-mvp-bootstrap',
    approvedAt: new Date().toISOString(),
    promotionReport: {
      approvalBasis: 'Spec safe research MVP bootstrap baseline. No live trading authority.',
      gates: [
        { gate: 'interpretable_baseline', status: 'pass' },
        { gate: 'live_trading_authority', status: 'blocked' },
      ],
    },
    metrics: {
      outOfSampleInformationCoefficient: 0,
      turnover: 0,
      capacity: 'not_estimated',
      backtestStatus: 'pending_safe_mvp',
    },
  });
}

function assertApprovedModel(userId, modelVersion) {
  const model = specRepo.getModel(userId, modelVersion);
  const approved = ['approved', 'champion'].includes(model?.status);
  return {
    allowed: approved,
    model,
    reason: approved ? 'Model is approved for safe research MVP scoring.' : `Model ${modelVersion} is not approved.`,
  };
}

module.exports = { ensureSafeMvpChampion, assertApprovedModel, SAFE_MVP_MODEL_VERSION };
