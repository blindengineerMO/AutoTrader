const OpenAI = require('openai');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const duckAiWebClient = require('./duckAiWebClient');
const ollamaClient = require('./ollamaClient');
const ollamaResearchTools = require('./ollamaResearchToolService');

const TOKEN_CHAR_RATIO = 4;
const OLLAMA_PROMPT_SAFETY_TOKENS = 300;
const OLLAMA_CHUNK_RETRY_ATTEMPTS = 2;

const SYSTEM_PROMPT = `You are an autonomous investment research assistant inside AutoTrader.
Use only the evidence supplied in the prompt. Do not invent URLs, prices, or facts.
Your job is to find new public-company or sector-proxy research leads, explain why they matter,
and recommend follow-up URLs that AutoTrader should crawl later.

Return only JSON matching this shape:
{
  "summary": "short research synthesis",
  "candidateHints": [
    {
      "symbol": "NVDA",
      "companyName": "NVIDIA",
      "reason": "why this deserves follow-up",
      "confidence": 0.0,
      "sourceUrls": ["https://example.com/source"]
    }
  ],
  "sourceHints": [
    {
      "url": "https://example.com/source",
      "title": "source title",
      "reason": "why AutoTrader should crawl it",
      "tags": ["market", "ai"]
    }
  ],
  "riskNotes": ["specific caveat"]
}`;

const ARTICLE_COMPREHENSION_SYSTEM_PROMPT = `You are an autonomous investment research assistant inside AutoTrader.
You will be shown one crawled news article plus a short list of already-classified event categories
(e.g. "war or geopolitical conflict", "sanctions or trade policy") and a small set of example Google-search
query templates drawn from AutoTrader's research playbook for related research dimensions.

Your job is to read the article and reason about its indirect, second-order investment implications —
not just companies named in the article. For example, an article about a war should lead you to identify
categories of companies that would see increased demand (e.g. military equipment manufacturers), not just
companies already mentioned by name. Use only evidence in the article; do not invent facts, prices, or URLs.

Return only JSON matching this shape:
{
  "reasoning": "short causal chain from the article's subject to an investment implication",
  "inferredCompanies": [
    { "name": "company or sector-proxy name", "symbol": "TICKER or empty string", "reason": "why this follows from the article" }
  ],
  "followUpQueries": ["concrete google search query to research one of the inferred companies or the underlying theme"]
}`;

async function runChatResearch({ userId, news, learned, macro, consumer, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, discoveredCompanies = [], onEvent = () => {} } = {}) {
  const providers = buildProviders(userId, SYSTEM_PROMPT);
  const payload = buildResearchPayload({ news, learned, macro, consumer, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, discoveredCompanies });
  const results = [];

  if (!providers.length) {
    emit(onEvent, 'chat-research', 36, 'debug', 'No supported chat-research providers configured; continuing without chat augmentation.', {});
    return emptyResult();
  }

  for (const provider of providers) {
    if (provider.kind === 'unsupported-web-chat') {
      results.push(skippedDuckAi(provider));
      emit(onEvent, 'chat-research', 36, 'warn', 'Duck.ai public webapp automation skipped; no endpoint configured and browser mode is disabled.', {
        provider: provider.provider,
        publicUrl: provider.publicUrl,
      });
      continue;
    }

    try {
      if (provider.provider === 'ollama' && results.some((result) => result.available === false)) {
        emit(onEvent, 'chat-research', 37, 'info', 'External chat research was unavailable; falling back to local Ollama research agent.', {
          provider: provider.provider,
          model: provider.model,
          failedProviders: results.filter((result) => result.available === false).map((result) => result.provider),
        });
      } else if (provider.provider === 'ollama') {
        emit(onEvent, 'chat-research', 36, 'info', 'Using local Ollama research agent before external chat providers.', {
          provider: provider.provider,
          model: provider.model,
          baseUrl: provider.baseUrl,
          toolCalling: config.ollamaToolCallingEnabled,
        });
      }
      emit(onEvent, 'chat-research', 36, 'debug', 'Requesting autonomous research augmentation from chat provider.', {
        provider: provider.provider,
        model: provider.model,
      });
      const result = await provider.ask(payload, { onEvent });
      const normalized = normalizeProviderResult(provider, result);
      persistSourceHints(userId, normalized.sourceHints, provider.provider);
      emit(onEvent, 'chat-research', 37, 'debug', 'Chat provider returned research leads.', {
        provider: provider.provider,
        candidates: normalized.candidateHints.length,
        sourceHints: normalized.sourceHints.length,
      });
      results.push(normalized);
      if (provider.provider === 'ollama' && config.chatResearchPreferOllama) {
        emit(onEvent, 'chat-research', 38, 'debug', 'Local Ollama research completed; skipping external chat providers.', {
          provider: provider.provider,
          model: provider.model,
        });
        break;
      }
    } catch (err) {
      const stopAfterLocalFailure = provider.provider === 'ollama'
        && config.chatResearchPreferOllama
        && !config.chatResearchExternalFallbackEnabled;
      emit(onEvent, 'chat-research', 37, 'warn', stopAfterLocalFailure
        ? 'Local Ollama research failed; external chat fallback is disabled by local-first policy.'
        : 'Chat research provider failed; continuing with crawl-first research.', {
        provider: provider.provider,
        error: err.message,
      });
      results.push({
        provider: provider.provider,
        model: provider.model,
        available: false,
        skipped: false,
        error: err.message,
        summary: '',
        candidateHints: [],
        sourceHints: [],
        riskNotes: [],
      });
      if (stopAfterLocalFailure) break;
    }
  }

  return combineResults(results);
}

async function runArticleComprehension({ userId, article, eventCategories = [], queryTemplates = [], onEvent = () => {} } = {}) {
  const providers = buildProviders(userId, ARTICLE_COMPREHENSION_SYSTEM_PROMPT);
  if (!providers.length) {
    emit(onEvent, 'article-comprehension', 13, 'debug', 'No supported chat-research providers configured; skipping article comprehension.', {
      url: article?.url,
    });
    return emptyArticleComprehensionResult();
  }

  const payload = {
    task: 'Read this article and infer indirect investment implications beyond companies named directly in the text.',
    article: {
      title: cleanText(article?.title).slice(0, 300),
      url: article?.url,
      excerpt: cleanText(article?.excerpt || article?.text).slice(0, 2000),
    },
    eventCategories,
    exampleQueryTemplates: queryTemplates.slice(0, 12),
  };

  for (const provider of providers) {
    if (provider.kind === 'unsupported-web-chat') continue;
    try {
      const result = await provider.ask(payload, { onEvent });
      const normalized = normalizeArticleComprehensionResult(provider, result);
      emit(onEvent, 'article-comprehension', 13, 'debug', 'Chat provider inferred article implications.', {
        provider: provider.provider,
        url: article?.url,
        inferredCompanies: normalized.inferredCompanies.length,
        followUpQueries: normalized.followUpQueries.length,
      });
      return normalized;
    } catch (err) {
      emit(onEvent, 'article-comprehension', 13, 'warn', 'Article comprehension provider failed; trying next provider.', {
        provider: provider.provider,
        url: article?.url,
        error: err.message,
      });
    }
  }

  return emptyArticleComprehensionResult();
}

