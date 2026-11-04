"""canvas-2h2w.3: Entra group membership as Canvas sees it. At each Entra sign-in the ID token's `groups` claim
(the Canvas app's assigned groups the person is in, with groupMembershipClaims = ApplicationGroup) replaces what
was recorded before; access checks read it from `user_group_memberships`. So a change in Entra takes effect at the
person's next sign-in."""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import Connection, text

from canvas_api.auth.graph import EntraGroup
from canvas_api.timestamps import now_utc, to_db

log = structlog.get_logger()

#: Ids are GUIDs; anything longer isn't a group id (and a token is untrusted input to a database row).
_MAX_ID_LENGTH = 64


def groups_from_claims(claims: dict[str, Any]) -> list[str] | None:
    """The group ids in the token, or None when it doesn't say (the claim is missing, or Entra left it out
    because there were too many and pointed at Graph instead: `_claim_names.groups`)."""
    names = claims.get("_claim_names")
    if isinstance(names, dict) and "groups" in names:
        return None
    raw = claims.get("groups")
    if raw is None:
        return []
    if not isinstance(raw, list):
        return None
    return list(dict.fromkeys(g for g in raw if isinstance(g, str) and 0 < len(g) <= _MAX_ID_LENGTH))


def record_memberships(conn: Connection, user_id: str, claims: dict[str, Any]) -> None:
    """Replaces the person's recorded groups with the token's. When the token doesn't say (too many groups), the
    old record stays and that's logged: more than 200 groups assigned to one app isn't expected."""
    groups = groups_from_claims(claims)
    if groups is None:
        log.warning("Entra sign-in token has no usable groups claim; group memberships left as they were")
        return
    conn.execute(text("DELETE FROM user_group_memberships WHERE user_id = :id"), {"id": user_id})
    for group_id in groups:
        conn.execute(
            text("INSERT INTO user_group_memberships (user_id, group_id) VALUES (:user, :group)"),
            {"user": user_id, "group": group_id},
        )


def remember_group(conn: Connection, group: EntraGroup) -> None:
    """Keeps the group's current name (shown in share lists), adding it the first time it's picked."""
    params = {"id": group.id, "name": group.display_name, "at": to_db(now_utc(), conn.dialect.name)}
    updated = conn.execute(
        text("UPDATE entra_groups SET display_name = :name, updated_at = :at WHERE id = :id"), params
    ).rowcount
    if not updated:
        conn.execute(text("INSERT INTO entra_groups (id, display_name, updated_at) VALUES (:id, :name, :at)"), params)
