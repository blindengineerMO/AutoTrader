const OpenAI = require('openai');
const { config } = require('../../config');
const providerCredentialRepo = require('../../db/repositories/providerCredentialRepo');
const ollamaClient = require('../ollamaClient');
const alpacaRules = require('../alpacaRulesService');
const crossSourceAgreement = require('../crossSourceAgreementService');
const logger = require('../../utils/logger');

const TOKEN_CHAR_RATIO = 4;
const STRATEGY_PROMPT_SAFETY_TOKENS = 500;

const SYSTEM_PROMPT = `You are a disciplined, moderately-aggressive day-trading strategist operating a small
real-money account ($100 starting capital) through Alpaca. Your job is to propose a short list of
buy/sell/hold actions for the current session based on the research data provided.
The input may include quote signals, autonomous news/macro/consumer-sales summaries,
local brain.js opportunity scores, and source evidence. Use that full context.

Hard constraints you must respect:
- Never propose more than 3 trades for the same symbol.
- Never propose spending more than the account's available cash.
- Never propose a buy whose estimated notional exceeds the configured max buy per order; this applies equally to whole-share and fractional-share orders.
- Fractional Alpaca orders are allowed only when fractional trading is enabled, the supplied Alpaca asset metadata has fractionable=true, and quantity uses 9 or fewer decimal places.
- Do not use notional orders. Use quantity only, and never propose a fractional short sale.
- Always review every current owned position in the supplied positions list and include an action for it: buy more using action "buy", hold using action "hold", or sell using action "sell".
- Prefer capital preservation over speculative swings when signals are weak or conflicting.
- A buy/sell proposal needs cross-source agreement. New buys require at least 3 independent evidence lanes; sells require at least 2. If fewer lanes agree, choose HOLD and explain what evidence is missing.
- Every action must include a concise, concrete rationale referencing the data you were given.
- If local AI scores and macro/news evidence conflict, explain the conflict and prefer HOLD unless quote momentum confirms the thesis.

Respond with ONLY a JSON object matching this shape, no prose outside the JSON:
{
  "actions": [{ "symbol": "AAPL", "action": "buy" | "sell" | "hold", "quantity": number|null, "rationale": "string" }],
  "overallRationale": "string"
}`;

function buildProviders(userId) {
  const providers = [];
  const userOpenAi = userId ? providerCredentialRepo.getSecret(userId, 'openai') : null;
  const userDeepSeek = userId ? providerCredentialRepo.getSecret(userId, 'deepseek') : null;
  const userGroq = userId ? providerCredentialRepo.getSecret(userId, 'groq') : null;

  const openaiApiKey = userOpenAi?.apiKey || config.openaiApiKey;
  const openaiModel = userOpenAi?.model || config.openaiModel;
  if (openaiApiKey) {
    providers.push({ client: new OpenAI({ apiKey: openaiApiKey }), model: openaiModel, provider: 'openai' });
  }
  const deepseekApiKey = userDeepSeek?.apiKey || config.deepseekApiKey;
  const deepseekModel = userDeepSeek?.model || config.deepseekModel;
  if (deepseekApiKey) {
    providers.push({
      client: new OpenAI({ apiKey: deepseekApiKey, baseURL: 'https://api.deepseek.com' }),
      model: deepseekModel,
      provider: 'deepseek',
    });
  }
  const groqApiKey = userGroq?.apiKey || config.groqApiKey;
  const groqModel = userGroq?.model || config.groqModel;
  if (groqApiKey) {
    providers.push({
      client: new OpenAI({ apiKey: groqApiKey, baseURL: 'https://api.groq.com/openai/v1' }),
      model: groqModel,
      provider: 'groq',
    });
  }
  // Appended last: a local Ollama instance only gets used when no hosted provider is
  // configured or every hosted provider above it failed, preserving today's fallback order.
  const userOllama = userId ? providerCredentialRepo.getSecret(userId, 'ollama') : null;
  const ollamaBaseUrl = userOllama?.baseUrl || config.ollamaBaseUrl;
  const ollamaModel = userOllama?.model || config.ollamaModel;
  if (ollamaBaseUrl) {
    providers.push({
      client: new OpenAI({ apiKey: 'ollama-local', baseURL: ollamaClient.buildOllamaOpenAiBaseUrl(ollamaBaseUrl) }),
      model: ollamaModel,
      provider: 'ollama',
    });
  }
  return providers;
}

