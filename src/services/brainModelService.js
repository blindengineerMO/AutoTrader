const brain = require('brain.js/dist/browser.js');
const brainModelRepo = require('../db/repositories/brainModelRepo');

function loadOrTrain({ userId, modelKey, trainingData, hiddenLayers = [6, 4], iterations = 80, metadata = {} }) {
  const net = new brain.NeuralNetwork({ hiddenLayers });
  const saved = brainModelRepo.get(userId, modelKey);
  if (saved?.model?.layers) {
    net.fromJSON(saved.model);
    return { net, saved: true, record: saved };
  }
  net.train(trainingData, { iterations, log: false });
  const record = brainModelRepo.save({
    userId,
    modelKey,
    modelJson: net.toJSON(),
    metadata: {
      ...metadata,
      hiddenLayers,
      iterations,
      exportedAt: new Date().toISOString(),
      trainingExamples: trainingData.length,
    },
  });
  return { net, saved: false, record };
}

module.exports = { loadOrTrain };
