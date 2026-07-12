const fs = require('fs');
const path = require('path');

const DEFAULT_PLAYBOOK_PATH = path.join(process.cwd(), 'tmp', 'data.json');

let cache = null;

function loadPlaybook(filePath = process.env.INVESTOR_PLAYBOOK_PATH || DEFAULT_PLAYBOOK_PATH) {
  try {
    const stat = fs.statSync(filePath);
    if (cache?.filePath === filePath && cache?.mtimeMs === stat.mtimeMs) return cache.playbook;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(extractFirstJsonObject(raw));
    const playbook = normalizePlaybook(parsed, filePath);
    cache = { filePath, mtimeMs: stat.mtimeMs, playbook };
    return playbook;
  } catch (err) {
    return emptyPlaybook(filePath, err.message);
  }
}

function scoreCandidate({ candidate, quote, changePct = 0, volatilityPct = 0, sentiment = 0, macro, consumer, companyRecord, factorIntel }) {
  const playbook = loadPlaybook();
  if (!playbook.available) {
    return { normalized: 0.5, compositeScore: 50, available: false, indicators: [], investorMatches: [], sellRisks: [], source: playbook.source };
  }

  const summary = companyRecord?.summary || {};
  const factors = summary.factors || {};
  const fiveYearReturnPct = Number(summary.history?.fiveYearReturnPct || 0);
  const brokerNormalized = factorIntel?.normalized ?? clamp01((summary.compositeScore || 50) / 100);
  const consumerScore = consumer?.consumerBias === 'constructive' ? 0.68 : consumer?.consumerBias === 'softening' ? 0.34 : 0.5;
  const macroLiquidity = macro?.riskBias === 'risk-on' ? 0.74 : macro?.riskBias === 'risk-off' ? 0.28 : 0.5;
  const momentumScore = clamp01(((changePct || 0) + 8) / 16);
  const sentimentScore = clamp01(((sentiment || 0) + 4) / 8);
  const volatilityRisk = clamp01((volatilityPct || 0) / 8);

  const indicatorScores = {
    'price relative to estimated value': average([
      scoreFactor(factors.lowCostHighYield),
      quote?.current && quote.current < 50 ? 0.68 : 0.46,
      fiveYearReturnPct > 90 ? 0.36 : 0.58,
    ]),
    'fundamental quality and cash generation': average([
      brokerNormalized,
      scoreFactor(factors.requiredEnergyValuation),
      scoreFactor(factors.populationDemand),
      scoreFactor(factors.deepHistoryTrend),
    ]),
    'liquidity, interest rates and credit conditions': average([macroLiquidity, 1 - volatilityRisk * 0.45]),
    'expectations versus actual developments': average([
      sentimentScore,
      clamp01((candidate.themeHits || 0) / 8),
      consumerScore,
    ]),
    'price trend or market confirmation': average([
      momentumScore,
      fiveYearReturnPct > 25 ? 0.72 : fiveYearReturnPct < -10 ? 0.28 : 0.5,
    ]),
    'investor psychology and positioning': average([
      volatilityPct > 5 ? 0.35 : 0.58,
      sentiment < -1 && brokerNormalized > 0.55 ? 0.66 : sentiment > 2 ? 0.48 : 0.54,
    ]),
    'asymmetric payoff and margin of safety': average([
      scoreFactor(factors.lowCostHighYield),
      brokerNormalized,
      1 - volatilityRisk * 0.5,
    ]),
  };

  const indicators = playbook.consensusPurchaseIndicators.map((indicator) => {
    const key = indicator.indicator.toLowerCase();
    const score = indicatorScores[key] ?? 0.5;
    return {
      rank: indicator.rank,
      indicator: indicator.indicator,
      score: Math.round(score * 100),
      weight: indicator.weight,
      usedBy: indicator.usedBy,
      interpretation: indicator.interpretation,
    };
  });

  const weighted = indicators.reduce((sum, item) => sum + (item.score / 100) * item.weight, 0);
  const totalWeight = indicators.reduce((sum, item) => sum + item.weight, 0) || 1;
  const normalized = clamp01(weighted / totalWeight);
  const sellRisks = detectSellRisks({
    playbook,
    macro,
    sentiment,
    changePct,
    volatilityPct,
    fiveYearReturnPct,
    brokerNormalized,
  });

  return {
    available: true,
    source: playbook.source,
    title: playbook.title,
    investorCount: playbook.investorCount,
    normalized,
    compositeScore: Math.round(normalized * 100),
    indicators: indicators.sort((a, b) => b.score - a.score).slice(0, 5),
    investorMatches: matchInvestors(playbook, indicators).slice(0, 4),
    sellRisks,
    conclusion: playbook.keyConclusion,
  };
}