async function requestStructuredCompletion({ providers, systemPrompt, userPrompt, onEvent = () => {} }) {
  let lastError;
  for (const { client, model, provider } of providers) {
    try {
      const prompt = preparePromptForProvider({ provider, systemPrompt, userPrompt, onEvent });
      emit(onEvent, 'strategy', 86, 'debug', 'Requesting structured completion from provider.', {
        provider,
        model,
        estimatedPromptTokens: estimatePromptTokens(systemPrompt, prompt),
      });
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });
      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      return { provider, model, parsed };
    } catch (err) {
      logger.warn('AI provider failed, trying next if available', { provider, error: err.message });
      emit(onEvent, 'strategy', 87, 'warn', 'Provider failed; trying next provider if available.', { provider, error: err.message });
      lastError = err;
    }
  }
  if (lastError) logger.warn('All AI providers failed for structured completion request', { error: lastError.message });
  return null;
}

function generateRulesBasedPlan({ userId, researchSnapshot, accountState, recentTradeCounts, positions = [], reason }) {
  const alpacaRuleSummary = alpacaRules.getRulesSummary({ userId });
  const positionSymbols = new Set((positions || []).map((position) => cleanSymbol(position.symbol)).filter(Boolean));
  const ranked = [...researchSnapshot.signals].sort((a, b) => {
    const aScore = a.localAiScore ?? (a.changePct || 0) - Math.abs(a.volatilityPct || 0) * 0.15;
    const bScore = b.localAiScore ?? (b.changePct || 0) - Math.abs(b.volatilityPct || 0) * 0.15;
    return bScore - aScore;
  });
  const actions = ranked.slice(0, 5).map((signal, index) => {
    const tradeCount = recentTradeCounts?.[signal.symbol] || 0;
    const ownedPosition = (positions || []).find((position) => cleanSymbol(position.symbol) === cleanSymbol(signal.symbol));
    if (tradeCount >= 3) {
      return {
        symbol: signal.symbol,
        action: 'hold',
        quantity: null,
        rationale: `${signal.symbol} is held because it already has ${tradeCount} trades in the last 24 hours.`,
      };
    }
    const strongLocalScore = signal.localAiScore === undefined || signal.localAiScore >= 66;
    if (ownedPosition && signal.actionBias === 'sell-or-avoid') {
      return {
        symbol: signal.symbol,
        action: 'sell',
        quantity: Number(ownedPosition.quantity || 0) || null,
        rationale: `${signal.symbol} is an owned position and the current research bias is sell-or-avoid with local score ${signal.localAiScore ?? 'n/a'}; board review recommends selling the held quantity.`,
      };
    }
    const buyQuantity = selectBuyQuantity({ signal, accountState, alpacaRuleSummary });
    if (index === 0 && strongLocalScore && signal.momentum === 'bullish' && buyQuantity) {
      return {
        symbol: signal.symbol,
        action: 'buy',
        quantity: buyQuantity,
        rationale: `${signal.symbol} ${ownedPosition ? 'is already owned and merits buying more because it' : 'leads the autonomous research ranking and'} has ${signal.changePct}% change, ${signal.volatilityPct}% intraday range, and local score ${signal.localAiScore ?? 'n/a'}; quantity respects Alpaca fractional rules and the max buy per order limit.`,
      };
    }
    return {
      symbol: signal.symbol,
      action: 'hold',
      quantity: null,
      rationale: `${signal.symbol} ${ownedPosition ? 'is an owned position to hold' : 'is held'} with ${signal.momentum} momentum, ${signal.changePct}% change, and local score ${signal.localAiScore ?? 'n/a'}; signal strength does not justify execution.`,
    };
  });
  for (const position of positions || []) {
    const symbol = cleanSymbol(position.symbol);
    if (!symbol || actions.some((action) => cleanSymbol(action.symbol) === symbol)) continue;
    actions.push({
      symbol,
      action: 'hold',
      quantity: null,
      rationale: `${symbol} is a current owned position (${position.quantity} shares at average cost $${Number(position.avg_cost_usd || 0).toFixed(2)}). No fresh ranked signal was attached, so the board keeps it on HOLD pending refreshed research.`,
    });
  }

  return {
    modelUsed: 'rules:fallback',
    raw: {
      actions,
      overallRationale:
        reason ||
        'AI providers were unavailable, so AutoTrader used a deterministic signal-ranked fallback strategy and preserved capital unless one clear bullish signal fit available buying power.',
    },
  };
}