function normalizeArticleComprehensionResult(provider, result) {
  return {
    provider: provider.provider,
    reasoning: cleanText(result?.reasoning).slice(0, 500),
    inferredCompanies: (Array.isArray(result?.inferredCompanies) ? result.inferredCompanies : [])
      .map((item) => ({
        name: cleanText(item.name).slice(0, 120),
        symbol: cleanSymbol(item.symbol),
        reason: cleanText(item.reason).slice(0, 300),
      }))
      .filter((item) => item.name)
      .slice(0, 10),
    followUpQueries: (Array.isArray(result?.followUpQueries) ? result.followUpQueries : [])
      .map((query) => cleanText(query).slice(0, 200))
      .filter(Boolean)
      .slice(0, 6),
  };
}

function emptyArticleComprehensionResult() {
  return { provider: null, reasoning: '', inferredCompanies: [], followUpQueries: [] };
}

function buildProviders(userId, systemPrompt = SYSTEM_PROMPT) {
  const providers = [];
  if (config.chatResearchPreferOllama) addOllamaProvider(providers, userId, systemPrompt);

  const userXai = userId ? providerCredentialRepo.getSecret(userId, 'xai-grok') : null;
  const xaiApiKey = userXai?.apiKey || config.xaiApiKey;
  const xaiModel = userXai?.model || config.xaiModel;
  if (xaiApiKey) {
    const client = new OpenAI({ apiKey: xaiApiKey, baseURL: 'https://api.x.ai/v1' });
    providers.push({
      provider: 'xai-grok',
      model: xaiModel,
      ask: async (payload) => {
        const completion = await client.chat.completions.create({
          model: xaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        });
        return JSON.parse(completion.choices[0]?.message?.content || '{}');
      },
    });
  }

  const userGemini = userId ? providerCredentialRepo.getSecret(userId, 'gemini') : null;
  const geminiApiKey = userGemini?.apiKey || config.geminiApiKey;
  const geminiModel = userGemini?.model || config.geminiModel;
  if (geminiApiKey) {
    providers.push({
      provider: 'gemini',
      model: geminiModel,
      ask: (payload) => askGemini({ apiKey: geminiApiKey, model: geminiModel, payload, systemPrompt }),
    });
  }

  const userDuck = userId ? providerCredentialRepo.getSecret(userId, 'duck-ai') : null;
  const duckEndpoint = userDuck?.sanctionedEndpoint || config.duckAiResearch.sanctionedEndpoint;
  if (duckEndpoint) {
    providers.push({
      provider: 'duck-ai',
      model: userDuck?.model || config.duckAiResearch.model || 'duck-ai-sanctioned-endpoint',
      ask: (payload) => askSanctionedDuckEndpoint({ endpoint: duckEndpoint, payload, systemPrompt }),
    });
  } else if (config.duckAiResearch.enabled && config.duckAiResearch.browserEnabled) {
    providers.push({
      provider: 'duck-ai',
      model: userDuck?.model || config.duckAiResearch.model || 'public-webapp-session',
      ask: (payload) => duckAiWebClient.askDuckAiWeb({ payload, systemPrompt }),
    });
  } else if (config.duckAiResearch.enabled) {
    providers.push({
      provider: 'duck-ai',
      model: 'public-web-chat',
      kind: 'unsupported-web-chat',
      publicUrl: config.duckAiResearch.publicUrl,
    });
  }

  if (!config.chatResearchPreferOllama) addOllamaProvider(providers, userId, systemPrompt);

  return providers;
}

function resolveOllamaInstances(userId) {
  const configured = userId ? settingsRepo.getOllamaInstances(userId).filter((instance) => instance.enabled) : [];
  if (configured.length) {
    return configured.map((instance) => ({ baseUrl: instance.baseUrl, model: instance.model, label: instance.label }));
  }
  const userOllama = userId ? providerCredentialRepo.getSecret(userId, 'ollama') : null;
  const baseUrl = userOllama?.baseUrl || config.ollamaBaseUrl;
  const model = userOllama?.model || config.ollamaModel;
  return baseUrl && model ? [{ baseUrl, model }] : [];
}

function addOllamaProvider(providers, userId, systemPrompt) {
  const instances = resolveOllamaInstances(userId);
  if (!instances.length) return;
  providers.push({
    provider: 'ollama',
    model: instances[0].model,
    baseUrl: instances[0].baseUrl,
    role: 'local-interpretation',
    ask: (payload, { onEvent = () => {} } = {}) => askOllamaResearchAgent({
      instances,
      payload,
      systemPrompt,
      onEvent,
    }),
  });
}

async function askOllamaResearchAgent({ instances, payload, systemPrompt, onEvent = () => {} }) {
  const localSystemPrompt = buildLocalOllamaSystemPrompt(systemPrompt);
  const payloadChunks = buildOllamaPayloadChunks(payload, localSystemPrompt);
  if (payloadChunks.length > 1) {
    emit(onEvent, 'ollama-chunking', 36, 'debug', 'Split local Ollama research into smaller questions for context safety.', {
      chunks: payloadChunks.length,
      maxPromptTokens: config.ollamaMaxPromptTokens,
    });
  }

  const results = [];
  for (let index = 0; index < payloadChunks.length; index += 1) {
    const chunk = payloadChunks[index];
    const chunkedPayload = payloadChunks.length > 1
      ? {
          ...chunk,
          chunking: {
            chunkIndex: index + 1,
            totalChunks: payloadChunks.length,
            instruction: 'Analyze only this chunk of crawler/research evidence. Return JSON hints from this chunk; the app will merge all chunk results.',
          },
        }
      : chunk;

    if (payloadChunks.length > 1) {
      emit(onEvent, 'ollama-chunking', 36, 'debug', 'Sending local Ollama research chunk.', {
        chunk: index + 1,
        totalChunks: payloadChunks.length,
        estimatedPromptTokens: estimatePromptTokens(localSystemPrompt, chunkedPayload),
      });
    }

    const outcome = await runChunkAcrossInstances({
      instances,
      chunkedPayload,
      systemPrompt: localSystemPrompt,
      onEvent,
      chunkIndex: index,
      totalChunks: payloadChunks.length,
    });
    if (outcome.ok) results.push(outcome.result);
  }

  if (!results.length) {
    throw new Error(`All ${payloadChunks.length} local Ollama research chunk(s) failed across ${instances.length} instance(s)`);
  }

  return mergeOllamaChunkResults(results);
}

