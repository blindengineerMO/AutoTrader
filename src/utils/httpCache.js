// Small in-memory TTL cache for slow-changing HTTP responses (company
// profiles, daily/annual data-source series). Dedupes concurrent lookups for
// the same key by caching the in-flight promise, not just the resolved value.
const store = new Map();

async function getOrFetch(key, ttlMs, fetchFn) {
  const now = Date.now();
  const cached = store.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = Promise.resolve().then(fetchFn);
  store.set(key, { promise, expiresAt: now + ttlMs });
  try {
    return await promise;
  } catch (err) {
    store.delete(key);
    throw err;
  }
}

function clearCache(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { getOrFetch, clearCache };
