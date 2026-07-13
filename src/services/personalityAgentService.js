const tradingAgentRepo = require('../db/repositories/tradingAgentRepo');
const researchRepo = require('../db/repositories/researchRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const aiClient = require('./strategy/aiClient');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const positionRepo = require('../db/repositories/positionRepo');
const brainMesh = require('./brainMeshService');
const watcherAgentService = require('./watcherAgentService');
const agentWorkspace = require('./agentWorkspaceService');
const agentResearch = require('./agentResearchService');
const agentDecisionTree = require('./agentDecisionTreeService');

const MODERATOR_BRAIN_ID = 'agent.council.moderator';
const OLLAMA_BRAIN_ID = 'brain.llm.ollama';
const OLLAMA_BMCL_OPS = ['llm.assist', 'llm.reason', 'llm.research.assist', 'llm.training.suggest', 'llm.analysis.assist'];
const DEFAULT_CHALLENGE_BASELINE = 65;
const CONSENSUS_SOURCE_CREDIBILITY_DELTA = 2;
const CONSENSUS_SOURCE_RELEVANCE_DELTA = 1;
let moderatorRegistered = false;
let sourceCredibilityHandlerRegistered = false;

function ensureSourceCredibilityHandlerRegistered() {
  if (sourceCredibilityHandlerRegistered) return;
  sourceCredibilityHandlerRegistered = true;
  // agent.consensus.ready is broadcast to brain.research.source alongside brain.reporting/
  // brain.evaluation, but nothing ever picked it up, so winning theses never fed back into
  // source credibility scoring — this closes that loop.
  brainMesh.registerHandler('brain.research.source', 'agent.consensus.ready', (envelope) => {
    const userId = envelope.ctx?.userId;
    const consensus = envelope.body || {};
    if (!userId) return { updated: 0 };

    const winningAgentIds = new Set();
    for (const rec of consensus.finalRecommendations || []) {
      if (rec.action !== 'buy' && rec.action !== 'sell') continue;
      for (const vote of rec.votes || []) {
        if (vote.action === rec.action) winningAgentIds.add(vote.agentId);
      }
    }

    let updated = 0;
    for (const agentId of winningAgentIds) {
      const agent = tradingAgentRepo.getAgent(userId, agentId);
      for (const url of agent?.sourceUrls || []) {
        const source = researchSourceRepo.getByUrl(userId, url);
        if (!source) continue;
        researchSourceRepo.updateStats(source.id, {
          success: true,
          relevanceDelta: CONSENSUS_SOURCE_RELEVANCE_DELTA,
          credibilityDelta: CONSENSUS_SOURCE_CREDIBILITY_DELTA,
        });
        updated += 1;
      }
    }
    return { updated };
  });
}

function ensureModeratorRegistered() {
  if (moderatorRegistered) return;
  moderatorRegistered = true;
  brainMesh.registerAgent({
    id: MODERATOR_BRAIN_ID,
    role: 'council-moderator',
    capabilities: ['agent.thesis.proposed', 'agent.challenge.raised', 'agent.consensus.ready'],
    metadata: { service: 'personalityAgentService' },
  });
  brainMesh.registerHandler(MODERATOR_BRAIN_ID, 'agent.thesis.proposed', (envelope) => ({
    acknowledged: true,
    agent: envelope.body?.agent?.name,
    recommendations: envelope.body?.recommendations?.length || 0,
  }));
  brainMesh.registerHandler(MODERATOR_BRAIN_ID, 'agent.challenge.raised', (envelope) => {
    const debate = envelope.body || {};
    const counterConviction = Number.isFinite(debate.challengerConviction) ? debate.challengerConviction : DEFAULT_CHALLENGE_BASELINE;
    const targetConviction = Number(debate.targetConviction ?? 0);
    const upheld = counterConviction > targetConviction;
    const weightMultiplier = upheld ? clamp(1 - (counterConviction - targetConviction) / 100, 0.35, 1) : 1;
    return {
      resolution: upheld ? 'challenge-upheld' : 'challenge-overruled',
      targetAgentId: debate.targetAgentId,
      symbol: debate.symbol,
      counterConviction,
      targetConviction,
      weightMultiplier,
    };
  });
  // agent.profile.ready is broadcast whenever a new/refreshed persona is built, but
  // watcher coverage for that persona's favorite symbols was never actually seeded —
  // this auto-creates watcher agents so the two features are actually wired together.
  brainMesh.registerHandler(MODERATOR_BRAIN_ID, 'agent.profile.ready', (envelope) => {
    const userId = envelope.ctx?.userId;
    const watchSymbols = envelope.body?.watchSymbols || [];
    if (!userId) return { seeded: 0 };
    let seeded = 0;
    for (const symbol of watchSymbols) {
      watcherAgentService.ensureWatcherAgent(userId, { symbol });
      seeded += 1;
    }
    return { seeded };
  });
}

const DEFAULT_PERSONAS = [
  {
    name: 'Bill Gates',
    slug: 'bill-gates',
    archetype: 'systems-builder-philanthropic-technologist',
    summary: 'Long-horizon technology and infrastructure thinker biased toward climate, healthcare, productivity software, platforms, and scalable human-welfare outcomes.',
    style: ['long-term systems', 'technical due diligence', 'climate and health utility', 'platform durability'],
    sourceUrls: [
      'https://www.gatesnotes.com/home/home-page-topic/reader/three-tough-truths-about-climate',
      'https://www.gatesfoundation.org/ideas/articles/next-chapter',
      'https://www.breakthroughenergy.org/',
    ],
    bias: {
      sectors: { software: 0.18, climate: 0.18, healthcare: 0.14, energy: 0.12, consumer: -0.03 },
      factors: { moat: 0.24, longHorizon: 0.24, quality: 0.18, volatilityPenalty: 0.10, momentum: 0.04 },
      watchSymbols: ['MSFT', 'GOOGL', 'NVDA', 'LLY', 'NVO', 'XLE'],
    },
  },
  {
    name: 'Donald Trump',
    slug: 'donald-trump',
    archetype: 'brand-leverage-real-estate-deal-maker',
    summary: 'Brand, leverage, real estate, media, hospitality, energy, and deal-flow oriented persona with high appetite for visible catalysts and sentiment shifts.',
    style: ['brand power', 'deal momentum', 'real assets', 'media attention', 'energy preference'],
    sourceUrls: [
      'https://www.trump.com/',
      'https://www.trump.com/real-estate-portfolio',
      'https://www.trump.com/golf',
    ],
    bias: {
      sectors: { realEstate: 0.20, energy: 0.16, financials: 0.12, media: 0.12, consumer: 0.08, climate: -0.08 },
      factors: { momentum: 0.18, sentiment: 0.18, volatilityTolerance: 0.16, moat: 0.08, riskPenalty: -0.04 },
      watchSymbols: ['XLE', 'XLF', 'DJT', 'DIS', 'MAR', 'HLT'],
    },
  },
  {
    name: 'Nancy Pelosi',
    slug: 'nancy-pelosi',
    archetype: 'policy-aware-large-cap-growth-observer',
    summary: 'Policy-aware public-market persona biased toward liquid large-cap technology, infrastructure, healthcare, and disclosure-traceable market context.',
    style: ['policy sensitivity', 'large-cap liquidity', 'technology leadership', 'risk controls', 'disclosure awareness'],
    sourceUrls: [
      'https://clerk.house.gov/members/P000197',
      'https://disclosures-clerk.house.gov/',
      'https://pelosi.house.gov/',
    ],
    bias: {
      sectors: { software: 0.18, semiconductors: 0.16, healthcare: 0.10, infrastructure: 0.10, defense: 0.08 },
      factors: { liquidity: 0.22, policyCatalyst: 0.18, moat: 0.16, volatilityPenalty: 0.12, momentum: 0.10 },
      watchSymbols: ['NVDA', 'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'PANW'],
    },
  },
  {
    name: 'Jeff Bezos',
    slug: 'jeff-bezos',
    archetype: 'day-one-customer-obsessed-platform-builder',
    summary: 'Customer obsession and long-horizon platform compounding persona biased toward cloud, logistics, marketplaces, space, AI infrastructure, and founder-led reinvestment.',
    style: ['customer obsession', 'Day 1 thinking', 'cash-flow reinvestment', 'platform scale', 'frontier bets'],
    sourceUrls: [
      'https://media.corporate-ir.net/media_files/irol/97/97664/reports/Shareholderletter97.pdf',
      'https://www.sec.gov/Archives/edgar/data/1018724/000119312513151836/d511111dex991.htm',
      'https://www.bezosexpeditions.com/',
    ],
    bias: {
      sectors: { cloud: 0.18, ecommerce: 0.16, logistics: 0.14, ai: 0.12, space: 0.10 },
      factors: { longHorizon: 0.24, customerDemand: 0.20, reinvestment: 0.18, moat: 0.16, shortTermProfitPenalty: -0.04 },
      watchSymbols: ['AMZN', 'GOOGL', 'MSFT', 'SHOP', 'UBER', 'BA'],
    },
  },
  {
    name: 'Elon Musk',
    slug: 'elon-musk',
    archetype: 'first-principles-frontier-technology-operator',
    summary: 'First-principles frontier-technology persona biased toward EVs, robotics, AI, space, energy storage, autonomy, and asymmetric high-volatility outcomes.',
    style: ['first principles', 'vertical integration', 'moonshot risk', 'engineering velocity', 'automation'],
    sourceUrls: [
      'https://www.tesla.com/master-plans',
      'https://www.tesla.com/secret-master-plan',
      'https://x.ai/',
      'https://www.spacex.com/',
    ],
    bias: {
      sectors: { ev: 0.18, ai: 0.18, space: 0.16, robotics: 0.14, energy: 0.12, legacyConsumer: -0.06 },
      factors: { asymmetricUpside: 0.24, technicalCatalyst: 0.22, momentum: 0.18, volatilityTolerance: 0.18, quality: 0.04 },
      watchSymbols: ['TSLA', 'NVDA', 'AMD', 'GOOGL', 'PLTR', 'XLE'],
    },
  },
];

function ensureDefaultAgents(userId) {
  return DEFAULT_PERSONAS.map((profile) => {
    const existing = tradingAgentRepo.getBySlug(userId, profile.slug);
    if (existing) {
      const updated = ensureAgentRuntimeMetadata(existing);
      agentWorkspace.ensureWorkspace(updated);
      return updated;
    }
    return saveProfile(userId, profile, 'seeded-public-persona');
  });
}

function listAgents(userId) {
  ensureDefaultAgents(userId);
  const agents = tradingAgentRepo.listAgents(userId).map(ensureAgentRuntimeMetadata);
  return agentWorkspace.syncAgents(agents);
}

function createAgent(userId, name) {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
  if (!cleanName) throw new Error('Agent name is required');
  const known = DEFAULT_PERSONAS.find((persona) => persona.slug === slugify(cleanName) || persona.name.toLowerCase() === cleanName.toLowerCase());
  const profile = known || buildGeneratedProfile(cleanName);
  return saveProfile(userId, profile, known ? 'seeded-public-persona' : 'generated-research-persona');
}

function createAgentFromProfile(userId, profile, profileSource = 'agent-web-crawled-persona') {
  if (!profile?.name) throw new Error('Agent profile requires a name');
  return saveProfile(userId, profile, profileSource);
}

function startResearchCreateAgent(userId, name) {
  return agentResearch.startAgentResearchRun({
    userId,
    name,
    createAgent: createAgentFromProfile,
  });
}

function getResearchCreateRun(userId, runId) {
  return agentResearch.getAgentResearchRun(userId, runId);
}

function refreshAgentPersonalities(userId) {
  const agents = listAgents(userId).filter((agent) => agent.status === 'active');
  return agents.map((agent) => startResearchCreateAgent(userId, agent.name));
}

function updateAgent(userId, id, patch = {}) {
  const existing = tradingAgentRepo.getAgent(userId, id);
  if (!existing) throw new Error('Agent not found');
  const next = tradingAgentRepo.updateAgent(userId, id, {
    name: cleanText(patch.name) || existing.name,
    status: ['active', 'paused', 'archived'].includes(patch.status) ? patch.status : existing.status,
    persona: objectOrExisting(patch.persona, existing.persona),
    bias: objectOrExisting(patch.bias, existing.bias),
    sourceUrls: Array.isArray(patch.sourceUrls) ? normalizeUrls(patch.sourceUrls) : existing.sourceUrls,
    model: objectOrExisting(patch.model, existing.model),
  });
  const ready = ensureAgentOllamaGuidance(next);
  registerMeshAgent(ready);
  persistAgentSources(userId, ready);
  return { ...ready, workspace: agentWorkspace.ensureWorkspace(ready) };
}

function deleteAgent(userId, id) {
  const deleted = tradingAgentRepo.markDeleted(userId, id);
  if (!deleted) throw new Error('Agent not found');
  agentWorkspace.markDeleted(deleted);
  return { ok: true, id: deleted.id, status: deleted.status };
}

function exportAgent(userId, id) {
  const agent = tradingAgentRepo.getAgent(userId, id);
  if (!agent || agent.status === 'deleted') throw new Error('Agent not found');
  return agentWorkspace.exportWorkspace(agent);
}

function importAgent(userId, payload) {
  const spec = payload?.spec || payload;
  if (!spec?.name) throw new Error('Agent import requires a spec with a name');
  const slug = spec.slug || slugify(spec.name);
  const profile = {
    name: cleanText(spec.name),
    slug,
    archetype: spec.persona?.archetype || spec.archetype || 'imported-personality-agent',
    summary: spec.persona?.summary || spec.summary || 'Imported personality trading agent.',
    style: Array.isArray(spec.persona?.style) ? spec.persona.style : Array.isArray(spec.style) ? spec.style : ['imported', 'adaptive'],
    sourceUrls: normalizeUrls(spec.sourceUrls || []),
    bias: spec.bias || {},
  };
  const agent = saveProfile(userId, profile, 'imported-agent-spec');
  return updateAgent(userId, agent.id, {
    status: spec.status === 'paused' || spec.status === 'archived' ? spec.status : 'active',
    persona: {
      ...agent.persona,
      ...(spec.persona || {}),
      profileSource: 'imported-agent-spec',
    },
    model: spec.model || agent.model,
  });
}

async function runCouncil({ userId, snapshotId = null, onEvent = () => {} } = {}) {
  ensureModeratorRegistered();
  ensureSourceCredibilityHandlerRegistered();
  const agents = listAgents(userId).filter((agent) => agent.status === 'active');
  const snapshot = snapshotId ? researchRepo.getByIdForUser(snapshotId, userId) : researchRepo.listByUser(userId, 1)[0];
  const signals = snapshot?.signals || [];
  const accountState = brokerAccountRepo.ensureDefault(userId);
  const positions = positionRepo.listByUser(userId);
  const decisionContext = { snapshot, signals, positions, accountState };
  const conversation = brainMesh.startConversation({
    userId,
    topic: `agent-council${snapshot?.id ? `:${snapshot.id}` : ''}`,
    metadata: {
      snapshotId: snapshot?.id || null,
      agentCount: agents.length,
      decisionFrameworkVersion: agentDecisionTree.VERSION,
    },
  });

  emit(onEvent, 'agent-council', 52, 'debug', 'Personality agent council opened BrainMesh conversation.', {
    conversationId: conversation.id,
    agents: agents.map((agent) => agent.name),
    snapshotId: snapshot?.id || null,
  });

  const allRecommendations = [];
  for (const agent of agents) {
    registerMeshAgent(agent);
    persistAgentSources(userId, agent);
    const recommendations = recommendForAgent(agent, signals, decisionContext);
    allRecommendations.push(...recommendations);
    brainMesh.tell({
      from: agent.brain_id,
      to: ['brain.model.neural', 'brain.reporting', 'agent.council.moderator'],
      kind: 'event',
      op: 'agent.thesis.proposed',
      ctx: { userId, snapshotId: snapshot?.id || null },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        agent: summarizeAgent(agent),
        recommendations: recommendations.map(stripRecommendationForFrame),
      },
    });
  }

  const debates = buildDebateRounds(agents, allRecommendations);
  const challengeOutcomes = new Map();
  for (const debate of debates) {
    const result = await brainMesh.ask({
      from: debate.challengerBrainId,
      to: [MODERATOR_BRAIN_ID],
      op: 'agent.challenge.raised',
      ctx: { userId, snapshotId: snapshot?.id || null },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: debate,
    }, { timeoutMs: 3000 });
    const resolution = result.replies.find((reply) => reply.kind === 'reply')?.body;
    if (resolution) {
      challengeOutcomes.set(`${resolution.targetAgentId}:${resolution.symbol}`, resolution.weightMultiplier);
    }
  }

  const consensus = buildConsensus(allRecommendations, agents, challengeOutcomes);
  brainMesh.tell({
    from: 'agent.council.moderator',
    to: ['brain.reporting', 'brain.evaluation', 'brain.research.source'],
    kind: 'event',
    op: 'agent.consensus.ready',
    ctx: { userId, snapshotId: snapshot?.id || null },
    conv: conversation.id,
    trace: conversation.metadata.trace,
    body: consensus,
  });

  const settings = settingsRepo.get(userId);
  if (settings?.agent_local_learning_enabled) {
    await applyLocalLearningPass({ userId, agents, allRecommendations, consensus, onEvent });
  }

  const run = tradingAgentRepo.createCouncilRun({
    userId,
    researchSnapshotId: snapshot?.id || null,
    conversationId: conversation.id,
    status: 'complete',
    summary: consensus,
    recommendations: allRecommendations,
  });
  for (const recommendation of allRecommendations) {
    const agent = agents.find((item) => item.id === recommendation.agentId);
    if (agent) agentWorkspace.recordRecommendation(agent, recommendation, run);
  }

  emit(onEvent, 'agent-council', 58, 'debug', 'Personality agent council completed consensus run.', {
    runId: run.id,
    consensus: consensus.finalRecommendations.slice(0, 5),
  });
  return run;
}

function listCouncilRuns(userId, limit = 20) {
  return tradingAgentRepo.listCouncilRuns(userId, limit);
}

function saveProfile(userId, profile, profileSource) {
  const slug = profile.slug || slugify(profile.name);
  const brainId = `agent.personality.${slug}`;
  const agent = tradingAgentRepo.upsertAgent({
    userId,
    name: profile.name,
    slug,
    status: 'active',
    brainId,
    persona: {
      archetype: profile.archetype,
      summary: profile.summary,
      style: profile.style,
      profileSource,
      disclaimer: 'This is a simulated investment-style persona based on public sources, not an endorsement or claim about the real person making trades.',
      localAiCollaboration: buildOllamaCollaborationGuidance(),
    },
    bias: profile.bias,
    sourceUrls: profile.sourceUrls,
    model: {
      modelType: 'personality-bias-v1',
      createdAt: new Date().toISOString(),
      promptSeed: `${profile.name} ${profile.archetype} ${profile.style?.join(' ')}`,
      ...(profile.model || {}),
      decisionFrameworkVersion: agentDecisionTree.VERSION,
      decisionFramework: agentDecisionTree.buildDecisionFramework(profile),
      bmcl: buildOllamaBmclModelGuidance(profile.model?.bmcl),
    },
  });
  registerMeshAgent(agent);
  persistAgentSources(userId, agent);
  return { ...agent, workspace: agentWorkspace.ensureWorkspace(agent) };
}

function buildGeneratedProfile(name) {
  const slug = slugify(name);
  const google = new URL('https://www.google.com/search');
  google.searchParams.set('q', `${name} investment philosophy business strategy portfolio`);
  const news = new URL('https://news.google.com/rss/search');
  news.searchParams.set('q', `${name} company investments strategy market`);
  news.searchParams.set('hl', 'en-US');
  news.searchParams.set('gl', 'US');
  news.searchParams.set('ceid', 'US:en');
  return {
    name,
    slug,
    archetype: 'self-researched-personality-agent',
    summary: `${name} agent profile generated from autonomous source discovery. The system will crawl attached search/news URLs and refine the model as evidence is collected.`,
    style: ['evidence-seeking', 'adaptive', 'debate-ready'],
    sourceUrls: [google.toString(), news.toString()],
    bias: {
      sectors: { software: 0.08, ai: 0.08, financials: 0.04, energy: 0.04 },
      factors: { evidenceQuality: 0.22, momentum: 0.12, moat: 0.12, riskPenalty: 0.10 },
      watchSymbols: ['SPY', 'QQQ'],
    },
  };
}

function recommendForAgent(agent, signals, context = {}) {
  const candidates = signals.length ? signals : fallbackSignals(agent);
  return candidates
    .map((signal) => scoreSignalForAgent(agent, signal, context))
    .sort((a, b) => b.conviction - a.conviction)
    .slice(0, 5)
    .map((scored, index) => {
      const action = pickAction(scored, index);
      return {
        agentId: agent.id,
        symbol: scored.symbol,
        action,
        conviction: scored.conviction,
        rationale: `${agent.name} bias ${action.toUpperCase()} on ${scored.symbol}: ${scored.reason}`,
        evidence: {
          agent: summarizeAgent(agent),
          signal: scored.signal,
          biasScore: scored.biasScore,
          localAiScore: scored.signal.localAiScore,
          challengePoints: scored.challengePoints,
          decisionTree: scored.decisionTree,
          decisionObject: scored.decisionTree.decision,
        },
      };
    });
}

function scoreSignalForAgent(agent, signal, context = {}) {
  const bias = agent.bias || {};
  const sectors = bias.sectors || {};
  const factors = bias.factors || {};
  const theme = String(signal.theme || '').toLowerCase();
  const symbol = signal.symbol;
  let biasScore = 0;
  for (const [sector, weight] of Object.entries(sectors)) {
    if (theme.includes(sector.toLowerCase()) || symbolMatchesSector(symbol, sector)) biasScore += Number(weight) * 100;
  }
  if ((bias.watchSymbols || []).includes(symbol)) biasScore += 12;
  const local = Number(signal.localAiScore ?? 50);
  const momentum = Number(signal.changePct || 0) > 1 ? 8 : Number(signal.changePct || 0) < -1 ? -8 : 0;
  const volatility = Number(signal.volatilityPct || 0);
  const volatilityTerm = (factors.volatilityTolerance || 0) * volatility * 4 - (factors.volatilityPenalty || 0) * volatility * 4;
  const quality = (factors.moat || factors.quality || 0) * local;
  const decisionTree = agentDecisionTree.evaluateSignalForAgent({
    agent,
    signal,
    context,
    personaBiasScore: biasScore,
  });
  const conviction = clamp(Math.round(decisionTree.convictionBase + biasScore * 0.15 + momentum * 0.25 + volatilityTerm * 0.2 + quality * 0.08), 0, decisionTree.hardFailures.length ? 44 : 100);
  const challengePoints = [];
  if (volatility > 4 && !(factors.volatilityTolerance > 0.1)) challengePoints.push('Volatility may exceed this agent risk style.');
  if (local < 45) challengePoints.push('Local Brain score is weak, so recommendation should face council challenge.');
  if (biasScore < 5) challengePoints.push('Symbol is outside the agent preferred domain.');
  for (const failure of decisionTree.hardFailures) challengePoints.push(`Decision-tree hard gate failed: ${failure}.`);
  for (const warning of decisionTree.warnings.slice(0, 3)) challengePoints.push(`Decision-tree warning: ${warning}`);
  return {
    symbol,
    signal,
    conviction,
    recommendedAction: decisionTree.recommendedAction,
    biasScore: Number(biasScore.toFixed(2)),
    challengePoints,
    decisionTree,
    reason: `conviction ${conviction}/100 after ${agentDecisionTree.VERSION}; tree recommends ${decisionTree.recommendedAction}, local score ${local}, theme ${signal.theme || 'n/a'}, bias score ${biasScore.toFixed(1)}, margin of safety ${decisionTree.valuation.marginOfSafety}.`,
  };
}

function buildDebateRounds(agents, recommendations) {
  const bySymbol = new Map();
  for (const rec of recommendations) {
    const list = bySymbol.get(rec.symbol) || [];
    list.push(rec);
    bySymbol.set(rec.symbol, list);
  }
  const debates = [];
  for (const [symbol, recs] of bySymbol.entries()) {
    const actions = new Set(recs.map((rec) => rec.action));
    const top = [...recs].sort((a, b) => b.conviction - a.conviction)[0];
    const skeptic = agents.find((agent) => agent.id !== top.agentId && hasRiskPenalty(agent)) || agents.find((agent) => agent.id !== top.agentId);
    if (!skeptic) continue;
    if (actions.size > 1 || top.conviction < 68 || top.evidence.challengePoints?.length) {
      const challengerRec = recs.find((rec) => rec.agentId === skeptic.id);
      debates.push({
        symbol,
        targetAction: top.action,
        targetAgentId: top.agentId,
        targetBrainId: agents.find((agent) => agent.id === top.agentId)?.brain_id,
        targetConviction: top.conviction,
        challengerAgentId: skeptic.id,
        challengerBrainId: skeptic.brain_id,
        challengerConviction: challengerRec ? challengerRec.conviction : null,
        challenge: `${skeptic.name} challenges ${symbol}: ${top.evidence.challengePoints?.[0] || top.evidence.decisionTree?.warnings?.[0] || 'council requires stronger cross-agent evidence before consensus.'}`,
        alternative: top.action === 'buy' ? 'watch' : 'hold',
      });
    }
  }
  return debates.slice(0, 12);
}

function buildConsensus(recommendations, agents, challengeOutcomes = new Map()) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const grouped = new Map();
  for (const rec of recommendations) {
    const item = grouped.get(rec.symbol) || { symbol: rec.symbol, votes: [], score: 0 };
    const actionWeight = rec.action === 'buy' ? 1 : rec.action === 'watch' ? 0.4 : rec.action === 'sell' ? -1 : 0;
    const learningWeight = Number(agentById.get(rec.agentId)?.model?.learningWeight ?? 1);
    const challengeMultiplier = challengeOutcomes.get(`${rec.agentId}:${rec.symbol}`) ?? 1;
    item.score += actionWeight * rec.conviction * learningWeight * challengeMultiplier;
    item.votes.push({
      agentId: rec.agentId,
      agentName: agents.find((agent) => agent.id === rec.agentId)?.name,
      action: rec.action,
      conviction: rec.conviction,
      rationale: rec.rationale,
    });
    grouped.set(rec.symbol, item);
  }
  const finalRecommendations = [...grouped.values()]
    .map((item) => {
      const buyVotes = item.votes.filter((vote) => vote.action === 'buy');
      const sellVotes = item.votes.filter((vote) => vote.action === 'sell');
      const avgConviction = Math.round(item.votes.reduce((sum, vote) => sum + vote.conviction, 0) / item.votes.length);
      const action = item.score > 90 && buyVotes.length >= 2 ? 'buy' : item.score < -45 || sellVotes.length >= 2 ? 'sell' : 'watch';
      return {
        symbol: item.symbol,
        action,
        consensusScore: Math.round(item.score),
        avgConviction,
        supportingAgents: item.votes.filter((vote) => vote.action === action || (action === 'watch' && vote.action !== 'sell')).map((vote) => vote.agentName),
        decisionFrameworkVersion: agentDecisionTree.VERSION,
        votes: item.votes,
      };
    })
    .sort((a, b) => b.consensusScore - a.consensusScore)
    .slice(0, 10);
  return {
    generatedAt: new Date().toISOString(),
    agentCount: agents.length,
    recommendationCount: recommendations.length,
    finalRecommendations,
    operatingMode: 'simulation-council',
    decisionFrameworkVersion: agentDecisionTree.VERSION,
    decisionFramework: agentDecisionTree.buildDecisionFramework({}),
    disclaimer: 'Agent recommendations are simulated strategy opinions. They do not mean the named public figures made or endorsed any trade.',
  };
}

