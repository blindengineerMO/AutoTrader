const BUY_REQUIRED_AGREEMENTS = 3;
const SELL_REQUIRED_AGREEMENTS = 2;

function evaluateSignalAgreement({ action, signal = {}, researchSummary = {}, ownedPosition = null } = {}) {
  const normalizedAction = String(action || '').toLowerCase();
  if (!['buy', 'sell'].includes(normalizedAction)) {
    return { required: 0, count: 0, passed: true, agreements: [], disagreements: [] };
  }
  const agreements = [];
  const disagreements = [];
  const direction = normalizedAction === 'buy' ? 1 : -1;
  const financialEventScore = Number(signal.financialEventScore);
  const hasFinancialEventScore = Number.isFinite(financialEventScore);

  addLane({
    name: 'quote-momentum',
    direction,
    agreements,
    disagreements,
    buy: signal.momentum === 'bullish' || Number(signal.changePct || 0) >= 1,
    sell: signal.actionBias === 'sell-or-avoid' || signal.momentum === 'bearish' || Number(signal.changePct || 0) <= -1,
    neutral: signal.momentum === 'neutral',
  });
  addLane({
    name: 'local-ai-score',
    direction,
    agreements,
    disagreements,
    buy: Number(signal.localAiScore || 0) >= 66,
    sell: Number(signal.localAiScore || 50) <= 40 || signal.actionBias === 'sell-or-avoid',
  });
  addLane({
    name: 'financial-event-score',
    direction,
    agreements,
    disagreements,
    buy: hasFinancialEventScore && financialEventScore >= 55,
    sell: hasFinancialEventScore && financialEventScore <= 40,
  });
  addLane({
    name: 'candidate-rank-narrative',
    direction,
    agreements,
    disagreements,
    buy: hasNarrativeBias(signal.symbol, researchSummary, ['buy', 'bullish', 'purchase', 'growth', 'opportunity']),
    sell: hasNarrativeBias(signal.symbol, researchSummary, ['sell', 'bearish', 'avoid', 'decline', 'risk']),
  });
  addLane({
    name: 'source-stack-depth',
    direction,
    agreements,
    disagreements,
    buy: sourceStackDepth(researchSummary) >= 3 && Number(signal.localAiScore || 0) >= 60,
    sell: sourceStackDepth(researchSummary) >= 2 && (signal.actionBias === 'sell-or-avoid' || Number(signal.localAiScore || 50) <= 45),
  });
  addLane({
    name: 'owned-position-review',
    direction,
    agreements,
    disagreements,
    buy: Boolean(ownedPosition) && Number(signal.localAiScore || 0) >= 70 && signal.momentum === 'bullish',
    sell: Boolean(ownedPosition) && (signal.actionBias === 'sell-or-avoid' || Number(signal.localAiScore || 50) <= 45),
  });

  const required = normalizedAction === 'buy' ? BUY_REQUIRED_AGREEMENTS : SELL_REQUIRED_AGREEMENTS;
  return {
    required,
    count: agreements.length,
    passed: agreements.length >= required,
    agreements,
    disagreements,
  };
}

function enforcePlanAgreement({ actions = [], researchSnapshot = {}, positions = [] } = {}) {
  const signalBySymbol = new Map((researchSnapshot.signals || []).map((signal) => [cleanSymbol(signal.symbol), signal]));
  const positionBySymbol = new Map((positions || []).map((position) => [cleanSymbol(position.symbol), position]));
  return (actions || []).map((action) => {
    const symbol = cleanSymbol(action.symbol);
    const normalizedAction = String(action.action || '').toLowerCase();
    if (!['buy', 'sell'].includes(normalizedAction)) return action;
    const agreement = evaluateSignalAgreement({
      action: normalizedAction,
      signal: signalBySymbol.get(symbol) || { symbol },
      researchSummary: researchSnapshot.summary || {},
      ownedPosition: positionBySymbol.get(symbol) || null,
    });
    if (agreement.passed) {
      return {
        ...action,
        rationale: appendAgreement(action.rationale, agreement),
      };
    }
    return {
      ...action,
      action: 'hold',
      quantity: null,
      rationale: `${action.rationale || `${symbol} ${normalizedAction} proposal`} Cross-source agreement gate downgraded this to HOLD: ${agreement.count}/${agreement.required} independent evidence lanes agreed (${agreement.agreements.join(', ') || 'none'}).`,
    };
  });
}

function addLane({ name, direction, agreements, disagreements, buy, sell, neutral = false }) {
  if (neutral) return;
  const agrees = direction === 1 ? buy : sell;
  const opposes = direction === 1 ? sell : buy;
  if (agrees) agreements.push(name);
  else if (opposes) disagreements.push(name);
}

function hasNarrativeBias(symbol, summary, keywords) {
  const clean = cleanSymbol(symbol);
  const candidates = [
    ...(summary.reportNarrative?.topCandidates || []),
    ...(summary.prePlan?.candidates || []),
    ...(summary.chatResearch?.candidateHints || []),
  ];
  const record = candidates.find((candidate) => cleanSymbol(candidate.symbol) === clean);
  if (!record) return false;
  const text = [
    record.bias,
    record.action,
    record.reason,
    record.thesis,
    record.summary,
    ...(record.reasons || []),
  ].join(' ').toLowerCase();
  return keywords.some((keyword) => text.includes(keyword));
}

function sourceStackDepth(summary = {}) {
  return new Set((summary.sourceStack || []).map((source) => String(source.type || source.name || '').toLowerCase()).filter(Boolean)).size;
}

function appendAgreement(rationale, agreement) {
  return `${rationale || ''} Cross-source agreement passed ${agreement.count}/${agreement.required}: ${agreement.agreements.join(', ')}.`.trim();
}

function cleanSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

module.exports = {
  BUY_REQUIRED_AGREEMENTS,
  SELL_REQUIRED_AGREEMENTS,
  evaluateSignalAgreement,
  enforcePlanAgreement,
};
