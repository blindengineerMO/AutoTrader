const { getLimiter, sleep } = require('./rateLimiter');
const { config } = require('../config');

class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

class RateLimitError extends HttpError {
  constructor(message, details) {
    super(message, details);
    this.name = 'RateLimitError';
  }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function backoffDelayMs(attempt, baseDelayMs) {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.round(exponential + jitter);
}

// Fetches a URL through a named rate-limiter bucket with exponential-backoff
// retry on 429 / 5xx / network errors. Honors a Retry-After header when the
// server supplies one. `onRetry({attempt, delayMs, status, provider})` lets the
// caller emit a standard log line before each wait. `fetchImpl` is injectable
// for tests.
async function resilientFetch(url, options = {}, {
  bucket = 'default',
  perMinute = config.rateLimits.defaultSource,
  provider,
  maxRetries = config.rateLimits.retry.maxRetries,
  baseDelayMs = config.rateLimits.retry.baseDelayMs,
  timeoutMs = 15000,
  onRetry = () => {},
  fetchImpl = fetch,
} = {}) {
  const limiter = getLimiter(bucket, { perMinute });
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await limiter.acquire();

    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: options.signal || controller.signal });
    } catch (networkError) {
      if (timer) clearTimeout(timer);
      if (attempt >= maxRetries) {
        throw new HttpError(`Request failed after ${attempt + 1} attempts: ${networkError.message}`, { url });
      }
      const delayMs = backoffDelayMs(attempt, baseDelayMs);
      onRetry({ attempt: attempt + 1, delayMs, status: null, provider, url });
      await sleep(delayMs);
      attempt += 1;
      continue;
    }
    if (timer) clearTimeout(timer);

    if (isRetryableStatus(response.status) && attempt < maxRetries) {
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
      const delayMs = retryAfterMs != null ? retryAfterMs : backoffDelayMs(attempt, baseDelayMs);
      onRetry({ attempt: attempt + 1, delayMs, status: response.status, provider, url });
      await sleep(delayMs);
      attempt += 1;
      continue;
    }

    if (response.status === 429) {
      throw new RateLimitError(`Rate limited (429) after ${attempt + 1} attempts`, { status: 429, url });
    }
    return response;
  }
}

module.exports = { resilientFetch, HttpError, RateLimitError, isRetryableStatus, parseRetryAfterMs, backoffDelayMs };