const LOCAL_LEARNING_MAX_DELTA = 0.05;

// Opt-in, off by default: asks whichever AI provider is configured (including a local
// Ollama fallback) for small bias nudges based on this council run's outcome, so agents
// incrementally adapt between the expensive nightly full persona refreshes.
async function applyLocalLearningPass({ userId, agents, allRecommendations, consensus, onEvent = () => {} }) {
  const providers = aiClient.buildProviders(userId);
  const systemPrompt = `You tune small numeric bias weights for simulated trading personas based on a council debate outcome. Respond with strict JSON only. Personality agents can ask ${OLLAMA_BRAIN_ID} over BMCL for reasoning, research interpretation, analysis, and self-improvement support when they need local LLM help.`;
  const userPrompt = JSON.stringify({
    instructions: 'Given these agent recommendations and the consensus outcome, propose small bias adjustments (delta between -0.05 and 0.05) for agents whose thesis was strongly confirmed or contradicted. Respond as {"biasAdjustments": [{"agentId": string, "sectorOrFactor": string, "delta": number, "rationale": string}]}. Return at most 5 adjustments.',
    bmclLocalAi: buildOllamaCollaborationGuidance(),
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      brainId: agent.brain_id,
      bias: agent.bias,
      localAiCollaboration: agent.persona?.localAiCollaboration || buildOllamaCollaborationGuidance(),
    })),
    recommendations: allRecommendations.map(stripRecommendationForFrame),
    consensus: { finalRecommendations: consensus.finalRecommendations },
  });

  const result = await aiClient.requestStructuredCompletion({ providers, systemPrompt, userPrompt, onEvent });
  const adjustments = Array.isArray(result?.parsed?.biasAdjustments) ? result.parsed.biasAdjustments : [];

  for (const adjustment of adjustments) {
    const agent = agents.find((candidate) => candidate.id === adjustment.agentId);
    if (!agent || !adjustment.sectorOrFactor) continue;
    const delta = clamp(Number(adjustment.delta) || 0, -LOCAL_LEARNING_MAX_DELTA, LOCAL_LEARNING_MAX_DELTA);
    if (!delta) continue;

    const key = adjustment.sectorOrFactor;
    const bucket = agent.bias?.sectors && key in agent.bias.sectors ? 'sectors' : 'factors';
    const current = Number(agent.bias?.[bucket]?.[key] ?? 0);
    const nextBias = {
      ...agent.bias,
      [bucket]: { ...(agent.bias?.[bucket] || {}), [key]: Number((current + delta).toFixed(4)) },
    };
    updateAgent(userId, agent.id, { bias: nextBias });
  }
}

