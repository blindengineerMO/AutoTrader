const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-challenger-scorer.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const eventTrainingLabelRepo = require('../src/db/repositories/eventTrainingLabelRepo');
const brainModelRepo = require('../src/db/repositories/brainModelRepo');
const challengerScorerService = require('../src/services/challengerScorerService');
const db = require('../src/db/connection');

// Separable synthetic set: confirmed filing events are always correct,
// rumored blog events are always wrong.
function seedLabels(userId, count) {
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const correct = i % 2 === 0;
    labels.push({
      symbol: `SYM${i}`,
      eventCategory: correct ? 'guidance' : 'legal',
      eventType: correct ? 'raised_guidance' : 'lawsuit',
      eventDirection: correct ? 'positive' : 'negative',
      baseWeight: correct ? 8 : 3,
      certainty: correct ? 'confirmed' : 'rumored',
      sourceType: correct ? 'company_filing' : 'blog',
      sourceReliability: correct ? 1.0 : 0.35,
      surpriseDirection: correct ? 'above' : 'below',
      finalEventScore: correct ? 6 : 1.2,
      documentId: `doc-${i}`,
      sectorSymbol: 'SPY',
      eventDate: new Date().toISOString(),
    });
  }
  eventTrainingLabelRepo.saveLabels(userId, labels);
  for (const label of eventTrainingLabelRepo.listRecent(userId, count + 10)) {
    const correct = label.certainty === 'confirmed' ? 1 : 0;
    eventTrainingLabelRepo.updateOutcomes(label.id, { original_model_prediction_correct: correct });
  }
}

describe('challengerScorerService', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `challenger-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  afterEach(() => {
    db.prepare('DELETE FROM event_training_labels').run();
    db.prepare('DELETE FROM brain_models').run();
  });

  it('skips training below the minimum completed-label count', () => {
    seedLabels(userId, 10);
    const result = challengerScorerService.trainChallenger({ userId });
    expect(result.skipped).toBe(true);
    expect(challengerScorerService.getChallengerStatus(userId)).toEqual({ trained: false });
  });

  it('trains and promotes on a separable label set, and the promoted scorer scores events', () => {
    seedLabels(userId, 60);
    const result = challengerScorerService.trainChallenger({ userId });

    expect(result.skipped).toBe(false);
    expect(result.holdoutAccuracy).toBeGreaterThan(result.majorityBaseline);
    expect(result.promoted).toBe(true);

    const scorer = challengerScorerService.getPromotedScorer(userId);
    expect(scorer).not.toBeNull();

    const strongEvent = {
      event: { category: 'guidance', direction: 'positive', base_weight: 8 },
      statement: { certainty: 'confirmed' },
      source: { reliability: 1.0 },
      financial_effect: { surprise_relative_to_consensus: 'above' },
      final_event_score: 6,
    };
    const weakEvent = {
      event: { category: 'legal', direction: 'negative', base_weight: 3 },
      statement: { certainty: 'rumored' },
      source: { reliability: 0.35 },
      financial_effect: { surprise_relative_to_consensus: 'below' },
      final_event_score: 1.2,
    };

    expect(scorer.scoreEvent(strongEvent)).toBeGreaterThan(scorer.scoreEvent(weakEvent));
    expect(challengerScorerService.getChallengerStatus(userId).promoted).toBe(true);
  });

  it('does not dethrone a reigning promoted model with higher accuracy, but keeps the audit history', () => {
    seedLabels(userId, 60);
    brainModelRepo.save({
      userId,
      modelKey: challengerScorerService.CHALLENGER_MODEL_KEY,
      modelJson: { layers: [] },
      metadata: { promoted: true, holdoutAccuracy: 1.0, samples: 500, history: [] },
    });

    const result = challengerScorerService.trainChallenger({ userId });

    expect(result.promoted).toBe(false);
    const record = brainModelRepo.get(userId, challengerScorerService.CHALLENGER_MODEL_KEY);
    expect(record.metadata.promoted).toBe(true);
    expect(record.metadata.holdoutAccuracy).toBe(1.0);
    expect(record.metadata.history.length).toBe(1);
    expect(record.metadata.history[0].promoted).toBe(false);
  });

  it('records an audit entry even when an unpromoted challenger fails the baseline gate', () => {
    // Non-separable labels: identical features, random outcomes -> accuracy ~ baseline.
    const labels = [];
    for (let i = 0; i < 40; i += 1) {
      labels.push({
        symbol: `FLAT${i}`,
        eventCategory: 'guidance',
        eventType: 'raised_guidance',
        eventDirection: 'positive',
        baseWeight: 5,
        certainty: 'confirmed',
        sourceType: 'company_filing',
        sourceReliability: 1.0,
        surpriseDirection: 'inline',
        finalEventScore: 3,
        documentId: `flat-doc-${i}`,
        sectorSymbol: 'SPY',
        eventDate: new Date().toISOString(),
      });
    }
    eventTrainingLabelRepo.saveLabels(userId, labels);
    const rows = eventTrainingLabelRepo.listRecent(userId, 50);
    rows.forEach((label, index) => {
      eventTrainingLabelRepo.updateOutcomes(label.id, { original_model_prediction_correct: index % 3 === 0 ? 0 : 1 });
    });

    const result = challengerScorerService.trainChallenger({ userId });

    expect(result.skipped).toBe(false);
    const record = brainModelRepo.get(userId, challengerScorerService.CHALLENGER_MODEL_KEY);
    expect(record).not.toBeNull();
    expect(record.metadata.history.length).toBeGreaterThan(0);
    if (!result.promoted) {
      expect(challengerScorerService.getPromotedScorer(userId)).toBeNull();
    }
  });
});