// Tries a chunk on each configured instance in turn; if every instance fails,
// the whole round repeats up to OLLAMA_CHUNK_RETRY_ATTEMPTS times before the
// chunk is given up on (dropped from the merged result rather than aborting
// the whole request) — malformed/truncated JSON is often a one-off
// sampling/num_predict-cutoff fluke rather than a deterministic failure, so
// retrying (on the same or a different instance) recovers most cases.
async function runChunkAcrossInstances({ instances, chunkedPayload, systemPrompt, onEvent, chunkIndex, totalChunks }) {
  for (let round = 1; round <= OLLAMA_CHUNK_RETRY_ATTEMPTS; round += 1) {
    for (const instance of instances) {
      try {
        const result = config.ollamaToolCallingEnabled
          ? await askOllamaResearchChunkWithTools({ baseUrl: instance.baseUrl, model: instance.model, payload: chunkedPayload, systemPrompt, onEvent })
          : await ollamaClient.askOllamaJson({ baseUrl: instance.baseUrl, model: instance.model, payload: chunkedPayload, systemPrompt });
        return { ok: true, result };
      } catch (err) {
        const isLastAttempt = round === OLLAMA_CHUNK_RETRY_ATTEMPTS && instance === instances[instances.length - 1];
        emit(onEvent, 'ollama-chunking', 36, 'warn', isLastAttempt
          ? 'Local Ollama research chunk failed on all instances; skipping chunk.'
          : 'Local Ollama research chunk failed on instance; trying next instance.', {
          chunk: chunkIndex + 1,
          totalChunks,
          round,
          instance: instance.label || instance.baseUrl,
          model: instance.model,
          error: err.message,
        });
      }
    }
  }
  return { ok: false };
}

async function askOllamaResearchChunkWithTools({ baseUrl, model, payload, systemPrompt, onEvent = () => {} }) {
  return ollamaClient.askOllamaJsonWithTools({
    baseUrl,
    model,
    payload,
    systemPrompt,
    tools: ollamaResearchTools.getToolDefinitions(),
    executeToolCall: (call) => ollamaResearchTools.executeToolCall(call, { onEvent }),
    onToolCall: (call, round) => emit(onEvent, 'ollama-tool', 38, 'debug', 'Local Ollama agent selected a research tool.', {
      tool: call?.function?.name || call?.name,
      round,
    }),
  });
}

function buildLocalOllamaSystemPrompt(systemPrompt) {
  return `${systemPrompt}

You are running as a local Ollama research agent. You do not have built-in current market knowledge.
Use tools when you need live search results or deeper page text to interpret crawled evidence. Tool
results are observations, not truth; cite them through sourceHints/sourceUrls and include caveats in riskNotes.`;
}

function buildOllamaPayloadChunks(payload, systemPrompt) {
  const maxTokens = Math.max(512, Number(config.ollamaMaxPromptTokens) || 4096);
  const maxPayloadTokens = Math.max(256, maxTokens - estimateTokens(systemPrompt) - OLLAMA_PROMPT_SAFETY_TOKENS);
  if (estimateTokens(JSON.stringify(payload || {})) <= maxPayloadTokens) return [payload || {}];

  let base = buildOllamaChunkBase(payload);
  const evidence = extractOllamaEvidencePieces(payload);
  if (!evidence.length) return splitOversizedPayload(payload, maxPayloadTokens);

  // Base context fields (macro, consumer, disasterContext, etc.) repeat in every
  // chunk. Cap their combined size so they can't crowd out the evidence budget
  // (previously each field was trimmed independently with no combined ceiling).
  const maxBaseTokens = Math.max(200, Math.floor(maxPayloadTokens * 0.4));
  if (estimateTokens(JSON.stringify(base)) > maxBaseTokens) {
    base = trimBaseToBudget(base, maxBaseTokens * TOKEN_CHAR_RATIO);
  }

  const maxPayloadChars = maxPayloadTokens * TOKEN_CHAR_RATIO;
  const baseTokens = estimateTokens(JSON.stringify(base));
  const pieceTokenBudget = Math.max(180, maxPayloadTokens - baseTokens - 120);
  const splitEvidence = evidence.flatMap((piece) => splitEvidencePiece(piece, pieceTokenBudget));
  const chunks = [];
  let current = { ...base, evidence: [] };

  for (const piece of splitEvidence) {
    const candidate = { ...current, evidence: [...current.evidence, piece] };
    if (current.evidence.length && estimateTokens(JSON.stringify(candidate)) > maxPayloadTokens) {
      chunks.push(current);
      current = { ...base, evidence: [piece] };
    } else {
      current = candidate;
    }

    if (estimateTokens(JSON.stringify(current)) > maxPayloadTokens) {
      const oversized = current.evidence.pop();
      if (current.evidence.length) chunks.push(current);
      for (const smaller of splitEvidencePiece(oversized, Math.max(80, Math.floor(pieceTokenBudget / 2)))) {
        chunks.push({ ...base, evidence: [smaller] });
      }
      current = { ...base, evidence: [] };
    }
  }

  if (current.evidence.length) chunks.push(current);
  return chunks.map((chunk) => trimChunkToBudget(chunk, maxPayloadChars));
}

function trimBaseToBudget(base, maxBaseChars) {
  const copy = { ...base };
  const contextKeys = Object.keys(copy).filter((key) => key !== 'task' && typeof copy[key] === 'object' && copy[key] !== null);
  while (JSON.stringify(copy).length > maxBaseChars && contextKeys.length) {
    const largest = contextKeys.reduce((chosen, key) => {
      const length = JSON.stringify(copy[key]).length;
      return length > chosen.length ? { key, length } : chosen;
    }, { key: contextKeys[0], length: 0 });
    if (largest.length <= 200) {
      delete copy[largest.key];
      contextKeys.splice(contextKeys.indexOf(largest.key), 1);
      continue;
    }
    const raw = JSON.stringify(copy[largest.key]);
    copy[largest.key] = trimObjectForPrompt(copy[largest.key], Math.floor(raw.length * 0.6));
  }
  return copy;
}

function buildOllamaChunkBase(payload = {}) {
  const base = {
    task: payload.task || 'Analyze research evidence and return investment research hints.',
  };
  if (payload.macro) base.macro = trimObjectForPrompt(payload.macro, 1800);
  if (payload.consumer) base.consumer = trimObjectForPrompt(payload.consumer, 1600);
  if (payload.jsonDatasets) base.jsonDatasets = trimObjectForPrompt(payload.jsonDatasets, 1800);
  if (payload.businessFormation) base.businessFormation = trimObjectForPrompt(payload.businessFormation, 1200);
  if (payload.businessDynamics) base.businessDynamics = trimObjectForPrompt(payload.businessDynamics, 1200);
  if (payload.disasterContext) base.disasterContext = trimObjectForPrompt(payload.disasterContext, 1400);
  if (payload.naturalEventContext) base.naturalEventContext = trimObjectForPrompt(payload.naturalEventContext, 1400);
  if (payload.humanitarianContext) base.humanitarianContext = trimObjectForPrompt(payload.humanitarianContext, 1400);
  if (payload.refugeeContext) base.refugeeContext = trimObjectForPrompt(payload.refugeeContext, 1400);
  if (payload.historicalDisasterContext) base.historicalDisasterContext = trimObjectForPrompt(payload.historicalDisasterContext, 1400);
  if (payload.earthquakeContext) base.earthquakeContext = trimObjectForPrompt(payload.earthquakeContext, 1400);
  if (payload.weatherAlertContext) base.weatherAlertContext = trimObjectForPrompt(payload.weatherAlertContext, 1400);
  if (payload.nuclearEventContext) base.nuclearEventContext = trimObjectForPrompt(payload.nuclearEventContext, 1400);
  if (payload.wildfireContext) base.wildfireContext = trimObjectForPrompt(payload.wildfireContext, 1400);
  if (payload.droughtContext) base.droughtContext = trimObjectForPrompt(payload.droughtContext, 1400);
  if (payload.finvizContext) base.finvizContext = trimObjectForPrompt(payload.finvizContext, 1400);
  if (payload.tradingViewContext) base.tradingViewContext = trimObjectForPrompt(payload.tradingViewContext, 1400);
  if (payload.yahooFinanceContext) base.yahooFinanceContext = trimObjectForPrompt(payload.yahooFinanceContext, 1400);
  if (payload.nasdaqContext) base.nasdaqContext = trimObjectForPrompt(payload.nasdaqContext, 1400);
  if (payload.marketBeatContext) base.marketBeatContext = trimObjectForPrompt(payload.marketBeatContext, 1400);
  if (payload.wallStreetZenContext) base.wallStreetZenContext = trimObjectForPrompt(payload.wallStreetZenContext, 1400);
  if (payload.finraContext) base.finraContext = trimObjectForPrompt(payload.finraContext, 1400);
  if (payload.ownershipContext) base.ownershipContext = trimObjectForPrompt(payload.ownershipContext, 1400);
  if (payload.eventCategories) base.eventCategories = payload.eventCategories;
  if (payload.exampleQueryTemplates) base.exampleQueryTemplates = (payload.exampleQueryTemplates || []).slice(0, 8);
  return base;
}