function ensureDecisionFramework(agent) {
  if (agent.model?.decisionFrameworkVersion === agentDecisionTree.VERSION && agent.model?.decisionFramework) return agent;
  return tradingAgentRepo.updateAgent(agent.user_id, agent.id, {
    model: {
      ...(agent.model || {}),
      decisionFrameworkVersion: agentDecisionTree.VERSION,
      decisionFramework: agentDecisionTree.buildDecisionFramework(agent),
    },
  }) || agent;
}

function ensureAgentRuntimeMetadata(agent) {
  let updated = ensureDecisionFramework(agent);
  updated = ensureAgentOllamaGuidance(updated);
  registerMeshAgent(updated);
  return updated;
}

function ensureAgentOllamaGuidance(agent) {
  if (!agent) return agent;
  const currentPersona = agent.persona || {};
  const currentModel = agent.model || {};
  const collaboration = currentPersona.localAiCollaboration || {};
  const bmcl = currentModel.bmcl || {};
  const hasPersonaGuidance = collaboration.brainId === OLLAMA_BRAIN_ID
    && OLLAMA_BMCL_OPS.every((op) => (collaboration.supportedOps || []).includes(op));
  const hasModelGuidance = bmcl.primaryLocalLlmBrainId === OLLAMA_BRAIN_ID
    && OLLAMA_BMCL_OPS.every((op) => (bmcl.requestOps || bmcl.canAsk || []).includes(op));
  if (hasPersonaGuidance && hasModelGuidance) return agent;

  return tradingAgentRepo.updateAgent(agent.user_id, agent.id, {
    persona: {
      ...currentPersona,
      localAiCollaboration: buildOllamaCollaborationGuidance(currentPersona.localAiCollaboration),
    },
    model: {
      ...currentModel,
      bmcl: buildOllamaBmclModelGuidance(currentModel.bmcl),
    },
  }) || agent;
}

