const { TokenBucketLimiter, getLimiter, resetLimiters } = require('../src/utils/rateLimiter');

describe('rateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetLimiters();
  });

  it('allows an immediate burst up to capacity then paces further calls', async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketLimiter({ perMinute: 60 }); // 1 token / 1000ms

    // Capacity is 60, so the first 60 acquire() calls resolve without waiting.
    for (let i = 0; i < 60; i += 1) {
      await limiter.acquire();
    }
    expect(limiter.msUntilAvailable()).toBeGreaterThan(0);

    // The 61st needs ~1000ms of refill.
    const acquire = limiter.acquire();
    let resolved = false;
    acquire.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await acquire;
    expect(resolved).toBe(true);
  });

  it('reuses a named limiter and can update its rate', () => {
    const a = getLimiter('finnhub', { perMinute: 58 });
    const b = getLimiter('finnhub', { perMinute: 120 });
    expect(a).toBe(b);
    expect(a.perMinute).toBe(120);
  });
});
