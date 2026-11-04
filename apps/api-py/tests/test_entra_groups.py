"""canvas-2h2w.3: sharing with Entra groups assigned to the Canvas app. The real sign-in flow and the real Graph
client, with only the network faked: tests/test_auth_oidc.py's identity provider, plus the client-credentials
token and Microsoft Graph's service-principal and appRoleAssignedTo answers."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from sqlalchemy import text

from tests.auth_helpers import Site
from tests.test_auth_oidc import (
    CLIENT_ID,
    OIDC_SETTINGS,
    TOKEN_ENDPOINT,
    FakeIdp,
    callback,
    claims,
    signed_in_cookie,
    start_login,
)

GRAPH = "https://graph.microsoft.com/v1.0"
SP_ID = "sp-object-id"
ARCHITECTS = "aaaaaaaa-0000-0000-0000-000000000001"
REVIEWERS = "aaaaaaaa-0000-0000-0000-000000000002"
NOT_ASSIGNED = "aaaaaaaa-0000-0000-0000-000000000099"


class FakeMicrosoft(FakeIdp):
    def __init__(self) -> None:
        super().__init__()
        self.graph_calls: list[httpx.Request] = []
        self.graph_status = 200
        self.assignments = [
            {"principalId": REVIEWERS, "principalDisplayName": "Reviewers", "principalType": "Group"},
            {"principalId": "user-1", "principalDisplayName": "Somebody", "principalType": "User"},
        ]
        self.second_page = [
            {"principalId": ARCHITECTS, "principalDisplayName": "Architects", "principalType": "Group"},
        ]

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == TOKEN_ENDPOINT:
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if form.get("grant_type") == "client_credentials":
                self.token_requests.append(form)
                return httpx.Response(
                    200, json={"token_type": "Bearer", "access_token": "graph-token", "expires_in": 3600}
                )
        if url.startswith(GRAPH):
            self.graph_calls.append(request)
            assert request.headers["authorization"] == "Bearer graph-token"
            if self.graph_status != 200:
                return httpx.Response(self.graph_status, json={"error": {"code": "Authorization_RequestDenied"}})
            if request.url.path.endswith(f"/servicePrincipals(appId='{CLIENT_ID}')"):
                return httpx.Response(200, json={"id": SP_ID})
            if request.url.path.endswith(f"/servicePrincipals/{SP_ID}/appRoleAssignedTo"):
                if request.url.params.get("$skiptoken") == "2":
                    return httpx.Response(200, json={"value": self.second_page})
                return httpx.Response(
                    200,
                    json={
                        "value": self.assignments,
                        "@odata.nextLink": f"{GRAPH}/servicePrincipals/{SP_ID}/appRoleAssignedTo?$skiptoken=2",
                    },
                )
            raise AssertionError(f"unexpected Graph request {url}")
        return super().handler(request)


@pytest.fixture()
def ms() -> FakeMicrosoft:
    return FakeMicrosoft()


@pytest.fixture()
def site(make_site: Any, ms: FakeMicrosoft) -> Site:
    site: Site = make_site(httpx.MockTransport(ms.handler), **OIDC_SETTINGS, entra_groups_setting="true")
    site.api.diagram_type("flowchart")
    return site


def sign_in(
    site: Site, ms: FakeMicrosoft, email: str, groups: list[str] | None, role: str = "architect", **extra: Any
) -> str:
    cookie, state, nonce = start_login(site)
    token_claims = claims(nonce=nonce, email=email, sub=f"sub-{email}", name=email.split("@")[0], roles=[role], **extra)
    if groups is not None:
        token_claims["groups"] = groups
    ms.respond_with(ms.sign(token_claims))
    response = callback(site, cookie, state)
    assert response.status_code == 302, response.text
    return signed_in_cookie(response)


def query_rows(site: Site, sql: str, **params: Any) -> list[dict[str, Any]]:
    with site.engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(text(sql), params)]


def memberships(site: Site, email: str) -> list[str]:
    found = query_rows(
        site,
        "SELECT m.group_id FROM user_group_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = :e"
        " ORDER BY m.group_id",
        e=email,
    )
    return [r["group_id"] for r in found]


def new_project(site: Site, cookie: str, name: str = "Payments") -> str:
    response = site.request("POST", "/projects", cookie, json={"name": name})
    assert response.status_code == 201, response.text
    return str(response.json()["project"]["id"])


def share(site: Site, cookie: str, subject: str, subject_id: str, level: str, **grantee: str) -> httpx.Response:
    return site.request("POST", f"/{subject}/{subject_id}/shares", cookie, json={**grantee, "accessLevel": level})


def your_access(site: Site, cookie: str, project: str) -> str:
    response = site.request("GET", f"/projects/{project}/members", cookie)
    assert response.status_code == 200, response.text
    return str(response.json()["yourAccess"])


# --- sign-in records the groups -------------------------------------------------------------------------------


def test_sign_in_records_the_groups_in_the_token_and_the_next_one_replaces_them(site: Site, ms: FakeMicrosoft) -> None:
    sign_in(site, ms, "ann@contoso.com", [ARCHITECTS, REVIEWERS, ARCHITECTS, 7, "x" * 65])  # junk dropped
    assert memberships(site, "ann@contoso.com") == [ARCHITECTS, REVIEWERS]
    sign_in(site, ms, "ann@contoso.com", [REVIEWERS])
    assert memberships(site, "ann@contoso.com") == [REVIEWERS]
    sign_in(site, ms, "ann@contoso.com", None)  # no claim: in no assigned group
    assert memberships(site, "ann@contoso.com") == []


def test_too_many_groups_leaves_the_record_as_it_was(site: Site, ms: FakeMicrosoft) -> None:
    sign_in(site, ms, "ann@contoso.com", [ARCHITECTS])
    sign_in(site, ms, "ann@contoso.com", None, _claim_names={"groups": "src1"}, _claim_sources={"src1": {}})
    assert memberships(site, "ann@contoso.com") == [ARCHITECTS]


def test_with_groups_off_sign_in_records_nothing_and_the_routes_say_so(make_site: Any, ms: FakeMicrosoft) -> None:
    off: Site = make_site(httpx.MockTransport(ms.handler), **OIDC_SETTINGS)
    cookie = sign_in(off, ms, "ann@contoso.com", [ARCHITECTS])
    assert memberships(off, "ann@contoso.com") == []
    assert off.get("/auth/config").json()["groupsEnabled"] is False
    assert off.request("GET", "/groups", cookie).status_code == 400
    project = new_project(off, cookie)
    assert share(off, cookie, "projects", project, "view", granteeGroupId=ARCHITECTS).status_code == 400
    assert ms.graph_calls == []


# --- the picker ---------------------------------------------------------------------------------------------


def test_the_picker_lists_the_groups_assigned_to_canvas(site: Site, ms: FakeMicrosoft) -> None:
    assert site.get("/auth/config").json()["groupsEnabled"] is True
    cookie = sign_in(site, ms, "ann@contoso.com", [])
    response = site.request("GET", "/groups", cookie)
    assert response.status_code == 200, response.text
    # Both pages, groups only (not the assigned user), by name.
    assert response.json() == {
        "groups": [{"id": ARCHITECTS, "displayName": "Architects"}, {"id": REVIEWERS, "displayName": "Reviewers"}]
    }
    assert site.request("GET", "/groups?q=revi", cookie).json()["groups"] == [
        {"id": REVIEWERS, "displayName": "Reviewers"}
    ]
    # An app-only token, with the same client authentication as sign-in.
    sent = ms.token_requests[-1]
    assert sent["grant_type"] == "client_credentials"
    assert sent["scope"] == "https://graph.microsoft.com/.default"
    assert sent["client_secret"] == "test-client-secret"
    # Cached: asking again doesn't go back to Graph.
    calls = len(ms.graph_calls)
    site.request("GET", "/groups", cookie)
    assert len(ms.graph_calls) == calls


def test_signed_out_gets_no_groups_and_graph_trouble_is_a_503(site: Site, ms: FakeMicrosoft) -> None:
    assert site.request("GET", "/groups").status_code == 401
    cookie = sign_in(site, ms, "ann@contoso.com", [])
    ms.graph_status = 403  # e.g. no admin consent
    response = site.request("GET", "/groups", cookie)
    assert response.status_code == 503
    assert "Microsoft" in response.json()["error"]


# --- sharing with a group -----------------------------------------------------------------------------------


def test_a_group_member_gets_the_groups_access_and_nobody_else_does(site: Site, ms: FakeMicrosoft) -> None:
    owner = sign_in(site, ms, "olive@contoso.com", [])
    member = sign_in(site, ms, "ann@contoso.com", [ARCHITECTS])
    outsider = sign_in(site, ms, "bob@contoso.com", [REVIEWERS])
    project = new_project(site, owner)

    response = share(site, owner, "projects", project, "edit", granteeGroupId=ARCHITECTS)
    assert response.status_code == 201, response.text
    grant = response.json()["grant"]
    assert (grant["granteeUserId"], grant["granteeGroupId"], grant["accessLevel"]) == (None, ARCHITECTS, "edit")

    assert your_access(site, member, project) == "edit"
    assert your_access(site, outsider, project) == "view"  # everyone signed in can read

    members = site.request("GET", f"/projects/{project}/members", owner).json()["members"]
    assert members == [
        {
            "grantId": grant["id"],
            "userId": None,
            "groupId": ARCHITECTS,
            "name": "Architects",
            "email": None,
            "accessLevel": "edit",
        }
    ]
    listed = site.request("GET", f"/projects/{project}/shares", owner).json()["grants"]
    assert [(g["granteeGroupId"], g["granteeName"], g["granteeEmail"]) for g in listed] == [
        (ARCHITECTS, "Architects", None)
    ]
    # Sharing again changes the level of the same grant.
    again = share(site, owner, "projects", project, "manage", granteeGroupId=ARCHITECTS).json()["grant"]
    assert again["id"] == grant["id"]
    assert your_access(site, member, project) == "manage"

    # Leaving the group in Entra takes effect at the next sign-in.
    member = sign_in(site, ms, "ann@contoso.com", [])
    assert your_access(site, member, project) == "view"


def test_the_higher_of_a_direct_and_a_group_grant_counts(site: Site, ms: FakeMicrosoft) -> None:
    owner = sign_in(site, ms, "olive@contoso.com", [])
    member = sign_in(site, ms, "ann@contoso.com", [ARCHITECTS])
    member_id = str(site.api.scalar("SELECT id FROM users WHERE email = 'ann@contoso.com'"))
    project = new_project(site, owner)
    share(site, owner, "projects", project, "comment", granteeGroupId=ARCHITECTS)
    share(site, owner, "projects", project, "edit", granteeUserId=member_id)
    assert your_access(site, member, project) == "edit"

    diagram = site.request(
        "POST", f"/projects/{project}/diagrams", owner, json={"name": "Flow", "diagramTypeId": "flowchart"}
    ).json()["diagram"]["id"]
    other = new_project(site, owner, "Other")
    loose = site.request(
        "POST", f"/projects/{other}/diagrams", owner, json={"name": "Loose", "diagramTypeId": "flowchart"}
    ).json()["diagram"]["id"]
    share(site, owner, "diagrams", loose, "view", granteeUserId=member_id)
    share(site, owner, "diagrams", loose, "edit", granteeGroupId=ARCHITECTS)
    assert diagram
    shared = site.request("GET", "/shared-diagrams", member).json()["diagrams"]
    assert [(d["diagramName"], d["accessLevel"]) for d in shared] == [("Loose", "edit")]  # once, at the higher level


def test_refused_group_shares(site: Site, ms: FakeMicrosoft) -> None:
    owner = sign_in(site, ms, "olive@contoso.com", [])
    project = new_project(site, owner)
    unassigned = share(site, owner, "projects", project, "view", granteeGroupId=NOT_ASSIGNED)
    assert unassigned.status_code == 400
    assert "assigned to Canvas" in unassigned.json()["error"]
    owner_id = str(site.api.scalar("SELECT id FROM users WHERE email = 'olive@contoso.com'"))
    both = share(site, owner, "projects", project, "view", granteeGroupId=ARCHITECTS, granteeUserId=owner_id)
    assert both.status_code == 400
    neither = site.request("POST", f"/projects/{project}/shares", owner, json={"accessLevel": "view"})
    assert neither.status_code == 400
    # Someone who can't share there never makes Canvas ask Microsoft.
    stranger = sign_in(site, ms, "bob@contoso.com", [])
    calls = len(ms.graph_calls)
    assert share(site, stranger, "projects", project, "view", granteeGroupId=ARCHITECTS).status_code == 403
    assert len(ms.graph_calls) == calls


def test_removing_a_group_share_and_no_notifications_for_groups(site: Site, ms: FakeMicrosoft) -> None:
    owner = sign_in(site, ms, "olive@contoso.com", [])
    member = sign_in(site, ms, "ann@contoso.com", [ARCHITECTS])
    project = new_project(site, owner)
    grant = share(site, owner, "projects", project, "edit", granteeGroupId=ARCHITECTS).json()["grant"]
    assert site.request("GET", "/me/notifications", member).json()["notifications"] == []
    assert site.request("DELETE", f"/shares/{grant['id']}", owner).status_code == 204
    assert your_access(site, member, project) == "view"
    audit = query_rows(
        site, "SELECT event, target_user_id FROM audit_events WHERE event LIKE 'project_member_%' ORDER BY occurred_at"
    )
    assert [(a["event"], a["target_user_id"]) for a in audit] == [
        ("project_member_added", None),
        ("project_member_removed", None),
    ]
