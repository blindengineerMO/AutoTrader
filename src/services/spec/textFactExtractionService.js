const crypto = require('crypto');
const { textFactContract } = require('./interfaceContracts');

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(the\s+)?(system|developer|previous)\s+instructions/i,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/i,
  /exfiltrat(e|ion)|api[_ -]?key|secret[_ -]?key|access\s+token/i,
  /execute\s+(a\s+)?(shell|terminal|command)/i,
  /tool\s*call|function\s*call/i,
  /change\s+(the\s+)?trading\s+rules/i,
  /bypass\s+(risk|safety|compliance)/i,
];

function sanitizeTextFacts({ symbol, documentId, publishedAt, sourceUrl, extractedFacts = [], now = new Date() }) {
  const citations = normalizeCitations(sourceUrl, extractedFacts);
  const rejected = [];
  const safeFacts = [];

  for (const fact of extractedFacts || []) {
    const text = normalizeFactText(typeof fact === 'string' ? fact : fact.text);
    if (!text) continue;
    const matched = INJECTION_PATTERNS.find((pattern) => pattern.test(text));
    if (matched) {
      rejected.push({ fact: text, reason: `prompt_injection_pattern:${matched.source}` });
      continue;
    }
    safeFacts.push(text);
  }

  if (!safeFacts.length) {
    return {
      accepted: false,
      rejected,
      error: 'No safe cited facts were extracted from the document.',
      facts: [],
    };
  }

  const candidate = {
    symbol,
    document_id: documentId || stableDocumentId({ symbol, sourceUrl, publishedAt, safeFacts }),
    published_at: publishedAt || now.toISOString(),
    event_type: inferEventType(safeFacts),
    sentiment: averageNumeric(extractedFacts, 'sentiment', 0),
    uncertainty: clamp01(averageNumeric(extractedFacts, 'uncertainty', 0.5)),
    financial_impact: clampSigned(averageNumeric(extractedFacts, 'financialImpact', 0)),
    time_horizon_days: Math.max(0, Math.round(averageNumeric(extractedFacts, 'timeHorizonDays', 30))),
    facts: safeFacts,
    citations,
    confidence: clamp01(0.35 + Math.min(0.45, safeFacts.length * 0.08) + Math.min(0.2, citations.length * 0.05)),
  };

  const parsed = textFactContract.safeParse(candidate);
  if (!parsed.success) {
    return {
      accepted: false,
      rejected,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
      facts: [],
    };
  }

  return {
    accepted: true,
    rejected,
    facts: [parsed.data],
  };
}

function normalizeCitations(sourceUrl, facts) {
  const citations = new Set();
  if (isUrl(sourceUrl)) citations.add(sourceUrl);
  for (const fact of facts || []) {
    const citation = typeof fact === 'object' ? fact.citation || fact.url : null;
    if (isUrl(citation)) citations.add(citation);
  }
  return [...citations];
}

function normalizeFactText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 800);
}

function inferEventType(facts) {
  const joined = facts.join(' ').toLowerCase();
  if (/earnings|revenue|profit|margin/.test(joined)) return 'earnings';
  if (/acquisition|merger|deal|stake/.test(joined)) return 'corporate_transaction';
  if (/lawsuit|regulation|sanction|investigation/.test(joined)) return 'legal_regulatory';
  if (/launch|product|release/.test(joined)) return 'product_market';
  return 'market_news';
}

function stableDocumentId({ symbol, sourceUrl, publishedAt, safeFacts }) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ symbol, sourceUrl, publishedAt, safeFacts })).digest('hex');
  return `doc_${hash.slice(0, 16)}`;
}

function averageNumeric(items, key, fallback) {
  const values = (items || [])
    .map((item) => (typeof item === 'object' ? Number(item[key]) : NaN))
    .filter(Number.isFinite);
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampSigned(value) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch (_err) {
    return false;
  }
}

module.exports = {
  INJECTION_PATTERNS,
  sanitizeTextFacts,
};
