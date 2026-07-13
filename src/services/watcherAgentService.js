const pLimit = require('p-limit');
const watcherAgentRepo = require('../db/repositories/watcherAgentRepo');
const brainMesh = require('./brainMeshService');
const companyIntelligence = require('./companyIntelligenceService');
const logger = require('../utils/logger');

const PRICE_TIER_THRESHOLD = 20;
const DEFAULT_CONCURRENCY = 5;
const TOP_LEVEL_RESEARCH_AGENT = 'agent.research.top-level';
const MAX_SIBLING_CHATS_PER_AGENT = 3;

// Lazy require avoids a circular-require deadlock: autonomousResearchService
// requires this module (to call ensureWatcherAgent per discovered symbol),
// so this module cannot require autonomousResearchService at the top level.
function autonomousResearch() {
  return require('./autonomousResearchService');
}

function classifyPriceTier(price) {
  if (price === null || price === undefined || price === '') return 'standard';
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) return 'standard';
  return numericPrice < PRICE_TIER_THRESHOLD ? 'priority' : 'standard';
}

function brainIdForSymbol(symbol) {
  return `agent.watcher.${String(symbol).toLowerCase()}`;
}

function ensureWatcherAgent(userId, { symbol, companyName, price } = {}) {
  if (!userId) throw new Error('userId is required to ensure a watcher agent');
  if (!symbol) throw new Error('symbol is required to ensure a watcher agent');

  const priceTier = classifyPriceTier(price);
  const brainId = brainIdForSymbol(symbol);

  const watcherAgent = watcherAgentRepo.upsertAgent({
    userId,
    symbol,
    companyName,
    brainId,
    priceTier,
  });

  brainMesh.registerAgent({
    id: brainId,
    userId,
    role: 'company-watcher',
    capabilities: ['watcher.research', 'watcher.chat'],
    status: 'online',
    metadata: { symbol, priceTier },
  });

  brainMesh.registerHandler(brainId, 'watcher.research.shared', (envelope) => {
    watcherAgentRepo.recordPeerSignal(watcherAgent.id, envelope.body);
    return { acknowledged: true };
  });

  return watcherAgent;
}

function isDueThisCycle(watcherAgent, cycleIndex) {
  if (watcherAgent.price_tier === 'priority') return true;
  return cycleIndex % 2 === 0;
}

async function researchOneAgent(userId, watcherAgent) {
  const research = autonomousResearch();
  const quotes = await research.collectQuotes([watcherAgent.symbol], { userId, onEvent: () => {} });
  const quote = quotes.find((q) => q.symbol === watcherAgent.symbol);
  if (!quote) {
    logger.warn('Watcher cycle skipped symbol with no quote available', { userId, symbol: watcherAgent.symbol });
    return null;
  }

  const candidates = [{ symbol: watcherAgent.symbol, companyName: watcherAgent.company_name, theme: 'watcher', themeHits: 0 }];
  const companyIntel = await companyIntelligence.researchCompanies({
    userId,
    candidates,
    macro: { riskBias: 'neutral' },
    consumer: { consumerBias: 'neutral' },
    quotes,
    onEvent: () => {},
  });

  const [signal] = research.scoreCandidates({
    userId,
    candidates,
    quotes,
    news: { items: [] },
    macro: { riskBias: 'neutral' },
    consumer: { consumerBias: 'neutral' },
    learned: { observations: [] },
    companyIntel,
    jsonDatasets: [],
    onEvent: () => {},
  });
  if (!signal) return null;

  ensureWatcherAgent(userId, { symbol: watcherAgent.symbol, companyName: watcherAgent.company_name, price: signal.price });

  const peerSignals = watcherAgentRepo.listPeerSignals(watcherAgent.id);
  const bullishSiblings = peerSignals.filter((peer) => peer.predictedAction === 'buy').length;
  const bearishSiblings = peerSignals.filter((peer) => peer.predictedAction === 'sell').length;
  const peerConvictionNudge = bullishSiblings >= 2 ? 4 : bearishSiblings >= 2 ? -4 : 0;
  const localAiScore = signal.localAiScore + peerConvictionNudge;

  const run = watcherAgentRepo.recordResearchRun({
    watcherAgentId: watcherAgent.id,
    userId,
    symbol: watcherAgent.symbol,
    priceAtResearch: signal.price,
    predictedAction: signal.actionBias,
    localAiScore,
    rationale: {
      explanation: signal.evidence.explanation,
      theme: signal.theme,
      priceTierBonusApplied: signal.priceTierBonusApplied,
      peerConvictionNudge,
      bullishSiblings,
      bearishSiblings,
    },
  });

  reportToTopLevelAgent(userId, watcherAgent, run, signal);
  return run;
}

function reportToTopLevelAgent(userId, watcherAgent, run, signal) {
  brainMesh.tell({
    from: watcherAgent.brain_id,
    to: TOP_LEVEL_RESEARCH_AGENT,
    kind: 'event',
    op: 'watcher.research.reported',
    ctx: { userId },
    body: {
      symbol: watcherAgent.symbol,
      predictedAction: run.predicted_action,
      localAiScore: run.local_ai_score,
      priceAtResearch: run.price_at_research,
      priceTier: watcherAgent.price_tier,
      rationale: run.rationale,
      theme: signal.theme,
    },
  });
}

function chatWithSiblingWatchers(userId, watcherAgent, run, allWatcherAgents) {
  // No per-agent theme/sector tagging exists on watcher_agents yet, so this
  // shares research with a small capped set of other active watchers rather
  // than targeting a true sector/theme match — tightened once that data exists.
  const targets = allWatcherAgents
    .filter((other) => other.id !== watcherAgent.id)
    .slice(0, MAX_SIBLING_CHATS_PER_AGENT);

  for (const sibling of targets) {
    brainMesh.tell({
      from: watcherAgent.brain_id,
      to: sibling.brain_id,
      kind: 'event',
      op: 'watcher.research.shared',
      ctx: { userId },
      body: {
        symbol: watcherAgent.symbol,
        predictedAction: run.predicted_action,
        localAiScore: run.local_ai_score,
        rationale: run.rationale,
      },
    });
  }
}

async function runWatcherCycle(userId, { cycleIndex = 1, concurrency = DEFAULT_CONCURRENCY } = {}) {
  const allWatcherAgents = watcherAgentRepo.listActiveByUser(userId);
  const due = allWatcherAgents.filter((agent) => isDueThisCycle(agent, cycleIndex));
  const limit = pLimit(concurrency);

  const runs = await Promise.all(
    due.map((agent) =>
      limit(async () => {
        try {
          const run = await researchOneAgent(userId, agent);
          if (run) chatWithSiblingWatchers(userId, agent, run, allWatcherAgents);
          return run;
        } catch (error) {
          logger.error('Watcher research cycle failed for symbol', { userId, symbol: agent.symbol, error: error.message });
          return null;
        }
      })
    )
  );

  return runs.filter(Boolean);
}

module.exports = {
  PRICE_TIER_THRESHOLD,
  DEFAULT_CONCURRENCY,
  TOP_LEVEL_RESEARCH_AGENT,
  classifyPriceTier,
  brainIdForSymbol,
  ensureWatcherAgent,
  runWatcherCycle,
};
