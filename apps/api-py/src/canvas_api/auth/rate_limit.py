"""Password sign-in attempts per client address (apps/api/src/auth/login-rate-limit.ts): a fixed one-minute
window, in memory, one per service process -- the per-account lockout is what actually stops guessing one
account's password; this slows down trying many accounts from one address."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable


class LoginRateLimiter:
    def __init__(self, per_minute: int, now: Callable[[], float] = time.monotonic) -> None:
        self._per_minute = per_minute
        self._now = now
        self._windows: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        """Counts an attempt; False when `key` is over the limit for the current minute."""
        if self._per_minute <= 0:
            return True
        now = self._now()
        with self._lock:
            start, count = self._windows.get(key, (now, 0))
            if now - start >= 60:
                start, count = now, 0
            self._windows[key] = (start, count + 1)
            if len(self._windows) > 10_000:
                self._windows = {k: w for k, w in self._windows.items() if now - w[0] < 60}
            return count + 1 <= self._per_minute
