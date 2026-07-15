const brain = require('brain.js/dist/browser.js');
const brainModelRepo = require('../db/repositories/brainModelRepo');
const eventTrainingLabelRepo = require('../db/repositories/eventTrainingLabelRepo');
const logger = require('../utils/logger');

const CHALLENGER_MODEL_KEY = 'event-outcome-challenger-v1';
const MIN_COMPLETED_LABELS = 30;
const HOLDOUT_FRACTION = 0.2;
const HIDDEN_LAYERS = [8, 4];
const TRAIN_ITERATIONS = 200;
const HISTORY_LIMIT = 12;

const CERTAINTY_SCORES = { confirmed: 1, likely: 0.7, expected: 0.6, rumored: 0.3 };
const SURPRISE_SCORES = { above: 1, inline: 0.5, 'in-line': 0.5, below: 0 };
const CATEGORY_FLAGS = ['guidance', 'earnings', 'liquidity', 'legal', 'acquisition', 'product'];

function labelToFeatures(label) {
  const category = String(label.event_category || '').toLowerCase();
  const input = {
    baseWeightNorm: Math.min(1, Math.abs(label.base_weight || 0) / 10),
    direction: label.event_direction === 'positive' ? 1 : 0,
    sourceReliability: Number.isFinite(label.source_reliability) ? label.source_reliability : 0.55,
    certaintyScore: CERTAINTY_SCORES[label.certainty] ?? 0.5,
    surprise: SURPRISE_SCORES[label.surprise_direction] ?? 0.5,
    finalScoreNorm: Math.min(1, Math.abs(label.final_event_score || 0) / 10),
  };
  for (const flag of CATEGORY_FLAGS) {
    input[`cat_${flag}`] = category.includes(flag) ? 1 : 0;
  }
  return input;
}

function buildTrainingSet(userId) {
  const completed = eventTrainingLabelRepo
    .listRecent(userId, 5000)
    .filter((label) => label.original_model_prediction_correct !== null);
  return completed.map((label) => ({
    input: labelToFeatures(label),
    output: { correct: label.original_model_prediction_correct ? 1 : 0 },
  }));
}

function deterministicShuffle(items) {
  // Seeded by array length so retraining on the same dataset splits identically.
  const shuffled = [...items];
  let seed = items.length * 2654435761 % 4294967296;
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function accuracyOn(net, examples) {
  if (!examples.length) return 0;
  let hits = 0;
  for (const example of examples) {
    const prediction = net.run(example.input).correct >= 0.5 ? 1 : 0;
    if (prediction === example.output.correct) hits += 1;
  }
  return hits / examples.length;
}

function trainChallenger({ userId }) {
  const dataset = buildTrainingSet(userId);
  if (dataset.length < MIN_COMPLETED_LABELS) {
    return { skipped: true, reason: `only ${dataset.length} completed labels; need ${MIN_COMPLETED_LABELS}`, samples: dataset.length };
  }

  const shuffled = deterministicShuffle(dataset);
  const holdoutSize = Math.max(1, Math.floor(shuffled.length * HOLDOUT_FRACTION));
  const holdout = shuffled.slice(0, holdoutSize);
  const train = shuffled.slice(holdoutSize);

  const net = new brain.NeuralNetwork({ hiddenLayers: HIDDEN_LAYERS });
  net.train(train, { iterations: TRAIN_ITERATIONS, log: false });

  const holdoutAccuracy = Number(accuracyOn(net, holdout).toFixed(4));
  const correctShare = dataset.filter((example) => example.output.correct === 1).length / dataset.length;
  const majorityBaseline = Number(Math.max(correctShare, 1 - correctShare).toFixed(4));

  const existing = brainModelRepo.get(userId, CHALLENGER_MODEL_KEY);
  const championAccuracy = existing?.metadata?.promoted ? existing.metadata.holdoutAccuracy : null;
  const promoted = holdoutAccuracy > majorityBaseline && (championAccuracy === null || holdoutAccuracy > championAccuracy);

  const history = [...(existing?.metadata?.history || []), {
    trainedAt: new Date().toISOString(),
    samples: dataset.length,
    holdoutAccuracy,
    majorityBaseline,
    promoted,
  }].slice(-HISTORY_LIMIT);

  if (!promoted && existing?.metadata?.promoted) {
    // Keep the reigning promoted model; only refresh the audit history.
    brainModelRepo.save({
      userId,
      modelKey: CHALLENGER_MODEL_KEY,
      modelJson: existing.model,
      metadata: { ...existing.metadata, history },
    });
    return { skipped: false, promoted: false, holdoutAccuracy, majorityBaseline, samples: dataset.length, championAccuracy };
  }

  brainModelRepo.save({
    userId,
    modelKey: CHALLENGER_MODEL_KEY,
    modelJson: net.toJSON(),
    metadata: {
      promoted,
      holdoutAccuracy,
      majorityBaseline,
      samples: dataset.length,
      trainedAt: new Date().toISOString(),
      hiddenLayers: HIDDEN_LAYERS,
      history,
    },
  });

  logger.info('Event-outcome challenger scorer trained', { userId, samples: dataset.length, holdoutAccuracy, majorityBaseline, promoted });
  return { skipped: false, promoted, holdoutAccuracy, majorityBaseline, samples: dataset.length, championAccuracy };
}

function getPromotedScorer(userId) {
  const record = brainModelRepo.get(userId, CHALLENGER_MODEL_KEY);
  if (!record?.metadata?.promoted || !record.model?.layers) return null;
  const net = new brain.NeuralNetwork({ hiddenLayers: record.metadata.hiddenLayers || HIDDEN_LAYERS });
  net.fromJSON(record.model);
  return {
    metadata: record.metadata,
    scoreEvent: (event) => {
      const label = {
        event_category: event.event?.category,
        event_direction: event.event?.direction,
        base_weight: event.event?.base_weight,
        certainty: event.statement?.certainty,
        source_reliability: event.source?.reliability,
        surprise_direction: event.financial_effect?.surprise_relative_to_consensus,
        final_event_score: event.final_event_score,
        original_model_prediction_correct: 0,
      };
      const output = net.run(labelToFeatures(label));
      return Number.isFinite(output.correct) ? output.correct : 0.5;
    },
  };
}

function getChallengerStatus(userId) {
  const record = brainModelRepo.get(userId, CHALLENGER_MODEL_KEY);
  if (!record) return { trained: false };
  const { promoted, holdoutAccuracy, majorityBaseline, samples, trainedAt } = record.metadata || {};
  return { trained: true, promoted: Boolean(promoted), holdoutAccuracy, majorityBaseline, samples, trainedAt };
}

module.exports = {
  CHALLENGER_MODEL_KEY,
  buildTrainingSet,
  trainChallenger,
  getPromotedScorer,
  getChallengerStatus,
  labelToFeatures,
};
