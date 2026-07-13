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

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  jwtSecret: process.env.JWT_SECRET || '',
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',

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

  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1',

  duckAiResearch: {
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
  reliefWebAppName: process.env.RELIEFWEB_APP_NAME || '',
  nwsUserAgent: process.env.NWS_USER_AGENT || process.env.NOAA_USER_AGENT || '',

  secEdgarUserAgent: process.env.SEC_EDGAR_USER_AGENT || '',

  alerting: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    emailTo: process.env.ALERT_EMAIL_TO || '',
    emailFrom: process.env.ALERT_EMAIL_FROM || '',
    smtpUrl: process.env.ALERT_SMTP_URL || '',
  },

  robinhood: {
    username: process.env.ROBINHOOD_USERNAME || '',
    password: process.env.ROBINHOOD_PASSWORD || '',
    mfaSecret: process.env.ROBINHOOD_MFA_SECRET || '',
  },

  trading: {
    dailyLossLimitUsd: num(process.env.DAILY_LOSS_LIMIT_USD, 10),
    maxTradesPerSymbolPer24h: num(process.env.MAX_TRADES_PER_SYMBOL_PER_24H, 3),
    enabled: bool(process.env.TRADING_ENABLED, false),
  },

  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', '..', 'data', 'autotrader.db'),
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
  if (!config.robinhood.username) missing.push('ROBINHOOD_USERNAME');
  if (!config.robinhood.password) missing.push('ROBINHOOD_PASSWORD');
  return { ready: missing.length === 0, missing };
}

module.exports = { config, getTradingReadiness };
