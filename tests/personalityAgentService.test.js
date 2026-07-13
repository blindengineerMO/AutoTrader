const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-personality-agents.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const researchRepo = require('../src/db/repositories/researchRepo');
const researchSourceRepo = require('../src/db/repositories/researchSourceRepo');
const watcherAgentRepo = require('../src/db/repositories/watcherAgentRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const personalityAgents = require('../src/services/personalityAgentService');
const brainMesh = require('../src/services/brainMeshService');
const aiClient = require('../src/services/strategy/aiClient');

describe('personalityAgentService', () => {
  it('seeds public-persona agents, creates custom agents, and runs a consensus council', async () => {
    const user = userRepo.createUser({
      email: `agents-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    researchRepo.create({
      userId: user.id,
      source: 'test',
      summary: { prePlan: { thesis: 'test' } },
      signals: [
        { symbol: 'NVDA', localAiScore: 82, changePct: 2.4, volatilityPct: 2.1, theme: 'semiconductors+ai', price: 100 },
        { symbol: 'XLE', localAiScore: 65, changePct: 1.1, volatilityPct: 1.2, theme: 'energy', price: 50 },
        { symbol: 'AMZN', localAiScore: 74, changePct: 1.6, volatilityPct: 1.9, theme: 'cloud+ecommerce', price: 80 },
      ],
    });

    const seeded = personalityAgents.ensureDefaultAgents(user.id);
    expect(seeded.map((agent) => agent.slug)).toEqual(expect.arrayContaining(['bill-gates', 'donald-trump', 'nancy-pelosi', 'jeff-bezos', 'elon-musk']));
    const billGates = seeded.find((agent) => agent.slug === 'bill-gates');
    expect(billGates.persona.localAiCollaboration.brainId).toBe('brain.llm.ollama');
    expect(billGates.persona.localAiCollaboration.supportedOps).toEqual(expect.arrayContaining(['llm.reason', 'llm.research.assist', 'llm.training.suggest', 'llm.analysis.assist']));
    expect(billGates.model.bmcl.primaryLocalLlmBrainId).toBe('brain.llm.ollama');
    expect(billGates.model.bmcl.conversationPattern.selfImprovement).toEqual({ to: ['brain.llm.ollama'], op: 'llm.training.suggest' });

    const billMeshAgent = brainMesh.listAgents(user.id).find((agent) => agent.id === billGates.brain_id);
    expect(billMeshAgent.user_id).toBeNull();
    expect(billMeshAgent.capabilities).toContain('bmcl.ask.ollama');
    expect(billMeshAgent.metadata.localAiCollaboration.brainId).toBe('brain.llm.ollama');
    expect(billMeshAgent.metadata.sharedAcrossUsers).toBe(true);

    const custom = personalityAgents.createAgent(user.id, 'Ada Lovelace');
    expect(custom.sourceUrls.some((url) => url.includes('google.com/search'))).toBe(true);
    expect(custom.workspace?.spec).toBeTruthy();
    expect(fs.existsSync(custom.workspace.spec)).toBe(true);
    expect(custom.persona.localAiCollaboration.supportedOps).toContain('llm.reason');

    const updated = personalityAgents.updateAgent(user.id, custom.id, {
      status: 'paused',
      persona: { ...custom.persona, style: ['analytical', 'systems'] },
      sourceUrls: [...custom.sourceUrls, 'https://example.com/ada-market-notes'],
    });
    expect(updated.status).toBe('paused');
    expect(updated.persona.style).toContain('systems');

    const exported = personalityAgents.exportAgent(user.id, custom.id);
    expect(exported.spec.name).toBe('Ada Lovelace');
    expect(exported.spec.workspace.database).toContain('agent.sqlite');

    const run = await personalityAgents.runCouncil({ userId: user.id });
    expect(run.recommendations.length).toBeGreaterThan(0);
    expect(run.summary.finalRecommendations.length).toBeGreaterThan(0);
    expect(run.conversation_id).toMatch(/^bc_/);
    expect(run.summary.decisionFrameworkVersion).toBe('agent-decision-tree-v1');
    expect(run.recommendations[0].evidence.decisionTree.version).toBe('agent-decision-tree-v1');
    expect(run.recommendations[0].evidence.decisionObject.requiredConditions.length).toBeGreaterThan(0);
    expect(run.recommendations[0].evidence.decisionTree.gates.map((gate) => gate.name)).toEqual(expect.arrayContaining([
      'data-quality',
      'intrinsic-value',
      'portfolio-fit',
      'sell-decision-tree',
    ]));

    const deleted = personalityAgents.deleteAgent(user.id, custom.id);
    expect(deleted.status).toBe('deleted');
    expect(personalityAgents.listAgents(user.id).some((agent) => agent.id === custom.id)).toBe(false);
  });

  it('shares the same personality BrainMesh agent across users while keeping user-scoped records', () => {
    const alice = userRepo.createUser({
      email: `shared-agent-alice-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    const bob = userRepo.createUser({
      email: `shared-agent-bob-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const [aliceBill] = personalityAgents.ensureDefaultAgents(alice.id).filter((agent) => agent.slug === 'bill-gates');
    const [bobBill] = personalityAgents.ensureDefaultAgents(bob.id).filter((agent) => agent.slug === 'bill-gates');

    expect(aliceBill.id).not.toBe(bobBill.id);
    expect(aliceBill.user_id).toBe(alice.id);
    expect(bobBill.user_id).toBe(bob.id);
    expect(aliceBill.brain_id).toBe('agent.personality.bill-gates');
    expect(bobBill.brain_id).toBe('agent.personality.bill-gates');

    const sharedMeshAgents = brainMesh.listAgents(alice.id).filter((agent) => agent.id === 'agent.personality.bill-gates');
    expect(sharedMeshAgents).toHaveLength(1);
    expect(sharedMeshAgents[0].user_id).toBeNull();
    expect(sharedMeshAgents[0].metadata.sharedPersonaSlug).toBe('bill-gates');
  });

  it('discounts a recommendation weight in buildConsensus when its thesis lost a council challenge', () => {
    const agents = [
      { id: 'agent-a', name: 'Agent A', model: { learningWeight: 1 } },
      { id: 'agent-b', name: 'Agent B', model: { learningWeight: 1 } },
    ];
    const recommendations = [
      { agentId: 'agent-a', symbol: 'NVDA', action: 'buy', conviction: 80, rationale: 'bullish' },
      { agentId: 'agent-b', symbol: 'MSFT', action: 'buy', conviction: 80, rationale: 'bullish' },
    ];

    const baseline = personalityAgents.buildConsensus(recommendations, agents);
    const nvdaBaseline = baseline.finalRecommendations.find((rec) => rec.symbol === 'NVDA');
    const msftBaseline = baseline.finalRecommendations.find((rec) => rec.symbol === 'MSFT');
    expect(nvdaBaseline.consensusScore).toBe(msftBaseline.consensusScore);

    const challengeOutcomes = new Map([['agent-a:NVDA', 0.5]]);
    const challenged = personalityAgents.buildConsensus(recommendations, agents, challengeOutcomes);
    const nvdaChallenged = challenged.finalRecommendations.find((rec) => rec.symbol === 'NVDA');
    const msftChallenged = challenged.finalRecommendations.find((rec) => rec.symbol === 'MSFT');

    expect(nvdaChallenged.consensusScore).toBeLessThan(msftChallenged.consensusScore);
    expect(nvdaChallenged.consensusScore).toBeLessThan(nvdaBaseline.consensusScore);
  });

  it('gives a source credibility bump when its owning agent backed a winning consensus recommendation', async () => {
    const user = userRepo.createUser({
      email: `consensus-source-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const sourceUrl = 'https://example.com/consensus-credibility-test';
    researchSourceRepo.upsert({
      userId: user.id,
      url: sourceUrl,
      title: 'Consensus credibility test source',
      sourceType: 'learned',
      discoveryMethod: 'test',
      relevanceScore: 50,
      credibilityScore: 50,
    });

    // Trigger runCouncil once (with no agents/signals it still registers the
    // brain.research.source handler as a side effect) so the manual envelope below
    // exercises the real registered handler rather than a hand-rolled stand-in.
    await personalityAgents.runCouncil({ userId: user.id });

    // The handler resolves the agent by id via tradingAgentRepo before crediting
    // its sourceUrls, so seed a real agent record with the test source attached.
    // updateAgent re-persists sourceUrls (via persistAgentSources), which upserts
    // fixed baseline scores, so capture the baseline after that instead of assuming
    // the pre-seeded values survive.
    const seeded = personalityAgents.createAgent(user.id, 'Credibility Test Agent');
    personalityAgents.updateAgent(user.id, seeded.id, { sourceUrls: [sourceUrl] });
    const baselineSource = researchSourceRepo.getByUrl(user.id, sourceUrl);

    brainMesh.tell({
      from: 'agent.council.moderator',
      to: ['brain.research.source'],
      kind: 'event',
      op: 'agent.consensus.ready',
      ctx: { userId: user.id },
      body: {
        finalRecommendations: [
          {
            symbol: 'TEST',
            action: 'buy',
            votes: [{ agentId: seeded.id, action: 'buy' }],
          },
        ],
      },
    });

    const updatedSource = researchSourceRepo.getByUrl(user.id, sourceUrl);
    expect(updatedSource.relevance_score).toBe(baselineSource.relevance_score + 1);
    expect(updatedSource.credibility_score).toBe(baselineSource.credibility_score + 2);
  });

  it('auto-seeds watcher agents for a persona\'s watch symbols when agent.profile.ready fires', () => {
    const user = userRepo.createUser({
      email: `profile-ready-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    expect(watcherAgentRepo.getBySymbol(user.id, 'PRSY')).toBeNull();

    brainMesh.tell({
      from: 'agent.personality.test-persona',
      to: ['agent.research.builder', 'agent.council.moderator', 'brain.reporting'],
      kind: 'event',
      op: 'agent.profile.ready',
      ctx: { userId: user.id },
      body: {
        agentId: 'agent-test-persona',
        name: 'Test Persona',
        sourceUrls: [],
        watchSymbols: ['PRSY', 'PRSY2'],
      },
    });

    const seeded = watcherAgentRepo.getBySymbol(user.id, 'PRSY');
    expect(seeded).toBeTruthy();
    expect(seeded.status).toBe('active');
    expect(watcherAgentRepo.getBySymbol(user.id, 'PRSY2')).toBeTruthy();
  });

  it('nudges an agent bias factor when agent_local_learning_enabled is true and the LLM proposes an adjustment', async () => {
    const user = userRepo.createUser({
      email: `local-learning-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    settingsRepo.update(user.id, { agentLocalLearningEnabled: 1 });

    const agent = personalityAgents.createAgent(user.id, 'Local Learner');
    personalityAgents.updateAgent(user.id, agent.id, { bias: { sectors: { technology: 0.1 } } });

    const spy = vi.spyOn(aiClient, 'requestStructuredCompletion').mockResolvedValue({
      provider: 'ollama',
      model: 'llama3.1',
      parsed: {
        biasAdjustments: [
          { agentId: agent.id, sectorOrFactor: 'technology', delta: 0.05, rationale: 'strong consensus win' },
        ],
      },
    });

    await personalityAgents.runCouncil({ userId: user.id });

    expect(spy).toHaveBeenCalled();
    const updated = personalityAgents.listAgents(user.id).find((candidate) => candidate.id === agent.id);
    expect(updated.bias.sectors.technology).toBeCloseTo(0.15, 4);

    spy.mockRestore();
  });

  it('does not call the LLM or touch bias when agent_local_learning_enabled is left off (default)', async () => {
    const user = userRepo.createUser({
      email: `local-learning-off-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const agent = personalityAgents.createAgent(user.id, 'Untouched Agent');
    personalityAgents.updateAgent(user.id, agent.id, { bias: { sectors: { technology: 0.1 } } });

    const spy = vi.spyOn(aiClient, 'requestStructuredCompletion');

    await personalityAgents.runCouncil({ userId: user.id });

    expect(spy).not.toHaveBeenCalled();
    const untouched = personalityAgents.listAgents(user.id).find((candidate) => candidate.id === agent.id);
    expect(untouched.bias.sectors.technology).toBe(0.1);

    spy.mockRestore();
  });
});
