const crypto = require('crypto');

const DEFAULT_DIMENSIONS = 96;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'with',
  'what', 'where', 'which', 'will', 'does', 'did', 'about', 'after', 'before', 'today',
]);

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9$.\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function embedText(value, dimensions = DEFAULT_DIMENSIONS) {
  const vector = Array(dimensions).fill(0);
  const counts = new Map();
  for (const token of tokenize(value)) counts.set(token, (counts.get(token) || 0) + 1);
  for (const [token, count] of counts.entries()) {
    const digest = crypto.createHash('sha1').update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.log(count));
  }
  return normalize(vector);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < length; i += 1) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    aMag += av * av;
    bMag += bv * bv;
  }
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

function topTerms(value, limit = 16) {
  const counts = new Map();
  for (const token of tokenize(value)) counts.set(token, (counts.get(token) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || '').slice(0, 20000)).digest('hex');
}

function normalize(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

module.exports = {
  DEFAULT_DIMENSIONS,
  tokenize,
  embedText,
  cosineSimilarity,
  topTerms,
  textHash,
};