async function generateTradingPlan({ userId, researchSnapshot, accountState, recentTradeCounts, positions = [], onEvent = () => {} }) {
  const providers = buildProviders(userId);
  const userPrompt = buildTradingPlanPrompt({ userId, researchSnapshot, accountState, recentTradeCounts, positions });

  if (!providers.length) {
    emit(onEvent, 'strategy', 85, 'warn', 'No AI credentials available; using transparent rules-based strategy fallback.');
    return generateRulesBasedPlan({
      researchSnapshot,
      accountState,
      recentTradeCounts,
      positions,
      reason: 'No AI provider credentials were configured, so the system generated a transparent rules-based simulation plan.',
    });
  }

  logger.info('Requesting trading plan from AI', { providers: providers.map((p) => p.provider), snapshotId: researchSnapshot.id });
  const result = await requestStructuredCompletion({ providers, systemPrompt: SYSTEM_PROMPT, userPrompt, onEvent });
  if (result) {
    emit(onEvent, 'strategy', 89, 'debug', 'Strategy provider returned structured trading plan.', {
      provider: result.provider,
      actions: result.parsed.actions?.length || 0,
    });
    return { modelUsed: `${result.provider}:${result.model}`, raw: result.parsed };
  }

  emit(onEvent, 'strategy', 89, 'warn', 'All strategy providers failed; using transparent rules-based fallback.');
  return generateRulesBasedPlan({
    researchSnapshot,
    accountState,
    recentTradeCounts,
    positions,
    reason: 'All AI providers failed or had no credits, so the system generated a transparent rules-based fallback plan.',
  });
}

function buildTradingPlanPrompt({ userId, researchSnapshot = {}, accountState = {}, recentTradeCounts = {}, positions = [] } = {}) {
  const summary = researchSnapshot.summary || {};
  const signalBySymbol = new Map((researchSnapshot.signals || []).map((signal) => [cleanSymbol(signal.symbol), signal]));
  const context = {
    instructions: 'Use this compact strategy context. The full crawl/source archive was intentionally summarized to fit the local model context.',
    positionInstructions: 'For every current position, include an action in the final JSON. Use action "buy" when buying more, "hold" when retaining, and "sell" when exiting/reducing. The rationale must say this is a current owned position review.',
    crossSourceAgreementRules: {
      buyRequiredIndependentLanes: crossSourceAgreement.BUY_REQUIRED_AGREEMENTS,
      sellRequiredIndependentLanes: crossSourceAgreement.SELL_REQUIRED_AGREEMENTS,
      instruction: 'Do not propose buy/sell unless the compact signal crossSourceAgreement for that direction passes. Use hold when agreement is insufficient.',
    },
    alpacaOrderRules: alpacaRules.getRulesSummary({ userId }),
    snapshot: {
      id: researchSnapshot.id || null,
      source: researchSnapshot.source || null,
      createdAt: researchSnapshot.created_at || researchSnapshot.createdAt || null,
    },
    accountState: compactObject(accountState, 1600),
    positions: compactPositions(positions, signalBySymbol),
    recentTradeCounts,
    signals: compactSignals(researchSnapshot.signals || [], summary),
    researchSummary: compactResearchSummary(summary),
  };
  return fitJsonToTokenBudget(context, Math.max(512, config.ollamaMaxPromptTokens - estimateTokens(SYSTEM_PROMPT) - STRATEGY_PROMPT_SAFETY_TOKENS));
}

