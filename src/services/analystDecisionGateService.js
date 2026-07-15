const RULE_VERSION = 'analyst-decision-gate-v1';
const MATERIAL_TARGET_CHANGE_PCT = 5;
const NEW_RECOMMENDATION_WINDOW_DAYS = 14;
const DIRECT_BUY_CAVEAT = 'Analyst recommendations never authorize direct orders; a passed gate only makes the symbol a possible candidate for further evaluation.';

function evaluateAnalystDecisionGate(input = {}) {
  const candidate = input.candidate || input.signal || input;
  const quote = input.quote || candidate?.evidence?.quote || {};
  const factorIntel = input.factorIntel || candidate?.evidence?.companyIntelligence || {};
  const marketBeatIntel = input.marketBeatIntel || candidate?.evidence?.marketBeatAnalyst || {};
  const yahooFinanceIntel = input.yahooFinanceIntel || candidate?.evidence?.yahooFinanceScreener || {};
  const nasdaqIntel = input.nasdaqIntel || candidate?.evidence?.nasdaqMarketResearch || {};
  const secOwnershipIntel = input.secOwnershipIntel || candidate?.evidence?.secOwnership || {};
  const portfolioContext = input.portfolioContext || input.context || {};
  const symbol = cleanSymbol(candidate?.symbol || input.symbol);
  const signals = collectAnalystSignals({ marketBeatIntel, yahooFinanceIntel, nasdaqIntel, candidate });
  const analystDriven = signals.length > 0;

  if (!analystDriven) {
    return {
      version: RULE_VERSION,
      symbol,
      analystDriven: false,
      passed: true,
      status: 'not-applicable',
      compositeScore: 100,
      normalized: 1,
      directBuyAllowed: false,
      caveat: DIRECT_BUY_CAVEAT,
      summary: 'No analyst recommendation evidence was detected, so the analyst gate did not participate in this decision.',
      gates: [
        gate('analyst-upgrade-detected', true, 100, 'No analyst recommendation evidence is driving this candidate.'),
      ],
    };
  }

  const gates = [
    detectUpgrade(signals),
    detectNewRecommendation(signals, input.now),
    detectMaterialChange(signals),
    estimateCredibility(signals),
    evaluateSecSupport({ factorIntel, secOwnershipIntel, candidate }),
    evaluateValuation({ candidate, factorIntel, marketBeatIntel, yahooFinanceIntel, nasdaqIntel }),
    evaluateRiskChecks({ candidate, quote, portfolioContext }),
  ];
  const hardPassed = gates.every((item) => item.passed);
  const compositeScore = Math.round(average(gates.map((item) => item.score)));
  const failedLabels = gates.filter((item) => !item.passed).map((item) => item.label);

  return {
    version: RULE_VERSION,
    symbol,
    analystDriven: true,
    passed: hardPassed,
    status: hardPassed ? 'possible-candidate-for-further-evaluation' : 'analyst-evidence-blocked',
    compositeScore,
    normalized: clamp01(compositeScore / 100),
    directBuyAllowed: false,
    caveat: DIRECT_BUY_CAVEAT,
    summary: hardPassed
      ? 'Analyst upgrade evidence cleared freshness, material-change, credibility, SEC-support, valuation, liquidity, and portfolio-risk checks; continue full evaluation.'
      : `Analyst evidence is not sufficient for a buy candidate yet. Failed checks: ${failedLabels.join(', ')}.`,
    gates,
    signals: signals.slice(0, 8).map(compactSignal),
  };
}

function compactForBmcl(result = {}) {
  const evaluated = result.version === RULE_VERSION ? result : evaluateAnalystDecisionGate(result);
  return {
    version: evaluated.version,
    symbol: evaluated.symbol,
    analystDriven: evaluated.analystDriven,
    passed: evaluated.passed,
    status: evaluated.status,
    compositeScore: evaluated.compositeScore,
    normalized: evaluated.normalized,
    directBuyAllowed: false,
    caveat: evaluated.caveat,
    summary: evaluated.summary,
    gates: (evaluated.gates || []).map((item) => ({
      key: item.key,
      label: item.label,
      passed: item.passed,
      score: item.score,
      reason: item.reason,
      evidence: item.evidence,
    })),
    signals: evaluated.signals || [],
    bmclUse: 'Agents call this before treating analyst upgrades, Buy ratings, price-target changes, or consensus notes as purchase evidence. A passed result means discuss further, not execute.',
  };
}

function collectAnalystSignals({ marketBeatIntel = {}, yahooFinanceIntel = {}, nasdaqIntel = {}, candidate = {} }) {
  const raw = [
    ...tagSignals(marketBeatIntel.signals, 'marketbeat'),
    ...tagSignals(marketBeatIntel.records, 'marketbeat'),
    ...tagSignals(yahooFinanceIntel.signals, 'yahoo-finance'),
    ...tagSignals(nasdaqIntel.signals, 'nasdaq'),
    ...tagSignals(candidate.analystSignals, 'candidate'),
  ];
  const symbol = cleanSymbol(candidate?.symbol);
  return raw
    .filter((signal) => !symbol || cleanSymbol(signal.symbol) === symbol || !signal.symbol)
    .filter(isAnalystSignal);
}