function normalizePlaybook(data, filePath) {
  const consensus = data.cross_investor_consensus || {};
  const purchase = (consensus.most_common_purchase_indicators || []).map((item) => ({
    rank: item.rank,
    indicator: item.indicator,
    usedBy: item.used_by || [],
    interpretation: item.interpretation,
    weight: Number((1 / Math.max(1, item.rank)).toFixed(3)),
  }));
  return {
    available: true,
    source: {
      type: 'local-research-artifact',
      path: filePath,
      title: data.metadata?.title || 'Investor playbook research',
      researchDate: data.metadata?.research_date || null,
      limitations: data.metadata?.important_limitations || [],
    },
    title: data.metadata?.title || 'Investor playbook research',
    investorCount: data.investors?.length || 0,
    investors: (data.investors || []).map((investor) => ({
      name: investor.name,
      strategyType: investor.strategy_type,
      horizon: investor.typical_time_horizon,
      indicators: investor.purchase_indicators || [],
      sellDiscipline: investor.sell_discipline || [],
      sources: (investor.sources || []).map((source) => ({
        ...source,
        url: cleanMarkdownUrl(source.url),
      })),
      confidence: investor.evidence_confidence,
    })),
    consensusPurchaseIndicators: purchase,
    consensusSellIndicators: consensus.most_common_sell_indicators || [],
    practicalFramework: data.practical_indicator_framework || {},
    keyConclusion: data.key_conclusion || null,
  };
}

function getPlaybookSummary() {
  const playbook = loadPlaybook();
  return {
    available: playbook.available,
    title: playbook.title,
    source: playbook.source,
    investorCount: playbook.investorCount || 0,
    consensusPurchaseIndicators: playbook.consensusPurchaseIndicators || [],
    consensusSellIndicators: playbook.consensusSellIndicators || [],
    keyConclusion: playbook.keyConclusion || null,
  };
}

function detectSellRisks({ playbook, macro, sentiment, changePct, volatilityPct, fiveYearReturnPct, brokerNormalized }) {
  const risks = [];
  if (brokerNormalized < 0.42) risks.push(playbook.consensusSellIndicators.find((item) => /fundamental/i.test(item.indicator)));
  if (macro?.riskBias === 'risk-off') risks.push(playbook.consensusSellIndicators.find((item) => /liquidity|policy/i.test(item.indicator)));
  if (changePct < -2 || fiveYearReturnPct < -10) risks.push(playbook.consensusSellIndicators.find((item) => /trend/i.test(item.indicator)));
  if (volatilityPct > 6 && sentiment < 0) risks.push(playbook.consensusSellIndicators.find((item) => /portfolio risk/i.test(item.indicator)));
  return risks.filter(Boolean).map((risk) => ({ indicator: risk.indicator, description: risk.description })).slice(0, 4);
}

function matchInvestors(playbook, indicators) {
  const topNames = new Set(indicators.slice(0, 3).flatMap((indicator) => indicator.usedBy));
  return playbook.investors
    .filter((investor) => [...topNames].some((name) => investor.name.toLowerCase().includes(name.toLowerCase().split(' ')[0])))
    .map((investor) => ({
      name: investor.name,
      strategyType: investor.strategyType,
      horizon: investor.horizon,
      confidence: investor.confidence,
    }));
}

function extractFirstJsonObject(value) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return value;
}

function cleanMarkdownUrl(value) {
  if (!value) return value;
  const match = String(value).match(/\((https?:\/\/[^)]+)\)/);
  return match?.[1] || value;
}

function scoreFactor(factor) {
  return factor?.score === undefined ? 0.5 : clamp01(factor.score / 100);
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0.5;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function emptyPlaybook(filePath, error) {
  return {
    available: false,
    title: 'Investor playbook unavailable',
    source: { type: 'local-research-artifact', path: filePath, error },
    investorCount: 0,
    investors: [],
    consensusPurchaseIndicators: [],
    consensusSellIndicators: [],
    practicalFramework: {},
    keyConclusion: null,
  };
}

module.exports = {
  loadPlaybook,
  getPlaybookSummary,
  scoreCandidate,
  extractFirstJsonObject,
};
