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
}) {
  const signalBySymbol = new Map((researchSnapshot.signals || []).map((signal) => [signal.symbol, signal]));
  const actions = (plan.actions || []).map((action) => {
    const signal = signalBySymbol.get(action.symbol);
    return {
      symbol: action.symbol,
      action: action.action,
      quantity: action.quantity,
      status: action.status,
      rationale: action.rationale,
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
      actions,
    },
  });
}

module.exports = { buildDecisionReport };
