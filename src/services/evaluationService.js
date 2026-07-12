const brain = require('brain.js/dist/browser.js');
const researchRepo = require('../db/repositories/researchRepo');
const tradingPlanRepo = require('../db/repositories/tradingPlanRepo');
const decisionReportRepo = require('../db/repositories/decisionReportRepo');
const evaluationReportRepo = require('../db/repositories/evaluationReportRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const webScrapeClient = require('./marketData/webScrapeClient');
const logger = require('../utils/logger');

async function runDailyEvaluation({ userId, reportDate = todayIsoDate(), periodStart, periodEnd } = {}) {
  const end = periodEnd ? new Date(periodEnd) : new Date();
  const start = periodStart ? new Date(periodStart) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const reports = decisionReportRepo.listByUser(userId, 100).filter((report) => {
    const created = parseDbTime(report.created_at);
    return created >= start && created <= end;
  });

  const evaluations = [];
  for (const report of reports) {
    const plan = report.trading_plan_id ? tradingPlanRepo.getById(report.trading_plan_id) : null;
    const snapshot = report.research_snapshot_id ? researchRepo.getById(report.research_snapshot_id) : null;
    if (!plan || !snapshot) continue;
    const symbols = [...new Set((plan.actions || []).map((action) => action.symbol))];
    const quotes = await webScrapeClient.getQuotes(symbols);
    const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
    evaluations.push(evaluatePlan({ report, plan, snapshot, quoteBySymbol }));
  }

  const summary = summarizeEvaluations({ evaluations, start, end });
  updateSourceScores(userId, evaluations, summary);

  const evaluationReport = evaluationReportRepo.create({
    userId,
    reportDate,
    status: 'complete',
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    summary,
  });

  logger.info('Daily evaluation report generated', {
    userId,
    evaluationReportId: evaluationReport.id,
    reportCount: evaluations.length,
  });
  return evaluationReport;
}

function evaluatePlan({ report, plan, snapshot, quoteBySymbol }) {
  const signalBySymbol = new Map((snapshot.signals || []).map((signal) => [signal.symbol, signal]));
  const actionEvaluations = (plan.actions || []).map((action) => {
    const signal = signalBySymbol.get(action.symbol);
    const latestQuote = quoteBySymbol.get(action.symbol);
    const startPrice = Number(signal?.price || 0);
    const endPrice = Number(latestQuote?.current || startPrice || 0);
    const returnPct = startPrice ? ((endPrice - startPrice) / startPrice) * 100 : 0;
    const outcome = classifyOutcome(action.action, returnPct);
    return {
      symbol: action.symbol,
      action: action.action,
      status: action.status,
      rationale: action.rationale,
      startPrice,
      endPrice,
      returnPct: Number(returnPct.toFixed(2)),
      outcome,
      localAiScore: signal?.localAiScore,
      sourceEvidence: signal?.evidence?.explanation || [],
    };
  });

  const correct = actionEvaluations.filter((item) => item.outcome === 'correct').length;
  const incorrect = actionEvaluations.filter((item) => item.outcome === 'incorrect').length;
  const accuracy = actionEvaluations.length ? correct / actionEvaluations.length : 0;
  return {
    decisionReportId: report.id,
    tradingPlanId: plan.id,
    researchSnapshotId: snapshot.id,
    createdAt: report.created_at,
    mode: report.mode,
    modelUsed: plan.model_used,
    researchSource: snapshot.source,
    actionEvaluations,
    accuracy: Number((accuracy * 100).toFixed(1)),
    correct,
    incorrect,
    sourceStack: snapshot.summary?.sourceStack || [],
    prePlan: snapshot.summary?.prePlan || null,
    researchNarrative: snapshot.summary?.reportNarrative || null,
  };
}

function summarizeEvaluations({ evaluations, start, end }) {
  const allActions = evaluations.flatMap((item) => item.actionEvaluations);
  const accuracy = allActions.length
    ? (allActions.filter((item) => item.outcome === 'correct').length / allActions.length) * 100
    : 0;
  const avgReturn = allActions.length ? allActions.reduce((sum, item) => sum + item.returnPct, 0) / allActions.length : 0;
  const mistakes = allActions.filter((item) => item.outcome === 'incorrect').slice(0, 8);
  const winners = allActions
    .filter((item) => item.outcome === 'correct')
    .sort((a, b) => Math.abs(b.returnPct) - Math.abs(a.returnPct))
    .slice(0, 8);
  const selfAssessment = buildSelfAssessment({ accuracy, avgReturn, mistakes, winners });
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    evaluatedDecisionReports: evaluations.length,
    evaluatedActions: allActions.length,
    accuracy: Number(accuracy.toFixed(1)),
    avgObservedReturnPct: Number(avgReturn.toFixed(2)),
    selfAssessment,
    brokerMindset: buildBrokerReflection({ accuracy, avgReturn, mistakes }),
    recommendedAdjustments: recommendAdjustments({ accuracy, avgReturn, mistakes }),
    neuralConfidence: localConfidenceScore({ accuracy, avgReturn, actionCount: allActions.length }),
    decisions: evaluations,
  };
}

