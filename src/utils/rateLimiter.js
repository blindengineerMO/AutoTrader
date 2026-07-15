// A tiny in-process token-bucket rate limiter registry. Each named bucket paces
// outbound calls to a configured per-minute rate so we stay under third-party
// API limits (e.g. Finnhub's 60/min). Refill-based, no busy-waiting — acquire()
// resolves immediately when a token is available, otherwise after the computed
// wait. Per-process only; a multi-process deploy would need a shared store.

const limiters = new Map();

class TokenBucketLimiter {
  constructor({ perMinute }) {
    this.setRate(perMinute);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  setRate(perMinute) {
    this.perMinute = Math.max(1, Number(perMinute) || 1);
    this.capacity = this.perMinute;
    // Tokens regenerate continuously at perMinute / 60000 per millisecond.
    this.refillPerMs = this.perMinute / 60000;
  }

  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  // Milliseconds until at least one token is available (0 if available now).
  msUntilAvailable() {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  async acquire() {
    const wait = this.msUntilAvailable();
    if (wait > 0) {
      await sleep(wait);
      this.refill();
    }
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLimiter(name, { perMinute } = {}) {
  const existing = limiters.get(name);
  if (existing) {
    if (perMinute && perMinute !== existing.perMinute) existing.setRate(perMinute);
    return existing;
  }
  const limiter = new TokenBucketLimiter({ perMinute: perMinute || 60 });
  limiters.set(name, limiter);
  return limiter;
}

function resetLimiters() {
  limiters.clear();
}

module.exports = { getLimiter, resetLimiters, TokenBucketLimiter, sleep };
