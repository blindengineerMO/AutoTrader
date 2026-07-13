const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-brain-mesh.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brainMesh = require('../src/services/brainMeshService');

describe('brainMeshService', () => {
  it('registers brains, performs RPC ask/reply, and records frames', async () => {
    const user = userRepo.createUser({
      email: `mesh-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'test-mesh' });

    const result = await brainMesh.ask({
      from: 'test.operator',
      to: 'brain.discovery.company',
      op: 'mesh.status',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {},
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body.id).toBe('brain.discovery.company');
    expect(brainMesh.listAgents(user.id).map((agent) => agent.id)).toContain('brain.discovery.company');

    const dynamic = brainMesh.registerAgent({
      id: `agent.test.${user.id}`,
      userId: user.id,
      role: 'test-agent',
      capabilities: ['mesh.status', 'test.op'],
    });
    expect(dynamic.status).toBe('online');
    brainMesh.linkAgentToBoard({ userId: user.id, agentId: dynamic.id, boardId: 'agent-council', role: 'member' });
    expect(brainMesh.listAgentLinks({ userId: user.id, boardId: 'agent-council' })[0].agent_id).toBe(dynamic.id);
    brainMesh.unlinkAgentFromBoard({ userId: user.id, agentId: dynamic.id, boardId: 'agent-council' });
    expect(brainMesh.listAgentLinks({ userId: user.id, boardId: 'agent-council' })).toHaveLength(0);
    expect(brainMesh.removeAgent(dynamic.id, user.id).status).toBe('removed');

    const messages = brainMesh.listMessages({ userId: user.id, traceId: conversation.metadata.trace, limit: 10 });
    expect(messages.map((message) => message.envelope.kind)).toEqual(expect.arrayContaining(['ask', 'reply']));
  });

  it('invokes a registered handler when tell() dispatches to it, so fire-and-forget events actually do something', async () => {
    let received = null;
    brainMesh.registerHandler('agent.test.tell-target', 'test.signal.reported', (envelope) => {
      received = envelope.body;
      return { acknowledged: true };
    });

    brainMesh.tell({
      from: 'agent.test.tell-source',
      to: ['agent.test.tell-target'],
      kind: 'event',
      op: 'test.signal.reported',
      ctx: {},
      body: { value: 42 },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual({ value: 42 });
  });

  it('returns the handler return value via reply() when using ask()', async () => {
    brainMesh.registerHandler('agent.test.ask-target', 'test.question.asked', (envelope) => ({
      answer: envelope.body.question === 'ping' ? 'pong' : 'unknown',
    }));

    const result = await brainMesh.ask({
      from: 'agent.test.ask-source',
      to: ['agent.test.ask-target'],
      op: 'test.question.asked',
      ctx: {},
      body: { question: 'ping' },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toEqual({ answer: 'pong' });
  });
});
