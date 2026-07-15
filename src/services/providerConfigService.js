const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');

const DEFAULT_APP_NAME = 'autotrader-research';
const DEFAULT_CONTACT = config.defaultAdmin.email || 'admin@autotrader.local';
const DEFAULT_USER_AGENT = `AutoTrader autonomous research (${DEFAULT_CONTACT})`;

const PROVIDERS = [
  {
    providerType: 'broker',
    providerKey: 'alpaca',
    displayName: 'Alpaca',
    description: 'Official Alpaca Trading API credentials for paper/live execution and primary symbol tradability lookup before Finnhub enrichment.',
    fields: [
      { key: 'keyId', label: 'API key ID', secret: true },
      { key: 'secretKey', label: 'Secret key', secret: true },
      { key: 'paper', label: 'Paper trading', secret: false, placeholder: String(config.alpaca.paper) },
      { key: 'baseUrl', label: 'Base URL', secret: false, placeholder: config.alpaca.baseUrl },
      { key: 'brokerBaseUrl', label: 'Broker API base URL', secret: false, placeholder: config.alpaca.brokerBaseUrl },
      { key: 'brokerAccountId', label: 'Broker account ID', secret: true, placeholder: config.alpaca.brokerAccountId || 'UUID from Alpaca Broker account' },
    ],
    envConfigured: () => Boolean(config.alpaca.keyId && config.alpaca.secretKey),
  },
  {
    providerType: 'billing',
    providerKey: 'stripe',
    displayName: 'Stripe',
    description: 'Billing credentials for the upcoming user signup, subscription, and billing portal workflow.',
    fields: [
      { key: 'publishableKey', label: 'Publishable key', secret: false, placeholder: config.stripe.publishableKey || 'pk_...' },
      { key: 'secretKey', label: 'Secret key', secret: true },
      { key: 'webhookSecret', label: 'Webhook signing secret', secret: true },
      { key: 'defaultPriceId', label: 'Default price ID', secret: false, placeholder: config.stripe.defaultPriceId || 'price_...' },
      { key: 'billingPortalReturnUrl', label: 'Billing portal return URL', secret: false, placeholder: config.stripe.billingPortalReturnUrl || 'https://example.com/settings' },
    ],
    envConfigured: () => Boolean(config.stripe.publishableKey || config.stripe.secretKey || config.stripe.webhookSecret),
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
    description: 'Local LLM for strategy fallback, agent learning, and crawl-evidence interpretation. It is not treated as a fresh market-data source.',
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
    description: 'Optional external chat research. Browser automation is disabled by default when local Ollama research is preferred; configure a sanctioned endpoint or enable Duck.ai env flags to opt in.',
    fields: [
      { key: 'sanctionedEndpoint', label: 'Sanctioned endpoint URL', secret: false, placeholder: config.duckAiResearch.sanctionedEndpoint || 'No official server endpoint configured' },
      { key: 'model', label: 'Model', secret: false, placeholder: config.duckAiResearch.model || 'duck.ai web chat' },
    ],
    envConfigured: () => Boolean(config.duckAiResearch.sanctionedEndpoint || (config.duckAiResearch.enabled && config.duckAiResearch.browserEnabled)),
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
    providerKey: 'sec-edgar',
    displayName: 'SEC EDGAR',
    description: 'No-key SEC company submissions and XBRL APIs. Requires a descriptive User-Agent/contact string for fair access.',
    fields: [{ key: 'userAgent', label: 'User-Agent / contact', secret: false, placeholder: config.secEdgarUserAgent || DEFAULT_USER_AGENT, defaultValue: config.secEdgarUserAgent || DEFAULT_USER_AGENT, autoFill: true }],
    envConfigured: () => Boolean(config.secEdgarUserAgent),
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
    providerKey: 'census-bfs',
    displayName: 'Census BFS',
    description: 'Census Business Formation Statistics for aggregate EIN applications and projected employer-business formations.',
    fields: [{ key: 'apiKey', label: 'Census API key', secret: true }],
    envConfigured: () => Boolean(config.censusApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'census-bds',
    displayName: 'Census BDS',
    description: 'Census Business Dynamics Statistics for annual aggregate firm startups, establishment births/deaths, shutdowns, and job creation/destruction.',
    fields: [{ key: 'apiKey', label: 'Census API key', secret: true }],
    envConfigured: () => Boolean(config.censusApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'census-retail',
    displayName: 'Census Retail/Trade',
    description: 'Census MRTS, MARTS, MTIS, and ARTS/AIES retail, trade sales, inventory, e-commerce, and gross-margin context.',
    fields: [{ key: 'apiKey', label: 'Census API key', secret: true }],
    envConfigured: () => Boolean(config.censusApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'gdelt',
    displayName: 'GDELT DOC',
    description: 'Free no-login DOC 2.0 full-text global news search for business, startup, funding, IPO, and acquisition discovery.',
    fields: [
      { key: 'enabled', label: 'Enabled', secret: false, placeholder: String(config.gdelt.enabled) },
      { key: 'maxRecords', label: 'Max records per query', secret: false, placeholder: String(config.gdelt.maxRecords) },
    ],
    envConfigured: () => Boolean(config.gdelt.enabled),
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
    providerKey: 'bls',
    displayName: 'BLS Public Data API',
    description: 'Optional BLS registration key for CPI, selected average-price, and PPI timeseries. Unauthenticated BLS API calls are still available at lower limits.',
    fields: [{ key: 'apiKey', label: 'BLS registration key', secret: true }],
    envConfigured: () => Boolean(config.blsApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'bea',
    displayName: 'BEA API',
    description: 'Free BEA API key for aggregate macroeconomic data, including motor-vehicle output and sales-related economic datasets. FRED direct CSV vehicle-sales series are used when no BEA key is configured.',
    fields: [{ key: 'apiKey', label: 'BEA API key', secret: true }],
    envConfigured: () => Boolean(config.beaApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'eia',
    displayName: 'EIA Open Data',
    description: 'Free EIA API key for fuel prices, petroleum product supplied, refinery output, inventories, electricity prices/sales, and natural-gas prices/sales. Public EIA pages and downloads are used when no key is configured.',
    fields: [{ key: 'apiKey', label: 'EIA API key', secret: true }],
    envConfigured: () => Boolean(config.eiaApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'usda-ams',
    displayName: 'USDA AMS MyMarketNews',
    description: 'Optional MyMarketNews API key for USDA AMS agricultural market price, volume, and report data. Public AMS/ERS pages remain available without this key.',
    fields: [{ key: 'apiKey', label: 'MyMarketNews API key', secret: true }],
    envConfigured: () => Boolean(config.usdaAmsApiKey),
  },
  {
    providerType: 'data-source',
    providerKey: 'reliefweb',
    displayName: 'ReliefWeb',
    description: 'Free humanitarian disaster/conflict report API; requests should include an application name.',
    fields: [{ key: 'appName', label: 'Application name', secret: false, placeholder: config.reliefWebAppName || DEFAULT_APP_NAME, defaultValue: config.reliefWebAppName || DEFAULT_APP_NAME, autoFill: true }],
    envConfigured: () => Boolean(config.reliefWebAppName),
  },
  {
    providerType: 'data-source',
    providerKey: 'nws-weather',
    displayName: 'NOAA/NWS Weather',
    description: 'Free National Weather Service forecasts, observations, and alerts; official requests require a User-Agent.',
    fields: [{ key: 'userAgent', label: 'User-Agent / contact', secret: false, placeholder: config.nwsUserAgent || DEFAULT_USER_AGENT, defaultValue: config.nwsUserAgent || DEFAULT_USER_AGENT, autoFill: true }],
    envConfigured: () => Boolean(config.nwsUserAgent),
  },
];

function listProviders(userId, { isAdmin = true } = {}) {
  const saved = new Map(providerCredentialRepo.listMasked(userId).map((row) => [row.providerKey, row]));
  return PROVIDERS.filter((provider) => isProviderVisibleToRole(provider, isAdmin)).map((provider) => {
    const record = saved.get(provider.providerKey);
    const ownFields = providerCredentialRepo.getOwnSecret(userId, provider.providerKey) || {};
    const envFields = isAdmin ? providerEnvFields(provider.providerKey) : {};
    const visibleFields = {};
    for (const field of provider.fields) {
      visibleFields[field.key] =
        ownFields[field.key] ??
        envFields[field.key] ??
        (field.autoFill ? field.defaultValue || field.placeholder || '' : '');
    }
    return {
      ...provider,
      envConfigured: provider.envConfigured(),
      configured: Boolean(provider.envConfigured() || record?.configured),
      maskedFields: record?.maskedFields || {},
      visibleFields,
      status: record?.status || (provider.envConfigured() ? 'configured_from_env' : 'not_configured'),
      lastError: record?.lastError || null,
      updatedAt: record?.updatedAt || null,
    };
  });
}

function saveProvider(userId, providerKey, fields, { isAdmin = true } = {}) {
  const provider = PROVIDERS.find((item) => item.providerKey === providerKey);
  if (!provider) throw new Error('Unknown provider');
  if (!isProviderVisibleToRole(provider, isAdmin)) throw new Error('Provider is restricted to admins');
  const allowed = new Set(provider.fields.map((field) => field.key));
  const cleanFields = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string' && value.trim() !== '') cleanFields[key] = value.trim();
  }
  if (!Object.keys(cleanFields).length) throw new Error('At least one provider field is required');
  const existing = providerCredentialRepo.getOwnSecret(userId, provider.providerKey) || {};
  return providerCredentialRepo.save({
    userId,
    providerType: provider.providerType,
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    fields: { ...existing, ...cleanFields },
  });
}

function isProviderVisibleToRole(provider, isAdmin) {
  if (isAdmin) return true;
  return provider.providerKey === 'alpaca';
}

function providerEnvFields(providerKey) {
  const values = {
    alpaca: {
      keyId: config.alpaca.keyId,
      secretKey: config.alpaca.secretKey,
      paper: String(config.alpaca.paper),
      baseUrl: config.alpaca.baseUrl,
      brokerBaseUrl: config.alpaca.brokerBaseUrl,
      brokerAccountId: config.alpaca.brokerAccountId,
    },
    stripe: config.stripe,
    openai: { apiKey: config.openaiApiKey, model: config.openaiModel },
    deepseek: { apiKey: config.deepseekApiKey, model: config.deepseekModel },
    groq: { apiKey: config.groqApiKey, model: config.groqModel },
    ollama: { baseUrl: config.ollamaBaseUrl, model: config.ollamaModel },
    'xai-grok': { apiKey: config.xaiApiKey, model: config.xaiModel },
    gemini: { apiKey: config.geminiApiKey, model: config.geminiModel },
    'duck-ai': {
      sanctionedEndpoint: config.duckAiResearch.sanctionedEndpoint,
      model: config.duckAiResearch.model,
    },
    finnhub: { apiKey: config.finnhubApiKey },
    'sec-edgar': { userAgent: config.secEdgarUserAgent },
    openalex: { apiKey: config.openAlexApiKey },
    'census-bfs': { apiKey: config.censusApiKey },
    'census-bds': { apiKey: config.censusApiKey },
    'census-retail': { apiKey: config.censusApiKey },
    gdelt: { enabled: String(config.gdelt.enabled), maxRecords: String(config.gdelt.maxRecords) },
    openfda: { apiKey: config.openFdaApiKey },
    bls: { apiKey: config.blsApiKey },
    bea: { apiKey: config.beaApiKey },
    eia: { apiKey: config.eiaApiKey },
    'usda-ams': { apiKey: config.usdaAmsApiKey },
    reliefweb: { appName: config.reliefWebAppName },
    'nws-weather': { userAgent: config.nwsUserAgent },
  }[providerKey] || {};
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

module.exports = { PROVIDERS, listProviders, saveProvider };
