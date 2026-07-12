const brainModelRepo = require('../../db/repositories/brainModelRepo');
const LogisticRegressionModel = require('./logisticRegressionModel');

const ENSEMBLE_WEIGHTS_KEY = 'candidate-ensemble-weights-v1';
const DEFAULT_MEMBERS = ['brainNet', 'logisticRegression', 'heuristic'];

/**
 * Rank-correlation information coefficient between a model's predictions and
 * realized outcomes. Used to weight ensemble members by measured
 * out-of-sample skill (SPEC.md §7) instead of fixed/arbitrary weights.
 */
function computeInformationCoefficient(predictions, outcomes) {
  const n = predictions.length;
  if (n < 2 || outcomes.length !== n) return 0;
  const rankOf = (values) => {
    const sorted = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    sorted.forEach(([, originalIndex], rankIndex) => {
      ranks[originalIndex] = rankIndex + 1;
    });
    return ranks;
  };
  const predRanks = rankOf(predictions);
  const outcomeRanks = rankOf(outcomes);
  const meanPred = predRanks.reduce((sum, value) => sum + value, 0) / n;
  const meanOutcome = outcomeRanks.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varPred = 0;
  let varOutcome = 0;
  for (let index = 0; index < n; index += 1) {
    covariance += (predRanks[index] - meanPred) * (outcomeRanks[index] - meanOutcome);
    varPred += (predRanks[index] - meanPred) ** 2;
    varOutcome += (outcomeRanks[index] - meanOutcome) ** 2;
  }
  if (!varPred || !varOutcome) return 0;
  return covariance / Math.sqrt(varPred * varOutcome);
}

/**
 * Converts per-member ICs into normalized combination weights. A
 * non-positive IC gets zero weight rather than dragging the ensemble down;
 * if every member is non-positive, falls back to an equal split.
 */
function computeWeightsFromIc(icByMember) {
  const members = Object.keys(icByMember);
  const clipped = members.map((member) => Math.max(0, icByMember[member]));
  const total = clipped.reduce((sum, value) => sum + value, 0);
  if (!total) {
    const equal = 1 / members.length;
    return Object.fromEntries(members.map((member) => [member, equal]));
  }
  return Object.fromEntries(members.map((member, index) => [member, clipped[index] / total]));
}

function loadWeights(userId) {
  const saved = brainModelRepo.get(userId, ENSEMBLE_WEIGHTS_KEY);
  if (saved?.model?.weights) return saved.model.weights;
  return Object.fromEntries(DEFAULT_MEMBERS.map((member) => [member, 1 / DEFAULT_MEMBERS.length]));
}

function saveWeights({ userId, weights, icByMember = {} }) {
  return brainModelRepo.save({
    userId,
    modelKey: ENSEMBLE_WEIGHTS_KEY,
    modelJson: { weights, icByMember, updatedAt: new Date().toISOString() },
    metadata: { purpose: 'IC-weighted ensemble combination weights for candidate scoring.' },
  });
}

function buildLogisticMember({ userId, modelKey, trainingData }) {
  const saved = brainModelRepo.get(userId, modelKey);
  if (saved?.model?.weights?.length) return LogisticRegressionModel.fromJSON(saved.model);
  const model = new LogisticRegressionModel().train(trainingData);
  brainModelRepo.save({
    userId,
    modelKey,
    modelJson: model.toJSON(),
    metadata: {
      purpose: 'Logistic regression ensemble member for candidate scoring.',
      trainingExamples: trainingData.length,
    },
  });
  return model;
}

/**
 * Combines the existing brain.js net score, a logistic regression member,
 * and the raw heuristic feature average into one 0-1 score, weighted by each
 * member's measured skill (or an equal split until skill has been measured).
 */
function scoreEnsemble({ userId, input, brainNetScore01, trainingData, modelKey = 'candidate-logistic-v1', weights }) {
  const logistic = buildLogisticMember({ userId, modelKey, trainingData });
  const logisticScore = logistic.predictProba(input);
  const featureValues = Object.values(input).filter((value) => Number.isFinite(value));
  const heuristicScore = featureValues.length ? featureValues.reduce((sum, value) => sum + value, 0) / featureValues.length : 0.5;
  const memberScores = { brainNet: brainNetScore01, logisticRegression: logisticScore, heuristic: heuristicScore };
  const resolvedWeights = weights || loadWeights(userId);
  const totalWeight = Object.values(resolvedWeights).reduce((sum, value) => sum + value, 0) || 1;
  const combined = Object.entries(memberScores).reduce(
    (sum, [member, score]) => sum + score * (resolvedWeights[member] || 0),
    0
  ) / totalWeight;
  return { combined: Math.max(0, Math.min(1, combined)), memberScores, weights: resolvedWeights };
}

module.exports = {
  computeInformationCoefficient,
  computeWeightsFromIc,
  loadWeights,
  saveWeights,
  scoreEnsemble,
  buildLogisticMember,
};
