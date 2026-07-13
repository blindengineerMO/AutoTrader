const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const PROVIDERS = [
  {
    providerType: 'broker',
    providerKey: 'robinhood',
    displayName: 'Robinhood',
    description: 'Broker credentials for live order execution.',
    fields: [
      { key: 'username', label: 'Username', secret: false },
      { key: 'password', label: 'Password', secret: true },
      { key: 'mfaSecret', label: 'MFA secret', secret: true },
    ],
    envConfigured: () => Boolean(config.robinhood.username && config.robinhood.password),
  },
  {
    providerType: 'ai',
    providerKey: 'openai',
    displayName: 'OpenAI',
    description: 'Primary strategy model provider.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'model', label: 'Model', secret: false, placeholder: config.openaiModel },
    ],
    envConfigured: () => Boolean(config.openaiApiKey),
  },
  {
    providerType: 'ai',
    providerKey: 'deepseek',
    displayName: 'DeepSeek',
    description: 'Fallback OpenAI-compatible strategy provider.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'model', label: 'Model', secret: false, placeholder: config.deepseekModel },
    ],
    envConfigured: () => Boolean(config.deepseekApiKey),
  },
  {
    providerType: 'ai',
    providerKey: 'groq',
    displayName: 'Groq',
    description: 'Fast fallback OpenAI-compatible strategy provider.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'model', label: 'Model', secret: false, placeholder: config.groqModel },
    ],
    envConfigured: () => Boolean(config.groqApiKey),
  },
  {
    providerType: 'ai',
    providerKey: 'ollama',
    displayName: 'Ollama (local)',
    description: 'Local, OpenAI-compatible LLM used as a free strategy/learning fallback when no hosted provider is configured.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', secret: false, placeholder: config.ollamaBaseUrl },
      { key: 'model', label: 'Model', secret: false, placeholder: config.ollamaModel },
    ],
    envConfigured: () => Boolean(config.ollamaBaseUrl),
  },
  {
    providerType: 'chat-research',
    providerKey: 'xai-grok',
    displayName: 'xAI Grok',
    description: 'Supported Grok API provider for autonomous AI research augmentation.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'model', label: 'Model', secret: false, placeholder: config.xaiModel },
    ],
    envConfigured: () => Boolean(config.xaiApiKey),
  },
  {
    providerType: 'chat-research',
    providerKey: 'gemini',
    displayName: 'Gemini',
    description: 'Supported Gemini API provider for autonomous AI research augmentation.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'model', label: 'Model', secret: false, placeholder: config.geminiModel },
    ],
    envConfigured: () => Boolean(config.geminiApiKey),
  },
  {
    providerType: 'chat-research',
    providerKey: 'duck-ai',
    displayName: 'Duck.ai',
    description: 'Duck.ai research can use a configured sanctioned endpoint or the public webapp through a persistent Playwright browser session.',
    fields: [
      { key: 'sanctionedEndpoint', label: 'Sanctioned endpoint URL', secret: false, placeholder: config.duckAiResearch.sanctionedEndpoint || 'No official server endpoint configured' },
      { key: 'model', label: 'Model', secret: false, placeholder: config.duckAiResearch.model || 'duck.ai web chat' },
    ],
    envConfigured: () => Boolean(config.duckAiResearch.sanctionedEndpoint || config.duckAiResearch.browserEnabled),
  },
  {
    providerType: 'market-data',
    providerKey: 'finnhub',
    displayName: 'Finnhub',
    description: 'Optional market data provider; web scraping is used when this is unavailable.',
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    envConfigured: () => Boolean(config.finnhubApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'openalex',
    displayName: 'OpenAlex',
    description: 'Free scholarly/technology signal API for papers, institutions, topics, funders, and semantic search.',
    fields: [{ key: 'apiKey', label: 'Free API key', secret: true }],
    envConfigured: () => Boolean(config.openAlexApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'openfda',
    displayName: 'openFDA',
    description: 'Free FDA drug, device, food, recall, adverse-event, label, and historical-document API.',
    fields: [{ key: 'apiKey', label: 'Free API key', secret: true }],
    envConfigured: () => Boolean(config.openFdaApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'reliefweb',
    displayName: 'ReliefWeb',
    description: 'Free humanitarian disaster/conflict report API; requests should include an application name.',
    fields: [{ key: 'appName', label: 'Application name', secret: false, placeholder: config.reliefWebAppName || 'autotrader-research' }],
    envConfigured: () => Boolean(config.reliefWebAppName),
  },
  {
    providerType: 'data-source',
    providerKey: 'nws-weather',
    displayName: 'NOAA/NWS Weather',
    description: 'Free National Weather Service forecasts, observations, and alerts; official requests require a User-Agent.',
    fields: [{ key: 'userAgent', label: 'User-Agent / contact', secret: false, placeholder: config.nwsUserAgent || '(app.example.com, contact@example.com)' }],
    envConfigured: () => Boolean(config.nwsUserAgent),
  },
];

function listProviders(userId) {
  const saved = new Map(providerCredentialRepo.listMasked(userId).map((row) => [row.providerKey, row]));
  return PROVIDERS.map((provider) => {
    const record = saved.get(provider.providerKey);
    return {
      ...provider,
      envConfigured: provider.envConfigured(),
      configured: Boolean(provider.envConfigured() || record?.configured),
      maskedFields: record?.maskedFields || {},
      status: record?.status || (provider.envConfigured() ? 'configured_from_env' : 'not_configured'),
      lastError: record?.lastError || null,
      updatedAt: record?.updatedAt || null,
    };
  });
}

function saveProvider(userId, providerKey, fields) {
  const provider = PROVIDERS.find((item) => item.providerKey === providerKey);
  if (!provider) throw new Error('Unknown provider');
  const allowed = new Set(provider.fields.map((field) => field.key));
  const cleanFields = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string' && value.trim() !== '') cleanFields[key] = value.trim();
  }
  if (!Object.keys(cleanFields).length) throw new Error('At least one provider field is required');
  const existing = providerCredentialRepo.getSecret(userId, provider.providerKey) || {};
  return providerCredentialRepo.save({
    userId,
    providerType: provider.providerType,
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    fields: { ...existing, ...cleanFields },
  });
}

module.exports = { PROVIDERS, listProviders, saveProvider };