function buildOllamaCollaborationGuidance(existing = {}) {
  return {
    ...existing,
    brainId: OLLAMA_BRAIN_ID,
    protocol: 'BMCL/1.0',
    transport: 'brainMesh.ask',
    supportedOps: OLLAMA_BMCL_OPS,
    useFor: {
      reasoning: 'Ask llm.reason for evidence-based causal reasoning before strengthening or weakening a thesis.',
      research: 'Ask llm.research.assist to interpret crawler/news/page evidence, identify gaps, and suggest source or candidate hints.',
      analysis: 'Ask llm.analysis.assist for compact analysis of company, macro, risk, and agent-council evidence.',
      selfImprovement: 'Ask llm.training.suggest for feature, label, memory, and bias-tuning suggestions after evaluations.',
    },
    guardrails: [
      'Do not place trades through BMCL.',
      'Do not send credentials or secrets.',
      'Keep requests compact, auditable, and based on supplied evidence or approved research tools.',
    ],
  };
}

function buildOllamaBmclModelGuidance(existing = {}) {
  return {
    ...existing,
    protocol: 'BMCL/1.0',
    primaryLocalLlmBrainId: OLLAMA_BRAIN_ID,
    requestOps: OLLAMA_BMCL_OPS,
    canAsk: OLLAMA_BMCL_OPS,
    conversationPattern: {
      reasoning: { to: [OLLAMA_BRAIN_ID], op: 'llm.reason' },
      research: { to: [OLLAMA_BRAIN_ID], op: 'llm.research.assist' },
      analysis: { to: [OLLAMA_BRAIN_ID], op: 'llm.analysis.assist' },
      selfImprovement: { to: [OLLAMA_BRAIN_ID], op: 'llm.training.suggest' },
    },
  };
}