function tagSignals(signals, source) {
  if (!Array.isArray(signals)) return [];
  return signals.map((item) => ({ ...item, source: item.source || source }));
}

function isAnalystSignal(signal = {}) {
  const text = signalText(signal);
  return /analyst|broker|upgrade|downgrade|rating|price target|target price|outperform|underperform|overweight|underweight|buy|sell|hold|consensus|forecast/.test(text);
}

function detectUpgrade(signals) {
  const upgrades = signals.filter((signal) => {
    const text = signalText(signal);
    return /upgrade|upgraded|initiated|raised to|boosted to|outperform|overweight|strong buy/.test(text)
      && !/downgrade|lowered to|cut to|underperform|underweight|sell/.test(text);
  });
  return gate(
    'analyst-upgrade-detected',
    upgrades.length > 0,
    upgrades.length ? 88 : 18,
    upgrades.length
      ? `Detected ${upgrades.length} upgrade/initiation/positive analyst action(s).`
      : 'No newly positive analyst action was detected; a generic Buy label cannot drive a purchase.',
    upgrades.slice(0, 3).map(compactSignal)
  );
}

function detectNewRecommendation(signals, now = new Date()) {
  const reference = now instanceof Date ? now : new Date(now);
  const fresh = signals.filter((signal) => {
    const published = parseDate(signal.publishedAt || signal.published_at || signal.date || signal.timestamp);
    if (published) {
      const ageDays = Math.abs(reference.getTime() - published.getTime()) / 86400000;
      return ageDays <= NEW_RECOMMENDATION_WINDOW_DAYS;
    }
    return /new|initiated|today|this week|recent|fresh|latest/.test(signalText(signal));
  });
  return gate(
    'newly-issued-recommendation',
    fresh.length > 0,
    fresh.length ? 84 : 28,
    fresh.length
      ? `At least one analyst signal is new/recent within ${NEW_RECOMMENDATION_WINDOW_DAYS} days or explicitly marked new.`
      : 'Analyst evidence is stale or undated, so it must not trigger a buy candidate.',
    fresh.slice(0, 3).map(compactSignal)
  );
}

function detectMaterialChange(signals) {
  const material = signals.filter((signal) => {
    const previousTarget = number(signal.previousTarget || signal.previous_target || signal.oldTarget);
    const newTarget = number(signal.newTarget || signal.new_target || signal.targetPrice || signal.priceTarget);
    if (previousTarget > 0 && newTarget > 0) {
      return Math.abs(((newTarget - previousTarget) / previousTarget) * 100) >= MATERIAL_TARGET_CHANGE_PCT;
    }
    const estimateChange = Math.abs(number(signal.estimateChangePct || signal.epsEstimateChangePct || signal.revenueEstimateChangePct));
    return estimateChange >= MATERIAL_TARGET_CHANGE_PCT || /price target|target.*(raise|increase|cut|lower)|estimate.*(raise|increase|cut|lower)|material/.test(signalText(signal));
  });
  return gate(
    'material-estimate-or-target-change',
    material.length > 0,
    material.length ? 82 : 32,
    material.length
      ? `Detected material estimate or price-target movement of at least ${MATERIAL_TARGET_CHANGE_PCT}% or equivalent text evidence.`
      : 'No material estimate or price-target change was detected.',
    material.slice(0, 3).map(compactSignal)
  );
}

function estimateCredibility(signals) {
  const credible = signals.filter((signal) => {
    const firm = cleanText(signal.analystFirm || signal.firm || signal.broker || signal.sourceFirm);
    const credibilityScore = number(signal.credibilityScore || signal.historicalAccuracy || signal.successRate);
    return firm.length >= 3 || credibilityScore >= 60;
  });
  const multipleSources = new Set(signals.map((signal) => signal.source).filter(Boolean)).size >= 2;
  return gate(
    'analyst-historically-credible',
    credible.length > 0 || multipleSources,
    credible.length || multipleSources ? 76 : 36,
    credible.length
      ? 'Analyst/broker identity or historical credibility score is present.'
      : multipleSources
        ? 'Multiple analyst data sources corroborate the action, but firm-level history should still be backtested.'
        : 'Analyst identity/history is missing; require source credibility research before buying.',
    credible.slice(0, 3).map(compactSignal)
  );
}

