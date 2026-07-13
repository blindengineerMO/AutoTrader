const OpenAI = require('openai');
const { config } = require('../../config');
const providerCredentialRepo = require('../../db/repositories/providerCredentialRepo');
const ollamaClient = require('../ollamaClient');
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
- Prefer capital preservation over speculative swings when signals are weak or conflicting.
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

function generateRulesBasedPlan({ researchSnapshot, accountState, recentTradeCounts, reason }) {
  const ranked = [...researchSnapshot.signals].sort((a, b) => {
    const aScore = a.localAiScore ?? (a.changePct || 0) - Math.abs(a.volatilityPct || 0) * 0.15;
    const bScore = b.localAiScore ?? (b.changePct || 0) - Math.abs(b.volatilityPct || 0) * 0.15;
    return bScore - aScore;
  });
  const actions = ranked.slice(0, 5).map((signal, index) => {
    const tradeCount = recentTradeCounts?.[signal.symbol] || 0;
    if (tradeCount >= 3) {
      return {
        symbol: signal.symbol,
        action: 'hold',
        quantity: null,
        rationale: `${signal.symbol} is held because it already has ${tradeCount} trades in the last 24 hours.`,
      };
    }
    const strongLocalScore = signal.localAiScore === undefined || signal.localAiScore >= 66;
    if (index === 0 && strongLocalScore && signal.momentum === 'bullish' && (accountState.buyingPowerUsd || accountState.cashUsd || 0) >= signal.price) {
      return {
        symbol: signal.symbol,
        action: 'buy',
        quantity: 1,
        rationale: `${signal.symbol} leads the autonomous research ranking with ${signal.changePct}% change, ${signal.volatilityPct}% intraday range, and local score ${signal.localAiScore ?? 'n/a'}.`,
      };
    }
    return {
      symbol: signal.symbol,
      action: 'hold',
      quantity: null,
      rationale: `${signal.symbol} is ${signal.momentum} with ${signal.changePct}% change and local score ${signal.localAiScore ?? 'n/a'}; signal strength does not justify execution.`,
    };
  });

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

async function generateTradingPlan({ userId, researchSnapshot, accountState, recentTradeCounts, onEvent = () => {} }) {
  const providers = buildProviders(userId);
  const userPrompt = buildTradingPlanPrompt({ researchSnapshot, accountState, recentTradeCounts });

  if (!providers.length) {
    emit(onEvent, 'strategy', 85, 'warn', 'No AI credentials available; using transparent rules-based strategy fallback.');
    return generateRulesBasedPlan({
      researchSnapshot,
      accountState,
      recentTradeCounts,
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
    reason: 'All AI providers failed or had no credits, so the system generated a transparent rules-based fallback plan.',
  });
}

function buildTradingPlanPrompt({ researchSnapshot = {}, accountState = {}, recentTradeCounts = {} } = {}) {
  const summary = researchSnapshot.summary || {};
  const context = {
    instructions: 'Use this compact strategy context. The full crawl/source archive was intentionally summarized to fit the local model context.',
    snapshot: {
      id: researchSnapshot.id || null,
      source: researchSnapshot.source || null,
      createdAt: researchSnapshot.created_at || researchSnapshot.createdAt || null,
    },
    accountState: compactObject(accountState, 1600),
    recentTradeCounts,
    signals: compactSignals(researchSnapshot.signals || []),
    researchSummary: compactResearchSummary(summary),
  };
  return fitJsonToTokenBudget(context, Math.max(512, config.ollamaMaxPromptTokens - estimateTokens(SYSTEM_PROMPT) - STRATEGY_PROMPT_SAFETY_TOKENS));
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

function compactSignals(signals) {
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
      evidence: compactSignalEvidence(signal.evidence),
    }));
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
