const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-model-service.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brainModelRepo = require('../src/db/repositories/brainModelRepo');
const brainModelService = require('../src/services/brainModelService');

const XOR_TRAINING_DATA = [
  { input: [0, 0], output: [0] },
  { input: [0, 1], output: [1] },
  { input: [1, 0], output: [1] },
  { input: [1, 1], output: [0] },
];

describe('brainModelService.loadOrTrain', () => {
  let userId;

  beforeAll(() => {
    const user = userRepo.createUser({
      email: `brain-model-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    userId = user.id;
  });

  it('trains and persists a new model when none is saved yet for this modelKey', () => {
    const { net, saved, record } = brainModelService.loadOrTrain({
      userId,
      modelKey: 'test-model-v1',
      trainingData: XOR_TRAINING_DATA,
      iterations: 200,
    });

    expect(saved).toBe(false);
    expect(record.model_key).toBe('test-model-v1');
    expect(record.model.layers).toBeDefined();
    expect(record.metadata.trainingExamples).toBe(4);
    expect(typeof net.run([0, 1])[0]).toBe('number');
  });

  it('loads the persisted model on a second call instead of retraining', () => {
    const first = brainModelService.loadOrTrain({
      userId,
      modelKey: 'test-model-v2',
      trainingData: XOR_TRAINING_DATA,
      iterations: 200,
    });
    const secondNetOutput = first.net.run([1, 0])[0];

    const { net, saved, record } = brainModelService.loadOrTrain({
      userId,
      modelKey: 'test-model-v2',
      trainingData: XOR_TRAINING_DATA,
      iterations: 200,
    });

    expect(saved).toBe(true);
    expect(record.model_key).toBe('test-model-v2');
    expect(net.run([1, 0])[0]).toBeCloseTo(secondNetOutput, 10);
  });

  it('round-trips the trained network through toJSON/fromJSON via the repository', () => {
    brainModelService.loadOrTrain({
      userId,
      modelKey: 'test-model-v3',
      trainingData: XOR_TRAINING_DATA,
      iterations: 200,
    });

    const stored = brainModelRepo.get(userId, 'test-model-v3');
    expect(stored.model.layers).toBeDefined();
    expect(Array.isArray(stored.model.layers)).toBe(true);
  });

  it('keeps models scoped per userId under the same modelKey', () => {
    const otherUser = userRepo.createUser({
      email: `brain-model-other-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    brainModelService.loadOrTrain({ userId, modelKey: 'shared-key', trainingData: XOR_TRAINING_DATA, iterations: 50 });
    const otherResult = brainModelService.loadOrTrain({ userId: otherUser.id, modelKey: 'shared-key', trainingData: XOR_TRAINING_DATA, iterations: 50 });

    expect(otherResult.saved).toBe(false);
    expect(brainModelRepo.get(userId, 'shared-key')).not.toBeNull();
    expect(brainModelRepo.get(otherUser.id, 'shared-key')).not.toBeNull();
  });
});
