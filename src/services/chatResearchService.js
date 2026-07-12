const OpenAI = require('openai');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');

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

async function runChatResearch({ userId, news, learned, macro, consumer, jsonDatasets, discoveredCompanies = [], onEvent = () => {} } = {}) {
  const providers = buildProviders(userId);
  const payload = buildResearchPayload({ news, learned, macro, consumer, jsonDatasets, discoveredCompanies });
  const results = [];

  if (!providers.length) {
    emit(onEvent, 'chat-research', 36, 'debug', 'No supported chat-research providers configured; continuing without chat augmentation.', {});
    return emptyResult();
  }

  for (const provider of providers) {
    if (provider.kind === 'unsupported-web-chat') {
      results.push(skippedDuckAi(provider));
      emit(onEvent, 'chat-research', 36, 'warn', 'Duck.ai public web chat automation skipped; no sanctioned server-side endpoint configured.', {
        provider: provider.provider,
        publicUrl: provider.publicUrl,
      });
      continue;
    }

    try {
      emit(onEvent, 'chat-research', 36, 'debug', 'Requesting autonomous research augmentation from chat provider.', {
        provider: provider.provider,
        model: provider.model,
      });
      const result = await provider.ask(payload);
      const normalized = normalizeProviderResult(provider, result);
      persistSourceHints(userId, normalized.sourceHints, provider.provider);
      emit(onEvent, 'chat-research', 37, 'debug', 'Chat provider returned research leads.', {
        provider: provider.provider,
        candidates: normalized.candidateHints.length,
        sourceHints: normalized.sourceHints.length,
      });
      results.push(normalized);
    } catch (err) {
      emit(onEvent, 'chat-research', 37, 'warn', 'Chat research provider failed; continuing with crawl-first research.', {
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
    }
  }

  return combineResults(results);
}

function buildProviders(userId) {
  const providers = [];
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
            { role: 'system', content: SYSTEM_PROMPT },
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
      ask: (payload) => askGemini({ apiKey: geminiApiKey, model: geminiModel, payload }),
    });
  }

  const userDuck = userId ? providerCredentialRepo.getSecret(userId, 'duck-ai') : null;
  const duckEndpoint = userDuck?.sanctionedEndpoint || config.duckAiResearch.sanctionedEndpoint;
  if (duckEndpoint) {
    providers.push({
      provider: 'duck-ai',
      model: userDuck?.model || config.duckAiResearch.model || 'duck-ai-sanctioned-endpoint',
      ask: (payload) => askSanctionedDuckEndpoint({ endpoint: duckEndpoint, payload }),
    });
  } else {
    providers.push({
      provider: 'duck-ai',
      model: 'public-web-chat',
      kind: 'unsupported-web-chat',
      publicUrl: config.duckAiResearch.publicUrl,
    });
  }

  return providers;
}

async function askGemini({ apiKey, model, payload }) {
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
          parts: [{ text: `${SYSTEM_PROMPT}\n\nResearch payload:\n${JSON.stringify(payload)}` }],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Gemini research request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '{}';
  return JSON.parse(extractJsonObject(text));
}

async function askSanctionedDuckEndpoint({ endpoint, payload }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: SYSTEM_PROMPT, input: payload }),
  });
  if (!res.ok) throw new Error(`Duck.ai sanctioned endpoint failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.summary || data.candidateHints || data.sourceHints ? data : JSON.parse(extractJsonObject(data.content || data.text || '{}'));
}

function buildResearchPayload({ news, learned, macro, consumer, jsonDatasets, discoveredCompanies }) {
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
    error: 'Duck.ai public web chat has no configured sanctioned server-side endpoint. Browser-session scraping is disabled.',
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
  buildResearchPayload,
  normalizeCandidateHints,
  normalizeSourceHints,
};
