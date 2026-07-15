const crypto = require('crypto');
const analystDecisionGate = require('./analystDecisionGateService');

const VERSION = 'agent-decision-tree-v1';

const GLOBAL_MANDATE = Object.freeze({
  portfolioObjective: 'maximize long-term risk-adjusted return',
  universe: 'liquid US-listed operating companies with reliable public evidence',
  holdingPeriodMonths: { minimum: 6, target: 24, maximum: 60 },
  benchmark: 'SPY',
  maximumPositionWeight: 0.03,
  maximumSectorWeight: 0.2,
  maximumPortfolioDrawdown: 0.1,
  leverageAllowed: false,
  shortSellingAllowed: false,
  minimumMarketCapUsd: 1000000000,
  minimumAverageDailyDollarVolume: 10000000,
  requiredMarginOfSafety: 0.2,
  maximumExpectedDownside: 0.35,
});

const DECISION_STEP_IDS = Object.freeze([
  'mandate',
  'investable-universe',
  'data-quality',
  'hard-disqualifiers',
  'business-understanding',
  'financial-health',
  'business-quality',
  'future-fundamentals',
  'intrinsic-value',
  'market-expectations',
  'analyst-recommendation-gate',
  'catalysts',
  'threats-premortem',
  'news-and-alternative-data',
  'macro-conditions',
  'price-liquidity',
  'stress-tests',
  'return-distribution',
  'alternatives',
  'portfolio-fit',
  'position-sizing',
  'independent-pretrade-controls',
  'staged-execution',
  'thesis-monitoring',
  'sell-decision-tree',
]);

