const DEFAULT_COST_ASSUMPTIONS = {
  commissionUsd: 0,
  regulatoryFeeBps: 0.22,
  halfSpreadBps: 5,
  slippageBps: 8,
  marketImpactBpsPerPctAdv: 12,
  maxParticipationPctAdv: 0.1,
};

function estimateTransactionCost({ notionalUsd, participationPctAdv = 0, assumptions = DEFAULT_COST_ASSUMPTIONS }) {
  const notional = Math.max(0, Number(notionalUsd || 0));
  const bps =
    Number(assumptions.regulatoryFeeBps || 0)
    + Number(assumptions.halfSpreadBps || 0)
    + Number(assumptions.slippageBps || 0)
    + Number(assumptions.marketImpactBpsPerPctAdv || 0) * Math.max(0, participationPctAdv);
  const variableCostUsd = notional * (bps / 10000);
  return {
    notionalUsd: round(notional),
    commissionUsd: round(Number(assumptions.commissionUsd || 0)),
    variableCostUsd: round(variableCostUsd),
    totalCostUsd: round(variableCostUsd + Number(assumptions.commissionUsd || 0)),
    bps: round(bps),
    assumptions,
  };
}

function round(value) {
  return Number((Number(value) || 0).toFixed(6));
}

module.exports = { estimateTransactionCost, DEFAULT_COST_ASSUMPTIONS };
