const decisionReportRepo = require('../db/repositories/decisionReportRepo');

function buildDecisionReport({
  userId,
  plan,
  researchSnapshot,
  mode,
  liveReady,
  modeReason,
  accountState,
  brokerAccount,
  positions = [],
}) {
  const signalBySymbol = new Map((researchSnapshot.signals || []).map((signal) => [cleanSymbol(signal.symbol), signal]));
  const positionsBySymbol = new Map((positions || []).map((position) => [cleanSymbol(position.symbol), position]));
  const actions = (plan.actions || []).map((action) => {
    const signal = signalBySymbol.get(cleanSymbol(action.symbol));
    const ownedPosition = positionsBySymbol.get(cleanSymbol(action.symbol));
    return {
      symbol: action.symbol,
      action: action.action,
      quantity: action.quantity,
      status: action.status,
      rationale: action.rationale,
      ownedPosition: ownedPosition ? summarizePosition(ownedPosition, signal) : null,
      positionReviewAction: ownedPosition ? normalizePositionReviewAction(action.action, action.rationale) : null,
      evidence: signal
        ? {
            price: signal.price,
            changePct: signal.changePct,
            volatilityPct: signal.volatilityPct,
            momentum: signal.momentum,
            actionBias: signal.actionBias,
            localAiScore: signal.localAiScore,
            theme: signal.theme,
            discovery: signal.discovery || signal.evidence?.discovery || null,
            chatResearch: signal.chatResearch || signal.evidence?.chatResearch || null,
            newsSentiment: signal.newsSentiment,
            macroRisk: signal.macroRisk,
            consumerBias: signal.consumerBias,
            brokerFactorScore: signal.brokerFactorScore,
            historicalWatchFactors: signal.evidence?.historicalWatchFactors || [],
            investorPlaybookScore: signal.investorPlaybookScore,
            investorPlaybook: signal.evidence?.investorPlaybook || null,
            jsonDatasetScore: signal.jsonDatasetScore,
            jsonDatasets: signal.evidence?.jsonDatasets || null,
            brainModelKey: signal.brainModelKey,
            explanation: signal.evidence?.explanation || [],
            quote: signal.evidence?.quote || null,
          }
        : null,
    };
  });
  const ownedPositionReviews = buildOwnedPositionReviews({ positions, actions, signalBySymbol });

  return decisionReportRepo.create({
    userId,
    tradingPlanId: plan.id,
    researchSnapshotId: researchSnapshot.id,
    mode,
    liveReady,
    summary: {
      mode,
      liveReady,
      modeReason,
      modelUsed: plan.model_used,
      planStatus: plan.status,
      overallRationale: plan.rawResponse?.overallRationale || '',
      researchSource: researchSnapshot.source,
      researchSummary: researchSnapshot.summary,
      sourceStack: researchSnapshot.summary?.sourceStack || [],
      researchNarrative: researchSnapshot.summary?.reportNarrative || null,
      prePlan: researchSnapshot.summary?.prePlan || null,
      accountState,
      brokerAccountStatus: brokerAccount?.status || 'not_connected',
      ownedPositions: ownedPositionReviews.map((review) => review.position),
      ownedPositionReviews,
      actions,
    },
  });
}

function buildOwnedPositionReviews({ positions = [], actions = [], signalBySymbol = new Map() }) {
  const actionBySymbol = new Map(actions.map((action) => [cleanSymbol(action.symbol), action]));
  return (positions || [])
    .filter((position) => Number(position.quantity || 0) > 0)
    .map((position) => {
      const symbol = cleanSymbol(position.symbol);
      const signal = signalBySymbol.get(symbol);
      const action = actionBySymbol.get(symbol);
      return {
        symbol,
        position: summarizePosition(position, signal),
        action: action ? normalizePositionReviewAction(action.action, action.rationale) : 'hold',
        executableAction: action?.action || 'hold',
        quantity: action?.quantity ?? null,
        rationale: action?.rationale || `${symbol} is currently owned and no explicit plan action was supplied, so the report marks it HOLD pending the next board review.`,
        evidence: signal ? {
          localAiScore: signal.localAiScore,
          actionBias: signal.actionBias,
          momentum: signal.momentum,
          changePct: signal.changePct,
          explanation: signal.evidence?.explanation || [],
        } : null,
      };
    });
}

function summarizePosition(position, signal) {
  const quantity = Number(position.quantity || 0);
  const avgCost = Number(position.avg_cost_usd || 0);
  const currentPrice = Number(signal?.price || signal?.evidence?.quote?.current || avgCost || 0);
  const costBasisUsd = quantity * avgCost;
  const marketValueUsd = quantity * currentPrice;
  return {
    id: position.id,
    symbol: cleanSymbol(position.symbol),
    quantity,
    avgCostUsd: avgCost,
    currentResearchPriceUsd: currentPrice,
    costBasisUsd: Number(costBasisUsd.toFixed(2)),
    marketValueUsd: Number(marketValueUsd.toFixed(2)),
    unrealizedPnlUsd: Number((marketValueUsd - costBasisUsd).toFixed(2)),
    unrealizedPnlPct: avgCost > 0 && currentPrice > 0 ? Number((((currentPrice - avgCost) / avgCost) * 100).toFixed(2)) : null,
    updatedAt: position.updated_at,
  };
}

function normalizePositionReviewAction(action, rationale = '') {
  if (action === 'sell') return 'sell';
  if (action === 'buy' || /buy\s+more|add|accumulat/i.test(String(rationale || ''))) return 'buy_more';
  return 'hold';
}

function cleanSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

module.exports = { buildDecisionReport };
