const { Ollama } = require('ollama');
const { config } = require('../config');

const MODEL_CACHE_TTL_MS = 60_000;
const modelCache = new Map();
const clientCache = new Map();

async function askOllamaJson({
  baseUrl = config.ollamaBaseUrl,
  model = config.ollamaModel,
  systemPrompt,
  payload,
  temperature = 0.2,
  timeoutMs = config.ollamaTimeoutMs,
} = {}) {
  const resolvedModel = await resolveOllamaModel({ baseUrl, model });
  const data = await withTimeout(
    getOllamaClient(baseUrl).chat({
      model: resolvedModel,
      stream: false,
      format: 'json',
      think: config.ollamaThink,
      options: buildOllamaOptions(temperature),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
    timeoutMs,
    'Ollama request'
  );
  return JSON.parse(extractJsonObject(data.message?.content || data.response || '{}'));
}

async function askOllamaJsonWithTools({
  baseUrl = config.ollamaBaseUrl,
  model = config.ollamaModel,
  systemPrompt,
  payload,
  tools = [],
  executeToolCall,
  onToolCall = () => {},
  temperature = 0.2,
  timeoutMs = config.ollamaTimeoutMs,
  maxToolRounds = config.ollamaToolMaxRounds,
} = {}) {
  if (!tools.length || typeof executeToolCall !== 'function') {
    return askOllamaJson({ baseUrl, model, systemPrompt, payload, temperature, timeoutMs });
  }

  const models = await listOllamaModels(baseUrl);
  const resolvedModel = resolveModelFromList(models, model);
  if (!modelSupportsTools(models, resolvedModel)) {
    return askOllamaJson({
      baseUrl,
      model: resolvedModel,
      systemPrompt: `${systemPrompt}

The selected local Ollama model does not advertise tool-calling support. Use only the supplied evidence and return the required JSON shape.`,
      payload,
      temperature,
      timeoutMs,
    });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: JSON.stringify({
        ...payload,
        toolInstructions: 'If current outside information or deeper page text is needed, call an available tool. After tool results are returned, respond only with the required JSON shape.',
      }),
    },
  ];

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const data = await withTimeout(
      getOllamaClient(baseUrl).chat({
        model: resolvedModel,
        stream: false,
        messages,
        tools: round < maxToolRounds ? tools : [],
        format: 'json',
        think: config.ollamaThink,
        options: buildOllamaOptions(temperature),
      }),
      timeoutMs,
      'Ollama request'
    );
    const assistantMessage = data.message || {};
    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];

    if (!toolCalls.length) {
      return JSON.parse(extractJsonObject(assistantMessage.content || data.response || '{}'));
    }

    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls.slice(0, 4)) {
      onToolCall(call, round);
      const result = await executeToolCall(call);
      messages.push({
        role: 'tool',
        tool_name: call.function?.name || call.name || 'unknown_tool',
        content: JSON.stringify(result).slice(0, 8000),
      });
    }
  }

  throw new Error(`Ollama exceeded tool-call limit of ${maxToolRounds} rounds`);
}

async function resolveOllamaModel({ baseUrl = config.ollamaBaseUrl, model = config.ollamaModel } = {}) {
  const models = await listOllamaModels(baseUrl);
  return resolveModelFromList(models, model);
}

async function listOllamaModels(baseUrl = config.ollamaBaseUrl) {
  const url = buildOllamaApiUrl(baseUrl, '/api/tags');
  const cached = modelCache.get(url);
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.models;

  try {
    const data = await withTimeout(
      getOllamaClient(baseUrl).list(),
      Math.min(config.ollamaTimeoutMs, 5000),
      'Ollama model list'
    );
    const models = (Array.isArray(data.models) ? data.models : [])
      .map((item) => ({
        name: item.name || item.model,
        model: item.model || item.name,
        capabilities: Array.isArray(item.capabilities) ? item.capabilities : [],
      }))
      .filter((item) => item.name);
    if (models.length) modelCache.set(url, { at: Date.now(), models });
    return models;
  } catch {
    return [];
  }
}

function resolveModelFromList(models, model) {
  const preferred = String(model || '').trim();
  if (!models.length) return preferred;
  if (!preferred) return models[0].name;
  return models.some((item) => item.name === preferred || item.model === preferred) ? preferred : models[0].name;
}

function modelSupportsTools(models, model) {
  const target = String(model || '').trim();
  const info = models.find((item) => item.name === target || item.model === target);
  if (!info || !Array.isArray(info.capabilities) || !info.capabilities.length) return true;
  return info.capabilities.some((capability) => /tool/i.test(String(capability)));
}

function buildOllamaOptions(temperature) {
  const options = { temperature };
  if (Number.isFinite(config.ollamaNumPredict) && config.ollamaNumPredict > 0) {
    options.num_predict = config.ollamaNumPredict;
  }
  return options;
}

function getOllamaClient(baseUrl = config.ollamaBaseUrl) {
  const host = buildOllamaHost(baseUrl);
  if (!clientCache.has(host)) clientCache.set(host, new Ollama({ host }));
  return clientCache.get(host);
}

function buildOllamaApiUrl(baseUrl = config.ollamaBaseUrl, path = '/api/chat') {
  const url = new URL(buildOllamaHost(baseUrl));
  const basePath = url.pathname.replace(/\/api\/?$/, '').replace(/\/+$/, '');
  const nextPath = path.startsWith('/') ? path : `/${path}`;
  url.pathname = `${basePath === '/' ? '' : basePath}${nextPath}`;
  url.search = '';
  return url.toString();
}

function buildOllamaOpenAiBaseUrl(baseUrl = config.ollamaBaseUrl) {
  const url = new URL(buildOllamaHost(baseUrl));
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith('/v1') ? basePath : `${basePath === '/' ? '' : basePath}/v1`;
  url.search = '';
  return url.toString();
}

function buildOllamaHost(baseUrl = config.ollamaBaseUrl) {
  const url = new URL(baseUrl || 'http://localhost:11434');
  url.pathname = url.pathname
    .replace(/\/v1\/?$/, '')
    .replace(/\/api\/?$/, '')
    .replace(/\/api\/chat\/?$/, '')
    .replace(/\/api\/tags\/?$/, '')
    .replace(/\/+$/, '');
  if (!url.pathname) url.pathname = '/';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{')) return raw;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '{}';
  return raw.slice(start, end + 1);
}

function clearOllamaModelCache() {
  modelCache.clear();
  clientCache.clear();
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

module.exports = {
  askOllamaJson,
  askOllamaJsonWithTools,
  resolveOllamaModel,
  listOllamaModels,
  modelSupportsTools,
  buildOllamaOptions,
  getOllamaClient,
  clearOllamaModelCache,
  buildOllamaHost,
  buildOllamaApiUrl,
  buildOllamaOpenAiBaseUrl,
};