function persistAgentSources(userId, agent) {
  for (const url of agent.sourceUrls || []) {
    researchSourceRepo.upsert({
      userId,
      url,
      title: `${agent.name} personality source`,
      sourceType: 'learned',
      discoveryMethod: `personality-agent:${agent.slug}`,
      tags: ['personality-agent', agent.slug].slice(0, 8),
      relevanceScore: 68,
      credibilityScore: 58,
      notes: `Source attached to ${agent.name} personality model.`,
    });
  }
}

function registerMeshAgent(agent) {
  const localAiCollaboration = agent.persona?.localAiCollaboration || buildOllamaCollaborationGuidance();
  brainMesh.registerAgent({
    id: agent.brain_id,
    userId: null,
    role: 'personality-trading-agent',
    capabilities: ['agent.thesis.proposed', 'agent.challenge.raised', 'agent.vote.cast', 'mesh.status', 'bmcl.ask.ollama'],
    metadata: {
      name: agent.name,
      sharedPersonaSlug: agent.slug,
      sharedAcrossUsers: true,
      archetype: agent.persona?.archetype,
      localAiCollaboration,
      userScopedState: 'trading_agents rows store per-user status, bias, source URLs, workspace history, and council recommendations; BMCL brain identity is shared by slug.',
    },
  });
}