function evaluateSecSupport({ factorIntel = {}, secOwnershipIntel = {}, candidate = {} }) {
  const filingFactor = factorIntel.secFilingFactor || candidate?.evidence?.secFilingFactor || {};
  const filingScore = number(filingFactor.score || factorIntel.secFilingScore || candidate?.secFilingHistoryScore);
  const ownershipScore = number(secOwnershipIntel.compositeScore || secOwnershipIntel.score || candidate?.secOwnershipScore);
  const explanationText = [
    ...(Array.isArray(factorIntel.explanations) ? factorIntel.explanations : []),
    ...(Array.isArray(candidate?.evidence?.explanation) ? candidate.evidence.explanation : []),
    filingFactor.stance,
  ].join(' ').toLowerCase();
  const supported = filingScore >= 60
    || ownershipScore >= 60
    || /sec filing history.*(constructive|support|positive)|10-k|10-q|8-k|13f|13d|13g/.test(explanationText);
  return gate(
    'sec-filing-data-supports-thesis',
    supported,
    supported ? Math.max(72, filingScore || ownershipScore || 72) : 30,
    supported
      ? 'SEC filing or ownership-filing evidence supports continued evaluation.'
      : 'No supporting SEC filing evidence was attached; analyst evidence must be corroborated with EDGAR before buy review.',
    {
      secFilingScore: filingScore || null,
      latestForm: filingFactor.latestForm || null,
      latestFilingDate: filingFactor.latestFilingDate || null,
      secOwnershipScore: ownershipScore || null,
    }
  );
}

function evaluateValuation({ candidate = {}, factorIntel = {}, marketBeatIntel = {}, yahooFinanceIntel = {}, nasdaqIntel = {} }) {
  const valuationScore = firstFinite([
    candidate.valuationScore,
    candidate.wallStreetZenQuantScore,
    candidate.brokerFactorScore,
    factorIntel.compositeScore,
    marketBeatIntel.compositeScore,
    yahooFinanceIntel.compositeScore,
    nasdaqIntel.compositeScore,
    candidate.localAiScore,
  ], 50);
  const text = `${candidate.theme || ''} ${candidate.evidence?.explanation?.join(' ') || ''}`.toLowerCase();
  const stretched = /overvalued|expensive|rich valuation|valuation risk|priced for perfection/.test(text);
  const attractive = valuationScore >= 58 && !stretched;
  return gate(
    'valuation-still-attractive',
    attractive,
    attractive ? Math.max(65, valuationScore) : Math.min(48, valuationScore),
    attractive
      ? 'Valuation proxies are still constructive after the analyst action.'
      : 'Valuation evidence is insufficient or already stretched after the analyst action.',
    { valuationScore, stretched }
  );
}

function evaluateRiskChecks({ candidate = {}, quote = {}, portfolioContext = {} }) {
  const current = number(quote.current || candidate.price);
  const volatilityPct = Math.abs(number(candidate.volatilityPct));
  const changePct = number(candidate.changePct);
  const dollarVolume = number(candidate.averageDailyDollarVolume || candidate.dollarVolume || quote.dollarVolume);
  const liquidityKnown = dollarVolume > 0;
  const liquidityPass = liquidityKnown ? dollarVolume >= 10000000 : current > 0 && volatilityPct <= 10;
  const portfolioViolations = Array.isArray(portfolioContext.violations)
    ? portfolioContext.violations
    : Array.isArray(candidate.portfolioViolations)
      ? candidate.portfolioViolations
      : [];
  const riskPass = current > 0 && volatilityPct <= 12 && changePct > -8 && portfolioViolations.length === 0 && liquidityPass;
  return gate(
    'liquidity-and-portfolio-risk-checks',
    riskPass,
    riskPass ? 78 : 24,
    riskPass
      ? liquidityKnown
        ? 'Liquidity and portfolio-risk checks passed using attached market/risk data.'
        : 'No dollar-volume field was attached, but quote/volatility checks are acceptable for further review; live order flow still needs brokerage liquidity validation.'
      : 'Liquidity, price, volatility, or portfolio constraints failed.',
    {
      current,
      volatilityPct,
      changePct,
      dollarVolume: liquidityKnown ? dollarVolume : null,
      liquidityKnown,
      portfolioViolations,
    }
  );
}

function gate(key, passed, score, reason, evidence = {}) {
  return {
    key,
    label: key.replace(/-/g, ' '),
    passed: Boolean(passed),
    score: Math.round(clamp(score, 0, 100)),
    reason,
    evidence,
  };
}

function compactSignal(signal = {}) {
  return {
    source: signal.source,
    symbol: cleanSymbol(signal.symbol),
    action: signal.action || signal.signal || signal.category || null,
    analystFirm: signal.analystFirm || signal.firm || signal.broker || null,
    previousRating: signal.previousRating || null,
    newRating: signal.newRating || null,
    previousTarget: number(signal.previousTarget) || null,
    newTarget: number(signal.newTarget) || null,
    publishedAt: signal.publishedAt || signal.published_at || signal.date || null,
    reason: clip(signal.reason || signal.rowText || signal.snippet || '', 180),
  };
}

function signalText(signal = {}) {
  return [
    signal.action,
    signal.signal,
    signal.category,
    signal.stance,
    signal.previousRating,
    signal.newRating,
    signal.reason,
    signal.rowText,
    signal.snippet,
  ].filter(Boolean).join(' ').toLowerCase();
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function cleanSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value, limit) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstFinite(values, fallback) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return clamp(parsed, 0, 100);
  }
  return fallback;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function average(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return 0;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

module.exports = {
  RULE_VERSION,
  DIRECT_BUY_CAVEAT,
  evaluateAnalystDecisionGate,
  compactForBmcl,
};
