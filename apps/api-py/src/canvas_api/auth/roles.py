"""apps/api/src/auth/middleware.ts requireRole: signed in (401), with one of the roles (403).

Like the TypeScript service, the role comes from the session (set at sign-in), not a fresh read.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import Depends

from canvas_api.auth.session import SessionUser, current_user
from canvas_api.errors import ApiError

Role = Literal["admin", "architect", "viewer"]


def require_role(*roles: Role) -> Callable[[SessionUser], SessionUser]:
    def dependency(user: Annotated[SessionUser, Depends(current_user)]) -> SessionUser:
        if user.role not in roles:
            raise ApiError(403, f"This action requires one of the following roles: {', '.join(roles)}")
        return user

    return dependency


CurrentUser = Annotated[SessionUser, Depends(current_user)]
AdminUser = Annotated[SessionUser, Depends(require_role("admin"))]
ArchitectOrAdmin = Annotated[SessionUser, Depends(require_role("architect", "admin"))]