function extractOllamaEvidencePieces(payload = {}) {
  const pieces = [];
  for (const item of payload.news || []) {
    pieces.push({
      type: 'news',
      title: cleanText(item.title).slice(0, 220),
      url: item.url || item.link,
      source: item.source,
      publishedAt: item.publishedAt,
      text: cleanText(item.description || item.summary || '').slice(0, 2200),
    });
  }
  for (const item of payload.learnedObservations || []) {
    pieces.push({
      type: 'crawled-page',
      title: cleanText(item.title).slice(0, 220),
      url: item.url,
      tags: item.tags,
      links: (item.links || []).slice(0, 5),
      text: cleanText(item.excerpt || item.text || item.fullText || ''),
    });
  }
  for (const item of payload.discoveredCompanies || []) {
    pieces.push({
      type: 'discovered-company',
      title: cleanText(item.companyName || item.symbol).slice(0, 220),
      symbol: cleanSymbol(item.symbol),
      tags: item.tags,
      text: cleanText(item.reason || '').slice(0, 1200),
    });
  }
  if (payload.article) {
    pieces.push({
      type: 'article',
      title: cleanText(payload.article.title).slice(0, 220),
      url: payload.article.url,
      text: cleanText(payload.article.excerpt || payload.article.text || ''),
    });
  }
  return pieces.filter((piece) => piece.title || piece.text || piece.url || piece.symbol);
}

function splitEvidencePiece(piece, tokenBudget) {
  const maxChars = Math.max(600, tokenBudget * TOKEN_CHAR_RATIO);
  const text = cleanText(piece?.text || '');
  if (estimateTokens(JSON.stringify(piece)) <= tokenBudget) return [piece];
  if (!text) return [{ ...piece, text: '' }];

  const chunks = splitText(text, Math.max(300, maxChars - JSON.stringify({ ...piece, text: '' }).length));
  return chunks.map((chunk, index) => ({
    ...piece,
    text: chunk,
    part: chunks.length > 1 ? `${index + 1}/${chunks.length}` : undefined,
  }));
}

function splitOversizedPayload(payload, maxPayloadTokens) {
  const text = JSON.stringify(payload || {});
  return splitText(text, Math.max(1000, maxPayloadTokens * TOKEN_CHAR_RATIO)).map((chunk, index, chunks) => ({
    task: 'Analyze this serialized research payload chunk and return JSON research hints.',
    serializedPayloadChunk: chunk,
    chunking: { chunkIndex: index + 1, totalChunks: chunks.length },
  }));
}

function trimChunkToBudget(chunk, maxPayloadChars) {
  const copy = JSON.parse(JSON.stringify(chunk));
  while (JSON.stringify(copy).length > maxPayloadChars && copy.evidence?.length) {
    const largest = copy.evidence.reduce((chosen, item, index) => {
      const length = JSON.stringify(item).length;
      return length > chosen.length ? { index, length } : chosen;
    }, { index: 0, length: 0 });
    const item = copy.evidence[largest.index];
    item.text = cleanText(item.text).slice(0, Math.max(300, Math.floor((item.text || '').length * 0.75)));
    if (String(item.text || '').length <= 320) break;
  }
  return copy;
}

function trimObjectForPrompt(value, maxChars) {
  const text = JSON.stringify(value || {});
  if (text.length <= maxChars) return value;
  return { truncated: true, json: text.slice(0, maxChars) };
}

function splitText(text, maxChars) {
  const clean = cleanText(text);
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let remaining = clean;
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    const breakAt = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('; '), slice.lastIndexOf(', '), slice.lastIndexOf(' '));
    const end = breakAt > maxChars * 0.45 ? breakAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function mergeOllamaChunkResults(results) {
  if (results.length <= 1) return results[0] || {};
  return {
    summary: results.map((result) => cleanText(result?.summary)).filter(Boolean).join(' '),
    candidateHints: results.flatMap((result) => result?.candidateHints || result?.candidates || []),
    sourceHints: results.flatMap((result) => result?.sourceHints || result?.sources || []),
    riskNotes: results.flatMap((result) => result?.riskNotes || result?.risks || []),
    inferredCompanies: results.flatMap((result) => result?.inferredCompanies || []),
    followUpQueries: results.flatMap((result) => result?.followUpQueries || []),
    reasoning: results.map((result) => cleanText(result?.reasoning)).filter(Boolean).join(' '),
  };
}

function estimatePromptTokens(systemPrompt, payload) {
  return estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(payload || {}));
}

function estimateTokens(value) {
  return Math.ceil(String(value || '').length / TOKEN_CHAR_RATIO);
}

