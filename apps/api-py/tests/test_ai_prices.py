"""The cost estimate (canvas-zs0): the cases of apps/api/tests/unit/ai-prices.test.ts."""

from __future__ import annotations

import pytest

from canvas_api.ai.usage import estimate_cost

PRICE = {
    "provider": "p",
    "modelId": "m",
    "inputPerMillion": 3,
    "outputPerMillion": 15,
    "cacheReadPerMillion": 0.3,
    "cacheWritePerMillion": 3.75,
}


def tokens(input: int, output: int, cache_read: int = 0, cache_write: int = 0) -> dict[str, int]:
    return {
        "inputTokens": input,
        "outputTokens": output,
        "cacheReadTokens": cache_read,
        "cacheWriteTokens": cache_write,
    }


def test_prices_plain_input_and_output_per_million_tokens() -> None:
    assert estimate_cost(tokens(1_000_000, 1_000_000), PRICE) == pytest.approx(18, abs=1e-10)
    assert estimate_cost(tokens(500, 200), PRICE) == pytest.approx((500 * 3 + 200 * 15) / 1e6, abs=1e-12)


def test_charges_cached_tokens_at_their_own_rates_and_only_the_rest_at_the_input_rate() -> None:
    # 1M input of which 200k read from cache and 100k written to it: 700k at 3, 200k at 0.3, 100k at 3.75.
    cost = estimate_cost(tokens(1_000_000, 100_000, 200_000, 100_000), PRICE)
    assert cost == pytest.approx(2.1 + 0.06 + 0.375 + 1.5, abs=1e-10)


def test_never_charges_negative_uncached_input_when_cache_tokens_exceed_the_input_total() -> None:
    cost = estimate_cost(tokens(100, 0, 80, 50), PRICE)
    assert cost == pytest.approx((80 * 0.3 + 50 * 3.75) / 1e6, abs=1e-12)
    assert cost > 0


def test_is_zero_for_zero_tokens_and_for_a_free_model() -> None:
    assert estimate_cost(tokens(0, 0), PRICE) == 0
    free = {
        **PRICE,
        "inputPerMillion": 0,
        "outputPerMillion": 0,
        "cacheReadPerMillion": 0,
        "cacheWritePerMillion": 0,
    }
    assert estimate_cost(tokens(9, 9, 1, 1), free) == 0
