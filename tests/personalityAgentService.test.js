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
const personalityAgents = require('../src/services/personalityAgentService');

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

    const custom = personalityAgents.createAgent(user.id, 'Ada Lovelace');
    expect(custom.sourceUrls.some((url) => url.includes('google.com/search'))).toBe(true);
    expect(custom.workspace?.spec).toBeTruthy();
    expect(fs.existsSync(custom.workspace.spec)).toBe(true);

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
});
