function normalizeLimitedStrings(value, limit) {
  const values = Array.isArray(value) ? value : [value].filter(Boolean);
  return values.map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function isPublicHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
    return true;
  } catch {
    return false;
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function clampFloat(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

module.exports = { normalizeLimitedStrings, isPublicHttpUrl, clampNumber, clampFloat };
