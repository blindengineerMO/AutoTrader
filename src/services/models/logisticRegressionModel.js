/**
 * Minimal L2-regularized logistic regression trained by batch gradient
 * descent. No new dependency: this is the "regularized linear model" /
 * "logistic regression for probability of positive excess return" member
 * SPEC.md §7 calls for, sitting alongside the existing brain.js net instead
 * of being the only scorer.
 */
class LogisticRegressionModel {
  constructor({ featureNames = [], weights = null, bias = 0 } = {}) {
    this.featureNames = featureNames;
    this.weights = weights || featureNames.map(() => 0);
    this.bias = bias;
  }

  static sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
  }

  vectorize(input) {
    return this.featureNames.map((name) => Number(input[name]) || 0);
  }

  predictProba(input) {
    const x = this.vectorize(input);
    const z = this.bias + x.reduce((sum, xi, index) => sum + xi * this.weights[index], 0);
    return LogisticRegressionModel.sigmoid(z);
  }

  train(trainingData, { iterations = 800, learningRate = 0.3, l2 = 0.001 } = {}) {
    if (!trainingData.length) throw new Error('LogisticRegressionModel.train requires at least one training row');
    if (!this.featureNames.length) {
      this.featureNames = Object.keys(trainingData[0].input);
      this.weights = this.featureNames.map(() => 0);
    }
    const n = trainingData.length;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const gradWeights = this.weights.map(() => 0);
      let gradBias = 0;
      for (const row of trainingData) {
        const x = this.vectorize(row.input);
        const y = Number(row.output?.score ?? row.output?.label ?? 0);
        const yHat = this.predictProba(row.input);
        const error = yHat - y;
        for (let index = 0; index < x.length; index += 1) gradWeights[index] += error * x[index];
        gradBias += error;
      }
      for (let index = 0; index < this.weights.length; index += 1) {
        this.weights[index] -= learningRate * (gradWeights[index] / n + l2 * this.weights[index]);
      }
      this.bias -= learningRate * (gradBias / n);
    }
    return this;
  }

  toJSON() {
    return { featureNames: this.featureNames, weights: this.weights, bias: this.bias };
  }

  static fromJSON(json) {
    return new LogisticRegressionModel(json);
  }
}

module.exports = LogisticRegressionModel;