function fallbackSignals(agent) {
  return (agent.bias?.watchSymbols || ['SPY', 'QQQ']).map((symbol) => ({
    symbol,
    localAiScore: 50,
    changePct: 0,
    volatilityPct: 1,
    theme: 'agent-watchlist',
    price: 0,
  }));
}

function stripRecommendationForFrame(rec) {
  return {
    symbol: rec.symbol,
    action: rec.action,
    conviction: rec.conviction,
    rationale: rec.rationale,
    challengePoints: rec.evidence?.challengePoints || [],
  };
}

function summarizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    brainId: agent.brain_id,
    archetype: agent.persona?.archetype,
    style: agent.persona?.style || [],
    localAiCollaboration: agent.persona?.localAiCollaboration || buildOllamaCollaborationGuidance(),
  };
}

function hasRiskPenalty(agent) {
  return (agent.bias?.factors?.riskPenalty || agent.bias?.factors?.volatilityPenalty || 0) > 0;
}

function pickAction(scored, index) {
  if (scored.recommendedAction === 'buy') return index <= 4 ? 'buy' : 'watch';
  if (scored.recommendedAction === 'sell') return 'sell';
  if (scored.recommendedAction === 'watch') return 'watch';
  if (scored.conviction >= 72 && index <= 2) return 'buy';
  if (scored.conviction <= 28) return 'sell';
  if (scored.conviction >= 55) return 'watch';
  return 'hold';
}

