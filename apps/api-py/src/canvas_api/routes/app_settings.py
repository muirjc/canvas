"""Platform feature switches (phase 2, canvas-1bty.6; apps/api/src/settings/app-settings.routes.ts).

Any signed-in user reads them (the web app hides what's switched off); only an admin changes them, and
each change is audited.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Request
from sqlalchemy import Connection, Engine, text

from canvas_api.audit import client_ip, record_audit
from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.db import get_engine
from canvas_api.errors import ApiError

router = APIRouter(tags=["Settings"])
Db = Annotated[Engine, Depends(get_engine)]

#: The settings there are (all booleans so far). A new one gets its own column in the UPDATE below.
_SETTINGS = ("sharingEnabled",)


def _read(conn: Connection) -> dict[str, bool]:
    row = conn.execute(text("SELECT sharing_enabled FROM app_settings")).one()
    return {"sharingEnabled": bool(row.sharing_enabled)}


@router.get("/app-settings")
def get_app_settings(_user: CurrentUser, db: Db) -> dict[str, bool]:
    with db.connect() as conn:
        return _read(conn)


@router.patch("/admin/app-settings")
def set_app_settings(
    request: Request, admin: AdminUser, db: Db, body: Annotated[Any, Body()] = None
) -> dict[str, bool]:
    # As the TypeScript route's schema: an object; unknown keys dropped; known ones must be booleans.
    if not isinstance(body, dict):
        raise ApiError(400, "body must be object")
    changes: dict[str, bool] = {}
    for setting in _SETTINGS:
        if setting in body:
            value = body[setting]
            if not isinstance(value, bool):
                raise ApiError(400, f"body/{setting} must be boolean")
            changes[setting] = value
    if not changes:
        raise ApiError(400, "No known setting to change.")
    with db.begin() as conn:
        before = _read(conn)
        conn.execute(
            text("UPDATE app_settings SET sharing_enabled = :sharingEnabled, updated_at = CURRENT_TIMESTAMP"),
            changes,
        )
        after = _read(conn)
        for setting in changes:
            if before[setting] == after[setting]:
                continue
            record_audit(
                conn,
                "app_setting_changed",
                actor_user_id=admin.id,
                ip=client_ip(request),
                detail={"setting": setting, "from": before[setting], "to": after[setting]},
            )
    return after
