const webScrapeClient = require('./marketData/webScrapeClient');
const evaluationService = require('./evaluationService');
const watcherAgentRepo = require('../db/repositories/watcherAgentRepo');
const companyIntelligenceRepo = require('../db/repositories/companyIntelligenceRepo');
const brainMesh = require('./brainMeshService');
const logger = require('../utils/logger');

const BEHAVIOR_AGENT_ID = 'agent.behavior.supervisor';
const GRADE_HISTORY_LIMIT = 20;
const MIN_GRADES_FOR_LEARNING = 3;
const LEARNING_ACCURACY_UP = 0.6;
const LEARNING_ACCURACY_DOWN = 0.4;
const LEARNING_WEIGHT_STEP = 0.1;
const LEARNING_WEIGHT_MIN = 0.5;
const LEARNING_WEIGHT_MAX = 1.5;

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeAction(predictedAction) {
  if (predictedAction === 'buy-candidate') return 'buy';
  if (predictedAction === 'sell-or-avoid') return 'sell';
  return 'hold';
}

function verdictFromOutcome(outcome) {
  return outcome === 'correct' ? 'praise' : 'punish';
}

async function runDailyGrading(userId, { tradingDay = todayIsoDate() } = {}) {
  const ungraded = watcherAgentRepo.listUngradedRunsForUser(userId, tradingDay);
  if (!ungraded.length) return [];

  const symbols = [...new Set(ungraded.map((run) => run.symbol))];
  const quotes = await webScrapeClient.getQuotes(symbols);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));

  const grades = [];
  for (const run of ungraded) {
    try {
      const grade = gradeResearchRun(userId, run, quoteBySymbol);
      if (grade) grades.push(grade);
    } catch (error) {
      logger.error('Failed to grade watcher research run', { userId, runId: run.id, symbol: run.symbol, error: error.message });
    }
  }

  try {
    updateWatcherLearningWeights(userId);
  } catch (error) {
    logger.warn('Failed to update watcher learning weights', { userId, error: error.message });
  }

  return grades;
}

function updateWatcherLearningWeights(userId) {
  const updates = [];
  for (const watcherAgent of watcherAgentRepo.listActiveByUser(userId)) {
    const scorecard = watcherAgentRepo.getScorecard(watcherAgent.id);
    const graded = (scorecard?.praiseCount || 0) + (scorecard?.punishCount || 0);
    if (graded < MIN_GRADES_FOR_LEARNING) continue;

    const accuracy = scorecard.praiseCount / graded;
    let weight = watcherAgent.learning_weight ?? 1;
    if (accuracy >= LEARNING_ACCURACY_UP) weight *= 1 + LEARNING_WEIGHT_STEP;
    else if (accuracy <= LEARNING_ACCURACY_DOWN) weight *= 1 - LEARNING_WEIGHT_STEP;
    else continue;
    weight = Math.min(LEARNING_WEIGHT_MAX, Math.max(LEARNING_WEIGHT_MIN, Number(weight.toFixed(4))));
    if (weight === watcherAgent.learning_weight) continue;

    watcherAgentRepo.updateLearningWeight(watcherAgent.id, weight);
    updates.push({ watcherAgentId: watcherAgent.id, symbol: watcherAgent.symbol, weight, accuracy });
    brainMesh.tell({
      from: BEHAVIOR_AGENT_ID,
      to: watcherAgent.brain_id,
      kind: 'event',
      op: 'watcher.learning.updated',
      ctx: { userId },
      body: { symbol: watcherAgent.symbol, learningWeight: weight, accuracy: Number(accuracy.toFixed(3)), graded },
    });
  }
  return updates;
}

function gradeResearchRun(userId, run, quoteBySymbol) {
  const watcherAgent = watcherAgentRepo.getById(userId, run.watcher_agent_id);
  if (!watcherAgent) {
    watcherAgentRepo.markGraded(run.id);
    return null;
  }

  const closeQuote = quoteBySymbol.get(run.symbol);
  const startPrice = Number(run.price_at_research || 0);
  const closePrice = Number(closeQuote?.current || startPrice || 0);
  const returnPct = startPrice ? ((closePrice - startPrice) / startPrice) * 100 : 0;
  const outcome = evaluationService.classifyOutcome(normalizeAction(run.predicted_action), returnPct);
  const verdict = verdictFromOutcome(outcome);
  const rationale = `Predicted ${run.predicted_action}; realized ${returnPct.toFixed(2)}% move from research to close (${outcome} within margin).`;

  const grade = watcherAgentRepo.recordGrade({
    watcherAgentId: watcherAgent.id,
    researchRunId: run.id,
    userId,
    symbol: run.symbol,
    predictedAction: run.predicted_action,
    startPrice,
    closePrice,
    returnPct: Number(returnPct.toFixed(2)),
    verdict,
    rationale,
  });

  postGradeToWatcher(userId, watcherAgent, grade);
  pushFindingToCompanyIntelligence(userId, watcherAgent, grade);
  return grade;
}

function postGradeToWatcher(userId, watcherAgent, grade) {
  brainMesh.tell({
    from: BEHAVIOR_AGENT_ID,
    to: watcherAgent.brain_id,
    kind: 'event',
    op: 'watcher.grade.issued',
    ctx: { userId },
    body: {
      symbol: grade.symbol,
      verdict: grade.verdict,
      returnPct: grade.return_pct,
      predictedAction: grade.predicted_action,
      rationale: grade.rationale,
    },
  });
}

function pushFindingToCompanyIntelligence(userId, watcherAgent, grade) {
  const existing = companyIntelligenceRepo.getBySymbol(userId, grade.symbol);
  const summary = existing?.summary || { symbol: grade.symbol };
  const watcherGradeHistory = Array.isArray(summary.watcherGradeHistory) ? summary.watcherGradeHistory : [];
  watcherGradeHistory.push({
    verdict: grade.verdict,
    returnPct: grade.return_pct,
    predictedAction: grade.predicted_action,
    gradedAt: grade.graded_at,
  });
  companyIntelligenceRepo.save({
    userId,
    symbol: grade.symbol,
    companyName: existing?.company_name || watcherAgent.company_name,
    summary: { ...summary, watcherGradeHistory: watcherGradeHistory.slice(-GRADE_HISTORY_LIMIT) },
  });
}

module.exports = {
  BEHAVIOR_AGENT_ID,
  runDailyGrading,
  updateWatcherLearningWeights,
};