function compactPositions(positions = [], signalBySymbol = new Map()) {
  return (positions || []).slice(0, 25).map((position) => {
    const symbol = cleanSymbol(position.symbol);
    const signal = signalBySymbol.get(symbol);
    const avgCost = Number(position.avg_cost_usd || 0);
    const currentPrice = Number(signal?.price || signal?.evidence?.quote?.current || avgCost || 0);
    const quantity = Number(position.quantity || 0);
    return {
      symbol,
      quantity,
      avgCostUsd: avgCost,
      currentResearchPriceUsd: currentPrice,
      costBasisUsd: Number((quantity * avgCost).toFixed(2)),
      marketValueUsd: Number((quantity * currentPrice).toFixed(2)),
      unrealizedPnlPct: avgCost > 0 && currentPrice > 0 ? Number((((currentPrice - avgCost) / avgCost) * 100).toFixed(2)) : null,
      researchSignal: signal ? {
        localAiScore: signal.localAiScore,
        actionBias: signal.actionBias,
        momentum: signal.momentum,
        changePct: signal.changePct,
        theme: signal.theme,
        topReasons: normalizeShortStrings(signal.evidence?.explanation || [], 3, 180),
      } : null,
    };
  });
}

function preparePromptForProvider({ provider, systemPrompt, userPrompt, onEvent = () => {} }) {
  if (provider !== 'ollama') return userPrompt;
  const maxTokens = Math.max(512, Number(config.ollamaMaxPromptTokens) || 4096);
  const availableUserTokens = Math.max(256, maxTokens - estimateTokens(systemPrompt) - STRATEGY_PROMPT_SAFETY_TOKENS);
  if (estimateTokens(userPrompt) <= availableUserTokens) return userPrompt;

  emit(onEvent, 'strategy', 86, 'warn', 'Compacted oversized local Ollama strategy prompt to fit context window.', {
    provider,
    originalEstimatedTokens: estimateTokens(userPrompt) + estimateTokens(systemPrompt),
    maxPromptTokens: maxTokens,
  });

  try {
    const parsed = JSON.parse(userPrompt);
    return fitJsonToTokenBudget({ compacted: true, ...parsed }, availableUserTokens);
  } catch {
    return JSON.stringify({
      compacted: true,
      warning: 'Original prompt exceeded local Ollama context and was text-truncated.',
      promptExcerpt: String(userPrompt || '').slice(0, availableUserTokens * TOKEN_CHAR_RATIO),
    });
  }
}

function compactSignals(signals, researchSummary = {}) {
  return [...signals]
    .sort((a, b) => (b.localAiScore ?? 0) - (a.localAiScore ?? 0))
    .slice(0, 12)
    .map((signal) => ({
      symbol: signal.symbol,
      companyName: signal.companyName || signal.name,
      price: signal.price,
      changePct: signal.changePct,
      volatilityPct: signal.volatilityPct,
      momentum: signal.momentum,
      localAiScore: signal.localAiScore,
      actionBias: signal.actionBias,
      financialEventScore: signal.financialEventScore,
      theme: signal.theme,
      alpacaAsset: compactAlpacaAsset(signal.alpacaAsset || signal.evidence?.alpacaAsset),
      crossSourceAgreement: {
        buy: crossSourceAgreement.evaluateSignalAgreement({ action: 'buy', signal, researchSummary }),
        sell: crossSourceAgreement.evaluateSignalAgreement({ action: 'sell', signal, researchSummary }),
      },
      evidence: compactSignalEvidence(signal.evidence),
    }));
}

