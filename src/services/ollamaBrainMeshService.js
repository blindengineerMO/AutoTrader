const { config } = require('../config');
const ollamaClient = require('./ollamaClient');
const ollamaResearchTools = require('./ollamaResearchToolService');

const OLLAMA_BRAIN_ID = 'brain.llm.ollama';

const MODE_PROMPTS = {
  assist: 'Provide concise AI-to-AI assistance for another AutoTrader brain or agent.',
  reason: 'Reason over the supplied evidence and produce an auditable causal analysis without inventing facts.',
  research: 'Help interpret research evidence, identify gaps, and use tools when live search or page context is needed.',
  training: 'Review model outcomes, features, and evaluation notes to suggest training improvements and future labels.',
  analysis: 'Analyze the supplied subject, evidence, and questions into actionable insights for trading-system agents.',
};

async function handleMeshAssist(envelope) {
  return runOllamaBrain({
    mode: envelope.body?.mode || 'assist',
    envelope,
  });
}

async function handleMeshReason(envelope) {
  return runOllamaBrain({ mode: 'reason', envelope });
}

async function handleMeshResearch(envelope) {
  return runOllamaBrain({ mode: 'research', envelope, allowTools: envelope.body?.allowTools !== false });
}

async function handleMeshTraining(envelope) {
  return runOllamaBrain({ mode: 'training', envelope, allowTools: false });
}

async function handleMeshAnalysis(envelope) {
  return runOllamaBrain({ mode: 'analysis', envelope, allowTools: envelope.body?.allowTools === true });
}

async function runOllamaBrain({ mode, envelope, allowTools = false }) {
  const normalizedMode = MODE_PROMPTS[mode] ? mode : 'assist';
  const payload = buildMeshPayload({ mode: normalizedMode, envelope });
  const systemPrompt = buildSystemPrompt(normalizedMode);
  const useTools = Boolean(allowTools && config.ollamaToolCallingEnabled);
  const result = useTools
    ? await ollamaClient.askOllamaJsonWithTools({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      systemPrompt,
      payload,
      tools: ollamaResearchTools.getToolDefinitions(),
      executeToolCall: (call) => ollamaResearchTools.executeToolCall(call),
    })
    : await ollamaClient.askOllamaJson({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      systemPrompt,
      payload,
    });

  return normalizeMeshResult({ mode: normalizedMode, result });
}

function buildMeshPayload({ mode, envelope }) {
  return {
    task: MODE_PROMPTS[mode],
    request: {
      from: envelope.from,
      op: envelope.op,
      ctx: envelope.ctx,
      body: sanitizeBody(envelope.body || {}),
    },
    responseContract: {
      mode,
      summary: 'short answer for the requesting brain',
      reasoning: 'brief auditable causal chain, not hidden chain-of-thought',
      insights: ['specific finding'],
      recommendations: ['specific next action'],
      followUpQuestions: ['question another brain should answer'],
      trainingNotes: ['feature/label/model-memory suggestion'],
      sourceHints: [{ url: 'https://example.com', title: 'source title', reason: 'why it matters', tags: ['tag'] }],
      candidateHints: [{ symbol: 'AAPL', companyName: 'Apple', reason: 'why it matters', confidence: 0.5, sourceUrls: ['https://example.com'] }],
      riskNotes: ['specific caveat'],
    },
  };
}

function buildSystemPrompt(mode) {
  return `You are ${OLLAMA_BRAIN_ID}, the local Ollama LLM brain inside AutoTrader's BrainMesh protocol.
${MODE_PROMPTS[mode]}

You are communicating with other software agents, not a human chat UI. Be compact, structured, and auditable.
Do not place trades, do not request credentials, and do not invent current facts. If tools are available and
current search/page context is necessary, call them. Otherwise use only the supplied body and clearly note limits.

Return only JSON matching this shape:
{
  "mode": "${mode}",
  "summary": "short answer",
  "reasoning": "brief evidence-based causal chain",
  "insights": ["specific finding"],
  "recommendations": ["specific next action"],
  "followUpQuestions": ["question another brain should answer"],
  "trainingNotes": ["feature/label/model-memory suggestion"],
  "sourceHints": [{ "url": "https://example.com", "title": "source title", "reason": "why it matters", "tags": ["tag"] }],
  "candidateHints": [{ "symbol": "AAPL", "companyName": "Apple", "reason": "why it matters", "confidence": 0.5, "sourceUrls": ["https://example.com"] }],
  "riskNotes": ["specific caveat"]
}`;
}

function normalizeMeshResult({ mode, result }) {
  return {
    provider: 'ollama',
    brainId: OLLAMA_BRAIN_ID,
    model: config.ollamaModel,
    mode,
    summary: cleanText(result?.summary).slice(0, 1200),
    reasoning: cleanText(result?.reasoning).slice(0, 1600),
    insights: normalizeStringArray(result?.insights).slice(0, 12),
    recommendations: normalizeStringArray(result?.recommendations).slice(0, 12),
    followUpQuestions: normalizeStringArray(result?.followUpQuestions).slice(0, 10),
    trainingNotes: normalizeStringArray(result?.trainingNotes).slice(0, 12),
    sourceHints: normalizeSourceHints(result?.sourceHints || result?.sources || []),
    candidateHints: normalizeCandidateHints(result?.candidateHints || result?.candidates || []),
    riskNotes: normalizeStringArray(result?.riskNotes || result?.risks || []).slice(0, 12),
  };
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

function sanitizeBody(body) {
  const clone = JSON.parse(JSON.stringify(body || {}));
  redactKeys(clone);
  return clipLargeStrings(clone);
}

function redactKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/secret|password|token|api[-_]?key|credential/i.test(key)) {
      value[key] = '[redacted]';
    } else {
      redactKeys(value[key]);
    }
  }
}

function clipLargeStrings(value) {
  if (typeof value === 'string') return cleanText(value).slice(0, 3000);
  if (Array.isArray(value)) return value.slice(0, 40).map(clipLargeStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, item]) => [key, clipLargeStrings(item)]));
  }
  return value;
}

function normalizeUrls(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(cleanUrl).filter(Boolean).slice(0, 8);
}

function normalizeStringArray(value) {
  const values = Array.isArray(value) ? value : [value].filter(Boolean);
  return values.map((item) => cleanText(item)).filter(Boolean);
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

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

module.exports = {
  OLLAMA_BRAIN_ID,
  handleMeshAssist,
  handleMeshReason,
  handleMeshResearch,
  handleMeshTraining,
  handleMeshAnalysis,
  normalizeMeshResult,
};
