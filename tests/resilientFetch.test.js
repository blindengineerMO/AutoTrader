const { resilientFetch, parseRetryAfterMs, backoffDelayMs, RateLimitError } = require('../src/utils/resilientFetch');
const { resetLimiters } = require('../src/utils/rateLimiter');

function response(status, { retryAfter } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : undefined) },
    text: async () => '',
    json: async () => ({}),
  };
}

describe('resilientFetch', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetLimiters();
  });

  it('returns immediately on a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200));
    const res = await resilientFetch('https://x.test', {}, { bucket: 'unit-success', fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 with exponential backoff and eventually succeeds', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const onRetry = vi.fn();

    const promise = resilientFetch('https://x.test', {}, {
      bucket: 'unit-retry', baseDelayMs: 100, maxRetries: 4, onRetry, fetchImpl,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].status).toBe(429);
  });

  it('honors a Retry-After header', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(429, { retryAfter: '2' }))
      .mockResolvedValueOnce(response(200));
    const onRetry = vi.fn();

    const promise = resilientFetch('https://x.test', {}, {
      bucket: 'unit-retryafter', baseDelayMs: 100, onRetry, fetchImpl,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry.mock.calls[0][0].delayMs).toBe(2000);
  });

  it('throws RateLimitError after exhausting retries on persistent 429', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response(429));

    const promise = resilientFetch('https://x.test', {}, {
      bucket: 'unit-exhaust', baseDelayMs: 10, maxRetries: 2, fetchImpl,
    }).catch((err) => err);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(RateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('parseRetryAfterMs handles seconds and http-dates', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('backoffDelayMs grows with attempt', () => {
    const d0 = backoffDelayMs(0, 100);
    const d2 = backoffDelayMs(2, 100);
    expect(d2).toBeGreaterThan(d0);
  });
});
