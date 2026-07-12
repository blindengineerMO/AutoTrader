const OpenAI = require('openai');
const { config } = require('../../config');
const providerCredentialRepo = require('../../db/repositories/providerCredentialRepo');
const logger = require('../../utils/logger');

const SYSTEM_PROMPT = `You are a disciplined, moderately-aggressive day-trading strategist operating a small
real-money account ($100 starting capital) through Robinhood. Your job is to propose a short list of
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
  return providers;
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

  const userPrompt = JSON.stringify({
    signals: researchSnapshot.signals,
    researchSummary: researchSnapshot.summary,
    accountState,
    recentTradeCounts,
  });

  let lastError;
  if (!providers.length) {
    emit(onEvent, 'strategy', 85, 'warn', 'No AI credentials available; using transparent rules-based strategy fallback.');
    return generateRulesBasedPlan({
      researchSnapshot,
      accountState,
      recentTradeCounts,
      reason: 'No AI provider credentials were configured, so the system generated a transparent rules-based simulation plan.',
    });
  }

  for (const { client, model, provider } of providers) {
    logger.info('Requesting trading plan from AI', { provider, model, snapshotId: researchSnapshot.id });
    try {
      emit(onEvent, 'strategy', 86, 'debug', 'Requesting final trading plan from strategy provider.', {
        provider,
        model,
      });
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      emit(onEvent, 'strategy', 89, 'debug', 'Strategy provider returned structured trading plan.', {
        provider,
        actions: parsed.actions?.length || 0,
      });
      return { modelUsed: `${provider}:${model}`, raw: parsed };
    } catch (err) {
      logger.warn('AI provider failed, trying next if available', { provider, error: err.message });
      emit(onEvent, 'strategy', 87, 'warn', 'Strategy provider failed; trying next provider or fallback.', {
        provider,
        error: err.message,
      });
      lastError = err;
    }
  }

  emit(onEvent, 'strategy', 89, 'warn', 'All strategy providers failed; using transparent rules-based fallback.');
  return generateRulesBasedPlan({
    researchSnapshot,
    accountState,
    recentTradeCounts,
    reason: `All AI providers failed or had no credits (${lastError?.message || 'unknown error'}), so the system generated a transparent rules-based fallback plan.`,
  });
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = { generateTradingPlan, generateRulesBasedPlan };
