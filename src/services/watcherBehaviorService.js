const webScrapeClient = require('./marketData/webScrapeClient');
const evaluationService = require('./evaluationService');
const watcherAgentRepo = require('../db/repositories/watcherAgentRepo');
const companyIntelligenceRepo = require('../db/repositories/companyIntelligenceRepo');
const brainMesh = require('./brainMeshService');
const logger = require('../utils/logger');

const BEHAVIOR_AGENT_ID = 'agent.behavior.supervisor';
const GRADE_HISTORY_LIMIT = 20;

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
  return grades;
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
};
