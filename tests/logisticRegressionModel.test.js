const LogisticRegressionModel = require('../src/services/models/logisticRegressionModel');

describe('LogisticRegressionModel', () => {
  it('converges toward correct probabilities on a linearly separable synthetic dataset', () => {
    const trainingData = [
      { input: { x: 0.9, y: 0.1 }, output: { score: 1 } },
      { input: { x: 0.85, y: 0.2 }, output: { score: 1 } },
      { input: { x: 0.95, y: 0.05 }, output: { score: 1 } },
      { input: { x: 0.1, y: 0.9 }, output: { score: 0 } },
      { input: { x: 0.15, y: 0.85 }, output: { score: 0 } },
      { input: { x: 0.05, y: 0.95 }, output: { score: 0 } },
    ];
    const model = new LogisticRegressionModel().train(trainingData, { iterations: 1000, learningRate: 0.5 });

    expect(model.predictProba({ x: 0.9, y: 0.1 })).toBeGreaterThan(0.7);
    expect(model.predictProba({ x: 0.1, y: 0.9 })).toBeLessThan(0.3);
  });

  it('round-trips through toJSON/fromJSON without losing learned weights', () => {
    const trainingData = [
      { input: { x: 1 }, output: { score: 1 } },
      { input: { x: 0 }, output: { score: 0 } },
    ];
    const model = new LogisticRegressionModel().train(trainingData, { iterations: 200 });
    const restored = LogisticRegressionModel.fromJSON(model.toJSON());
    expect(restored.predictProba({ x: 1 })).toBeCloseTo(model.predictProba({ x: 1 }), 10);
  });

  it('throws on an empty training set rather than silently producing a useless model', () => {
    expect(() => new LogisticRegressionModel().train([])).toThrow();
  });
});
