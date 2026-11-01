"""Icon libraries and app settings (canvas-1bty.6), the cases of apps/api/tests/contract/libraries and
app-settings. Libraries are seeded directly: loading one (POST /libraries) is still TypeScript.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import text

from tests.api import Api, User

AWS = [
    {"id": "lambda", "displayName": "Lambda", "category": "Compute", "keywords": ["serverless", "function"]},
    {"id": "s3", "displayName": "S3", "category": "Storage", "keywords": ["storage", "bucket"]},
    {"id": "old", "displayName": "Old Storage Thing", "category": "Storage", "retired": True},
]
AZURE = [{"id": "storage-accounts", "displayName": "Storage Accounts", "category": "Storage", "keywords": ["blob"]}]
GENERIC = [{"id": "rectangle", "displayName": "Rectangle", "category": "Shapes"}]


@pytest.fixture()
def architect(api: Api) -> User:
    api.library("aws-icons", "1.0.0", AWS, license="Apache-2.0")
    api.library("azure-icons", "2.0.0", AZURE)
    api.library("generic", "1.0.0", GENERIC)
    api.diagram_type("cloud-infrastructure", "architecture", palette=["azure-icons", "aws-icons"])
    return api.user("architect@example.com")


def ids(icons: list[dict[str, str]]) -> list[str]:
    return [f"{i['libraryId']}:{i['id']}" for i in icons]


def test_lists_libraries_with_icon_counts(api: Api, architect: User) -> None:
    response = api.call("GET", "/libraries", architect)
    assert response.status_code == 200
    assert response.json()["libraries"] == [
        {"id": "aws-icons", "version": "1.0.0", "license": "Apache-2.0", "iconCount": 3},
        {"id": "azure-icons", "version": "2.0.0", "license": None, "iconCount": 1},
        {"id": "generic", "version": "1.0.0", "license": None, "iconCount": 1},
    ]


def test_searches_one_library_version_by_keyword(api: Api, architect: User) -> None:
    response = api.call("GET", "/libraries/aws-icons/versions/1.0.0/icons?query=serverless", architect)
    assert response.status_code == 200
    [icon] = response.json()["icons"]
    assert icon == {
        "libraryId": "aws-icons",
        "libraryVersion": "1.0.0",
        "id": "lambda",
        "displayName": "Lambda",
        "keywords": ["serverless", "function"],
        "category": "Compute",
        "assetRef": "<svg id='lambda'/>",
    }


def test_an_empty_query_lists_every_live_icon_and_matching_ignores_case(api: Api, architect: User) -> None:
    everything = api.call("GET", "/libraries/aws-icons/versions/1.0.0/icons", architect).json()["icons"]
    assert sorted(i["id"] for i in everything) == ["lambda", "s3"]  # the retired one isn't offered
    by_name = api.call("GET", "/libraries/aws-icons/versions/1.0.0/icons?query=%20LAMB%20", architect).json()["icons"]
    assert [i["id"] for i in by_name] == ["lambda"]


def test_searches_across_a_diagram_types_palette(api: Api, architect: User) -> None:
    response = api.call("GET", "/icons/search?diagramTypeId=cloud-infrastructure&query=storage", architect)
    assert response.status_code == 200
    assert sorted(ids(response.json()["icons"])) == ["aws-icons:s3", "azure-icons:storage-accounts"]


def test_leaves_out_libraries_outside_the_palette(api: Api, architect: User) -> None:
    response = api.call("GET", "/icons/search?diagramTypeId=cloud-infrastructure&query=rectangle", architect)
    assert response.json()["icons"] == []
    assert api.call("GET", "/icons/search?diagramTypeId=no-such-type", architect).json() == {"icons": []}


def test_icon_search_needs_a_diagram_type_and_sign_in(api: Api, architect: User) -> None:
    assert api.call("GET", "/icons/search?query=x", architect).status_code == 400
    assert api.call("GET", "/icons/search?diagramTypeId=", architect).status_code == 400
    assert api.call("GET", "/icons/search?diagramTypeId=cloud-infrastructure").status_code == 401
    assert api.call("GET", "/libraries").status_code == 401


# --- app settings ------------------------------------------------------------------------------------


@pytest.fixture()
def admin(api: Api) -> User:
    return api.user("admin@example.com", role="admin")


def test_sharing_is_off_by_default_and_any_signed_in_user_reads_it(api: Api, admin: User, architect: User) -> None:
    response = api.call("GET", "/app-settings", architect)
    assert response.status_code == 200
    assert response.json() == {"sharingEnabled": False}
    assert api.call("GET", "/app-settings").status_code == 401


def test_only_an_admin_changes_a_setting(api: Api, admin: User, architect: User) -> None:
    assert api.call("PATCH", "/admin/app-settings", architect, json={"sharingEnabled": True}).status_code == 403
    assert api.call("GET", "/app-settings", architect).json() == {"sharingEnabled": False}


def test_an_admin_turns_sharing_on_and_off_and_each_change_is_audited(api: Api, admin: User, architect: User) -> None:
    on = api.call(
        "PATCH",
        "/admin/app-settings",
        admin,
        json={"sharingEnabled": True},
        headers={"x-canvas-client-ip": "203.0.113.9"},
    )
    assert on.status_code == 200
    assert on.json() == {"sharingEnabled": True}
    assert api.call("GET", "/app-settings", architect).json() == {"sharingEnabled": True}
    # The same value again changes nothing, so it isn't audited.
    api.call("PATCH", "/admin/app-settings", admin, json={"sharingEnabled": True})
    api.call("PATCH", "/admin/app-settings", admin, json={"sharingEnabled": False})

    with api.engine.connect() as conn:
        rows = conn.execute(
            text("SELECT detail, actor_user_id, ip FROM audit_events WHERE event = 'app_setting_changed'")
        ).all()
    # Two changes (on, then off); sorted so two writes in the same millisecond can't swap them.
    rows = sorted(rows, key=lambda r: not json.loads(r.detail)["to"])
    assert [json.loads(r.detail) for r in rows] == [
        {"setting": "sharingEnabled", "from": False, "to": True},
        {"setting": "sharingEnabled", "from": True, "to": False},
    ]
    assert {str(r.actor_user_id) for r in rows} == {admin.id}
    assert rows[0].ip == "203.0.113.9"
    # apps/api writes the same compact JSON.
    assert rows[0].detail == '{"setting":"sharingEnabled","from":false,"to":true}'


@pytest.mark.parametrize("payload", [{"somethingElse": True}, {"sharingEnabled": "yes"}, {}, ["sharingEnabled"]])
def test_rejects_an_unknown_setting_or_a_wrongly_typed_value(api: Api, admin: User, payload: object) -> None:
    assert api.call("PATCH", "/admin/app-settings", admin, json=payload).status_code == 400