const ETF_SYMBOLS = new Set(['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'XLE', 'XLF', 'XLV', 'XLU', 'XLY', 'ITA', 'SOXX']);

function buildAgentMandate(agentOrProfile = {}) {
  const bias = agentOrProfile.bias || {};
  const factors = bias.factors || {};
  const riskPenalty = Number(factors.riskPenalty || factors.volatilityPenalty || 0);
  const volatilityTolerance = Number(factors.volatilityTolerance || 0);
  const longHorizon = Number(factors.longHorizon || 0);
  const asymmetricUpside = Number(factors.asymmetricUpside || 0);
  const requiredMarginOfSafety = clamp(
    GLOBAL_MANDATE.requiredMarginOfSafety + riskPenalty * 0.18 - volatilityTolerance * 0.08 - asymmetricUpside * 0.04,
    0.12,
    0.35
  );
  const maximumPositionWeight = clamp(
    GLOBAL_MANDATE.maximumPositionWeight + volatilityTolerance * 0.01 - riskPenalty * 0.012,
    0.01,
    GLOBAL_MANDATE.maximumPositionWeight
  );
  const targetHoldingPeriod = Math.round(clamp(
    GLOBAL_MANDATE.holdingPeriodMonths.target + longHorizon * 36 - volatilityTolerance * 6,
    GLOBAL_MANDATE.holdingPeriodMonths.minimum,
    GLOBAL_MANDATE.holdingPeriodMonths.maximum
  ));

  return {
    ...GLOBAL_MANDATE,
    requiredMarginOfSafety: round(requiredMarginOfSafety, 4),
    maximumPositionWeight: round(maximumPositionWeight, 4),
    targetHoldingPeriodMonths: targetHoldingPeriod,
    agentStyleAdjustments: {
      riskPenalty: round(riskPenalty, 4),
      volatilityTolerance: round(volatilityTolerance, 4),
      longHorizon: round(longHorizon, 4),
      asymmetricUpside: round(asymmetricUpside, 4),
    },
  };
}

function buildDecisionFramework(agentOrProfile = {}) {
  return {
    version: VERSION,
    source: 'DECISION.md',
    mandate: buildAgentMandate(agentOrProfile),
    decisionSteps: DECISION_STEP_IDS,
    centralRule:
      'No purchase unless the business is understandable, evidence is timely and reliable, adverse scenarios are survivable, expected value clears the required margin of safety, and the position improves the portfolio after costs and risk.',
  };
}

function evaluateSignalForAgent({ agent, signal, context = {}, personaBiasScore = 0, now = new Date() }) {
  const mandate = agent?.model?.decisionFramework?.mandate || buildAgentMandate(agent || {});
  const currentPrice = number(signal?.price || signal?.evidence?.quote?.current);
  const localAiScore = scoreValue(signal?.localAiScore, 50);
  const volatilityPct = Math.max(0, number(signal?.volatilityPct));
  const changePct = number(signal?.changePct);
  const brokerScore = scoreValue(signal?.brokerFactorScore, 50);
  const investorScore = scoreValue(signal?.investorPlaybookScore, 50);
  const datasetScore = scoreValue(signal?.jsonDatasetScore, 50);
  const discoveryEvidence = evidenceList(signal?.discovery?.evidence || signal?.evidence?.discovery?.evidence);
  const chatReasons = evidenceList(signal?.chatResearch?.reasons || signal?.evidence?.chatResearch?.reasons);
  const explanation = evidenceList(signal?.evidence?.explanation);
  const sector = inferSector(signal);
  const alternatives = context.signals || [];
  const positions = context.positions || [];
  const accountState = context.accountState || {};

  const gates = [];
  gates.push(gate('mandate', 'pass', 100, 'Candidate evaluated against the agent mandate before personality bias.', {
    objective: mandate.portfolioObjective,
    benchmark: mandate.benchmark,
    holdingPeriodMonths: mandate.targetHoldingPeriodMonths,
  }));

  const universeWarnings = [];
  if (!/^[A-Z][A-Z0-9.]{0,7}$/.test(String(signal?.symbol || ''))) universeWarnings.push('Symbol format is not a normal US-listed ticker.');
  if (ETF_SYMBOLS.has(signal?.symbol)) universeWarnings.push('ETF or basket detected; useful as an alternative/hedge but not a single operating-company analysis.');
  gates.push(gate(
    'investable-universe',
    universeWarnings.length ? 'warn' : 'pass',
    universeWarnings.length ? 58 : 86,
    universeWarnings.length ? universeWarnings.join(' ') : 'Symbol appears eligible for the current US-listed research universe.',
    { symbol: signal?.symbol, sector, universe: mandate.universe }
  ));

  const dataFailures = [];
  const dataWarnings = [];
  if (!currentPrice || currentPrice <= 0) dataFailures.push('No valid current price is attached.');
  if (!Number.isFinite(Number(signal?.localAiScore))) dataWarnings.push('Local Brain score is missing; neutral fallback used.');
  if (!signal?.evidence?.quote) dataWarnings.push('Quote evidence object is missing from the signal.');
  if (!explanation.length) dataWarnings.push('No detailed explanation lines were attached.');
  gates.push(gate(
    'data-quality',
    dataFailures.length ? 'fail' : dataWarnings.length ? 'warn' : 'pass',
    dataFailures.length ? 0 : dataWarnings.length ? 64 : 92,
    [...dataFailures, ...dataWarnings].join(' ') || 'Current quote, model score, and explanation evidence are present.',
    { currentPrice, localAiScore, hasQuote: Boolean(signal?.evidence?.quote), explanationCount: explanation.length },
    true
  ));

  const hardRejects = [];
  if (dataFailures.length) hardRejects.push('unreliable-or-stale-market-data');
  if (volatilityPct >= 12) hardRejects.push('volatility-too-high-for-current-safe-mandate');
  if (localAiScore <= 20 && changePct < -2) hardRejects.push('weak-model-score-and-negative-price-confirmation');
  gates.push(gate(
    'hard-disqualifiers',
    hardRejects.length ? 'fail' : 'pass',
    hardRejects.length ? 8 : 90,
    hardRejects.length ? `Hard reject: ${hardRejects.join(', ')}.` : 'No immediate disqualifier was detected from available evidence.',
    { hardRejects },
    true
  ));

  const businessScore = clamp(38 + Math.min(22, String(signal?.theme || '').length ? 16 : 0) + Math.min(18, discoveryEvidence.length * 6) + Math.min(14, chatReasons.length * 4) + (brokerScore - 50) * 0.3, 0, 100);
  gates.push(gate(
    'business-understanding',
    businessScore < 35 ? 'fail' : businessScore < 55 ? 'warn' : 'pass',
    businessScore,
    businessScore < 35
      ? 'The system cannot yet explain the business well enough from theme, crawl, chat, or company intelligence evidence.'
      : 'The signal has enough theme/source evidence to form a first-pass business model.',
    {
      theme: signal?.theme || null,
      crawledEvidenceCount: discoveryEvidence.length,
      chatReasonCount: chatReasons.length,
      edgarSearchUrl: signal?.symbol ? `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(signal.symbol)}&category=form-cat1` : null,
    },
    businessScore < 35
  ));

  const financialScore = clamp(avg([localAiScore, investorScore, brokerScore]) - Math.max(0, volatilityPct - 4) * 2, 0, 100);
  gates.push(gate(
    'financial-health',
    financialScore < 35 ? 'fail' : financialScore < 55 ? 'warn' : 'pass',
    financialScore,
    financialScore < 35 ? 'Cash generation/financial proxies are too weak for a buy gate.' : 'Available financial-health proxies are sufficient for continued analysis.',
    {
      localAiScore,
      investorPlaybookScore: investorScore,
      brokerFactorScore: brokerScore,
      note: 'This proxy must be replaced or strengthened by EDGAR filing facts when available.',
    },
    financialScore < 35
  ));

  const qualityScore = clamp(avg([brokerScore, investorScore, datasetScore, localAiScore]) + (String(signal?.theme || '').includes('saas') ? 4 : 0), 0, 100);
  gates.push(gate(
    'business-quality',
    qualityScore < 45 ? 'warn' : 'pass',
    qualityScore,
    qualityScore < 45 ? 'Business-quality evidence is thin or below the agent mandate.' : 'Moat/quality proxies are acceptable for this stage.',
    { brokerFactorScore: brokerScore, investorPlaybookScore: investorScore, jsonDatasetScore: datasetScore }
  ));

  const scenarios = buildForecastScenarios({ localAiScore, qualityScore, datasetScore, volatilityPct, changePct });
  gates.push(gate(
    'future-fundamentals',
    scenarios.base.revenueGrowth < 0.02 ? 'warn' : 'pass',
    clamp(50 + scenarios.base.revenueGrowth * 220 + scenarios.base.terminalMargin * 80, 0, 100),
    'Forecast is scenario-based and tied to model/factor evidence rather than a single price prediction.',
    { forecastScenarios: scenarios }
  ));

  const valuation = buildValuation({ currentPrice, scenarios, mandate, volatilityPct });
  gates.push(gate(
    'intrinsic-value',
    valuation.marginOfSafety >= mandate.requiredMarginOfSafety ? 'pass' : valuation.marginOfSafety > 0 ? 'warn' : 'fail',
    clamp(50 + valuation.marginOfSafety * 180, 0, 100),
    valuation.marginOfSafety >= mandate.requiredMarginOfSafety
      ? 'Probability-weighted intrinsic value clears the required margin of safety.'
      : valuation.marginOfSafety > 0
        ? 'Intrinsic value may exceed price, but margin of safety is not yet adequate for a buy.'
        : 'Probability-weighted value does not exceed the current price.',
    { valuation, requiredMarginOfSafety: mandate.requiredMarginOfSafety }
  ));

  const expectationsScore = clamp(62 + (localAiScore - 50) * 0.25 - Math.max(0, changePct - 5) * 4 - Math.max(0, volatilityPct - 5) * 2, 0, 100);
  gates.push(gate(
    'market-expectations',
    expectationsScore < 45 ? 'warn' : 'pass',
    expectationsScore,
    expectationsScore < 45 ? 'Market expectations may already be aggressive or crowded.' : 'Current expectations appear reasonable relative to evidence.',
    { changePct, volatilityPct, localAiScore }
  ));

  const analystGate = signal?.evidence?.analystDecisionGate || signal?.analystDecisionGate || analystDecisionGate.evaluateAnalystDecisionGate({ signal });
  if (analystGate.analystDriven) {
    gates.push(gate(
      'analyst-recommendation-gate',
      analystGate.passed ? 'pass' : 'warn',
      analystGate.compositeScore,
      analystGate.passed
        ? 'Analyst evidence passed the practical decision rule and may proceed to the rest of the decision tree.'
        : 'Analyst evidence is blocked from driving a buy decision until freshness, material-change, credibility, SEC, valuation, liquidity, and portfolio-risk checks pass.',
      analystGate
    ));
  }

  const catalysts = buildCatalysts(signal, discoveryEvidence, chatReasons);
  gates.push(gate(
    'catalysts',
    catalysts.length ? 'pass' : 'warn',
    catalysts.length ? clamp(56 + catalysts.length * 8, 0, 88) : 42,
    catalysts.length ? 'Concrete catalyst candidates were found in crawled/chat/theme evidence.' : 'No concrete catalyst was found; undervaluation may persist.',
    { catalysts }
  ));

  const premortem = buildPremortem({ signal, volatilityPct, datasetScore, investorScore, valuation });
  gates.push(gate(
    'threats-premortem',
    premortem.some((item) => item.severity >= 0.45 && item.probability >= 0.3) ? 'warn' : 'pass',
    clamp(84 - premortem.reduce((sum, item) => sum + item.probability * item.severity * 80, 0), 0, 100),
    'The agent attempted to disprove the thesis before recommending action.',
    { premortem }
  ));

  const newsScore = clamp(50 + Math.min(16, discoveryEvidence.length * 4) + Math.min(12, chatReasons.length * 3) + Number(signal?.newsSentiment || 0) * 4, 0, 100);
  gates.push(gate(
    'news-and-alternative-data',
    newsScore < 42 ? 'warn' : 'pass',
    newsScore,
    'News and alternative data modify revenue/cost/risk assumptions, not sentiment alone.',
    { newsSentiment: signal?.newsSentiment || 0, crawledEvidenceCount: discoveryEvidence.length, chatReasonCount: chatReasons.length }
  ));

  const macroScore = clamp(58 + macroAdjustment(signal), 0, 100);
  gates.push(gate(
    'macro-conditions',
    macroScore < 42 ? 'warn' : 'pass',
    macroScore,
    'Macro, oil, consumer, population, and global dataset context adjust risk assumptions.',
    { macroRisk: signal?.macroRisk, consumerBias: signal?.consumerBias, jsonDatasetScore: datasetScore }
  ));

  const liquidityScore = clamp(78 + Math.min(12, changePct * 2) - volatilityPct * 5, 0, 100);
  gates.push(gate(
    'price-liquidity',
    liquidityScore < 40 ? 'warn' : 'pass',
    liquidityScore,
    liquidityScore < 40 ? 'Price behavior is unstable; timing should wait or position size should shrink.' : 'Price behavior is acceptable for staged entry/monitoring.',
    { changePct, volatilityPct, momentum: signal?.momentum || null }
  ));

  const stressTests = buildStressTests({ scenarios, volatilityPct, valuation, currentPrice });
  const severeStress = stressTests.find((test) => test.scenario === 'severe_recession');
  gates.push(gate(
    'stress-tests',
    severeStress?.survives ? 'pass' : 'fail',
    severeStress?.survives ? 72 : 25,
    severeStress?.survives ? 'Severe stress case remains within expected permanent-loss tolerance.' : 'Severe stress case exceeds expected permanent-loss tolerance.',
    { stressTests, maximumExpectedDownside: mandate.maximumExpectedDownside },
    !severeStress?.survives
  ));

  const returnDistribution = buildReturnDistribution({ valuation, volatilityPct, qualityScore, dataScore: gateScore(gates, 'data-quality'), holdingPeriodMonths: mandate.targetHoldingPeriodMonths });
  gates.push(gate(
    'return-distribution',
    returnDistribution.probabilityOf20PercentLoss > 0.28 ? 'warn' : 'pass',
    clamp(returnDistribution.probabilityPositive * 100 - returnDistribution.probabilityOf20PercentLoss * 45, 0, 100),
    'The output is a distribution with confidence tied to data completeness, stability, and valuation sensitivity.',
    { expectedReturnDistribution: returnDistribution }
  ));

  const alternativeScore = compareAlternatives(signal, alternatives);
  gates.push(gate(
    'alternatives',
    alternativeScore < 45 ? 'warn' : 'pass',
    alternativeScore,
    alternativeScore < 45 ? 'Candidate is not materially better than current alternatives.' : 'Candidate compares favorably with the available research slate.',
    { benchmark: mandate.benchmark, alternativeCount: alternatives.length }
  ));

  const portfolioFit = buildPortfolioFit({ signal, positions, accountState, sector, mandate });
  gates.push(gate(
    'portfolio-fit',
    portfolioFit.violations.length ? 'fail' : portfolioFit.warnings.length ? 'warn' : 'pass',
    portfolioFit.violations.length ? 22 : portfolioFit.warnings.length ? 58 : 82,
    portfolioFit.violations[0] || portfolioFit.warnings[0] || 'Candidate fits current portfolio exposure constraints.',
    portfolioFit,
    Boolean(portfolioFit.violations.length)
  ));

  const sizing = buildPositionSizing({ valuation, returnDistribution, mandate, portfolioFit, liquidityScore });
  gates.push(gate(
    'position-sizing',
    sizing.initialEntryWeight > 0 ? 'pass' : 'warn',
    sizing.initialEntryWeight > 0 ? 76 : 42,
    sizing.initialEntryWeight > 0 ? 'Position size is staged and scaled by confidence/downside.' : 'No initial entry weight approved until uncertainty improves.',
    { positionSizing: sizing }
  ));

  const pretrade = buildPretradeControls({ signal, currentPrice, gates, sizing });
  gates.push(gate(
    'independent-pretrade-controls',
    pretrade.failures.length ? 'fail' : pretrade.warnings.length ? 'warn' : 'pass',
    pretrade.failures.length ? 18 : pretrade.warnings.length ? 64 : 88,
    pretrade.failures[0] || pretrade.warnings[0] || 'Deterministic pre-trade controls are satisfied for simulation/paper review.',
    pretrade,
    Boolean(pretrade.failures.length)
  ));

  gates.push(gate(
    'staged-execution',
    sizing.initialEntryWeight > 0 ? 'pass' : 'warn',
    sizing.initialEntryWeight > 0 ? 78 : 45,
    'Execution plan uses staged entry instead of purchasing the full target immediately.',
    { entryPlan: buildEntryPlan(sizing) }
  ));

  const thesis = buildThesisRecord({ signal, valuation, returnDistribution, catalysts, premortem, sizing, now, holdingPeriodMonths: mandate.targetHoldingPeriodMonths });
  gates.push(gate(
    'thesis-monitoring',
    'pass',
    82,
    'Every purchase candidate creates a thesis, warning indicators, required review date, and sell conditions.',
    { investmentThesis: thesis }
  ));

  const sellTree = buildSellDecisionTree({ signal, valuation, returnDistribution, portfolioFit, gates });
  gates.push(gate(
    'sell-decision-tree',
    sellTree.action === 'sell' ? 'fail' : sellTree.action === 'reduce' ? 'warn' : 'pass',
    sellTree.action === 'sell' ? 28 : sellTree.action === 'reduce' ? 52 : 78,
    sellTree.primaryReason,
    { sellTree }
  ));

  const hardFailures = gates.filter((item) => item.hard && item.status === 'fail');
  const warnings = gates.filter((item) => item.status === 'warn').map((item) => `${item.name}: ${item.reason}`);
  const scores = buildScores(gates);
  const action = chooseAction({ signal, scores, gates, hardFailures, sellTree, valuation, mandate });
  const decision = {
    decisionId: crypto.randomUUID(),
    ticker: signal?.symbol,
    decision: action.toUpperCase(),
    decisionTimestamp: now.toISOString(),
    holdingPeriodMonths: mandate.targetHoldingPeriodMonths,
    currentPrice,
    intrinsicValue: valuation,
    expectedReturn: {
      annualized: returnDistribution.annualizedExpectedReturn,
      probabilityPositive: returnDistribution.probabilityPositive,
      probabilityLossOver20Percent: returnDistribution.probabilityOf20PercentLoss,
    },
    scores,
    position: {
      initialWeight: sizing.initialEntryWeight,
      maximumWeight: sizing.approvedTargetWeight,
    },
    primaryReasons: buildPrimaryReasons(gates, action),
    primaryRisks: premortem.slice(0, 4).map((item) => item.cause),
    requiredConditions: pretrade.requiredConditions,
    sellConditions: thesis.sellConditions,
    modelVersions: {
      decisionTree: VERSION,
      agentModel: agent?.model?.modelType || 'personality-bias-v1',
      researchBrain: signal?.brainModelKey || 'unknown',
    },
    evidence: [
      ...explanation.slice(0, 8),
      ...discoveryEvidence.map((item) => item.reason || item.title || String(item)).filter(Boolean).slice(0, 5),
      ...chatReasons.slice(0, 5),
    ],
    warnings,
  };

  return {
    version: VERSION,
    mandate,
    gates,
    hardFailures: hardFailures.map((item) => item.name),
    warnings,
    scenarios,
    valuation,
    returnDistribution,
    positionSizing: sizing,
    investmentThesis: thesis,
    sellTree,
    recommendedAction: action,
    convictionBase: clamp(scores.overall + Number(personaBiasScore || 0) * 0.18, 0, hardFailures.length ? 44 : 100),
    decision,
  };
}

function gate(name, status, score, reason, evidence = {}, hard = false) {
  return {
    name,
    status,
    score: Math.round(clamp(score, 0, 100)),
    hard,
    reason,
    evidence,
  };
}

function buildForecastScenarios({ localAiScore, qualityScore, datasetScore, volatilityPct, changePct }) {
  const qualityTerm = (qualityScore - 50) / 500;
  const modelTerm = (localAiScore - 50) / 550;
  const datasetTerm = (datasetScore - 50) / 800;
  const momentumTerm = clamp(changePct / 500, -0.02, 0.03);
  const uncertainty = clamp(volatilityPct / 100, 0.01, 0.18);
  return {
    bear: {
      probability: 0.25,
      revenueGrowth: round(clamp(0.01 + qualityTerm * 0.4 + modelTerm * 0.3 - uncertainty, -0.12, 0.08), 4),
      terminalMargin: round(clamp(0.1 + qualityTerm - uncertainty * 0.6, 0.02, 0.25), 4),
      valuationMultiple: Math.round(clamp(11 + qualityTerm * 45 - volatilityPct * 0.35, 6, 18)),
    },
    base: {
      probability: 0.5,
      revenueGrowth: round(clamp(0.05 + qualityTerm + modelTerm + datasetTerm + momentumTerm, -0.03, 0.18), 4),
      terminalMargin: round(clamp(0.14 + qualityTerm + datasetTerm, 0.04, 0.32), 4),
      valuationMultiple: Math.round(clamp(16 + qualityTerm * 60 + modelTerm * 40, 8, 28)),
    },
    bull: {
      probability: 0.25,
      revenueGrowth: round(clamp(0.09 + qualityTerm * 1.35 + modelTerm * 1.2 + datasetTerm, 0, 0.3), 4),
      terminalMargin: round(clamp(0.18 + qualityTerm * 1.2 + datasetTerm, 0.08, 0.42), 4),
      valuationMultiple: Math.round(clamp(21 + qualityTerm * 80 + modelTerm * 55, 11, 38)),
    },
  };
}

function buildValuation({ currentPrice, scenarios, mandate, volatilityPct }) {
  const price = currentPrice > 0 ? currentPrice : 0;
  const bearReturn = scenarios.bear.revenueGrowth * 1.3 + scenarios.bear.terminalMargin * 0.25 - 0.18 - volatilityPct / 180;
  const baseReturn = scenarios.base.revenueGrowth * 1.65 + scenarios.base.terminalMargin * 0.35 - 0.05 - volatilityPct / 260;
  const bullReturn = scenarios.bull.revenueGrowth * 1.9 + scenarios.bull.terminalMargin * 0.45 + 0.06;
  const bear = price * Math.max(0.2, 1 + bearReturn);
  const base = price * Math.max(0.3, 1 + baseReturn);
  const bull = price * Math.max(0.4, 1 + bullReturn);
  const probabilityWeighted = bear * scenarios.bear.probability + base * scenarios.base.probability + bull * scenarios.bull.probability;
  const marginOfSafety = price ? (probabilityWeighted - price) / price : -1;
  const uncertainty = volatilityPct > 6 ? 'high' : volatilityPct > 3 ? 'medium' : 'low';
  return {
    bear: round(bear),
    base: round(base),
    bull: round(bull),
    probabilityWeighted: round(probabilityWeighted),
    marginOfSafety: round(marginOfSafety, 4),
    requiredMarginOfSafety: mandate.requiredMarginOfSafety,
    valuationUncertainty: uncertainty,
  };
}

function buildCatalysts(signal, discoveryEvidence, chatReasons) {
  const catalysts = [];
  const theme = String(signal?.theme || '').replace(/\+/g, ', ');
  if (theme) {
    catalysts.push({
      description: `Theme pressure: ${theme}`,
      probability: 0.52,
      estimatedValueImpact: 0.08,
      evidence: [theme],
      alreadyPricedProbability: signal?.changePct > 4 ? 0.55 : 0.3,
    });
  }
  for (const item of discoveryEvidence.slice(0, 2)) {
    catalysts.push({
      description: item.reason || item.title || 'Crawled source catalyst',
      probability: 0.48,
      estimatedValueImpact: 0.06,
      evidence: [item.url || item.title || 'crawled-source'],
      alreadyPricedProbability: 0.35,
    });
  }
  for (const reason of chatReasons.slice(0, 2)) {
    catalysts.push({
      description: reason,
      probability: 0.44,
      estimatedValueImpact: 0.05,
      evidence: ['chat-research'],
      alreadyPricedProbability: 0.4,
    });
  }
  return catalysts.slice(0, 5);
}

function buildPremortem({ signal, volatilityPct, datasetScore, investorScore, valuation }) {
  const causes = [
    {
      cause: 'Valuation assumptions prove too optimistic',
      probability: valuation.marginOfSafety < 0.2 ? 0.34 : 0.2,
      severity: 0.38,
      earlyWarningIndicators: ['intrinsic value falls', 'earnings guide lower', 'peer multiples contract'],
    },
    {
      cause: 'Competitive or margin pressure weakens the thesis',
      probability: investorScore < 55 ? 0.32 : 0.18,
      severity: 0.4,
      earlyWarningIndicators: ['falling gross margin', 'price discounting', 'customer churn'],
    },
    {
      cause: 'Macro, commodity, or demand regime turns against the company',
      probability: datasetScore < 50 ? 0.32 : 0.2,
      severity: 0.36,
      earlyWarningIndicators: ['credit spreads widen', 'consumer data worsens', 'commodity costs rise'],
    },
  ];
  if (volatilityPct > 4) {
    causes.push({
      cause: 'Price volatility signals missing risk or crowded positioning',
      probability: clamp(volatilityPct / 16, 0.2, 0.55),
      severity: clamp(volatilityPct / 12, 0.32, 0.7),
      earlyWarningIndicators: ['large gaps', 'rising drawdown', 'volume spikes without fundamental confirmation'],
    });
  }
  if (signal?.actionBias === 'sell-or-avoid') {
    causes.push({
      cause: 'Local Brain already flagged sell-or-avoid',
      probability: 0.45,
      severity: 0.5,
      earlyWarningIndicators: ['weak model score', 'negative momentum', 'poor factor agreement'],
    });
  }
  return causes.map((item) => ({
    ...item,
    probability: round(item.probability, 4),
    severity: round(item.severity, 4),
  }));
}

function buildStressTests({ scenarios, volatilityPct, valuation, currentPrice }) {
  const price = currentPrice || 1;
  const recessionValue = price * Math.max(0.15, 1 + scenarios.bear.revenueGrowth - 0.18 - volatilityPct / 90);
  const rateShockValue = price * Math.max(0.2, 1 + scenarios.base.revenueGrowth - 0.12 - volatilityPct / 120);
  const marginCompressionValue = price * Math.max(0.2, 1 + scenarios.base.revenueGrowth - 0.1);
  return [
    {
      scenario: 'severe_recession',
      revenueChange: -0.12,
      marginChange: -0.04,
      multipleChange: -0.25,
      stressedValue: round(recessionValue),
      expectedLoss: round((price - recessionValue) / price, 4),
      survives: (price - recessionValue) / price <= 0.35,
    },
    {
      scenario: 'interest_rates_up_200_basis_points',
      discountRateChange: 0.02,
      refinancingCostChange: 0.025,
      stressedValue: round(rateShockValue),
      expectedLoss: round((price - rateShockValue) / price, 4),
      survives: (price - rateShockValue) / price <= 0.35,
    },
    {
      scenario: 'gross_margin_compression',
      grossMarginChange: -0.05,
      stressedValue: round(marginCompressionValue),
      expectedLoss: round((price - marginCompressionValue) / price, 4),
      survives: (price - marginCompressionValue) / price <= 0.35,
    },
    {
      scenario: 'valuation_sensitivity',
      stressedValue: round(valuation.bear),
      expectedLoss: round((price - valuation.bear) / price, 4),
      survives: (price - valuation.bear) / price <= 0.4,
    },
  ];
}

function buildReturnDistribution({ valuation, volatilityPct, qualityScore, dataScore, holdingPeriodMonths }) {
  const expectedTotalReturn = valuation.marginOfSafety;
  const annualized = Math.pow(Math.max(0.05, 1 + expectedTotalReturn), 12 / Math.max(1, holdingPeriodMonths)) - 1;
  const downsidePressure = clamp(volatilityPct / 15 + (100 - qualityScore) / 260 + (100 - dataScore) / 260, 0.03, 0.75);
  const probabilityPositive = clamp(0.48 + expectedTotalReturn * 0.75 + (qualityScore - 50) / 300, 0.15, 0.86);
  return {
    holdingPeriodMonths,
    expectedTotalReturn: round(expectedTotalReturn, 4),
    annualizedExpectedReturn: round(annualized, 4),
    medianReturn: round(expectedTotalReturn * 0.78, 4),
    probabilityPositive: round(probabilityPositive, 4),
    probabilityOf20PercentLoss: round(clamp(downsidePressure * 0.38, 0.02, 0.5), 4),
    probabilityOf40PercentLoss: round(clamp(downsidePressure * 0.14, 0.005, 0.25), 4),
    expectedShortfall95: round(-clamp(0.18 + downsidePressure * 0.45, 0.18, 0.65), 4),
    expectedMaximumDrawdown: round(-clamp(0.08 + downsidePressure * 0.35, 0.08, 0.45), 4),
    confidence: round(clamp((dataScore + qualityScore) / 220 + (valuation.marginOfSafety > 0 ? 0.12 : -0.06), 0.15, 0.86), 4),
  };
}

function compareAlternatives(signal, alternatives) {
  if (!alternatives.length) return 52;
  const target = scoreValue(signal?.localAiScore, 50);
  const ranked = [...alternatives].map((item) => scoreValue(item.localAiScore, 50)).sort((a, b) => b - a);
  const median = ranked[Math.floor(ranked.length / 2)] || 50;
  const top = ranked[0] || 50;
  return clamp(50 + (target - median) * 0.8 + (target >= top ? 8 : 0), 0, 100);
}

function buildPortfolioFit({ signal, positions, accountState, sector, mandate }) {
  const cash = Number(accountState?.cash_balance_usd || accountState?.cashUsd || 0);
  const positionValue = (positions || []).reduce((sum, position) => sum + Number(position.quantity || 0) * Number(position.avg_cost_usd || 0), 0);
  const totalValue = Math.max(1, cash + positionValue);
  const currentPosition = (positions || []).find((position) => position.symbol === signal?.symbol);
  const currentWeight = currentPosition ? (Number(currentPosition.quantity || 0) * Number(currentPosition.avg_cost_usd || 0)) / totalValue : 0;
  const similarPositions = (positions || []).filter((position) => inferSector({ symbol: position.symbol, theme: sector }) === sector);
  const sectorWeight = similarPositions.reduce((sum, position) => sum + (Number(position.quantity || 0) * Number(position.avg_cost_usd || 0)) / totalValue, 0);
  const violations = [];
  const warnings = [];
  if (currentWeight >= mandate.maximumPositionWeight) violations.push('Existing position already meets or exceeds maximum position weight.');
  if (sectorWeight >= mandate.maximumSectorWeight) warnings.push('Sector exposure is near or above the mandate limit; require a smaller or offset entry.');
  if (ETF_SYMBOLS.has(signal?.symbol)) warnings.push('ETF exposure should be treated as portfolio allocation rather than company-specific purchase.');
  return {
    sector,
    currentWeight: round(currentWeight, 4),
    estimatedSectorWeight: round(sectorWeight, 4),
    maxPositionWeight: mandate.maximumPositionWeight,
    maxSectorWeight: mandate.maximumSectorWeight,
    violations,
    warnings,
  };
}

function buildPositionSizing({ valuation, returnDistribution, mandate, portfolioFit, liquidityScore }) {
  const expectedExcessReturn = Math.max(0, valuation.marginOfSafety - 0.03);
  const confidence = returnDistribution.confidence;
  const expectedDownside = Math.abs(returnDistribution.expectedMaximumDrawdown);
  const liquidityFactor = clamp(liquidityScore / 100, 0.25, 1);
  const correlationPenalty = portfolioFit.warnings.length ? 0.65 : 0.9;
  const raw = expectedDownside > 0
    ? expectedExcessReturn * confidence * liquidityFactor * correlationPenalty / expectedDownside
    : 0;
  const modelWeight = clamp(raw, 0, mandate.maximumPositionWeight);
  const approvedTargetWeight = clamp(Math.min(modelWeight, mandate.maximumPositionWeight), 0, mandate.maximumPositionWeight);
  const initialEntryWeight = approvedTargetWeight > 0 ? round(Math.max(0.0025, approvedTargetWeight * 0.45), 4) : 0;
  return {
    expectedExcessReturn: round(expectedExcessReturn, 4),
    confidence,
    expectedDownside: round(expectedDownside, 4),
    liquidityFactor: round(liquidityFactor, 4),
    correlationPenalty,
    riskBudget: 0.01,
    modelWeight: round(modelWeight, 4),
    maximumAllowedWeight: mandate.maximumPositionWeight,
    approvedTargetWeight: round(approvedTargetWeight, 4),
    initialEntryWeight,
  };
}

function buildPretradeControls({ signal, currentPrice, gates, sizing }) {
  const failures = [];
  const warnings = [];
  if (!currentPrice) failures.push('Cannot trade without a valid current price.');
  if (gates.some((item) => item.hard && item.status === 'fail')) failures.push('A hard decision gate failed.');
  if (sizing.approvedTargetWeight <= 0 && !failures.length) warnings.push('Approved target weight is zero; watchlist only.');
  return {
    failures,
    warnings,
    requiredConditions: [
      `limit order price at or below ${round((currentPrice || 0) * 1.006)}`,
      'spread below configured threshold',
      'no new material filing or halt before execution',
      'portfolio position and sector limits remain satisfied',
      'simulation/paper risk engine approves before any live adapter can be considered',
    ],
  };
}

function buildEntryPlan(sizing) {
  const target = sizing.approvedTargetWeight;
  if (!target) return [];
  return [
    { stage: 1, weight: round(sizing.initialEntryWeight, 4), condition: 'initial approval' },
    { stage: 2, weight: round(target * 0.25, 4), condition: 'price remains below valuation threshold and thesis is unchanged' },
    { stage: 3, weight: round(Math.max(0, target - sizing.initialEntryWeight - target * 0.25), 4), condition: 'fundamental catalyst or results confirm the thesis' },
  ].filter((stage) => stage.weight > 0);
}

function buildThesisRecord({ signal, valuation, returnDistribution, catalysts, premortem, sizing, now, holdingPeriodMonths }) {
  const reviewDate = new Date(now.getTime() + 34 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    ticker: signal?.symbol,
    purchaseDate: now.toISOString().slice(0, 10),
    purchasePrice: number(signal?.price),
    baseIntrinsicValue: valuation.base,
    expectedHoldingPeriodMonths: holdingPeriodMonths,
    primaryThesis: [
      `Probability-weighted intrinsic value ${valuation.probabilityWeighted} versus price ${number(signal?.price)}.`,
      `Expected total return ${returnDistribution.expectedTotalReturn}.`,
      `Staged target weight ${sizing.approvedTargetWeight}.`,
    ],
    keyAssumptions: ['source evidence remains reliable', 'business model remains understandable', 'stress-case loss remains inside tolerance'],
    catalysts,
    risks: premortem,
    earlyWarningIndicators: [...new Set(premortem.flatMap((item) => item.earlyWarningIndicators || []))].slice(0, 10),
    sellConditions: [
      `base intrinsic value falls below ${round(valuation.base * 0.82)}`,
      'new SEC filing or material event invalidates the business thesis',
      'financial-health gate falls below 35',
      `market price exceeds ${round(valuation.bull * 0.95)} without matching intrinsic-value improvement`,
      'position or sector risk exceeds mandate limits',
      'source/model data is proven wrong',
    ],
    nextRequiredReview: reviewDate,
  };
}

function buildSellDecisionTree({ signal, valuation, returnDistribution, portfolioFit, gates }) {
  const financial = gates.find((item) => item.name === 'financial-health');
  const business = gates.find((item) => item.name === 'business-understanding');
  const quality = gates.find((item) => item.name === 'business-quality');
  if (signal?.actionBias === 'sell-or-avoid') return { action: 'sell', primaryReason: 'Local Brain sell-or-avoid flag triggered.', validReasons: ['model or source data was proven weak'] };
  if (financial?.status === 'fail') return { action: 'sell', primaryReason: 'Financial solvency/cash-flow proxy deteriorated.', validReasons: ['cash-flow outlook deteriorated', 'debt risk increased'] };
  if (business?.status === 'fail') return { action: 'sell', primaryReason: 'Business model cannot be understood from current evidence.', validReasons: ['thesis invalidated'] };
  if (valuation.marginOfSafety < -0.08) return { action: 'sell', primaryReason: 'Price is above reasonable intrinsic value or expected return is unattractive.', validReasons: ['valuation became extreme', 'superior opportunity emerged'] };
  if (portfolioFit.violations.length) return { action: 'reduce', primaryReason: portfolioFit.violations[0], validReasons: ['position became too concentrated'] };
  if (quality?.score < 42 && returnDistribution.probabilityOf20PercentLoss > 0.25) return { action: 'reduce', primaryReason: 'Quality is weak and downside probability is elevated.', validReasons: ['competitive advantage weakened'] };
  return { action: 'hold', primaryReason: 'No valid sell condition fired; continue monitoring.', validReasons: [] };
}

function buildScores(gates) {
  const lookup = Object.fromEntries(gates.map((item) => [item.name, item.score]));
  const scores = {
    dataQuality: lookup['data-quality'] || 0,
    businessQuality: Math.round(avg([lookup['business-understanding'], lookup['business-quality']])),
    financialStrength: lookup['financial-health'] || 0,
    valuation: lookup['intrinsic-value'] || 0,
    catalyst: lookup.catalysts || 0,
    marketConfirmation: lookup['price-liquidity'] || 0,
    portfolioFit: lookup['portfolio-fit'] || 0,
  };
  scores.overall = Math.round(
    scores.dataQuality * 0.14 +
    scores.businessQuality * 0.14 +
    scores.financialStrength * 0.14 +
    scores.valuation * 0.2 +
    scores.catalyst * 0.08 +
    scores.marketConfirmation * 0.1 +
    scores.portfolioFit * 0.1 +
    (lookup['stress-tests'] || 0) * 0.1
  );
  return scores;
}

function chooseAction({ signal, scores, gates, hardFailures, sellTree, valuation, mandate }) {
  if (hardFailures.length) return signal?.actionBias === 'sell-or-avoid' ? 'sell' : 'hold';
  if (sellTree.action === 'sell') return 'sell';
  if (sellTree.action === 'reduce') return 'sell';
  if (valuation.marginOfSafety < 0) return scores.overall <= 40 ? 'sell' : 'hold';
  const failedSoft = gates.filter((item) => item.status === 'fail' && !item.hard).map((item) => item.name);
  if (failedSoft.includes('intrinsic-value')) return 'hold';
  const analystGate = gates.find((item) => item.name === 'analyst-recommendation-gate');
  if (analystGate?.evidence?.analystDriven && !analystGate.evidence.passed) return 'hold';
  if (scores.overall >= 72 && valuation.marginOfSafety >= mandate.requiredMarginOfSafety) return 'buy';
  if (scores.overall >= 55) return 'watch';
  if (scores.overall <= 34) return 'sell';
  return 'hold';
}

function buildPrimaryReasons(gates, action) {
  const passed = gates
    .filter((item) => item.status === 'pass')
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => `${item.name}: ${item.reason}`);
  if (String(action).toLowerCase() === 'buy') return passed;
  return gates
    .filter((item) => item.status !== 'pass')
    .slice(0, 5)
    .map((item) => `${item.name}: ${item.reason}`)
    .concat(passed)
    .slice(0, 5);
}

function inferSector(signal) {
  const text = `${signal?.theme || ''} ${signal?.symbol || ''}`.toLowerCase();
  if (/semiconductor|nvda|amd|soxx|chip/.test(text)) return 'semiconductors';
  if (/software|cloud|saas|crm|msft|snow|shop|pltr/.test(text)) return 'software';
  if (/energy|oil|gas|xle|xom|cvx/.test(text)) return 'energy';
  if (/defense|military|war|ita|lmt|rtx/.test(text)) return 'defense';
  if (/health|drug|pharma|lly|nvo|unh/.test(text)) return 'healthcare';
  if (/financial|bank|xlf|jpm|bac/.test(text)) return 'financials';
  if (/consumer|retail|ecommerce|amzn|wmt|cost/.test(text)) return 'consumer';
  return 'unknown';
}

function macroAdjustment(signal) {
  const macro = String(signal?.macroRisk || '').toLowerCase();
  const consumer = String(signal?.consumerBias || '').toLowerCase();
  let score = 0;
  if (/risk-off|recession|weak/.test(macro)) score -= 12;
  if (/risk-on|constructive|support/.test(macro)) score += 8;
  if (/weak|cautious/.test(consumer)) score -= 8;
  if (/strong|healthy/.test(consumer)) score += 8;
  score += (scoreValue(signal?.jsonDatasetScore, 50) - 50) * 0.2;
  return score;
}

function gateScore(gates, name) {
  return gates.find((item) => item.name === name)?.score || 0;
}

function evidenceList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean);
}

function scoreValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : fallback;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function avg(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return 0;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

module.exports = {
  VERSION,
  GLOBAL_MANDATE,
  DECISION_STEP_IDS,
  buildAgentMandate,
  buildDecisionFramework,
  evaluateSignalForAgent,
};
