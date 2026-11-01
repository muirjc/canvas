"""The audit log (apps/api/src/audit/audit.service.ts). Never records a password."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from fastapi import Request
from sqlalchemy import Connection, text

from canvas_api.timestamps import now_utc, to_db


def record_audit(
    conn: Connection,
    event: str,
    *,
    actor_user_id: str | None = None,
    target_user_id: str | None = None,
    ip: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    conn.execute(
        text(
            "INSERT INTO audit_events (id, occurred_at, event, actor_user_id, target_user_id, ip, detail)"
            " VALUES (:id, :at, :event, :actor, :target, :ip, :detail)"
        ),
        {
            "id": str(uuid4()),
            "at": to_db(now_utc(), conn.dialect.name),
            "event": event,
            "actor": actor_user_id,
            "target": target_user_id,
            "ip": ip,
            # JSON.stringify's compact form, so both services write the same text.
            "detail": json.dumps(detail, separators=(",", ":"), ensure_ascii=False) if detail else None,
        },
    )


#: Set by the TypeScript front door to the client address it worked out (apps/api/src/python/front-door.ts),
#: overwriting anything the client sent. This service is internal-only, so only the front door reaches it.
CLIENT_IP_HEADER = "x-canvas-client-ip"


def client_ip(request: Request) -> str:
    """The client's address for the audit log, as apps/api's clientIp() sees it.

    Behind the front door, its header. Otherwise (local runs, tests) the same rule as apps/api: the LAST
    X-Forwarded-For entry, the one Azure's ingress appended (the first is whatever the client claims).
    """
    from_front_door = request.headers.get(CLIENT_IP_HEADER)
    if from_front_door:
        return from_front_door
    forwarded = request.headers.get("x-forwarded-for")
    last = forwarded.split(",")[-1].strip() if forwarded else ""
    if last:
        return last
    return request.client.host if request.client else ""
