/**
 * canvas-ez1.4: per-IP limit on password sign-in attempts -- a fixed one-minute window, in memory.
 * In memory is enough because canvas-api runs as one replica (apiapp.bicep maxReplicas: 1); with
 * more replicas each would count separately. Separate from the per-account lockout
 * (local-accounts.service.ts), which is what actually stops guessing one account's password; this
 * slows down trying many accounts from one address.
 */
export class LoginRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts an attempt; false when `key` is over the limit for the current minute. */
  allow(key: string): boolean {
    if (this.perMinute <= 0) return true;
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > 10_000) this.prune(now);
    }
    window.count += 1;
    return window.count <= this.perMinute;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= 60_000) this.windows.delete(key);
    }
  }
}
