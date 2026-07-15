const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-mesh-node-routes.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const authService = require('../src/services/authService');
const nodeRepo = require('../src/db/repositories/brainMeshNodeRepo');
const createApp = require('../src/server/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function jsonRequest(server, pathName, token, options = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${pathName}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  return { response, body };
}

describe('brain mesh node routes', () => {
  it('returns a join token plaintext once on creation and never again on list', async () => {
    const { token, user } = await authService.register({
      email: `brain-mesh-node-route-${Date.now()}@example.com`,
      password: 'correct-horse',
    });

    const server = await listen(createApp());
    try {
      const created = await jsonRequest(server, '/api/brain-mesh/nodes/join-tokens', token, {
        method: 'POST',
        body: { label: 'my-server' },
      });
      expect(created.response.status).toBe(201);
      expect(typeof created.body.token).toBe('string');
      expect(created.body.token.length).toBeGreaterThan(10);

      const listed = await jsonRequest(server, '/api/brain-mesh/nodes/join-tokens', token);
      expect(listed.response.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].token).toBeUndefined();
      expect(listed.body[0].tokenHash).toBeUndefined();
      expect(listed.body[0].label).toBe('my-server');
    } finally {
      server.close();
    }
  });

  it('revokes a join token so it can no longer be consumed', async () => {
    const { token, user } = await authService.register({
      email: `brain-mesh-node-revoke-${Date.now()}@example.com`,
      password: 'correct-horse',
    });

    const server = await listen(createApp());
    try {
      const created = await jsonRequest(server, '/api/brain-mesh/nodes/join-tokens', token, {
        method: 'POST',
        body: {},
      });

      const revoked = await jsonRequest(server, `/api/brain-mesh/nodes/join-tokens/${created.body.id}`, token, {
        method: 'DELETE',
      });
      expect(revoked.response.status).toBe(200);

      expect(nodeRepo.consumeJoinToken(created.body.token, 'node_route_test')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('lists registered nodes and revokes one by id', async () => {
    const { token, user } = await authService.register({
      email: `brain-mesh-node-list-${Date.now()}@example.com`,
      password: 'correct-horse',
    });
    const node = nodeRepo.upsertNode({ id: 'node_route_1', userId: user.id, publicKey: 'pk-route-1', status: 'online' });

    const server = await listen(createApp());
    try {
      const listed = await jsonRequest(server, '/api/brain-mesh/nodes/nodes', token);
      expect(listed.response.status).toBe(200);
      expect(listed.body.map((n) => n.id)).toContain(node.id);

      const revoked = await jsonRequest(server, `/api/brain-mesh/nodes/nodes/${node.id}`, token, {
        method: 'DELETE',
      });
      expect(revoked.response.status).toBe(200);
      expect(nodeRepo.getNode(node.id, user.id).status).toBe('revoked');

      const missing = await jsonRequest(server, `/api/brain-mesh/nodes/nodes/does-not-exist`, token, {
        method: 'DELETE',
      });
      expect(missing.response.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
