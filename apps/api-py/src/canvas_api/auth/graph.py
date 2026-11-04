"""canvas-2h2w.3: the Entra groups assigned to the Canvas app, from Microsoft Graph -- the groups people can share
with. Read with an app-only token (OidcClient.app_token: client credentials, the same client authentication as
sign-in), which needs Graph's Application.Read.All application permission with admin consent (RUNBOOK, "Entra
groups"). Assigned groups are what the ID token's `groups` claim reports with groupMembershipClaims set to
ApplicationGroup, so the picker and the access checks agree on which groups exist.

Cached for five minutes: an admin's assignment change shows within that.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from canvas_api.auth.oidc import OidcClient, OidcError

GRAPH_SCOPE = "https://graph.microsoft.com/.default"
_CACHE_SECONDS = 5 * 60
#: Paging guard: Graph pages assignments 100 at a time by default.
_MAX_PAGES = 50


class GraphError(RuntimeError):
    """Graph couldn't be asked, or refused (no permission, no consent). The message is safe to log."""


@dataclass(frozen=True)
class EntraGroup:
    id: str
    display_name: str


class GraphClient:
    def __init__(self, oidc: OidcClient, base_url: str) -> None:
        self._oidc = oidc
        self._base = base_url.rstrip("/")
        self._lock = threading.Lock()
        self._groups: list[EntraGroup] | None = None
        self._fetched_at = 0.0

    def _get(self, url: str) -> dict[str, Any]:
        try:
            token = self._oidc.app_token(GRAPH_SCOPE)
            response = self._oidc.http.get(
                url, headers={"authorization": f"Bearer {token}", "accept": "application/json"}
            )
        except (OidcError, httpx.HTTPError) as error:
            raise GraphError(f"couldn't reach Microsoft Graph: {error}") from error
        if response.status_code != 200:
            raise GraphError(f"Microsoft Graph answered {response.status_code} for {url.split('?')[0]}")
        body = response.json()
        if not isinstance(body, dict):
            raise GraphError("Microsoft Graph answered with something that isn't an object")
        return body

    def assigned_groups(self) -> list[EntraGroup]:
        """Every group assigned to the Canvas app (its service principal), sorted by name."""
        with self._lock:
            if self._groups is not None and time.time() - self._fetched_at < _CACHE_SECONDS:
                return self._groups
        client_id = quote(self._oidc.config.client_id, safe="")
        principal = self._get(f"{self._base}/servicePrincipals(appId='{client_id}')?$select=id")
        principal_id = principal.get("id")
        if not isinstance(principal_id, str) or not principal_id:
            raise GraphError("Microsoft Graph returned no service principal for the Canvas app")
        url: str | None = (
            f"{self._base}/servicePrincipals/{quote(principal_id, safe='')}/appRoleAssignedTo"
            "?$select=principalId,principalDisplayName,principalType&$top=999"
        )
        groups: dict[str, EntraGroup] = {}
        for _ in range(_MAX_PAGES):
            if url is None:
                break
            page = self._get(url)
            for item in page.get("value") or []:
                if not isinstance(item, dict) or item.get("principalType") != "Group":
                    continue
                group_id, name = item.get("principalId"), item.get("principalDisplayName")
                if isinstance(group_id, str) and group_id:
                    groups[group_id] = EntraGroup(group_id, name if isinstance(name, str) and name else group_id)
            next_link = page.get("@odata.nextLink")
            url = next_link if isinstance(next_link, str) and next_link.startswith(self._base + "/") else None
        result = sorted(groups.values(), key=lambda g: (g.display_name.casefold(), g.id))
        with self._lock:
            self._groups = result
            self._fetched_at = time.time()
        return result

    def find(self, group_id: str) -> EntraGroup | None:
        return next((g for g in self.assigned_groups() if g.id == group_id), None)
