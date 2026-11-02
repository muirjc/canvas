"""AI token usage and model prices (apps/api/src/ai/ai-usage.service.ts, ai-prices.service.ts).

Every chat turn records its tokens (ai_usage); admins see them by user and by day/model over a period, with
a cost estimate from the per-model prices they enter. The arithmetic follows the TypeScript service exactly
(the same float operations in the same order), so both services report the same estimates.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, bindparam, text

from canvas_api.timestamps import now_utc, to_api_ms, to_db

_BY_USER = text(
    "SELECT ai_usage.user_id AS user_id, users.email AS email, users.name AS name, ai_usage.provider AS provider,"
    " ai_usage.model_id AS model_id, COUNT(*) AS requests,"
    " SUM(CASE WHEN ai_usage.succeeded THEN 0 ELSE 1 END) AS failed_requests,"
    " SUM(ai_usage.input_tokens) AS input_tokens, SUM(ai_usage.output_tokens) AS output_tokens,"
    " SUM(ai_usage.cache_read_tokens) AS cache_read_tokens, SUM(ai_usage.cache_write_tokens) AS cache_write_tokens,"
    " MAX(ai_usage.occurred_at) AS last_used_at"
    " FROM ai_usage LEFT JOIN users ON users.id = ai_usage.user_id"
    " WHERE ai_usage.occurred_at >= :from_ AND ai_usage.occurred_at < :to"
    " GROUP BY ai_usage.user_id, users.email, users.name, ai_usage.provider, ai_usage.model_id"
)
_DETAIL_POSTGRES = text(
    "SELECT to_char(ai_usage.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, ai_usage.provider AS provider,"
    " ai_usage.model_id AS model_id, COUNT(*) AS requests,"
    " SUM(CASE WHEN ai_usage.succeeded THEN 0 ELSE 1 END) AS failed_requests,"
    " SUM(ai_usage.input_tokens) AS input_tokens, SUM(ai_usage.output_tokens) AS output_tokens,"
    " SUM(ai_usage.cache_read_tokens) AS cache_read_tokens, SUM(ai_usage.cache_write_tokens) AS cache_write_tokens"
    " FROM ai_usage WHERE ai_usage.user_id = :user AND ai_usage.occurred_at >= :from_ AND ai_usage.occurred_at < :to"
    " GROUP BY to_char(ai_usage.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), ai_usage.provider, ai_usage.model_id"
)
_DETAIL_SQLITE = text(
    "SELECT strftime('%Y-%m-%d', ai_usage.occurred_at) AS day, ai_usage.provider AS provider,"
    " ai_usage.model_id AS model_id, COUNT(*) AS requests,"
    " SUM(CASE WHEN ai_usage.succeeded THEN 0 ELSE 1 END) AS failed_requests,"
    " SUM(ai_usage.input_tokens) AS input_tokens, SUM(ai_usage.output_tokens) AS output_tokens,"
    " SUM(ai_usage.cache_read_tokens) AS cache_read_tokens, SUM(ai_usage.cache_write_tokens) AS cache_write_tokens"
    " FROM ai_usage WHERE ai_usage.user_id = :user AND ai_usage.occurred_at >= :from_ AND ai_usage.occurred_at < :to"
    " GROUP BY strftime('%Y-%m-%d', ai_usage.occurred_at), ai_usage.provider, ai_usage.model_id"
)
_DIAGRAM_TOTAL = text(
    "SELECT COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens"
    " FROM ai_usage WHERE diagram_id = :diagram"
)
_OWN = text(
    "SELECT COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens"
    " FROM ai_usage WHERE user_id = :user AND occurred_at >= :from_ AND occurred_at < :to"
)
_FOR_MESSAGES = text(
    "SELECT chat_message_id, input_tokens, output_tokens FROM ai_usage WHERE chat_message_id IN :ids"
).bindparams(bindparam("ids", expanding=True))
_PRICES = text(
    "SELECT provider, model_id, input_per_million, output_per_million, cache_read_per_million,"
    " cache_write_per_million, updated_at FROM ai_model_prices ORDER BY provider, model_id"
)
_UNPRICED = text(
    "SELECT DISTINCT ai_usage.provider AS provider, ai_usage.model_id AS model_id FROM ai_usage"
    " LEFT JOIN ai_model_prices ON ai_model_prices.provider = ai_usage.provider"
    " AND ai_model_prices.model_id = ai_usage.model_id"
    " WHERE ai_model_prices.provider IS NULL ORDER BY ai_usage.provider, ai_usage.model_id"
)
_SET_PRICE = text(
    "INSERT INTO ai_model_prices (provider, model_id, input_per_million, output_per_million, cache_read_per_million,"
    " cache_write_per_million) VALUES (:provider, :model, :input, :output, :cache_read, :cache_write)"
    " ON CONFLICT (provider, model_id) DO UPDATE SET input_per_million = :input, output_per_million = :output,"
    " cache_read_per_million = :cache_read, cache_write_per_million = :cache_write, updated_at = CURRENT_TIMESTAMP"
)
_INSERT = text(
    "INSERT INTO ai_usage (id, occurred_at, user_id, diagram_id, provider, model_id, mode, steps, input_tokens,"
    " output_tokens, cache_read_tokens, cache_write_tokens, succeeded, chat_message_id) VALUES (:id, :at, :user,"
    " :diagram, :provider, :model, :mode, :steps, :input, :output, :cache_read, :cache_write, :succeeded, :message)"
)


def record_usage(
    conn: Connection,
    *,
    user_id: str | None,
    diagram_id: str | None,
    provider: str,
    model_id: str,
    mode: str,
    steps: int,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    succeeded: bool,
    chat_message_id: str | None = None,
) -> None:
    conn.execute(
        _INSERT,
        {
            "id": str(uuid4()),
            "at": to_db(now_utc(), conn.dialect.name),
            "user": user_id,
            "diagram": diagram_id,
            "provider": provider,
            "model": model_id,
            "mode": mode,
            "steps": steps,
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read_tokens,
            "cache_write": cache_write_tokens,
            "succeeded": succeeded,
            "message": chat_message_id,
        },
    )


# --- prices -------------------------------------------------------------------------------------------


def list_prices(conn: Connection) -> list[dict[str, Any]]:
    return [
        {
            "provider": r.provider,
            "modelId": r.model_id,
            "inputPerMillion": float(r.input_per_million),
            "outputPerMillion": float(r.output_per_million),
            "cacheReadPerMillion": float(r.cache_read_per_million),
            "cacheWritePerMillion": float(r.cache_write_per_million),
            "updatedAt": to_api_ms(r.updated_at),
        }
        for r in conn.execute(_PRICES)
    ]


def set_price(conn: Connection, price: dict[str, Any]) -> None:
    conn.execute(
        _SET_PRICE,
        {
            "provider": price["provider"],
            "model": price["modelId"],
            "input": price["inputPerMillion"],
            "output": price["outputPerMillion"],
            "cache_read": price["cacheReadPerMillion"],
            "cache_write": price["cacheWritePerMillion"],
        },
    )


def delete_price(conn: Connection, provider: str, model_id: str) -> bool:
    deleted = conn.execute(
        text("DELETE FROM ai_model_prices WHERE provider = :provider AND model_id = :model"),
        {"provider": provider, "model": model_id},
    )
    return bool(deleted.rowcount)


def unpriced_models(conn: Connection) -> list[dict[str, str]]:
    return [{"provider": r.provider, "modelId": r.model_id} for r in conn.execute(_UNPRICED)]


def estimate_cost(tokens: dict[str, Any], price: dict[str, Any]) -> float:
    uncached = max(0, tokens["inputTokens"] - tokens["cacheReadTokens"] - tokens["cacheWriteTokens"])
    return float(
        (
            uncached * price["inputPerMillion"]
            + tokens["cacheReadTokens"] * price["cacheReadPerMillion"]
            + tokens["cacheWriteTokens"] * price["cacheWritePerMillion"]
            + tokens["outputTokens"] * price["outputPerMillion"]
        )
        / 1_000_000
    )


# --- summaries ----------------------------------------------------------------------------------------


def _totals(row: Any) -> dict[str, int]:
    def n(value: Any) -> int:
        return int(value or 0)

    input_tokens, output_tokens = n(row.input_tokens), n(row.output_tokens)
    return {
        "requests": n(row.requests),
        "failedRequests": n(row.failed_requests),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": n(row.cache_read_tokens),
        "cacheWriteTokens": n(row.cache_write_tokens),
        "totalTokens": input_tokens + output_tokens,
    }


def _empty() -> dict[str, Any]:
    return {
        "requests": 0,
        "failedRequests": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "totalTokens": 0,
        "estimatedCost": 0,
        "unpricedTokens": 0,
    }


def _add(acc: dict[str, Any], t: dict[str, int], price: dict[str, Any] | None) -> None:
    for key in ("requests", "failedRequests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
        acc[key] += t[key]
    acc["totalTokens"] += t["totalTokens"]
    if price:
        acc["estimatedCost"] += estimate_cost(t, price)
    else:
        acc["unpricedTokens"] += t["totalTokens"]


def _price_lookup(conn: Connection) -> dict[tuple[str, str], dict[str, Any]]:
    return {(p["provider"], p["modelId"]): p for p in list_prices(conn)}


def summarize_by_user(conn: Connection, from_: datetime, to: datetime) -> dict[str, Any]:
    prices = _price_lookup(conn)
    dialect = conn.dialect.name
    users: dict[str, dict[str, Any]] = {}
    totals = _empty()
    for r in conn.execute(_BY_USER, {"from_": to_db(from_, dialect), "to": to_db(to, dialect)}):
        key = str(r.user_id) if r.user_id is not None else ""
        last_used = to_api_ms(r.last_used_at)
        user = users.get(key)
        if user is None:
            user = {
                "userId": str(r.user_id) if r.user_id is not None else None,
                "email": r.email,
                "name": r.name,
                "lastUsedAt": last_used,
                **_empty(),
            }
            users[key] = user
        elif last_used and last_used > user["lastUsedAt"]:
            user["lastUsedAt"] = last_used
        t = _totals(r)
        price = prices.get((r.provider, r.model_id))
        _add(user, t, price)
        _add(totals, t, price)
    return {"users": sorted(users.values(), key=lambda u: -u["totalTokens"]), "totals": totals}


def user_detail(conn: Connection, user_id: str, from_: datetime, to: datetime) -> dict[str, Any]:
    prices = _price_lookup(conn)
    dialect = conn.dialect.name
    statement = _DETAIL_SQLITE if dialect == "sqlite" else _DETAIL_POSTGRES
    by_day: dict[str, dict[str, Any]] = {}
    by_model: dict[tuple[str, str], dict[str, Any]] = {}
    for r in conn.execute(statement, {"user": user_id, "from_": to_db(from_, dialect), "to": to_db(to, dialect)}):
        t = _totals(r)
        price = prices.get((r.provider, r.model_id))
        day = by_day.setdefault(r.day, {"day": r.day, **_empty()})
        _add(day, t, price)
        model = by_model.setdefault(
            (r.provider, r.model_id),
            {"provider": r.provider, "modelId": r.model_id, "priced": price is not None, **_empty()},
        )
        _add(model, t, price)
    return {
        "byDay": sorted(by_day.values(), key=lambda d: d["day"]),
        "byModel": sorted(by_model.values(), key=lambda m: -m["totalTokens"]),
    }


def _counts(row: Any) -> dict[str, int]:
    input_tokens, output_tokens = int(row.input_tokens or 0), int(row.output_tokens or 0)
    return {
        "requests": int(row.requests or 0),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": input_tokens + output_tokens,
    }


def diagram_usage_total(conn: Connection, diagram_id: str) -> dict[str, int]:
    return _counts(conn.execute(_DIAGRAM_TOTAL, {"diagram": diagram_id}).one())


def own_usage(conn: Connection, user_id: str, from_: datetime, to: datetime) -> dict[str, int]:
    dialect = conn.dialect.name
    return _counts(
        conn.execute(_OWN, {"user": user_id, "from_": to_db(from_, dialect), "to": to_db(to, dialect)}).one()
    )


def usage_for_messages(conn: Connection, message_ids: list[str]) -> dict[str, dict[str, int]]:
    if not message_ids:
        return {}
    return {
        str(r.chat_message_id): {
            "inputTokens": r.input_tokens,
            "outputTokens": r.output_tokens,
            "totalTokens": r.input_tokens + r.output_tokens,
        }
        for r in conn.execute(_FOR_MESSAGES, {"ids": message_ids})
    }
