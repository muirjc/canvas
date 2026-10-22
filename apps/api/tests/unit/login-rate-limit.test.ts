import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../../src/auth/login-rate-limit.js';

describe('LoginRateLimiter', () => {
  it('allows up to the limit per key per minute, then refuses', () => {
    const limiter = new LoginRateLimiter(3, () => 0);
    expect([1, 2, 3, 4, 5].map(() => limiter.allow('a'))).toEqual([true, true, true, false, false]);
  });

  it('counts keys separately', () => {
    const limiter = new LoginRateLimiter(1, () => 0);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('starts a fresh window after 60 seconds, not before', () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter(1, () => now);
    expect(limiter.allow('a')).toBe(true);
    now += 59_999;
    expect(limiter.allow('a')).toBe(false);
    now += 1;
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
  });

  it('0 means unlimited', () => {
    const limiter = new LoginRateLimiter(0, () => 0);
    for (let i = 0; i < 1000; i++) expect(limiter.allow('a')).toBe(true);
  });
});
