const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-mesh-node-transport.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const nodeRepo = require('../src/db/repositories/brainMeshNodeRepo');
const nodeTransport = require('../src/services/brainMeshNodeTransport');

function newUser() {
  return userRepo.createUser({
    email: `brain-mesh-transport-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  }).id;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const transport = nodeTransport.attach(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, transport }));
  });
}

function wsUrl(server) {
  const { port } = server.address();
  return `ws://127.0.0.1:${port}/api/brain-mesh/nodes/socket`;
}

function once(socket, matchKind) {
  return new Promise((resolve) => {
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!matchKind || message.kind === matchKind) {
        socket.off('message', onMessage);
        resolve(message);
      }
    }
    socket.on('message', onMessage);
  });
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

describe('brainMeshNodeTransport integration', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => {
    ctx.transport.close();
    ctx.server.close();
  });

  it('completes challenge -> hello -> ack with a valid join token', async () => {
    const userId = newUser();
    const joinToken = nodeRepo.createJoinToken({ userId, label: 'test-node' });
    const identity = generateIdentity();

    const socket = new WebSocket(wsUrl(ctx.server));
    const challenge = await once(socket, 'node.challenge');
    expect(challenge.body.nonce).toBeTruthy();

    socket.send(JSON.stringify({
      kind: 'node.hello',
      body: {
        publicKey: identity.publicKeyPem,
        joinToken: joinToken.token,
        capabilities: [{ op: 'crawler.crawl', maxConcurrency: 2 }],
        clientVersion: '0.0.1',
      },
    }));

    const ack = await once(socket, 'node.hello.ack');
    expect(ack.body.ok).toBe(true);
    expect(ack.body.nodeId).toBeTruthy();

    const nodes = nodeRepo.listNodes(userId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status).toBe('online');

    socket.close();
  });

  it('rejects an invalid or already-consumed join token', async () => {
    const socket = new WebSocket(wsUrl(ctx.server));
    await once(socket, 'node.challenge');

    const identity = generateIdentity();
    const closed = new Promise((resolve) => socket.on('close', resolve));

    socket.send(JSON.stringify({
      kind: 'node.hello',
      body: {
        publicKey: identity.publicKeyPem,
        joinToken: 'not-a-real-token',
        capabilities: [],
      },
    }));

    const ack = await once(socket, 'node.hello.ack');
    expect(ack.body.ok).toBe(false);
    await closed;
  });

  it('rejects a reconnect with a bad signature and accepts a valid one', async () => {
    const userId = newUser();
    const joinToken = nodeRepo.createJoinToken({ userId, label: 'test-node' });
    const identity = generateIdentity();

    const firstSocket = new WebSocket(wsUrl(ctx.server));
    await once(firstSocket, 'node.challenge');
    firstSocket.send(JSON.stringify({
      kind: 'node.hello',
      body: { publicKey: identity.publicKeyPem, joinToken: joinToken.token, capabilities: [] },
    }));
    const firstAck = await once(firstSocket, 'node.hello.ack');
    expect(firstAck.body.ok).toBe(true);
    firstSocket.close();

    const badSocket = new WebSocket(wsUrl(ctx.server));
    await once(badSocket, 'node.challenge');
    const badClosed = new Promise((resolve) => badSocket.on('close', resolve));
    badSocket.send(JSON.stringify({
      kind: 'node.hello',
      body: { publicKey: identity.publicKeyPem, signature: Buffer.from('garbage').toString('base64') },
    }));
    const badAck = await once(badSocket, 'node.hello.ack');
    expect(badAck.body.ok).toBe(false);
    await badClosed;

    const goodSocket = new WebSocket(wsUrl(ctx.server));
    const challenge = await once(goodSocket, 'node.challenge');
    const signature = crypto.sign(null, Buffer.from(challenge.body.nonce), identity.privateKeyPem).toString('base64');
    goodSocket.send(JSON.stringify({
      kind: 'node.hello',
      body: { publicKey: identity.publicKeyPem, signature, capabilities: [] },
    }));
    const goodAck = await once(goodSocket, 'node.hello.ack');
    expect(goodAck.body.ok).toBe(true);
    goodSocket.close();
  });

  it('never registers a remote handler for a disallowed op claimed via hello', async () => {
    const brainMesh = require('../src/services/brainMeshService');
    const registerSpy = vi.spyOn(brainMesh, 'registerRemoteHandler');

    const userId = newUser();
    const joinToken = nodeRepo.createJoinToken({ userId, label: 'malicious-node' });
    const identity = generateIdentity();

    const socket = new WebSocket(wsUrl(ctx.server));
    await once(socket, 'node.challenge');
    socket.send(JSON.stringify({
      kind: 'node.hello',
      body: {
        publicKey: identity.publicKeyPem,
        joinToken: joinToken.token,
        capabilities: [{ op: 'order.place', maxConcurrency: 1 }],
      },
    }));

    const ack = await once(socket, 'node.hello.ack');
    expect(ack.body.ok).toBe(true);

    expect(registerSpy).not.toHaveBeenCalledWith(expect.anything(), 'order.place', expect.anything());

    const [node] = nodeRepo.listNodes(userId);
    expect(nodeRepo.listNodesByCapability('order.place', userId)).toHaveLength(0);
    expect(node).toBeTruthy();

    registerSpy.mockRestore();
    socket.close();
  });

  it('persists health telemetry from node.hello and refreshes it on node.heartbeat', async () => {
    const userId = newUser();
    const joinToken = nodeRepo.createJoinToken({ userId, label: 'health-node' });
    const identity = generateIdentity();

    const socket = new WebSocket(wsUrl(ctx.server));
    await once(socket, 'node.challenge');
    socket.send(JSON.stringify({
      kind: 'node.hello',
      body: {
        publicKey: identity.publicKeyPem,
        joinToken: joinToken.token,
        capabilities: [],
        resources: { cpuCores: 8, ollamaModels: ['llama3'] },
        health: {
          cpuCores: 8,
          cpuPercent: 12,
          ram: { totalMb: 16000, usedMb: 4000, percent: 25 },
          uptimeSec: 120,
          features: ['ollama'],
          ollamaModels: ['llama3'],
          collectedAt: new Date().toISOString(),
        },
      },
    }));
    const ack = await once(socket, 'node.hello.ack');
    expect(ack.body.ok).toBe(true);

    let [node] = nodeRepo.listNodes(userId);
    expect(node.metadata.resources).toEqual({ cpuCores: 8, ollamaModels: ['llama3'] });
    expect(node.metadata.health.cpuPercent).toBe(12);
    expect(node.metadata.health.ram.percent).toBe(25);
    expect(node.metadata.health.features).toEqual(['ollama']);

    socket.send(JSON.stringify({
      kind: 'node.heartbeat',
      body: {
        capabilities: [],
        health: {
          cpuCores: 8,
          cpuPercent: 77,
          ram: { totalMb: 16000, usedMb: 9000, percent: 56 },
          uptimeSec: 180,
          features: [],
          ollamaModels: [],
          collectedAt: new Date().toISOString(),
        },
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));

    [node] = nodeRepo.listNodes(userId);
    expect(node.metadata.health.cpuPercent).toBe(77);
    expect(node.metadata.health.ram.percent).toBe(56);
    // resources from the original hello survive the heartbeat's metadata merge
    expect(node.metadata.resources).toEqual({ cpuCores: 8, ollamaModels: ['llama3'] });

    socket.close();
  });
});
