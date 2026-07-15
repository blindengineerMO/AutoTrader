const pLimit = require('p-limit');
const watcherAgentRepo = require('../db/repositories/watcherAgentRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const brainMesh = require('./brainMeshService');
const companyIntelligence = require('./companyIntelligenceService');
const webScrapeClient = require('./marketData/webScrapeClient');
const evaluationService = require('./evaluationService');
const logger = require('../utils/logger');

const PRICE_TIER_THRESHOLD = 20;
const DEFAULT_CONCURRENCY = 5;
const TOP_LEVEL_RESEARCH_AGENT = 'agent.research.top-level';
const MAX_SIBLING_CHATS_PER_AGENT = 3;
const TRAINING_BACKFILL_DAYS = 30;

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

function ensureWatcherAgent(userId, { symbol, companyName, price, theme } = {}) {
  if (!userId) throw new Error('userId is required to ensure a watcher agent');
  if (!symbol) throw new Error('symbol is required to ensure a watcher agent');
  if (settingsRepo.isSymbolExcluded(userId, symbol)) {
    logger.info('Skipping watcher creation for excluded symbol', { userId, symbol });
    return null;
  }

  const priceTier = classifyPriceTier(price);
  const brainId = brainIdForSymbol(symbol);

  const watcherAgent = watcherAgentRepo.upsertAgent({
    userId,
    symbol,
    companyName,
    brainId,
    priceTier,
    theme,
  });

  brainMesh.registerAgent({
    id: brainId,
    userId,
    role: 'company-watcher',
    capabilities: ['watcher.research', 'watcher.chat'],
    status: 'online',
    metadata: { symbol, priceTier, theme: watcherAgent.theme },
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

  const candidates = [{ symbol: watcherAgent.symbol, companyName: watcherAgent.company_name, theme: watcherAgent.theme || 'watcher', themeHits: 0 }];
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
  const learningWeight = watcherAgent.learning_weight ?? 1;
  const localAiScore = Math.round(signal.localAiScore * learningWeight) + peerConvictionNudge;

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
      learningWeight,
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
  const siblings = allWatcherAgents.filter((other) => other.id !== watcherAgent.id);
  const theme = watcherAgent.theme || 'general';
  const sameTheme = theme === 'general' ? [] : siblings.filter((other) => other.theme === theme);
  const others = siblings.filter((other) => !sameTheme.includes(other));
  const targets = [...sameTheme, ...others].slice(0, MAX_SIBLING_CHATS_PER_AGENT);

  for (const sibling of targets) {
    brainMesh.tell({
      from: watcherAgent.brain_id,
      to: sibling.brain_id,
      kind: 'event',
      op: 'watcher.research.shared',
      ctx: { userId },
      body: {
        symbol: watcherAgent.symbol,
        theme,
        sameTheme: sibling.theme === theme,
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

async function runThirtyDayTrainingBackfill(userId, {
  force = false,
  days = TRAINING_BACKFILL_DAYS,
  quoteProvider = webScrapeClient,
  concurrency = 2,
} = {}) {
  const settings = settingsRepo.get(userId);
  if (!force && settings?.watcher_training_backfill_30d_completed_at) {
    return {
      ran: false,
      reason: 'already-completed',
      completedAt: settings.watcher_training_backfill_30d_completed_at,
    };
  }

  const allWatcherAgents = watcherAgentRepo.listActiveByUser(userId);
  if (!allWatcherAgents.length) return { ran: false, reason: 'no-watchers' };

  const limit = pLimit(concurrency);
  const settled = await Promise.all(
    allWatcherAgents.map((agent) => limit(() => backfillOneWatcher(userId, agent, { days, quoteProvider })))
  );
  const summaries = settled.filter(Boolean);
  const generatedRuns = summaries.reduce((sum, item) => sum + item.runsCreated, 0);
  const gradesCreated = summaries.reduce((sum, item) => sum + item.gradesCreated, 0);

  const watcherBehavior = require('./watcherBehaviorService');
  const learningUpdates = watcherBehavior.updateWatcherLearningWeights(userId);
  if (!force) settingsRepo.markWatcherTrainingBackfill30d(userId);

  brainMesh.tell({
    from: 'agent.behavior.supervisor',
    to: TOP_LEVEL_RESEARCH_AGENT,
    kind: 'event',
    op: 'watcher.training.backfill.completed',
    ctx: { userId },
    body: {
      days,
      watcherCount: allWatcherAgents.length,
      generatedRuns,
      gradesCreated,
      learningUpdates: learningUpdates.length,
      forced: Boolean(force),
    },
  });

  return {
    ran: true,
    forced: Boolean(force),
    days,
    watcherCount: allWatcherAgents.length,
    generatedRuns,
    gradesCreated,
    learningUpdates,
    summaries,
  };
}

async function backfillOneWatcher(userId, watcherAgent, { days, quoteProvider }) {
  try {
    const closes = await quoteProvider.getDailyCloses(watcherAgent.symbol, '2mo');
    const usable = (closes || []).filter((value) => Number.isFinite(Number(value))).map(Number);
    if (usable.length < 4) return { symbol: watcherAgent.symbol, runsCreated: 0, gradesCreated: 0, reason: 'insufficient-history' };
    const window = usable.slice(-(Math.max(4, days + 1)));
    let runsCreated = 0;
    let gradesCreated = 0;
    for (let i = 1; i < window.length - 1; i += 1) {
      const previous = window[i - 1];
      const current = window[i];
      const next = window[i + 1];
      const signal = historicalSignalFromCloses(previous, current);
      const runAt = historicalRunAt(window.length - 1 - i);
      const run = watcherAgentRepo.recordResearchRun({
        watcherAgentId: watcherAgent.id,
        userId,
        symbol: watcherAgent.symbol,
        runAt,
        priceAtResearch: current,
        predictedAction: signal.predictedAction,
        localAiScore: signal.localAiScore,
        rationale: {
          source: 'watcher-30d-idle-training-backfill',
          explanation: signal.explanation,
          previousClose: previous,
          currentClose: current,
          trainingWindowDays: days,
        },
      });
      runsCreated += 1;
      const returnPct = current ? ((next - current) / current) * 100 : 0;
      const action = normalizeBackfillAction(signal.predictedAction);
      const outcome = evaluationService.classifyOutcome(action, returnPct);
      watcherAgentRepo.recordGrade({
        watcherAgentId: watcherAgent.id,
        researchRunId: run.id,
        userId,
        symbol: watcherAgent.symbol,
        predictedAction: signal.predictedAction,
        startPrice: current,
        closePrice: next,
        returnPct: Number(returnPct.toFixed(2)),
        verdict: outcome === 'correct' ? 'praise' : 'punish',
        rationale: `30-day idle watcher training backfill: predicted ${signal.predictedAction}; next close moved ${returnPct.toFixed(2)}%.`,
      });
      gradesCreated += 1;
    }
    return { symbol: watcherAgent.symbol, runsCreated, gradesCreated };
  } catch (error) {
    logger.warn('Watcher 30-day training backfill failed for symbol', { userId, symbol: watcherAgent.symbol, error: error.message });
    return { symbol: watcherAgent.symbol, runsCreated: 0, gradesCreated: 0, reason: 'error', error: error.message };
  }
}

function historicalSignalFromCloses(previous, current) {
  const changePct = previous ? ((current - previous) / previous) * 100 : 0;
  if (changePct >= 0.75) {
    return {
      predictedAction: 'buy-candidate',
      localAiScore: Math.min(92, Math.round(62 + Math.min(changePct, 5) * 6)),
      explanation: `Historical close momentum was bullish at ${changePct.toFixed(2)}%.`,
    };
  }
  if (changePct <= -0.75) {
    return {
      predictedAction: 'sell-or-avoid',
      localAiScore: Math.max(8, Math.round(38 + Math.max(changePct, -5) * 6)),
      explanation: `Historical close momentum was bearish at ${changePct.toFixed(2)}%.`,
    };
  }
  return {
    predictedAction: 'hold-watch',
    localAiScore: 50,
    explanation: `Historical close momentum was neutral at ${changePct.toFixed(2)}%.`,
  };
}

function normalizeBackfillAction(predictedAction) {
  if (predictedAction === 'buy-candidate') return 'buy';
  if (predictedAction === 'sell-or-avoid') return 'sell';
  return 'hold';
}

function historicalRunAt(daysAgo) {
  const date = new Date(Date.now() - Number(daysAgo || 0) * 24 * 60 * 60 * 1000);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = {
  PRICE_TIER_THRESHOLD,
  DEFAULT_CONCURRENCY,
  TOP_LEVEL_RESEARCH_AGENT,
  TRAINING_BACKFILL_DAYS,
  classifyPriceTier,
  brainIdForSymbol,
  ensureWatcherAgent,
  researchOneAgent,
  chatWithSiblingWatchers,
  runWatcherCycle,
  runThirtyDayTrainingBackfill,
};
