const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-evaluation-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const evaluationService = require('../src/services/evaluationService');
const ensembleService = require('../src/services/models/ensembleService');

describe('evaluationService.updateEnsembleWeights', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `evaluation-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('does nothing when fewer than two actions carry ensemble member scores', () => {
    const before = ensembleService.loadWeights(userId);
    evaluationService.updateEnsembleWeights(userId, [
      { actionEvaluations: [{ ensembleMemberScores: null, returnPct: 1 }] },
    ]);
    const after = ensembleService.loadWeights(userId);
    expect(after).toEqual(before);
  });

  it('reweights toward the member whose historical scores best rank-correlate with realized returns', () => {
    const evaluations = [
      {
        actionEvaluations: [
          { ensembleMemberScores: { brainNet: 0.9, logisticRegression: 0.1, heuristic: 0.5 }, returnPct: 5 },
          { ensembleMemberScores: { brainNet: 0.7, logisticRegression: 0.3, heuristic: 0.5 }, returnPct: 3 },
          { ensembleMemberScores: { brainNet: 0.3, logisticRegression: 0.7, heuristic: 0.5 }, returnPct: -2 },
          { ensembleMemberScores: { brainNet: 0.1, logisticRegression: 0.9, heuristic: 0.5 }, returnPct: -4 },
        ],
      },
    ];

    evaluationService.updateEnsembleWeights(userId, evaluations);
    const weights = ensembleService.loadWeights(userId);

    expect(weights.brainNet).toBeGreaterThan(weights.logisticRegression);
    expect(weights.brainNet + weights.logisticRegression + weights.heuristic).toBeCloseTo(1, 6);
  });
});