function symbolMatchesSector(symbol, sector) {
  const map = {
    software: ['MSFT', 'CRM', 'NOW', 'SHOP', 'SNOW', 'PLTR'],
    semiconductors: ['NVDA', 'AMD', 'TSM', 'AVGO', 'SOXX'],
    cloud: ['AMZN', 'MSFT', 'GOOGL', 'ORCL'],
    ai: ['NVDA', 'MSFT', 'GOOGL', 'PLTR', 'AMD', 'TSLA'],
    ev: ['TSLA'],
    energy: ['XOM', 'CVX', 'COP', 'SLB', 'XLE'],
    defense: ['LMT', 'RTX', 'NOC', 'GD', 'ITA', 'PLTR'],
    healthcare: ['LLY', 'NVO', 'PFE', 'MRK', 'JNJ', 'UNH'],
    ecommerce: ['AMZN', 'SHOP', 'WMT'],
    logistics: ['AMZN', 'UBER', 'FDX', 'UPS'],
    financials: ['JPM', 'BAC', 'GS', 'XLF', 'V', 'MA'],
    media: ['DIS', 'NFLX', 'META', 'DJT'],
  };
  return (map[sector] || []).includes(symbol);
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function objectOrExisting(value, existing) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : existing;
}

function normalizeUrls(urls) {
  return [...new Set((urls || []).map((url) => String(url || '').trim()).filter(Boolean))].slice(0, 100);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

// Registered eagerly at module load (not just inside runCouncil) so agent.profile.ready
// has a live handler even if a persona research run completes before the first council tick.
ensureModeratorRegistered();
ensureSourceCredibilityHandlerRegistered();

module.exports = {
  DEFAULT_PERSONAS,
  ensureDefaultAgents,
  listAgents,
  createAgent,
  createAgentFromProfile,
  startResearchCreateAgent,
  getResearchCreateRun,
  refreshAgentPersonalities,
  updateAgent,
  deleteAgent,
  exportAgent,
  importAgent,
  runCouncil,
  listCouncilRuns,
  buildConsensus,
};
