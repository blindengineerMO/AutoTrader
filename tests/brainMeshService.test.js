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
const ollamaClient = require('../src/services/ollamaClient');

describe('brainMeshService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ollamaClient.clearOllamaModelCache();
  });

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

  it('exposes Ollama as a BrainMesh LLM brain for agent reasoning and training assistance', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest' }] });
      }
      if (target.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        expect(body.model).toBe('deepseek-r1:latest');
        expect(body.messages[1].content).toContain('[redacted]');
        return jsonResponse({
          message: {
            content: JSON.stringify({
              summary: 'Use more outcome labels for weak high-volatility calls.',
              reasoning: 'Recent misses cluster around low evidence and high volatility.',
              insights: ['High-volatility holds need stricter confirmation.'],
              recommendations: ['Add a volatility-confirmation feature.'],
              trainingNotes: ['Label weak high-volatility outcomes separately.'],
              riskNotes: ['Local model used only supplied outcomes.'],
            }),
          },
        });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });

    const user = userRepo.createUser({
      email: `mesh-ollama-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const conversation = brainMesh.startConversation({ userId: user.id, topic: 'ollama-mesh' });

    const agents = brainMesh.listAgents(user.id);
    const ollamaAgent = agents.find((agent) => agent.id === 'brain.llm.ollama');
    expect(ollamaAgent.capabilities).toContain('llm.training.suggest');

    const result = await brainMesh.ask({
      from: 'agent.personality.test',
      to: 'brain.llm.ollama',
      op: 'llm.training.suggest',
      ctx: { userId: user.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        objective: 'Improve agent model after daily evaluation.',
        apiKey: 'should-not-leak',
        outcomes: [{ symbol: 'XYZ', predicted: 'buy', actualReturnPct: -4.2 }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.replies[0].body).toMatchObject({
      provider: 'ollama',
      brainId: 'brain.llm.ollama',
      mode: 'training',
      summary: 'Use more outcome labels for weak high-volatility calls.',
    });
    expect(result.replies[0].body.trainingNotes).toContain('Label weak high-volatility outcomes separately.');
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

function jsonResponse(data) {
  return {
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}