async function askGemini({ apiKey, model, payload, systemPrompt = SYSTEM_PROMPT }) {
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
  url.searchParams.set('key', apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\nResearch payload:\n${JSON.stringify(payload)}` }],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Gemini research request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '{}';
  return JSON.parse(extractJsonObject(text));
}

async function askSanctionedDuckEndpoint({ endpoint, payload, systemPrompt = SYSTEM_PROMPT }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: systemPrompt, input: payload }),
  });
  if (!res.ok) throw new Error(`Duck.ai sanctioned endpoint failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.summary || data.candidateHints || data.sourceHints ? data : JSON.parse(extractJsonObject(data.content || data.text || '{}'));
}

function buildResearchPayload({ news, learned, macro, consumer, jsonDatasets, businessFormation, businessDynamics, energyFuel, vehicleSales, finvizContext, tradingViewContext, yahooFinanceContext, nasdaqContext, marketBeatContext, wallStreetZenContext, finraContext, ownershipContext, disasterContext, naturalEventContext, humanitarianContext, refugeeContext, historicalDisasterContext, earthquakeContext, weatherAlertContext, nuclearEventContext, wildfireContext, droughtContext, discoveredCompanies }) {
  return {
    task: 'Find follow-up investment research leads and crawlable sources from current collected evidence.',
    news: (news?.items || []).slice(0, 10).map((item) => ({
      title: item.title,
      description: item.description,
      source: item.source,
      url: item.link || item.url,
      publishedAt: item.publishedAt,
    })),
    learnedObservations: (learned?.observations || []).slice(0, 10).map((item) => ({
      title: item.title,
      url: item.url,
      excerpt: item.excerpt,
      tags: item.score?.tags,
      links: (item.links || []).slice(0, 5),
    })),
    discoveredCompanies: (discoveredCompanies || []).slice(0, 12).map((item) => ({
      symbol: item.symbol,
      companyName: item.companyName,
      reason: item.discovery?.evidence?.[0]?.reason,
      tags: item.discovery?.tags,
    })),
    macro: {
      riskBias: macro?.riskBias,
      indicators: macro?.indicators,
    },
    consumer: {
      consumerBias: consumer?.consumerBias,
      reports: consumer?.reports,
    },
    jsonDatasets: {
      compositeRiskScore: jsonDatasets?.compositeRiskScore,
      opportunityScore: jsonDatasets?.opportunityScore,
      categoryScores: jsonDatasets?.categoryScores,
    },
    businessFormation: {
      available: businessFormation?.available,
      momentum: businessFormation?.momentum,
      opportunityScore: businessFormation?.opportunityScore,
      riskScore: businessFormation?.riskScore,
      averageGrowthPct: businessFormation?.averageGrowthPct,
      latestPeriod: businessFormation?.latestPeriod,
    },
    businessDynamics: {
      available: businessDynamics?.available,
      momentum: businessDynamics?.momentum,
      opportunityScore: businessDynamics?.opportunityScore,
      riskScore: businessDynamics?.riskScore,
      netDynamismPct: businessDynamics?.netDynamismPct,
      latestYear: businessDynamics?.latestYear,
    },
    energyFuel: {
      available: energyFuel?.available,
      apiConfigured: energyFuel?.apiConfigured,
      fallbackUsed: energyFuel?.fallbackUsed,
      momentum: energyFuel?.momentum,
      opportunityScore: energyFuel?.opportunityScore,
      riskScore: energyFuel?.riskScore,
      shippingCostPressureScore: energyFuel?.shippingCostPressureScore,
      consumerFuelPressureScore: energyFuel?.consumerFuelPressureScore,
      latestPeriod: energyFuel?.latestPeriod,
      latestSeries: (energyFuel?.latestSeries || []).slice(0, 5),
    },
    vehicleSales: {
      available: vehicleSales?.available,
      beaApiConfigured: vehicleSales?.beaApiConfigured,
      fredCsvUsed: vehicleSales?.fredCsvUsed,
      momentum: vehicleSales?.momentum,
      opportunityScore: vehicleSales?.opportunityScore,
      riskScore: vehicleSales?.riskScore,
      demandMomentumScore: vehicleSales?.demandMomentumScore,
      averageYoYChangePct: vehicleSales?.averageYoYChangePct,
      latestPeriod: vehicleSales?.latestPeriod,
      latestSeries: (vehicleSales?.latestSeries || []).slice(0, 5),
    },
    finvizContext: {
      available: finvizContext?.available,
      provider: finvizContext?.provider,
      momentum: finvizContext?.momentum,
      opportunityScore: finvizContext?.opportunityScore,
      riskScore: finvizContext?.riskScore,
      signalCount: finvizContext?.signalCount,
      bullishCount: finvizContext?.bullishCount,
      bearishCount: finvizContext?.bearishCount,
      topBullish: (finvizContext?.topBullish || []).slice(0, 6),
      topBearish: (finvizContext?.topBearish || []).slice(0, 6),
      fundamentalCandidates: (finvizContext?.fundamentalCandidates || []).slice(0, 6),
      caveat: finvizContext?.quoteDelayNote,
    },
    tradingViewContext: {
      available: tradingViewContext?.available,
      provider: tradingViewContext?.provider,
      momentum: tradingViewContext?.momentum,
      opportunityScore: tradingViewContext?.opportunityScore,
      riskScore: tradingViewContext?.riskScore,
      sectorLeadershipScore: tradingViewContext?.sectorLeadershipScore,
      preMarketMomentumScore: tradingViewContext?.preMarketMomentumScore,
      allTimeHighScore: tradingViewContext?.allTimeHighScore,
      signalCount: tradingViewContext?.signalCount,
      preMarketCount: tradingViewContext?.preMarketCount,
      allTimeHighCount: tradingViewContext?.allTimeHighCount,
      sectorCount: tradingViewContext?.sectorCount,
      topMomentum: (tradingViewContext?.topMomentum || []).slice(0, 6),
      topPreMarketGainers: (tradingViewContext?.topPreMarketGainers || []).slice(0, 6),
      allTimeHighs: (tradingViewContext?.allTimeHighs || []).slice(0, 6),
      sectorLeaders: (tradingViewContext?.sectorLeaders || []).slice(0, 6),
      caveat: tradingViewContext?.quoteDelayNote,
    },
    yahooFinanceContext: {
      available: yahooFinanceContext?.available,
      provider: yahooFinanceContext?.provider,
      momentum: yahooFinanceContext?.momentum,
      opportunityScore: yahooFinanceContext?.opportunityScore,
      riskScore: yahooFinanceContext?.riskScore,
      signalCount: yahooFinanceContext?.signalCount,
      bullishCount: yahooFinanceContext?.bullishCount,
      bearishCount: yahooFinanceContext?.bearishCount,
      analystSignalCount: yahooFinanceContext?.analystSignalCount,
      companyPageCount: yahooFinanceContext?.companyPageCount,
      topMomentum: (yahooFinanceContext?.topMomentum || []).slice(0, 6),
      topGainers: (yahooFinanceContext?.topGainers || []).slice(0, 6),
      topLosers: (yahooFinanceContext?.topLosers || []).slice(0, 6),
      topAnalyst: (yahooFinanceContext?.topAnalyst || []).slice(0, 6),
      mostActive: (yahooFinanceContext?.mostActive || []).slice(0, 6),
      trending: (yahooFinanceContext?.trending || []).slice(0, 6),
      caveat: yahooFinanceContext?.quoteDelayNote,
    },
    nasdaqContext: {
      available: nasdaqContext?.available,
      provider: nasdaqContext?.provider,
      momentum: nasdaqContext?.momentum,
      opportunityScore: nasdaqContext?.opportunityScore,
      riskScore: nasdaqContext?.riskScore,
      catalystScore: nasdaqContext?.catalystScore,
      signalCount: nasdaqContext?.signalCount,
      earningsCatalystCount: nasdaqContext?.earningsCatalystCount,
      ipoCatalystCount: nasdaqContext?.ipoCatalystCount,
      companyPageCount: nasdaqContext?.companyPageCount,
      topSignals: (nasdaqContext?.topSignals || []).slice(0, 6),
      earningsCatalysts: (nasdaqContext?.earningsCatalysts || []).slice(0, 6),
      ipoCatalysts: (nasdaqContext?.ipoCatalysts || []).slice(0, 6),
      caveat: nasdaqContext?.quoteDelayNote,
    },
    marketBeatContext: {
      available: marketBeatContext?.available,
      provider: marketBeatContext?.provider,
      momentum: marketBeatContext?.momentum,
      opportunityScore: marketBeatContext?.opportunityScore,
      riskScore: marketBeatContext?.riskScore,
      targetScore: marketBeatContext?.targetScore,
      signalCount: marketBeatContext?.signalCount,
      bullishCount: marketBeatContext?.bullishCount,
      bearishCount: marketBeatContext?.bearishCount,
      targetChangeCount: marketBeatContext?.targetChangeCount,
      consensusPageCount: marketBeatContext?.consensusPageCount,
      topPositive: (marketBeatContext?.topPositive || []).slice(0, 6),
      topNegative: (marketBeatContext?.topNegative || []).slice(0, 6),
      targetChanges: (marketBeatContext?.targetChanges || []).slice(0, 6),
      caveat: marketBeatContext?.quoteDelayNote,
    },
    wallStreetZenContext: {
      available: wallStreetZenContext?.available,
      provider: wallStreetZenContext?.provider,
      momentum: wallStreetZenContext?.momentum,
      opportunityScore: wallStreetZenContext?.opportunityScore,
      riskScore: wallStreetZenContext?.riskScore,
      quantScore: wallStreetZenContext?.quantScore,
      signalCount: wallStreetZenContext?.signalCount,
      bullishCount: wallStreetZenContext?.bullishCount,
      bearishCount: wallStreetZenContext?.bearishCount,
      ratedCount: wallStreetZenContext?.ratedCount,
      tickerPageCount: wallStreetZenContext?.tickerPageCount,
      topRated: (wallStreetZenContext?.topRated || []).slice(0, 6),
      topPositive: (wallStreetZenContext?.topPositive || []).slice(0, 6),
      topNegative: (wallStreetZenContext?.topNegative || []).slice(0, 6),
      tickerSummaries: (wallStreetZenContext?.tickerSummaries || []).slice(0, 6),
      caveat: wallStreetZenContext?.quoteDelayNote,
    },
    finraContext: {
      available: finraContext?.available,
      provider: finraContext?.provider,
      momentum: finraContext?.momentum,
      opportunityScore: finraContext?.opportunityScore,
      riskScore: finraContext?.riskScore,
      creditStressScore: finraContext?.creditStressScore,
      refinancingPressureScore: finraContext?.refinancingPressureScore,
      equityCreditDivergenceScore: finraContext?.equityCreditDivergenceScore,
      tradeSignalCount: finraContext?.tradeSignalCount,
      stressedCount: finraContext?.stressedCount,
      constructiveCount: finraContext?.constructiveCount,
      topCreditWeakness: (finraContext?.topCreditWeakness || []).slice(0, 6),
      topCreditStrength: (finraContext?.topCreditStrength || []).slice(0, 6),
      caveat: finraContext?.quoteDelayNote,
    },
    ownershipContext: {
      available: ownershipContext?.available,
      provider: ownershipContext?.provider,
      momentum: ownershipContext?.momentum,
      opportunityScore: ownershipContext?.opportunityScore,
      riskScore: ownershipContext?.riskScore,
      activistPressureScore: ownershipContext?.activistPressureScore,
      passiveOwnershipScore: ownershipContext?.passiveOwnershipScore,
      institutionalDemandScore: ownershipContext?.institutionalDemandScore,
      concentrationRiskScore: ownershipContext?.concentrationRiskScore,
      entryCount: ownershipContext?.entryCount,
      activistSignalCount: ownershipContext?.activistSignalCount,
      passiveSignalCount: ownershipContext?.passiveSignalCount,
      institutionalSignalCount: ownershipContext?.institutionalSignalCount,
      newPositionSignalCount: ownershipContext?.newPositionSignalCount,
      reductionSignalCount: ownershipContext?.reductionSignalCount,
      topActivistSignals: (ownershipContext?.topActivistSignals || []).slice(0, 6),
      topInstitutionalSignals: (ownershipContext?.topInstitutionalSignals || []).slice(0, 6),
      topBeneficialOwners: (ownershipContext?.topBeneficialOwners || []).slice(0, 6),
      topReductions: (ownershipContext?.topReductions || []).slice(0, 6),
      caveat: ownershipContext?.quoteDelayNote,
    },
    disasterContext: {
      available: disasterContext?.available,
      momentum: disasterContext?.momentum,
      eventCount: disasterContext?.eventCount,
      highImpactCount: disasterContext?.highImpactCount,
      disasterRiskScore: disasterContext?.disasterRiskScore,
      supplyChainRiskScore: disasterContext?.supplyChainRiskScore,
      insuranceRiskScore: disasterContext?.insuranceRiskScore,
      recoveryOpportunityScore: disasterContext?.recoveryOpportunityScore,
      estimatedPopulationExposure: disasterContext?.estimatedPopulationExposure,
      latestPeriod: disasterContext?.latestPeriod,
      topEvents: (disasterContext?.events || []).slice(0, 5),
    },
    naturalEventContext: {
      available: naturalEventContext?.available,
      momentum: naturalEventContext?.momentum,
      eventCount: naturalEventContext?.eventCount,
      openEventCount: naturalEventContext?.openEventCount,
      highImpactCount: naturalEventContext?.highImpactCount,
      naturalEventRiskScore: naturalEventContext?.naturalEventRiskScore,
      wildfireRiskScore: naturalEventContext?.wildfireRiskScore,
      stormFloodRiskScore: naturalEventContext?.stormFloodRiskScore,
      aviationVisibilityRiskScore: naturalEventContext?.aviationVisibilityRiskScore,
      agricultureDroughtRiskScore: naturalEventContext?.agricultureDroughtRiskScore,
      recoveryOpportunityScore: naturalEventContext?.recoveryOpportunityScore,
      latestPeriod: naturalEventContext?.latestPeriod,
      categoryCounts: naturalEventContext?.categoryCounts,
      topEvents: (naturalEventContext?.events || []).slice(0, 5),
    },
    humanitarianContext: {
      available: humanitarianContext?.available,
      appConfigured: humanitarianContext?.appConfigured,
      momentum: humanitarianContext?.momentum,
      disasterCount: humanitarianContext?.disasterCount,
      reportCount: humanitarianContext?.reportCount,
      humanitarianImpactScore: humanitarianContext?.humanitarianImpactScore,
      crisisSeverityScore: humanitarianContext?.crisisSeverityScore,
      aidRequirementScore: humanitarianContext?.aidRequirementScore,
      infrastructureRecoveryScore: humanitarianContext?.infrastructureRecoveryScore,
      supplyChainDisruptionScore: humanitarianContext?.supplyChainDisruptionScore,
      latestPeriod: humanitarianContext?.latestPeriod,
      disasterTypeCounts: humanitarianContext?.disasterTypeCounts,
      reportThemeCounts: humanitarianContext?.reportThemeCounts,
      topDisasters: (humanitarianContext?.disasters || []).slice(0, 5),
      topReports: (humanitarianContext?.reports || []).slice(0, 5),
    },
    refugeeContext: {
      available: refugeeContext?.available,
      momentum: refugeeContext?.momentum,
      latestYear: refugeeContext?.latestYear,
      totalForcedDisplacement: refugeeContext?.totalForcedDisplacement,
      totalPeopleOfConcern: refugeeContext?.totalPeopleOfConcern,
      refugeesAndAsylum: refugeeContext?.refugeesAndAsylum,
      displacementPressureScore: refugeeContext?.displacementPressureScore,
      refugeeAsylumPressureScore: refugeeContext?.refugeeAsylumPressureScore,
      idpPressureScore: refugeeContext?.idpPressureScore,
      statelessnessRiskScore: refugeeContext?.statelessnessRiskScore,
      hostCountryPressureScore: refugeeContext?.hostCountryPressureScore,
      aidDemandScore: refugeeContext?.aidDemandScore,
      shelterInfrastructureDemandScore: refugeeContext?.shelterInfrastructureDemandScore,
      healthcareDemandScore: refugeeContext?.healthcareDemandScore,
      logisticsAccessRiskScore: refugeeContext?.logisticsAccessRiskScore,
      borderPolicyRiskScore: refugeeContext?.borderPolicyRiskScore,
      topOriginCountries: (refugeeContext?.topOriginCountries || []).slice(0, 5),
      topHostCountries: (refugeeContext?.topHostCountries || []).slice(0, 5),
    },
    historicalDisasterContext: {
      available: historicalDisasterContext?.available,
      momentum: historicalDisasterContext?.momentum,
      datasetCount: historicalDisasterContext?.datasetCount,
      registeredAccessRequired: historicalDisasterContext?.registeredAccessRequired,
      historicalImpactModelingScore: historicalDisasterContext?.historicalImpactModelingScore,
      economicLossModelingScore: historicalDisasterContext?.economicLossModelingScore,
      humanImpactModelingScore: historicalDisasterContext?.humanImpactModelingScore,
      climateRiskBacktestScore: historicalDisasterContext?.climateRiskBacktestScore,
      dataAccessFrictionScore: historicalDisasterContext?.dataAccessFrictionScore,
      latestPeriod: historicalDisasterContext?.latestPeriod,
      disasterTypeSignals: historicalDisasterContext?.disasterTypeSignals,
      topDatasets: (historicalDisasterContext?.datasets || []).slice(0, 5),
    },
    earthquakeContext: {
      available: earthquakeContext?.available,
      momentum: earthquakeContext?.momentum,
      eventCount: earthquakeContext?.eventCount,
      highMagnitudeCount: earthquakeContext?.highMagnitudeCount,
      shallowHighMagnitudeCount: earthquakeContext?.shallowHighMagnitudeCount,
      tsunamiCount: earthquakeContext?.tsunamiCount,
      earthquakeRiskScore: earthquakeContext?.earthquakeRiskScore,
      seismicSupplyChainRiskScore: earthquakeContext?.seismicSupplyChainRiskScore,
      infrastructureDamageRiskScore: earthquakeContext?.infrastructureDamageRiskScore,
      tsunamiRiskScore: earthquakeContext?.tsunamiRiskScore,
      insuranceRiskScore: earthquakeContext?.insuranceRiskScore,
      recoveryOpportunityScore: earthquakeContext?.recoveryOpportunityScore,
      maxMagnitude: earthquakeContext?.maxMagnitude,
      averageMagnitude: earthquakeContext?.averageMagnitude,
      latestPeriod: earthquakeContext?.latestPeriod,
      alertCounts: earthquakeContext?.alertCounts,
      magnitudeBuckets: earthquakeContext?.magnitudeBuckets,
      topEvents: (earthquakeContext?.events || []).slice(0, 5),
    },
    weatherAlertContext: {
      available: weatherAlertContext?.available,
      userAgentConfigured: weatherAlertContext?.userAgentConfigured,
      momentum: weatherAlertContext?.momentum,
      alertCount: weatherAlertContext?.alertCount,
      severeAlertCount: weatherAlertContext?.severeAlertCount,
      weatherAlertRiskScore: weatherAlertContext?.weatherAlertRiskScore,
      logisticsRiskScore: weatherAlertContext?.logisticsRiskScore,
      utilityRiskScore: weatherAlertContext?.utilityRiskScore,
      agricultureRiskScore: weatherAlertContext?.agricultureRiskScore,
      insuranceRiskScore: weatherAlertContext?.insuranceRiskScore,
      retailFootTrafficRiskScore: weatherAlertContext?.retailFootTrafficRiskScore,
      recoveryOpportunityScore: weatherAlertContext?.recoveryOpportunityScore,
      latestPeriod: weatherAlertContext?.latestPeriod,
      eventFamilyCounts: weatherAlertContext?.eventFamilyCounts,
      severityCounts: weatherAlertContext?.severityCounts,
      urgencyCounts: weatherAlertContext?.urgencyCounts,
      certaintyCounts: weatherAlertContext?.certaintyCounts,
      topAlerts: (weatherAlertContext?.alerts || []).slice(0, 5),
    },
    nuclearEventContext: {
      available: nuclearEventContext?.available,
      momentum: nuclearEventContext?.momentum,
      eventCount: nuclearEventContext?.eventCount,
      reactorStatusCount: nuclearEventContext?.reactorStatusCount,
      highImpactEventCount: nuclearEventContext?.highImpactEventCount,
      scramCount: nuclearEventContext?.scramCount,
      part21Count: nuclearEventContext?.part21Count,
      powerReactorEventCount: nuclearEventContext?.powerReactorEventCount,
      offlineUnitCount: nuclearEventContext?.offlineUnitCount,
      deratedUnitCount: nuclearEventContext?.deratedUnitCount,
      averagePowerPct: nuclearEventContext?.averagePowerPct,
      safetyIncidentScore: nuclearEventContext?.safetyIncidentScore,
      reactorOutageScore: nuclearEventContext?.reactorOutageScore,
      regulatoryNotificationScore: nuclearEventContext?.regulatoryNotificationScore,
      nuclearUtilityRiskScore: nuclearEventContext?.nuclearUtilityRiskScore,
      nuclearServicesOpportunityScore: nuclearEventContext?.nuclearServicesOpportunityScore,
      alternativeEnergyOpportunityScore: nuclearEventContext?.alternativeEnergyOpportunityScore,
      latestPeriod: nuclearEventContext?.latestPeriod,
      topEvents: (nuclearEventContext?.events || []).slice(0, 5),
      topOutages: (nuclearEventContext?.reactorStatuses || []).filter((status) => status.status !== 'online').slice(0, 5),
    },
    wildfireContext: {
      available: wildfireContext?.available,
      momentum: wildfireContext?.momentum,
      incidentCount: wildfireContext?.incidentCount,
      activeIncidentCount: wildfireContext?.activeIncidentCount,
      largeFireCount: wildfireContext?.largeFireCount,
      uncontainedCount: wildfireContext?.uncontainedCount,
      totalAcres: wildfireContext?.totalAcres,
      averageContainmentPct: wildfireContext?.averageContainmentPct,
      preparednessLevel: wildfireContext?.preparednessLevel,
      wildfireRiskScore: wildfireContext?.wildfireRiskScore,
      activeIncidentRiskScore: wildfireContext?.activeIncidentRiskScore,
      perimeterRiskScore: wildfireContext?.perimeterRiskScore,
      smokeAirQualityRiskScore: wildfireContext?.smokeAirQualityRiskScore,
      utilityRiskScore: wildfireContext?.utilityRiskScore,
      insuranceRiskScore: wildfireContext?.insuranceRiskScore,
      timberAgricultureRiskScore: wildfireContext?.timberAgricultureRiskScore,
      logisticsRiskScore: wildfireContext?.logisticsRiskScore,
      recoveryOpportunityScore: wildfireContext?.recoveryOpportunityScore,
      latestPeriod: wildfireContext?.latestPeriod,
      stateCounts: wildfireContext?.stateCounts,
      topIncidents: (wildfireContext?.incidents || []).slice(0, 5),
    },
    droughtContext: {
      available: droughtContext?.available,
      momentum: droughtContext?.momentum,
      areaOfInterest: droughtContext?.areaOfInterest,
      mapReleaseDate: droughtContext?.mapReleaseDate,
      dataValidDate: droughtContext?.dataValidDate,
      latestPeriod: droughtContext?.latestPeriod,
      dsci: droughtContext?.dsci,
      dsciChange: droughtContext?.dsciChange,
      severeChangePct: droughtContext?.severeChangePct,
      severeDroughtPct: droughtContext?.severeDroughtPct,
      extremeExceptionalPct: droughtContext?.extremeExceptionalPct,
      exceptionalDroughtPct: droughtContext?.exceptionalDroughtPct,
      droughtRiskScore: droughtContext?.droughtRiskScore,
      agricultureRiskScore: droughtContext?.agricultureRiskScore,
      cropInputDemandScore: droughtContext?.cropInputDemandScore,
      waterUtilityRiskScore: droughtContext?.waterUtilityRiskScore,
      wildfireAmplificationRiskScore: droughtContext?.wildfireAmplificationRiskScore,
      foodInflationRiskScore: droughtContext?.foodInflationRiskScore,
      livestockRiskScore: droughtContext?.livestockRiskScore,
      logisticsRiskScore: droughtContext?.logisticsRiskScore,
      irrigationInfrastructureOpportunityScore: droughtContext?.irrigationInfrastructureOpportunityScore,
      droughtClassifications: droughtContext?.latestArea ? {
        none: droughtContext.latestArea.none,
        d0: droughtContext.latestArea.d0,
        d1: droughtContext.latestArea.d1,
        d2: droughtContext.latestArea.d2,
        d3: droughtContext.latestArea.d3,
        d4: droughtContext.latestArea.d4,
      } : null,
      topAreas: (droughtContext?.topAreas || []).slice(0, 5),
    },
  };
}

function normalizeProviderResult(provider, result) {
  return {
    provider: provider.provider,
    model: provider.model,
    available: true,
    skipped: false,
    summary: cleanText(result.summary).slice(0, 800),
    candidateHints: normalizeCandidateHints(result.candidateHints || result.candidates || []),
    sourceHints: normalizeSourceHints(result.sourceHints || result.sources || []),
    riskNotes: normalizeStringArray(result.riskNotes || result.risks || []).slice(0, 8),
  };
}

function combineResults(results) {
  const candidateMap = new Map();
  const sourceMap = new Map();
  const summaries = [];
  const riskNotes = [];
  for (const result of results) {
    if (result.summary) summaries.push(`${result.provider}: ${result.summary}`);
    for (const hint of result.candidateHints || []) {
      const existing = candidateMap.get(hint.symbol) || { ...hint, providers: [] };
      existing.confidence = Math.max(existing.confidence || 0, hint.confidence || 0);
      existing.reasons = [...new Set([...(existing.reasons || []), hint.reason].filter(Boolean))].slice(0, 4);
      existing.sourceUrls = [...new Set([...(existing.sourceUrls || []), ...(hint.sourceUrls || [])])].slice(0, 6);
      existing.providers = [...new Set([...(existing.providers || []), result.provider])];
      candidateMap.set(hint.symbol, existing);
    }
    for (const hint of result.sourceHints || []) {
      const existing = sourceMap.get(hint.url) || { ...hint, providers: [] };
      existing.tags = [...new Set([...(existing.tags || []), ...(hint.tags || [])])].slice(0, 8);
      existing.reasons = [...new Set([...(existing.reasons || []), hint.reason].filter(Boolean))].slice(0, 4);
      existing.providers = [...new Set([...(existing.providers || []), result.provider])];
      sourceMap.set(hint.url, existing);
    }
    riskNotes.push(...(result.riskNotes || []));
  }
  return {
    providers: results,
    summary: summaries.join(' '),
    candidateHints: [...candidateMap.values()].sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 16),
    sourceHints: [...sourceMap.values()].slice(0, 20),
    riskNotes: [...new Set(riskNotes)].slice(0, 12),
  };
}

