const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-model-promotion.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const specRepo = require('../src/db/repositories/specResearchRepo');
const modelRegistry = require('../src/services/spec/modelRegistryService');
const promotionService = require('../src/services/spec/modelPromotionService');

describe('modelPromotionService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `promotion-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
    modelRegistry.ensureSafeMvpChampion(userId);
  });

  it('rejects challengers that fail offline promotion gates', () => {
    promotionService.registerChallenger({
      userId,
      modelVersion: 'weak-challenger-v1',
      modelType: 'brain-js',
      artifact: { nodes: 3 },
      metrics: { totalReturn: -0.02, maximumDrawdown: 0.3, fillRate: 0.9, turnover: 0.4 },
    });

    const review = promotionService.evaluateChallenger({ userId, challengerModelVersion: 'weak-challenger-v1' });
    expect(review.review_status).toBe('rejected');
    expect(specRepo.getModel(userId, 'weak-challenger-v1').status).toBe('rejected');
  });

  it('requires explicit approval before promoting a passing challenger to champion', () => {
    const oldChampion = specRepo.getActiveChampion(userId);
    promotionService.registerChallenger({
      userId,
      modelVersion: 'strong-challenger-v1',
      modelType: 'brain-js',
      artifact: { nodes: 12 },
      metrics: { totalReturn: 0.12, maximumDrawdown: 0.08, fillRate: 0.95, turnover: 0.6 },
    });

    const review = promotionService.evaluateChallenger({ userId, challengerModelVersion: 'strong-challenger-v1', backtestRunId: 'bt-review-1' });
    expect(review.review_status).toBe('pending_approval');
    expect(specRepo.getActiveChampion(userId).model_version).toBe(oldChampion.model_version);

    const promoted = promotionService.approvePromotion({
      userId,
      challengerModelVersion: 'strong-challenger-v1',
      approvedBy: 'unit-test',
    });

    expect(promoted.status).toBe('champion');
    expect(specRepo.getModel(userId, oldChampion.model_version).status).toBe('retired');
    expect(specRepo.getActiveChampion(userId).model_version).toBe('strong-challenger-v1');
    expect(specRepo.getPromotionReview(userId, 'strong-challenger-v1').review_status).toBe('approved');
  });

  it('stores immutable training snapshots and supports approved champion rollback', () => {
    const first = promotionService.createTrainingSnapshot({
      userId,
      modelVersion: 'strong-challenger-v1',
      datasetVersion: 'dataset-train-1',
      featureVersion: 'feature-train-1',
      artifact: { weights: [0.1, 0.2] },
      metrics: { totalReturn: 0.12 },
      createdBy: 'unit-test',
    });
    const duplicate = promotionService.createTrainingSnapshot({
      userId,
      modelVersion: 'strong-challenger-v1',
      datasetVersion: 'dataset-train-1',
      featureVersion: 'feature-train-1',
      artifact: { weights: [0.1, 0.2] },
      metrics: { totalReturn: 0.99 },
      createdBy: 'mutating-test',
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.metrics.totalReturn).toBe(0.12);

    const rolledBack = promotionService.rollbackChampion({
      userId,
      targetModelVersion: modelRegistry.SAFE_MVP_MODEL_VERSION,
      approvedBy: 'unit-test',
      reason: 'restore baseline after challenger drift',
    });

    expect(rolledBack.status).toBe('champion');
    expect(specRepo.getActiveChampion(userId).model_version).toBe(modelRegistry.SAFE_MVP_MODEL_VERSION);
    expect(specRepo.listRollbackEvents(userId, 5)[0].to_model_version).toBe(modelRegistry.SAFE_MVP_MODEL_VERSION);
  });
});