function buildSelfAssessment({ accuracy, avgReturn, mistakes, winners }) {
  if (!winners.length && !mistakes.length) {
    return 'No completed decisions were available in the evaluation window, so the engine should keep collecting research before changing course.';
  }
  if (accuracy >= 70 && avgReturn >= 0) {
    return 'The research path is directionally correct: decisions mostly matched observed market movement, so the engine should keep the current source mix while increasing position selectivity.';
  }
  if (accuracy < 45 || avgReturn < -1) {
    return 'The research path needs re-evaluation: observed outcomes did not support enough decisions, so source weights and candidate thresholds should be tightened before committing capital.';
  }
  return 'The research path is mixed: continue simulation-heavy operation, keep high-performing sources, and demand stronger cross-source agreement before buy/sell actions.';
}

function buildBrokerReflection({ accuracy, avgReturn, mistakes }) {
  const mistakeSymbols = mistakes.map((item) => item.symbol).join(', ') || 'none';
  return `Broker review: accuracy ${accuracy.toFixed(1)}%, average observed return ${avgReturn.toFixed(2)}%. Weak calls: ${mistakeSymbols}. Treat capital as scarce, avoid forcing trades, and prefer cash when research conflict is high.`;
}

function recommendAdjustments({ accuracy, avgReturn, mistakes }) {
  const adjustments = [];
  if (accuracy < 55) adjustments.push('Raise buy threshold and require at least two independent source categories before buying.');
  if (avgReturn < 0) adjustments.push('Reduce exposure to high-volatility candidates unless macro and consumer evidence are both constructive.');
  if (mistakes.some((item) => item.action === 'buy')) adjustments.push('Re-check buy candidates against end-of-day momentum before live execution.');
  if (!adjustments.length) adjustments.push('Maintain current strategy, but keep recording source-level outcomes for compounding evidence quality.');
  return adjustments;
}

function localConfidenceScore({ accuracy, avgReturn, actionCount }) {
  const net = new brain.NeuralNetwork({ hiddenLayers: [4] });
  net.train(
    [
      { input: { accuracy: 0.8, avgReturn: 0.7, volume: 0.8 }, output: { confidence: 0.88 } },
      { input: { accuracy: 0.6, avgReturn: 0.55, volume: 0.5 }, output: { confidence: 0.62 } },
      { input: { accuracy: 0.4, avgReturn: 0.45, volume: 0.5 }, output: { confidence: 0.38 } },
      { input: { accuracy: 0.25, avgReturn: 0.25, volume: 0.3 }, output: { confidence: 0.18 } },
    ],
    { iterations: 60, log: false }
  );
  const output = net.run({
    accuracy: clamp01(accuracy / 100),
    avgReturn: clamp01((avgReturn + 5) / 10),
    volume: clamp01(actionCount / 20),
  });
  return Number(((output.confidence || 0) * 100).toFixed(1));
}

function updateSourceScores(userId, evaluations, summary) {
  const delta = summary.accuracy >= 60 && summary.avgObservedReturnPct >= 0 ? 1 : -1;
  for (const evaluation of evaluations) {
    for (const source of evaluation.sourceStack || []) {
      if (!source.url) continue;
      const stored = researchSourceRepo.getByUrl(userId, source.url);
      if (!stored) continue;
      researchSourceRepo.updateStats(stored.id, {
        success: delta > 0,
        relevanceDelta: delta,
        credibilityDelta: delta * 0.5,
      });
    }
  }
}

function classifyOutcome(action, returnPct) {
  if (action === 'buy') return returnPct > 0 ? 'correct' : 'incorrect';
  if (action === 'sell') return returnPct < 0 ? 'correct' : 'incorrect';
  return Math.abs(returnPct) < 1.5 ? 'correct' : 'watch-missed-move';
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseDbTime(value) {
  if (!value) return new Date(0);
  if (String(value).includes('T')) return new Date(value);
  return new Date(String(value).replace(' ', 'T') + 'Z');
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

module.exports = {
  runDailyEvaluation,
  evaluatePlan,
  summarizeEvaluations,
};
