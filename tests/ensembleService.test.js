const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-ensemble-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const ensembleService = require('../src/services/models/ensembleService');

describe('ensembleService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `ensemble-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('computes a positive information coefficient when predictions rank-agree with outcomes', () => {
    const predictions = [0.9, 0.7, 0.5, 0.3, 0.1];
    const outcomes = [0.08, 0.05, 0.01, -0.02, -0.06];
    const ic = ensembleService.computeInformationCoefficient(predictions, outcomes);
    expect(ic).toBeGreaterThan(0.9);
  });

  it('computes a near-zero information coefficient for unrelated rankings', () => {
    const predictions = [0.9, 0.1, 0.5, 0.3, 0.7];
    const outcomes = [-0.02, 0.05, -0.06, 0.08, 0.01];
    const ic = ensembleService.computeInformationCoefficient(predictions, outcomes);
    expect(Math.abs(ic)).toBeLessThanOrEqual(0.6);
  });

  it('weights the higher-IC member more heavily and gives a non-positive-IC member zero weight', () => {
    const weights = ensembleService.computeWeightsFromIc({ good: 0.8, bad: -0.2, mediocre: 0.2 });
    expect(weights.good).toBeGreaterThan(weights.mediocre);
    expect(weights.bad).toBe(0);
    expect(weights.good + weights.mediocre + weights.bad).toBeCloseTo(1, 6);
  });

  it('falls back to an equal split when every member has non-positive IC', () => {
    const weights = ensembleService.computeWeightsFromIc({ a: -0.1, b: -0.4 });
    expect(weights.a).toBeCloseTo(0.5, 6);
    expect(weights.b).toBeCloseTo(0.5, 6);
  });

  it('combines member scores using the persisted/derived weights and stays within [0, 1]', () => {
    const trainingData = [
      { input: { momentum: 0.9 }, output: { score: 1 } },
      { input: { momentum: 0.1 }, output: { score: 0 } },
    ];
    const weights = ensembleService.computeWeightsFromIc({ brainNet: 0.9, logisticRegression: 0.1, heuristic: 0.1 });

    const result = ensembleService.scoreEnsemble({
      userId,
      input: { momentum: 0.9 },
      brainNetScore01: 0.95,
      trainingData,
      modelKey: 'test-logistic-member',
      weights,
    });

    expect(result.combined).toBeGreaterThanOrEqual(0);
    expect(result.combined).toBeLessThanOrEqual(1);
    // brainNet carries the most weight, so combined should sit close to its score.
    expect(Math.abs(result.combined - 0.95)).toBeLessThan(Math.abs(result.combined - result.memberScores.heuristic));
  });

  it('persists and reloads ensemble weights across calls', () => {
    ensembleService.saveWeights({ userId, weights: { brainNet: 0.6, logisticRegression: 0.3, heuristic: 0.1 }, icByMember: { brainNet: 0.5 } });
    const reloaded = ensembleService.loadWeights(userId);
    expect(reloaded.brainNet).toBeCloseTo(0.6, 6);
  });
});