function selectBuyQuantity({ signal, accountState, alpacaRuleSummary }) {
  const price = Number(signal?.price || 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  const buyingPower = Number(accountState?.buyingPowerUsd || accountState?.cashUsd || 0);
  const maxNotional = Math.min(buyingPower, Number(alpacaRuleSummary?.maxBuyOrderNotionalUsd || 100));
  if (maxNotional <= 0) return null;
  if (price <= maxNotional) return 1;

  const asset = signal?.alpacaAsset || signal?.evidence?.alpacaAsset || {};
  const canFractional = alpacaRuleSummary?.fractionalTradingEnabled && asset.fractionable === true;
  if (!canFractional || maxNotional < Number(alpacaRuleSummary?.fractionalMinNotionalUsd || 1)) return null;
  const quantity = alpacaRules.roundQuantity(maxNotional / price);
  return quantity > 0 ? quantity : null;
}

function compactAlpacaAsset(asset = {}) {
  if (!asset || typeof asset !== 'object') return null;
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange,
    status: asset.status,
    tradable: asset.tradable,
    fractionable: asset.fractionable,
  };
}

function compactSignalEvidence(evidence = {}) {
  return {
    explanation: normalizeShortStrings(evidence.explanation || evidence.reasons || [], 6, 240),
    brokerFactors: compactObject(evidence.brokerFactors || evidence.companyFactors || {}, 1000),
    historicalWatchFactors: compactObject(evidence.historicalWatchFactors || {}, 1000),
    investorPlaybook: compactObject(evidence.investorPlaybook || {}, 900),
    jsonDatasets: compactObject(evidence.jsonDatasets || {}, 900),
    financialEvents: normalizeShortStrings(evidence.financialEvents || [], 6, 200),
  };
}

function compactResearchSummary(summary = {}) {
  const narrative = summary.reportNarrative || {};
  const prePlan = summary.prePlan || {};
  return {
    fetchedAt: summary.fetchedAt,
    narrativeSummary: cleanText(narrative.summary).slice(0, 900),
    topCandidates: (narrative.topCandidates || []).slice(0, 8).map((candidate) => ({
      symbol: candidate.symbol,
      score: candidate.score,
      bias: candidate.bias,
      financialEventScore: candidate.financialEventScore,
      reasons: normalizeShortStrings(candidate.reasons || [], 4, 220),
    })),
    prePlan: {
      thesis: cleanText(prePlan.thesis).slice(0, 700),
      themes: normalizeShortStrings(prePlan.themes || [], 8, 120),
      candidates: (prePlan.candidates || []).slice(0, 10).map((candidate) => ({
        symbol: candidate.symbol,
        companyName: candidate.companyName,
        theme: candidate.theme,
        reason: cleanText(candidate.reason || candidate.thesis || '').slice(0, 220),
      })),
    },
    chatResearch: {
      summary: cleanText(summary.chatResearch?.summary).slice(0, 800),
      candidateHints: (summary.chatResearch?.candidateHints || []).slice(0, 8).map((hint) => ({
        symbol: hint.symbol,
        companyName: hint.companyName,
        confidence: hint.confidence,
        reason: cleanText(hint.reason || hint.reasons?.[0] || '').slice(0, 240),
      })),
      riskNotes: normalizeShortStrings(summary.chatResearch?.riskNotes || [], 6, 180),
    },
    macro: {
      riskBias: summary.macro?.riskBias,
      indicators: (summary.macro?.indicators || narrative.macroIndicators || []).slice(0, 8).map((item) => compactObject(item, 500)),
    },
    consumer: {
      consumerBias: summary.consumer?.consumerBias,
      reports: (summary.consumer?.reports || narrative.consumerReports || []).slice(0, 6).map((item) => compactObject(item, 500)),
    },
    jsonDatasets: {
      compositeRiskScore: summary.jsonDatasets?.compositeRiskScore,
      opportunityScore: summary.jsonDatasets?.opportunityScore,
      categoryScores: compactObject(summary.jsonDatasets?.categoryScores || {}, 1400),
    },
    companyWorkspace: (summary.companyWorkspace || []).slice(0, 8).map((record) => ({
      symbol: record.symbol,
      companyName: record.companyName,
      compositeScore: record.compositeScore,
      summary: cleanText(record.summary).slice(0, 300),
    })),
    sourceStack: (summary.sourceStack || []).slice(0, 12).map((source) => ({
      name: cleanText(source.name).slice(0, 160),
      type: source.type,
      relevanceScore: source.relevanceScore,
      credibilityScore: source.credibilityScore,
    })),
  };
}

