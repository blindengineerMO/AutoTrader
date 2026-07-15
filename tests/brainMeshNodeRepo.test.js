const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-mesh-node-repo.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const nodeRepo = require('../src/db/repositories/brainMeshNodeRepo');

function newUser() {
  return userRepo.createUser({
    email: `brain-mesh-node-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

describe('brainMeshNodeRepo join tokens', () => {
  it('consumes a valid pending token exactly once', () => {
    const userId = newUser();
    const jt = nodeRepo.createJoinToken({ userId, label: 'test' });

    const first = nodeRepo.consumeJoinToken(jt.token, 'node_a');
    expect(first).toEqual({ userId, tokenId: jt.id });

    const second = nodeRepo.consumeJoinToken(jt.token, 'node_a');
    expect(second).toBeNull();
  });

  it('refuses an expired token', () => {
    const userId = newUser();
    const jt = nodeRepo.createJoinToken({ userId, label: 'test', ttlMs: -1000 });
    expect(nodeRepo.consumeJoinToken(jt.token, 'node_b')).toBeNull();
  });

  it('refuses a revoked token', () => {
    const userId = newUser();
    const jt = nodeRepo.createJoinToken({ userId, label: 'test' });
    expect(nodeRepo.revokeJoinToken(jt.id, userId)).toBe(true);
    expect(nodeRepo.consumeJoinToken(jt.token, 'node_c')).toBeNull();
  });
});

describe('brainMeshNodeRepo nodes and capabilities', () => {
  it('upserts a node and lists it by capability only when online', () => {
    const userId = newUser();
    const node = nodeRepo.upsertNode({ id: 'node_up', userId, publicKey: 'pk-up', status: 'online' });
    nodeRepo.upsertNodeCapabilities(node.id, [{ op: 'crawler.crawl', maxConcurrency: 3 }]);

    const online = nodeRepo.listNodesByCapability('crawler.crawl', userId);
    expect(online).toHaveLength(1);
    expect(online[0].maxConcurrency).toBe(3);
    expect(online[0].currentLoad).toBe(0);

    nodeRepo.setNodeStatus(node.id, 'offline');
    expect(nodeRepo.listNodesByCapability('crawler.crawl', userId)).toHaveLength(0);
  });

  it('never lets current_load go negative when decrementing past zero', () => {
    const userId = newUser();
    const node = nodeRepo.upsertNode({ id: 'node_load', userId, publicKey: 'pk-load', status: 'online' });
    nodeRepo.upsertNodeCapabilities(node.id, [{ op: 'crawler.crawl', maxConcurrency: 2 }]);

    nodeRepo.decrementNodeLoad(node.id, 'crawler.crawl');
    nodeRepo.decrementNodeLoad(node.id, 'crawler.crawl');

    const [capability] = nodeRepo.listNodesByCapability('crawler.crawl', userId);
    expect(capability.currentLoad).toBe(0);
  });

  it('force-revokes a node so it cannot be listed as active', () => {
    const userId = newUser();
    const node = nodeRepo.upsertNode({ id: 'node_revoke', userId, publicKey: 'pk-revoke', status: 'online' });
    expect(nodeRepo.revokeNode(node.id, userId)).toBe(true);
    const fetched = nodeRepo.getNode(node.id, userId);
    expect(fetched.status).toBe('revoked');
  });
});
