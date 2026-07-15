require('dotenv').config();

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ollamaThink(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).toLowerCase();
  if (['high', 'medium', 'low'].includes(normalized)) return normalized;
  return normalized === 'true';
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const defaultAdminEmails = [
  ...list(process.env.DEFAULT_ADMIN_EMAILS || process.env.ADMIN_EMAILS),
  ...list(process.env.DEFAULT_ADMIN_EMAIL || process.env.ADMIN_EMAIL),
];
if (defaultAdminEmails.length === 0) defaultAdminEmails.push('admin@autotrader.local');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  jwtSecret: process.env.JWT_SECRET || '',
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',

  defaultAdmin: {
    email: defaultAdminEmails[0],
    emails: [...new Set(defaultAdminEmails)],
    password: process.env.DEFAULT_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'ChangeMeAdmin123!',
    resetPassword: bool(process.env.DEFAULT_ADMIN_RESET_PASSWORD || process.env.ADMIN_RESET_PASSWORD, false),
  },

  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',

  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',

  xaiApiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY || '',
  xaiModel: process.env.XAI_MODEL || process.env.GROK_MODEL || 'grok-4',

  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',
  ollamaTimeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 300000),
  ollamaMaxPromptTokens: num(process.env.OLLAMA_MAX_PROMPT_TOKENS, 4096),
  ollamaNumPredict: num(process.env.OLLAMA_NUM_PREDICT, 1400),
  ollamaThink: ollamaThink(process.env.OLLAMA_THINK, false),
  ollamaToolCallingEnabled: bool(process.env.OLLAMA_TOOL_CALLING_ENABLED, true),
  ollamaToolMaxRounds: num(process.env.OLLAMA_TOOL_MAX_ROUNDS, 3),
  ollamaToolTimeoutMs: num(process.env.OLLAMA_TOOL_TIMEOUT_MS, 12000),
  chatResearchPreferOllama: bool(process.env.CHAT_RESEARCH_PREFER_OLLAMA, true),
  chatResearchExternalFallbackEnabled: bool(process.env.CHAT_RESEARCH_EXTERNAL_FALLBACK_ENABLED, false),

  duckAiResearch: {
    enabled: bool(process.env.DUCK_AI_RESEARCH_ENABLED, false),
    publicUrl: process.env.DUCK_AI_PUBLIC_URL || 'https://duck.ai/',
    sanctionedEndpoint: process.env.DUCK_AI_SANCTIONED_ENDPOINT || '',
    model: process.env.DUCK_AI_MODEL || '',
    browserEnabled: bool(process.env.DUCK_AI_BROWSER_ENABLED, true),
    browserHeadless: bool(process.env.DUCK_AI_BROWSER_HEADLESS, true),
    browserTimeoutMs: num(process.env.DUCK_AI_BROWSER_TIMEOUT_MS, 45000),
    sessionDir: process.env.DUCK_AI_SESSION_DIR || require('path').join(require('os').tmpdir(), 'autotrader-duck-ai-session'),
  },

  finnhubApiKey: process.env.FINNHUB_API_KEY || '',
  openAlexApiKey: process.env.OPENALEX_API_KEY || '',
  openFdaApiKey: process.env.OPENFDA_API_KEY || '',
  blsApiKey: process.env.BLS_API_KEY || process.env.BLS_REGISTRATION_KEY || '',
  beaApiKey: process.env.BEA_API_KEY || '',
  eiaApiKey: process.env.EIA_API_KEY || '',
  usdaAmsApiKey: process.env.USDA_AMS_API_KEY || process.env.MYMARKETNEWS_API_KEY || '',
  reliefWebAppName: process.env.RELIEFWEB_APP_NAME || '',
  nwsUserAgent: process.env.NWS_USER_AGENT || process.env.NOAA_USER_AGENT || '',
  censusApiKey: process.env.CENSUS_API_KEY || '',
  gdelt: {
    enabled: bool(process.env.GDELT_DOC_ENABLED, true),
    maxRecords: num(process.env.GDELT_DOC_MAX_RECORDS, 100),
  },

  secEdgarUserAgent: process.env.SEC_EDGAR_USER_AGENT || '',

  alerting: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    emailTo: process.env.ALERT_EMAIL_TO || '',
    emailFrom: process.env.ALERT_EMAIL_FROM || '',
    smtpUrl: process.env.ALERT_SMTP_URL || '',
  },

  alpaca: {
    keyId: process.env.ALPACA_KEY_ID || process.env.APCA_API_KEY_ID || '',
    secretKey: process.env.ALPACA_SECRET_KEY || process.env.APCA_API_SECRET_KEY || '',
    paper: bool(process.env.ALPACA_PAPER, true),
    baseUrl:
      process.env.ALPACA_BASE_URL ||
      process.env.APCA_API_BASE_URL ||
      (bool(process.env.ALPACA_PAPER, true) ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
    brokerBaseUrl:
      process.env.ALPACA_BROKER_BASE_URL ||
      (bool(process.env.ALPACA_PAPER, true) ? 'https://broker-api.sandbox.alpaca.markets' : 'https://broker-api.alpaca.markets'),
    brokerAccountId: process.env.ALPACA_BROKER_ACCOUNT_ID || process.env.ALPACA_ACCOUNT_ID || '',
  },

  stripe: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    defaultPriceId: process.env.STRIPE_DEFAULT_PRICE_ID || '',
    billingPortalReturnUrl: process.env.STRIPE_BILLING_PORTAL_RETURN_URL || '',
  },

  trading: {
    dailyLossLimitUsd: num(process.env.DAILY_LOSS_LIMIT_USD, 10),
    maxTradesPerSymbolPer24h: num(process.env.MAX_TRADES_PER_SYMBOL_PER_24H, 3),
    enabled: bool(process.env.TRADING_ENABLED, false),
  },

  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', '..', 'data', 'autotrader.db'),

  articleLlmComprehensionEnabled: bool(process.env.ARTICLE_LLM_COMPREHENSION_ENABLED, true),
  articleLlmComprehensionMaxPerRun: num(process.env.ARTICLE_LLM_COMPREHENSION_MAX_PER_RUN, 4),

  rateLimits: {
    finnhub: num(process.env.FINNHUB_RATE_PER_MIN, 58),
    search: num(process.env.SEARCH_RATE_PER_MIN, 30),
    defaultSource: num(process.env.SOURCE_RATE_PER_MIN, 60),
    retry: {
      maxRetries: num(process.env.HTTP_RETRY_MAX, 4),
      baseDelayMs: num(process.env.HTTP_RETRY_BASE_DELAY_MS, 500),
    },
  },

  search: {
    providers: process.env.SEARCH_PROVIDERS
      ? list(process.env.SEARCH_PROVIDERS)
      : ['google', 'google-news', 'bing', 'mojeek', 'dogpile', 'duckduckgo-html'],
  },

  idleResearch: {
    enabled: bool(process.env.IDLE_RESEARCH_ENABLED, true),
    cadenceCron: process.env.IDLE_RESEARCH_CADENCE_CRON || '15 * * * *',
    maxCompaniesPerTick: num(process.env.IDLE_RESEARCH_MAX_COMPANIES_PER_TICK, 3),
  },

  ollamaResearchReasoningEnabled: bool(process.env.OLLAMA_RESEARCH_REASONING_ENABLED, true),
};

/**
 * Checks whether the config has what it needs to actually run a live trading
 * cycle. The server should still boot without these — only a scheduled/manual
 * trading cycle should fail loudly when they're missing.
 */
function getTradingReadiness() {
  const missing = [];
  if (!config.openaiApiKey && !config.deepseekApiKey && !config.groqApiKey) {
    missing.push('OPENAI_API_KEY or DEEPSEEK_API_KEY or GROQ_API_KEY');
  }
  if (!config.alpaca.keyId) missing.push('ALPACA_KEY_ID or APCA_API_KEY_ID');
  if (!config.alpaca.secretKey) missing.push('ALPACA_SECRET_KEY or APCA_API_SECRET_KEY');
  return { ready: missing.length === 0, missing };
}

module.exports = { config, getTradingReadiness };