function persistSourceHints(userId, sourceHints, provider) {
  if (!userId) return;
  for (const hint of sourceHints.slice(0, 10)) {
    researchSourceRepo.upsert({
      userId,
      url: hint.url,
      title: hint.title || hint.url,
      sourceType: 'learned',
      status: 'active',
      discoveryMethod: `chat-research:${provider}`,
      tags: ['chat-research', ...(hint.tags || [])].slice(0, 8),
      relevanceScore: 66,
      credibilityScore: 50,
      notes: hint.reason || `Suggested by ${provider} chat research`,
    });
  }
}

function normalizeCandidateHints(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      symbol: cleanSymbol(item.symbol),
      companyName: cleanText(item.companyName || item.name).slice(0, 120),
      reason: cleanText(item.reason || item.rationale).slice(0, 500),
      confidence: clamp01(Number(item.confidence ?? item.score ?? 0.5)),
      sourceUrls: normalizeUrls(item.sourceUrls || item.urls || item.sources || []),
    }))
    .filter((item) => item.symbol && item.reason)
    .slice(0, 16);
}

function normalizeSourceHints(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      url: cleanUrl(item.url),
      title: cleanText(item.title || item.name).slice(0, 160),
      reason: cleanText(item.reason || item.rationale).slice(0, 500),
      tags: normalizeStringArray(item.tags).slice(0, 8),
    }))
    .filter((item) => item.url && item.reason)
    .slice(0, 20);
}

function normalizeUrls(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(cleanUrl).filter(Boolean).slice(0, 8);
}

function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : [value].filter(Boolean);
  return values.map((item) => cleanText(item).toLowerCase()).filter(Boolean);
}

function cleanSymbol(value) {
  const symbol = cleanText(value).toUpperCase().replace(/[^A-Z.]/g, '');
  return symbol.length <= 7 ? symbol : '';
}

function cleanUrl(value) {
  try {
    const parsed = new URL(cleanText(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{')) return raw;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '{}';
  return raw.slice(start, end + 1);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function emptyResult() {
  return { providers: [], summary: '', candidateHints: [], sourceHints: [], riskNotes: [] };
}

function skippedDuckAi(provider) {
  return {
    provider: provider.provider,
    model: provider.model,
    available: false,
    skipped: true,
    error: 'Duck.ai has no configured endpoint and browser-session automation is disabled.',
    summary: '',
    candidateHints: [],
    sourceHints: [],
    riskNotes: [],
  };
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  runChatResearch,
  runArticleComprehension,
  buildProviders,
  normalizeArticleComprehensionResult,
  buildResearchPayload,
  normalizeCandidateHints,
  normalizeSourceHints,
};
