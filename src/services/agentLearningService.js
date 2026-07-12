const tradingAgentRepo = require('../db/repositories/tradingAgentRepo');
const agentWorkspace = require('./agentWorkspaceService');
const logger = require('../utils/logger');

const MIN_MATCHED_RECOMMENDATIONS = 3;
const WEIGHT_STEP_PCT = 0.1;
const WEIGHT_FLOOR = 0.5;
const WEIGHT_CEILING = 1.5;
const ACCURACY_UPSHIFT_THRESHOLD = 60;
const ACCURACY_DOWNSHIFT_THRESHOLD = 40;

/**
 * Adjusts each personality agent's council opinion weight from realized
 * evaluation outcomes: agents whose calls matched the market direction gain
 * weight, agents whose calls didn't lose weight, bounded within
 * [WEIGHT_FLOOR, WEIGHT_CEILING] and stepped by WEIGHT_STEP_PCT per cycle.
 * This only affects the multiplier applied in council consensus scoring
 * (personalityAgentService.buildConsensus) — it never touches live orders.
 */
function updateAgentWeightsFromEvaluations(userId, evaluations) {
  const actionEvaluations = evaluations.flatMap((evaluation) => evaluation.actionEvaluations || []);
  if (!actionEvaluations.length) return [];

  const returnsBySymbol = new Map();
  for (const action of actionEvaluations) {
    const list = returnsBySymbol.get(action.symbol) || [];
    list.push(action.returnPct);
    returnsBySymbol.set(action.symbol, list);
  }

  const councilRuns = tradingAgentRepo.listCouncilRuns(userId, 20);
  const matchedByAgent = new Map();
  for (const run of councilRuns) {
    for (const rec of run.recommendations || []) {
      const returns = returnsBySymbol.get(rec.symbol);
      if (!returns) continue;
      const list = matchedByAgent.get(rec.agent_id) || [];
      for (const returnPct of returns) list.push({ action: rec.action, returnPct });
      matchedByAgent.set(rec.agent_id, list);
    }
  }

  const results = [];
  for (const [agentId, matched] of matchedByAgent.entries()) {
    if (matched.length < MIN_MATCHED_RECOMMENDATIONS) continue;
    const agent = tradingAgentRepo.getAgent(userId, agentId);
    if (!agent) continue;

    const hits = matched.filter((item) => isAgentRecommendationHit(item.action, item.returnPct)).length;
    const accuracy = (hits / matched.length) * 100;
    const previousWeight = Number(agent.model?.learningWeight ?? 1);
    const direction =
      accuracy >= ACCURACY_UPSHIFT_THRESHOLD ? 1 : accuracy <= ACCURACY_DOWNSHIFT_THRESHOLD ? -1 : 0;
    if (direction === 0) continue;

    const nextWeight = Number(clamp(previousWeight * (1 + direction * WEIGHT_STEP_PCT), WEIGHT_FLOOR, WEIGHT_CEILING).toFixed(4));
    if (nextWeight === previousWeight) continue;

    const rationale = `${agent.name} matched ${matched.length} recommendation(s) against realized outcomes with ${accuracy.toFixed(1)}% hit rate; opinion weight adjusted ${previousWeight.toFixed(4)} -> ${nextWeight.toFixed(4)}.`;

    tradingAgentRepo.updateAgent(userId, agentId, {
      model: { ...(agent.model || {}), learningWeight: nextWeight },
    });

    agentWorkspace.recordLearningAdjustment(agent, {
      previousWeight,
      newWeight: nextWeight,
      accuracy: Number(accuracy.toFixed(1)),
      sampleSize: matched.length,
      rationale,
    });

    logger.info('Personality agent opinion weight adjusted from realized outcomes', {
      userId,
      agentId,
      agentName: agent.name,
      previousWeight,
      nextWeight,
      accuracy,
    });

    results.push({
      agentId,
      agentName: agent.name,
      previousWeight,
      newWeight: nextWeight,
      accuracy: Number(accuracy.toFixed(1)),
      sampleSize: matched.length,
    });
  }
  return results;
}

function isAgentRecommendationHit(action, returnPct) {
  if (action === 'buy') return returnPct > 0;
  if (action === 'sell') return returnPct < 0;
  if (action === 'watch' || action === 'hold') return Math.abs(returnPct) < 1.5;
  return false;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  updateAgentWeightsFromEvaluations,
  WEIGHT_FLOOR,
  WEIGHT_CEILING,
  WEIGHT_STEP_PCT,
};