function fitJsonToTokenBudget(value, maxTokens) {
  let current = value;
  let json = JSON.stringify(current);
  if (estimateTokens(json) <= maxTokens) return json;

  current = {
    ...current,
    researchSummary: {
      ...current.researchSummary,
      sourceStack: (current.researchSummary?.sourceStack || []).slice(0, 6),
      companyWorkspace: (current.researchSummary?.companyWorkspace || []).slice(0, 5),
      macro: {
        ...current.researchSummary?.macro,
        indicators: (current.researchSummary?.macro?.indicators || []).slice(0, 4),
      },
      consumer: {
        ...current.researchSummary?.consumer,
        reports: (current.researchSummary?.consumer?.reports || []).slice(0, 3),
      },
    },
    signals: (current.signals || []).slice(0, 8),
  };
  json = JSON.stringify(current);
  if (estimateTokens(json) <= maxTokens) return json;

  current.signals = (current.signals || []).slice(0, 5).map((signal) => ({
    symbol: signal.symbol,
    price: signal.price,
    changePct: signal.changePct,
    volatilityPct: signal.volatilityPct,
    momentum: signal.momentum,
    localAiScore: signal.localAiScore,
    actionBias: signal.actionBias,
    evidence: { explanation: normalizeShortStrings(signal.evidence?.explanation || [], 3, 160) },
  }));
  current.researchSummary = {
    narrativeSummary: cleanText(current.researchSummary?.narrativeSummary).slice(0, 600),
    topCandidates: (current.researchSummary?.topCandidates || []).slice(0, 5),
    chatResearch: {
      summary: cleanText(current.researchSummary?.chatResearch?.summary).slice(0, 500),
      candidateHints: (current.researchSummary?.chatResearch?.candidateHints || []).slice(0, 5),
      riskNotes: (current.researchSummary?.chatResearch?.riskNotes || []).slice(0, 4),
    },
  };
  json = JSON.stringify(current);
  if (estimateTokens(json) <= maxTokens) return json;

  return JSON.stringify({
    compacted: true,
    warning: 'Strategy context was aggressively compacted to fit local model context.',
    signals: current.signals,
    accountState: current.accountState,
    positions: (current.positions || []).slice(0, 25).map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      avgCostUsd: position.avgCostUsd,
      currentResearchPriceUsd: position.currentResearchPriceUsd,
      unrealizedPnlPct: position.unrealizedPnlPct,
      researchSignal: position.researchSignal ? {
        localAiScore: position.researchSignal.localAiScore,
        actionBias: position.researchSignal.actionBias,
      } : null,
    })),
    positionInstructions: current.positionInstructions,
    alpacaOrderRules: current.alpacaOrderRules,
    recentTradeCounts: current.recentTradeCounts,
    narrativeSummary: cleanText(current.researchSummary?.narrativeSummary).slice(0, Math.max(200, maxTokens * TOKEN_CHAR_RATIO - 2200)),
  });
}

function compactObject(value, maxChars) {
  if (value === undefined || value === null) return value;
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return value;
  return { truncated: true, json: json.slice(0, maxChars) };
}

function normalizeShortStrings(items, limit, maxChars) {
  const values = Array.isArray(items) ? items : [items];
  return values.map((item) => cleanText(typeof item === 'string' ? item : JSON.stringify(item))).filter(Boolean).slice(0, limit).map((item) => item.slice(0, maxChars));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function estimatePromptTokens(systemPrompt, userPrompt) {
  return estimateTokens(systemPrompt) + estimateTokens(userPrompt);
}

function estimateTokens(value) {
  return Math.ceil(String(value || '').length / TOKEN_CHAR_RATIO);
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  generateTradingPlan,
  generateRulesBasedPlan,
  buildProviders,
  requestStructuredCompletion,
  buildTradingPlanPrompt,
  preparePromptForProvider,
  estimatePromptTokens,
};
