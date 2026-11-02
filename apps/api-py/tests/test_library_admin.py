"""Admin -> Libraries and loading a built-in library (phase 10, canvas-1bty.14): the cases of
apps/api/tests/contract/library-admin and the POST /libraries parts of libraries. Every response is also
checked against the API contract (tests/api.py). All of it needs the diagram-core bridge (SVG clean-up,
manifest validation, reading which diagrams use an icon).

Differences from the TypeScript tests, all setup: the bundled packs are small stand-in manifests loaded through
POST /libraries (same ids as the real ones where an id matters: `generic`, `aws-icons`, `mermaid-architecture`);
the type rows are made with api.diagram_type; the "re-ingesting a built-in manifest" case calls the service
function for its `origin: custom` half, which POST /libraries never reaches.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlalchemy import text

from canvas_api.routes.library_admin import _ingest, slugify
from tests.api import Api, User

ICON = '<path d="M0 0h5v5z"/>'


def manifest(library_id: str, version: str, icon_ids: list[str], **extra: Any) -> dict[str, Any]:
    return {
        "id": library_id,
        "version": version,
        "icons": [
            {"id": i, "displayName": i.title(), "keywords": [i, "kw"], "category": "Built-in", "assetRef": ICON}
            for i in icon_ids
        ],
        **extra,
    }


GENERIC = manifest("generic", "1.0.0", ["rectangle", "circle", "diamond"])
AWS = manifest("aws-icons", "1.0.0", ["lambda", "s3"], license="Apache-2.0")
ARCH = manifest("mermaid-architecture", "1.0.0", ["cloud", "database", "disk", "internet", "server"])
GV = GENERIC["version"]


def svg_of(body: str = '<path d="M0 0h24v24H0z" fill="#123456"/>', box: str = "0 0 24 24") -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}">{body}</svg>'


def file(name: str, svg: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"fileName": name, "svg": svg if svg is not None else svg_of(), **extra}


class Env:
    def __init__(self, api: Api, admin: User, architect: User, project_id: str) -> None:
        self.api = api
        self.admin = admin
        self.architect = architect
        self.project_id = project_id

    def call(self, method: str, url: str, json: Any = None, who: User | str | None = "admin", **kw: Any) -> Any:
        return self.api.call(method, url, self.admin if who == "admin" else who, json=json, **kw)  # type: ignore[arg-type]

    def import_svg(self, name: str, icons: list[dict[str, Any]], license: str | None = None) -> Any:
        return self.call("POST", "/admin/libraries/import-svg", {"name": name, "license": license, "icons": icons})

    def create_library(self, name: str = "My Pack", icons: list[dict[str, Any]] | None = None) -> dict[str, str]:
        response = self.import_svg(name, icons or [file("Star.svg"), file("moon.svg")])
        assert response.status_code == 201, response.text
        library: dict[str, str] = response.json()["library"]
        return library

    def seed_builtin(self) -> None:
        for m in (GENERIC, AWS, ARCH):
            assert self.call("POST", "/libraries", m).status_code == 201

    def make_diagram(self, dsl: str, name: str = "D", type_id: str = "flowchart") -> str:
        return str(self.api.new_diagram(self.project_id, self.admin, name, type_id, dsl)["id"])

    def admin_list(self) -> list[dict[str, Any]]:
        libraries: list[dict[str, Any]] = self.call("GET", "/admin/libraries").json()["libraries"]
        return libraries

    def icons(self, library_id: str, version: str = "1") -> dict[str, dict[str, Any]]:
        listed = self.call("GET", f"/admin/libraries/{library_id}/{version}/icons").json()["icons"]
        return {i["id"]: i for i in listed}

    def search(self, query: str = "", type_id: str = "flowchart") -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = self.call(
            "GET", f"/icons/search?diagramTypeId={type_id}&query={query}", who=self.architect
        ).json()["icons"]
        return found

    def put_palette(self, library_id: str, type_ids: list[str]) -> Any:
        return self.call("PUT", f"/admin/libraries/{library_id}/diagram-types", {"diagramTypeIds": type_ids})

    def audit(self) -> list[dict[str, Any]]:
        events = self.call("GET", "/admin/audit?limit=200").json()["events"]
        return [e["detail"] for e in events if e["event"] == "icon_library_changed"]


def own(env: Env, lib: dict[str, str]) -> list[str]:
    """The ids a flowchart palette search offers from one library (the starter library's icons are there too)."""
    return sorted(i["id"] for i in env.search() if i["libraryId"] == lib["id"])


def icon_dsl(library_id: str, version: str, icon_id: str) -> str:
    """What diagram-core's serializeFlowchart writes for one icon node (the reference is in front-matter)."""
    return (
        "---\ncanvas:\n  positions:\n    A:\n      x: 10\n      y: 10\n  containers: {}\n  styles: {}\n"
        f'  edgeStyles: {{}}\n  icons:\n    A:\n      libraryId: {library_id}\n      libraryVersion: "{version}"\n'
        f"      iconId: {icon_id}\n---\nflowchart TD\n  A[Icon node]\n"
    )


@pytest.fixture()
def env(api: Api, needs_bridge: str) -> Env:
    admin = api.user("admin@example.com", role="admin")
    architect = api.user("architect@example.com")
    e = Env(api, admin, architect, api.project(admin, "P"))
    # The palette rows of a diagram type point at a library, so the starter one exists first.
    assert e.call("POST", "/libraries", GENERIC).status_code == 201
    api.diagram_type("flowchart", name="Generic Flowchart")
    return e


# --- access control --------------------------------------------------------------------------------

ROUTES: list[tuple[str, str, str, Any]] = [
    ("list", "GET", "/admin/libraries", None),
    ("icons", "GET", "/admin/libraries/generic/1/icons", None),
    ("usage", "GET", "/admin/libraries/generic/1/usage", None),
    ("load", "POST", "/libraries", GENERIC),
    ("import-svg", "POST", "/admin/libraries/import-svg", {"name": "x", "icons": [file("a.svg")]}),
    (
        "import-manifest",
        "POST",
        "/admin/libraries/import-manifest",
        {"manifest": {"id": "x", "version": "1", "icons": []}},
    ),
    ("patch library", "PATCH", f"/admin/libraries/generic/{GV}", {"name": "x"}),
    ("add icons", "POST", "/admin/libraries/generic/1/icons", {"icons": [file("a.svg")]}),
    ("patch icon", "PATCH", "/admin/libraries/generic/1/icons/a", {"displayName": "x"}),
    ("retire library", "POST", f"/admin/libraries/generic/{GV}/retire", None),
    ("restore library", "POST", f"/admin/libraries/generic/{GV}/restore", None),
    ("retire icon", "POST", "/admin/libraries/generic/1/icons/a/retire", None),
    ("restore icon", "POST", "/admin/libraries/generic/1/icons/a/restore", None),
    ("delete library", "DELETE", f"/admin/libraries/generic/{GV}", None),
    ("delete icon", "DELETE", "/admin/libraries/generic/1/icons/a", None),
    ("palette", "PUT", "/admin/libraries/generic/diagram-types", {"diagramTypeIds": []}),
]


@pytest.mark.parametrize(("method", "url", "payload"), [r[1:] for r in ROUTES], ids=[r[0] for r in ROUTES])
def test_is_admin_only(env: Env, method: str, url: str, payload: Any) -> None:
    assert env.call(method, url, payload, who=env.architect).status_code == 403
    assert env.call(method, url, payload, who=None).status_code == 401


# --- POST /libraries -------------------------------------------------------------------------------


def test_loads_libraries_as_built_in_and_lists_them(env: Env) -> None:
    for m in (AWS, ARCH):
        response = env.call("POST", "/libraries", m)
        assert response.status_code == 201
        assert response.json() == {"status": "ingested", "id": m["id"], "version": m["version"]}
    listed = env.call("GET", "/libraries", who=env.architect).json()["libraries"]
    assert {lib["id"]: lib["iconCount"] for lib in listed} == {"aws-icons": 2, "generic": 3, "mermaid-architecture": 5}
    assert next(lib for lib in listed if lib["id"] == "aws-icons")["license"] == "Apache-2.0"
    assert {lib["origin"] for lib in env.admin_list()} == {"builtin"}


def test_a_loaded_library_is_searchable_by_keyword_and_within_a_palette(env: Env) -> None:
    env.call("POST", "/libraries", AWS)
    found = env.call("GET", "/libraries/aws-icons/versions/1.0.0/icons?query=lambda", who=env.architect).json()
    assert [i["id"] for i in found["icons"]] == ["lambda"]
    assert found["icons"][0]["keywords"] == ["lambda", "kw"]
    # Not in the flowchart palette yet; the generic pack is.
    assert env.search("lambda") == []
    assert env.put_palette("aws-icons", ["flowchart"]).status_code == 204
    assert [f"{i['libraryId']}:{i['id']}" for i in env.search("lambda")] == ["aws-icons:lambda"]
    assert env.search("lambda", "no-such-type") == []


def test_loading_the_same_version_again_updates_its_icons(env: Env) -> None:
    env.call("POST", "/libraries", AWS)
    changed = manifest("aws-icons", "1.0.0", ["lambda", "ec2"], license="MIT")
    changed["icons"][0]["displayName"] = "Renamed"
    assert env.call("POST", "/libraries", changed).status_code == 201
    [aws] = [lib for lib in env.admin_list() if lib["id"] == "aws-icons"]
    assert aws["license"] == "MIT"
    assert aws["origin"] == "builtin"
    icons = env.icons("aws-icons", "1.0.0")
    assert icons["lambda"]["displayName"] == "Renamed"
    # Icons the new manifest doesn't list are left in place, as in TypeScript's upsert.
    assert set(icons) == {"lambda", "s3", "ec2"}


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"id": "x", "icons": []}, "Library manifest requires both id and version"),
        ({"version": "1", "icons": []}, "Library manifest requires both id and version"),
        (
            {"id": "x", "version": "1", "icons": [{"id": "a", "assetRef": ICON}, {"id": "a", "assetRef": ICON}]},
            'Duplicate icon id "a" in library x@1',
        ),
    ],
)
def test_refuses_a_manifest_diagram_core_rejects(env: Env, payload: dict[str, Any], message: str) -> None:
    response = env.call("POST", "/libraries", payload)
    assert response.status_code == 400
    assert response.json() == {"error": message}
    assert [lib["id"] for lib in env.admin_list()] == ["generic"]


# --- slugify -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("cloud-storage_v2.svg", "cloud-storage-v2"),
        ("My Cool Pack!", "my-cool-pack"),
        ("Café Ünïcode.SVG", "cafe-unicode"),
        ("---", "icon"),
        ("", "icon"),
        ("a" * 70, "a" * 60),
        (("a" * 59) + " b", "a" * 59),
    ],
)
def test_slugify(value: str, expected: str) -> None:
    assert slugify(value) == expected


def test_slugify_falls_back_to_the_given_word() -> None:
    assert slugify("!!!", "library") == "library"


# --- import-svg --------------------------------------------------------------------------------------


def test_import_svg_makes_a_custom_library_with_a_slug_id_named_icons_and_fitted_artwork(env: Env) -> None:
    response = env.import_svg(
        "My Cool Pack!",
        [
            file("cloud-storage_v2.svg"),
            file("Other.svg", displayName="Custom", category="Net", keywords=["a", " b "]),
            file("C:\\art\\dir/path.svg"),
        ],
        "MIT",
    )
    assert response.status_code == 201
    body = response.json()
    assert body["rejected"] == []
    assert body["library"] == {
        "id": "my-cool-pack",
        "version": "1",
        "name": "My Cool Pack!",
        "origin": "custom",
        "license": "MIT",
        "iconCount": 3,
        "retiredIconCount": 0,
        "retiredAt": None,
        "diagramTypes": [],
        "usedByDiagramCount": 0,
    }
    icons = env.icons("my-cool-pack")
    assert icons["cloud-storage-v2"]["displayName"] == "Cloud storage v2"
    assert icons["cloud-storage-v2"]["category"] == "General"
    assert icons["cloud-storage-v2"]["keywords"] == []
    assert 'viewBox="0 0 24 24"' in icons["cloud-storage-v2"]["assetRef"]
    assert 'width="48"' in icons["cloud-storage-v2"]["assetRef"]
    assert icons["other"]["displayName"] == "Custom"
    assert icons["other"]["category"] == "Net"
    assert icons["other"]["keywords"] == ["a", "b"]
    # The id comes from the whole file name; the display name drops the path, from either kind of slash.
    assert icons["c-art-dir-path"]["displayName"] == "Path"


def test_import_svg_trims_the_license_and_drops_a_blank_one(env: Env) -> None:
    assert env.import_svg("A", [file("a.svg")], "  CC-BY  ").json()["library"]["license"] == "CC-BY"
    assert env.import_svg("B", [file("a.svg")], "   ").json()["library"]["license"] is None


def test_import_svg_de_duplicates_the_library_id_on_a_name_clash_and_icon_ids_within_a_library(env: Env) -> None:
    first = env.create_library("Same Name", [file("a.svg"), file("a.svg"), file("A.SVG")])
    second = env.create_library("Same Name")
    assert first["id"] == "same-name"
    assert second["id"] == "same-name-2"
    assert sorted(env.icons("same-name")) == ["a", "a-2", "a-3"]


def test_a_refused_file_does_not_take_its_id(env: Env) -> None:
    response = env.import_svg("Pack", [file("x.svg", "not an svg at all"), file("x.svg"), file("x.svg")])
    assert response.status_code == 201
    body = response.json()
    assert [r["fileName"] for r in body["rejected"]] == ["x.svg"]
    assert sorted(env.icons("pack")) == ["x", "x-2"]


def test_the_good_file_after_a_refused_one_of_the_same_name_gets_the_plain_id(env: Env) -> None:
    body = env.import_svg(
        "Pack", [file("x.svg", "junk"), file("x.svg", svg_of('<path d="M0 0h9v9z" fill="#fedcba"/>'))]
    )
    assert body.status_code == 201
    assert sorted(env.icons("pack")) == ["x"]
    # The artwork was prepared under the id it ended up with (its ids are prefixed per library and icon).
    assert "#fedcba" in env.icons("pack")["x"]["assetRef"]


def test_ids_inside_artwork_are_prefixed_with_the_final_icon_id(env: Env) -> None:
    gradient = (
        '<defs><linearGradient id="g"><stop stop-color="#111"/></linearGradient></defs>'
        '<path fill="url(#g)" d="M0 0h5v5z"/>'
    )
    env.import_svg("Pack", [file("x.svg", "junk"), file("x.svg", svg_of(gradient))])
    asset = env.icons("pack")["x"]["assetRef"]
    assert 'id="pack-x-g"' in asset
    assert "url(#pack-x-g)" in asset


def test_import_svg_reports_bad_files_in_rejected_while_good_ones_import(env: Env) -> None:
    response = env.import_svg(
        "Mixed",
        [file("good.svg"), file("junk.svg", "not an svg at all"), file("nosize.svg", '<svg><path d="M0 0"/></svg>')],
    )
    assert response.status_code == 201
    body = response.json()
    assert body["library"]["iconCount"] == 1
    assert sorted(r["fileName"] for r in body["rejected"]) == ["junk.svg", "nosize.svg"]
    assert all(r["reason"] for r in body["rejected"])


def test_import_svg_creates_nothing_when_every_file_is_bad(env: Env) -> None:
    response = env.import_svg("Bad", [file("junk.svg", "nope"), file("also.svg", "nope")])
    assert response.status_code == 400
    error = response.json()["error"]
    assert error.startswith("None of the files could be used: junk.svg (")
    assert "; also.svg (" in error
    assert [lib["id"] for lib in env.admin_list()] == ["generic"]


def test_import_svg_400s_on_a_blank_name_and_on_an_empty_icon_list(env: Env) -> None:
    assert env.import_svg("   ", [file("a.svg")]).json() == {"error": "Give the library a name."}
    assert env.import_svg("Empty", []).json() == {"error": "Choose at least one SVG file."}


@pytest.mark.parametrize(
    "payload",
    [
        {"icons": [file("a.svg")]},
        {"name": "x"},
        {"name": "x", "icons": [{"fileName": "a.svg"}]},
        {"name": "x", "icons": [{"fileName": "", "svg": "x"}]},
        {"name": "x" * 121, "icons": [file("a.svg")]},
        {"name": "x", "icons": [file("a.svg", keywords=["k"] * 21)]},
    ],
)
def test_import_svg_validates_the_body(env: Env, payload: dict[str, Any]) -> None:
    assert env.call("POST", "/admin/libraries/import-svg", payload).status_code == 400


def test_import_svg_strips_malicious_content_and_rejects_a_style_file_individually(env: Env) -> None:
    evil = svg_of(
        '<script>alert(1)</script><path onload="x()" d="M0 0h5v5z"/><use href="https://evil.example/x.svg#a"/>'
        '<image href="https://evil.example/p.png"/><foreignObject><div>hi</div></foreignObject>'
    )
    response = env.import_svg(
        "Evil",
        [
            file("evil.svg", evil),
            file("styled.svg", svg_of('<style>.a{fill:red}</style><path class="a" d="M0 0h5v5z"/>')),
        ],
    )
    assert response.status_code == 201
    rejected = response.json()["rejected"]
    assert [r["fileName"] for r in rejected] == ["styled.svg"]
    assert "style" in rejected[0]["reason"].lower()
    asset = env.icons("evil")["evil"]["assetRef"]
    for banned in ("script", "onload", "evil.example", "foreignObject", "<image", "alert"):
        assert banned not in asset
    assert "<path" in asset


def test_import_svg_accepts_a_large_payload_past_the_default_body_limit(env: Env) -> None:
    path = f'<path d="{"M0 0 L1 1 " * 1900}"/>'
    icons = [file(f"icon-{i}.svg", svg_of(path)) for i in range(300)]
    assert len(json.dumps(icons)) > 5 * 1024 * 1024
    response = env.import_svg("Big", icons)
    assert response.status_code == 201
    assert response.json()["library"]["iconCount"] == 300


def test_an_imported_icon_shows_in_palette_search_once_added_to_a_diagram_type_and_renders_in_an_export(
    env: Env,
) -> None:
    lib = env.create_library(
        "Searchable",
        [file("zebra-crossing.svg", svg_of('<path d="M0 0h24v24H0z" fill="#abcdef"/>'), keywords=["stripes"])],
    )
    assert env.search("stripes") == []
    assert env.put_palette(lib["id"], ["flowchart"]).status_code == 204
    assert [f"{i['libraryId']}/{i['id']}" for i in env.search("stripes")] == ["searchable/zebra-crossing"]
    diagram_id = env.make_diagram(icon_dsl(lib["id"], lib["version"], "zebra-crossing"))
    exported = env.call("GET", f"/diagrams/{diagram_id}/export?format=svg")
    assert exported.status_code == 200
    assert "#abcdef" in exported.text


# --- import-manifest ---------------------------------------------------------------------------------


def manifest_body(**over: Any) -> dict[str, Any]:
    return {
        "id": "my-manifest",
        "version": "2",
        "license": "CC0",
        "icons": [
            {
                "id": "one",
                "displayName": "One",
                "category": "X",
                "keywords": ["k"],
                "assetRef": '<g id="a"><path fill="url(#a)" d="M0 0h5v5z" onclick="x()"/></g><script>1</script>',
            }
        ],
        **over,
    }


def import_manifest(env: Env, m: Any, name: str | None = None) -> Any:
    return env.call("POST", "/admin/libraries/import-manifest", {"manifest": m, "name": name})


def test_import_manifest_creates_a_custom_library_applying_strict_sanitizing(env: Env) -> None:
    response = import_manifest(env, manifest_body(), "Named")
    assert response.status_code == 201
    library = response.json()["library"]
    assert library["id"] == "my-manifest"
    assert library["version"] == "2"
    assert library["name"] == "Named"
    assert library["origin"] == "custom"
    assert library["license"] == "CC0"
    assert library["iconCount"] == 1
    icon = env.icons("my-manifest", "2")["one"]
    assert icon["keywords"] == ["k"]
    assert "script" not in icon["assetRef"]
    assert "onclick" not in icon["assetRef"]
    assert 'id="my-manifest-one-a"' in icon["assetRef"]
    assert "url(#my-manifest-one-a)" in icon["assetRef"]


def test_import_manifest_defaults_name_category_and_keywords(env: Env) -> None:
    m = manifest_body(icons=[{"id": "bare", "assetRef": ICON}])
    library = import_manifest(env, m).json()["library"]
    assert library["name"] == "my-manifest"
    icon = env.icons("my-manifest", "2")["bare"]
    assert icon["displayName"] == "bare"
    assert icon["category"] == "General"
    assert icon["keywords"] == []


def test_import_manifest_409s_for_a_built_in_id_and_for_a_duplicate_id_and_version(env: Env) -> None:
    env.seed_builtin()
    assert import_manifest(env, manifest_body(id="generic")).status_code == 409
    assert import_manifest(env, manifest_body(id="aws-icons", version="99")).status_code == 409
    assert import_manifest(env, manifest_body()).status_code == 201
    duplicate = import_manifest(env, manifest_body())
    assert duplicate.status_code == 409
    assert duplicate.json() == {"error": "Library my-manifest version 2 already exists."}
    assert import_manifest(env, manifest_body(version="3")).status_code == 201


@pytest.mark.parametrize(
    "over",
    [
        {"id": "Bad Id"},
        {"id": "a/b"},
        {"version": "v 1"},
        {"icons": []},
        {"icons": [{"id": "x"}]},
        {"icons": [{"id": "x", "assetRef": ICON}, {"id": "x", "assetRef": ICON}]},
        {"icons": [{"id": "x", "assetRef": "<style>.a{}</style>"}]},
    ],
    ids=[
        "uppercase id",
        "slash id",
        "invalid version",
        "empty icons",
        "no assetRef",
        "duplicate icon ids",
        "style artwork",
    ],
)
def test_import_manifest_400s_on(env: Env, over: dict[str, Any]) -> None:
    assert import_manifest(env, manifest_body(**over)).status_code == 400
    assert [lib["id"] for lib in env.admin_list()] == ["generic"]


def test_import_manifest_400s_when_the_manifest_is_not_a_library_at_all(env: Env) -> None:
    assert import_manifest(env, {"nope": True}).status_code == 400
    assert env.call("POST", "/admin/libraries/import-manifest", {"name": "x"}).status_code == 400


# --- list --------------------------------------------------------------------------------------------


def test_list_reports_origin_counts_palette_types_retired_counts_and_usage(env: Env) -> None:
    env.api.diagram_type("cloud-infrastructure", "architecture", name="Cloud Infrastructure")
    env.seed_builtin()
    custom = env.create_library("Mine")
    env.put_palette(custom["id"], ["flowchart"])
    env.call("POST", f"/admin/libraries/{custom['id']}/1/icons/moon/retire")

    libs = {lib["id"]: lib for lib in env.admin_list()}
    # Built-in first, then custom, each by id.
    assert [lib["id"] for lib in env.admin_list()] == ["aws-icons", "generic", "mermaid-architecture", "mine"]
    assert libs["generic"] == {
        "id": "generic",
        "version": "1.0.0",
        "name": "generic",
        "origin": "builtin",
        "license": None,
        "iconCount": 3,
        "retiredIconCount": 0,
        "retiredAt": None,
        "diagramTypes": [
            {"id": "cloud-infrastructure", "name": "Cloud Infrastructure"},
            {"id": "flowchart", "name": "Generic Flowchart"},
        ],
        "usedByDiagramCount": 0,
    }
    assert libs["aws-icons"]["origin"] == "builtin"
    assert libs["mine"]["origin"] == "custom"
    assert libs["mine"]["name"] == "Mine"
    assert libs["mine"]["iconCount"] == 2
    assert libs["mine"]["retiredIconCount"] == 1
    assert libs["mine"]["version"] == "1"
    assert libs["mine"]["diagramTypes"] == [{"id": "flowchart", "name": "Generic Flowchart"}]


def test_list_orders_a_libraries_diagram_types_by_name(env: Env) -> None:
    env.api.diagram_type("cloud-infrastructure", "architecture", name="Cloud Infrastructure")
    env.put_palette("generic", ["flowchart", "cloud-infrastructure"])
    [generic] = env.admin_list()
    assert generic["diagramTypes"] == [
        {"id": "cloud-infrastructure", "name": "Cloud Infrastructure"},
        {"id": "flowchart", "name": "Generic Flowchart"},
    ]


def test_usage_counts_front_matter_icon_refs_and_architecture_built_in_icon_syntax_ignoring_deleted_diagrams(
    env: Env,
) -> None:
    env.api.diagram_type("cloud-infrastructure", "architecture", name="Cloud Infrastructure")
    env.seed_builtin()
    custom = env.create_library("Mine")
    flow = env.make_diagram(icon_dsl(custom["id"], "1", "star"), "uses star")
    env.make_diagram(icon_dsl(custom["id"], "1", "moon"), "uses moon")
    gone = env.make_diagram(icon_dsl(custom["id"], "1", "moon"), "deleted one")
    env.make_diagram(
        "architecture-beta\n    service db(database)[DB]\n    service s(server)[S]\n", "arch", "cloud-infrastructure"
    )
    assert env.call("DELETE", f"/diagrams/{gone}").status_code == 204

    libs = {lib["id"]: lib for lib in env.admin_list()}
    assert libs["mine"]["usedByDiagramCount"] == 2
    # Two icons in one diagram still count the diagram once.
    assert libs["mermaid-architecture"]["usedByDiagramCount"] == 1
    assert {k: v["usedByDiagramCount"] for k, v in env.icons("mine").items()} == {"star": 1, "moon": 1}
    assert env.call("GET", "/admin/libraries/mine/1/usage?iconId=star").json()["diagrams"] == [
        {"id": flow, "name": "uses star", "projectId": env.project_id}
    ]
    assert len(env.call("GET", "/admin/libraries/mine/1/usage").json()["diagrams"]) == 2
    assert env.call("GET", "/admin/libraries/mine/1/usage?iconId=nothing").json() == {"diagrams": []}


def test_usage_is_per_library_version(env: Env) -> None:
    env.create_library("Mine")
    env.call("POST", "/admin/libraries/import-manifest", {"manifest": manifest("mine", "2", ["star"])})
    env.make_diagram(icon_dsl("mine", "1", "star"))
    assert env.call("GET", "/admin/libraries/mine/1/usage").json()["diagrams"] != []
    assert env.call("GET", "/admin/libraries/mine/2/usage").json() == {"diagrams": []}


def test_a_diagram_that_does_not_parse_uses_nothing(env: Env) -> None:
    custom = env.create_library("Mine")
    diagram_id = env.make_diagram(icon_dsl(custom["id"], "1", "star"))
    # A save that doesn't parse can't happen through the API, so the broken text goes in the database directly.
    env.api.execute(
        "UPDATE diagram_versions SET dsl_content = :dsl WHERE diagram_id = :id AND dsl_content LIKE :like",
        dsl="libraryId: mine\nflowchart TD\n  A -->\n",
        id=diagram_id,
        like="%libraryId%",
    )
    assert env.admin_list()[1]["usedByDiagramCount"] == 0


def test_list_and_usage_404_for_an_unknown_library(env: Env) -> None:
    assert env.call("GET", "/admin/libraries/nope/1/icons").status_code == 404
    assert env.call("GET", "/admin/libraries/nope/1/usage").status_code == 404
    assert env.call("GET", "/admin/libraries/generic/9/icons").status_code == 404


# --- editing -----------------------------------------------------------------------------------------


def test_renames_a_custom_library_and_sets_or_clears_its_license(env: Env) -> None:
    lib = env.create_library("Old")
    assert (
        env.call("PATCH", f"/admin/libraries/{lib['id']}/1", {"name": " New Name ", "license": "Apache"}).status_code
        == 204
    )
    [_, mine] = env.admin_list()
    assert mine["name"] == "New Name"
    assert mine["license"] == "Apache"
    env.call("PATCH", f"/admin/libraries/{lib['id']}/1", {"license": None})
    [_, mine] = env.admin_list()
    assert (mine["name"], mine["license"]) == ("New Name", None)
    assert env.call("PATCH", f"/admin/libraries/{lib['id']}/1", {"name": "  "}).json() == {
        "error": "The library needs a name."
    }


def test_patch_bodies_need_at_least_one_field(env: Env) -> None:
    lib = env.create_library()
    library = env.call("PATCH", f"/admin/libraries/{lib['id']}/1", {})
    assert library.status_code == 400
    assert library.json() == {"error": "body must NOT have fewer than 1 properties"}
    icon = env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/star", {})
    assert icon.status_code == 400
    assert icon.json() == {"error": "body must NOT have fewer than 1 properties"}


def test_refuses_to_edit_built_in_libraries_and_icons(env: Env) -> None:
    env.seed_builtin()
    refused = env.call("PATCH", f"/admin/libraries/generic/{GV}", {"name": "x"})
    assert refused.status_code == 400
    assert refused.json() == {"error": "Built-in libraries can only be retired or restored, not edited."}
    assert env.call("PATCH", f"/admin/libraries/generic/{GV}/icons/rectangle", {"displayName": "x"}).status_code == 400
    assert env.call("POST", f"/admin/libraries/generic/{GV}/icons", {"icons": [file("a.svg")]}).status_code == 400


def test_404s_editing_an_unknown_library_or_icon(env: Env) -> None:
    lib = env.create_library()
    assert env.call("PATCH", "/admin/libraries/nope/1", {"name": "x"}).status_code == 404
    assert env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/nope", {"displayName": "x"}).status_code == 404
    assert env.call("POST", "/admin/libraries/nope/1/icons", {"icons": [file("a.svg")]}).status_code == 404


def test_edits_icon_name_category_and_keywords_without_touching_sibling_icons_keywords(env: Env) -> None:
    lib = env.create_library("Kw", [file("a.svg", keywords=["alpha"]), file("b.svg", keywords=["beta"])])
    changes = {"displayName": "Renamed", "category": " Shapes ", "keywords": ["x", " y ", ""]}
    assert env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/a", changes).status_code == 204
    icons = env.icons(lib["id"])
    assert icons["a"]["displayName"] == "Renamed"
    assert icons["a"]["category"] == "Shapes"
    assert icons["a"]["keywords"] == ["x", "y"]
    assert icons["b"]["keywords"] == ["beta"]
    assert env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/a", {"displayName": " "}).json() == {
        "error": "The icon needs a name."
    }


def test_clearing_an_icons_keywords_and_a_blank_category(env: Env) -> None:
    lib = env.create_library("Kw", [file("a.svg", keywords=["alpha"], category="Net")])
    env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/a", {"keywords": [], "category": " "})
    icon = env.icons(lib["id"])["a"]
    assert icon["keywords"] == []
    assert icon["category"] == "General"


def test_re_sanitizes_and_re_fits_replacement_artwork(env: Env) -> None:
    lib = env.create_library()
    body = {"svg": svg_of('<path d="M0 0h5v5z" onclick="x()"/><script>1</script>', "0 0 100 50")}
    assert env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/star", body).status_code == 204
    star = env.icons(lib["id"])["star"]
    assert 'viewBox="0 0 100 50"' in star["assetRef"]
    assert "script" not in star["assetRef"]
    assert "onclick" not in star["assetRef"]
    garbage = env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/star", {"svg": "garbage"})
    assert garbage.status_code == 400
    assert garbage.json()["error"]
    assert env.icons(lib["id"])["star"]["assetRef"] == star["assetRef"]


def test_adds_icons_to_a_custom_library_de_duplicating_ids_and_reporting_rejects(env: Env) -> None:
    lib = env.create_library()
    response = env.call(
        "POST",
        f"/admin/libraries/{lib['id']}/1/icons",
        {"icons": [file("star.svg"), file("sun.svg", keywords=["hot"]), file("bad.svg", "x")]},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["added"] == ["star-2", "sun"]
    assert [r["fileName"] for r in body["rejected"]] == ["bad.svg"]
    icons = env.icons(lib["id"])
    assert len(icons) == 4
    assert icons["sun"]["keywords"] == ["hot"]
    # Adding icons leaves the keywords already there.
    assert env.call("GET", f"/admin/libraries/{lib['id']}/1/icons").status_code == 200
    none_usable = env.call("POST", f"/admin/libraries/{lib['id']}/1/icons", {"icons": [file("bad.svg", "x")]})
    assert none_usable.status_code == 400
    assert none_usable.json()["error"].startswith("None of the files could be used: bad.svg (")
    assert env.call("POST", f"/admin/libraries/{lib['id']}/1/icons", {"icons": []}).status_code == 400


def test_adding_icons_keeps_existing_keywords(env: Env) -> None:
    lib = env.create_library("Kw", [file("a.svg", keywords=["alpha"])])
    env.call("POST", f"/admin/libraries/{lib['id']}/1/icons", {"icons": [file("b.svg", keywords=["beta"])]})
    icons = env.icons(lib["id"])
    assert icons["a"]["keywords"] == ["alpha"]
    assert icons["b"]["keywords"] == ["beta"]


# --- retire / restore --------------------------------------------------------------------------------


def test_a_retired_icon_leaves_search_and_the_versions_listing_but_still_exports_restore_brings_it_back(
    env: Env,
) -> None:
    lib = env.create_library(
        "Ret", [file("keep.svg"), file("hide.svg", svg_of('<path d="M0 0h9v9z" fill="#fedcba"/>'))]
    )
    env.put_palette(lib["id"], ["flowchart"])
    diagram_id = env.make_diagram(icon_dsl(lib["id"], "1", "hide"))

    assert env.call("POST", f"/admin/libraries/{lib['id']}/1/icons/hide/retire").status_code == 204
    assert own(env, lib) == ["keep"]
    listed = env.call("GET", f"/libraries/{lib['id']}/versions/1/icons", who=env.architect).json()["icons"]
    assert [i["id"] for i in listed] == ["keep"]
    assert env.icons(lib["id"])["hide"]["retiredAt"]
    assert env.admin_list()[1]["retiredIconCount"] == 1
    assert "#fedcba" in env.call("GET", f"/diagrams/{diagram_id}/export?format=svg").text

    assert env.call("POST", f"/admin/libraries/{lib['id']}/1/icons/hide/restore").status_code == 204
    assert own(env, lib) == ["hide", "keep"]
    assert env.admin_list()[1]["retiredIconCount"] == 0
    assert env.icons(lib["id"])["hide"]["retiredAt"] is None


def test_a_retired_library_is_hidden_everywhere_but_exports_still_render_works_on_built_ins_restore_reverses(
    env: Env,
) -> None:
    env.seed_builtin()
    lib = env.create_library("Gone", [file("x.svg", svg_of('<path d="M0 0h9v9z" fill="#112233"/>'))])
    env.put_palette(lib["id"], ["flowchart"])
    diagram_id = env.make_diagram(icon_dsl(lib["id"], "1", "x"))
    assert "gone" in [i["libraryId"] for i in env.search()]

    assert env.call("POST", f"/admin/libraries/{lib['id']}/1/retire").status_code == 204
    assert env.call("POST", f"/admin/libraries/generic/{GV}/retire").status_code == 204
    assert env.search() == []
    versions = env.call("GET", f"/libraries/{lib['id']}/versions/1/icons", who=env.architect).json()
    assert versions["icons"] == []
    assert "#112233" in env.call("GET", f"/diagrams/{diagram_id}/export?format=svg").text
    libs = {lib["id"]: lib for lib in env.admin_list()}
    assert libs["gone"]["retiredAt"]
    assert libs["generic"]["retiredAt"]

    env.call("POST", f"/admin/libraries/{lib['id']}/1/restore")
    env.call("POST", f"/admin/libraries/generic/{GV}/restore")
    assert len(env.search()) > 1
    assert all(lib["retiredAt"] is None for lib in env.admin_list())


def test_404s_retiring_or_restoring_an_unknown_library_or_icon(env: Env) -> None:
    lib = env.create_library()
    for action in ("retire", "restore"):
        assert env.call("POST", f"/admin/libraries/nope/1/{action}").status_code == 404
        assert env.call("POST", f"/admin/libraries/{lib['id']}/1/icons/nope/{action}").status_code == 404
        assert env.call("POST", f"/admin/libraries/nope/1/icons/star/{action}").status_code == 404


def test_re_loading_a_built_in_manifest_neither_un_retires_nor_changes_origin_or_display_name(env: Env) -> None:
    env.seed_builtin()
    env.call("POST", "/admin/libraries/aws-icons/1.0.0/retire")
    env.call("POST", "/admin/libraries/aws-icons/1.0.0/icons/lambda/retire")
    env.api.execute(
        "UPDATE icon_libraries SET display_name = :name WHERE id = :id", name="Renamed in DB", id="aws-icons"
    )

    # What the catalog seed does on each deploy, and the same call trying to take the library over.
    assert env.call("POST", "/libraries", AWS).status_code == 201
    with env.api.engine.begin() as conn:
        _ingest(conn, env.api.client.app.state.diagram_bridge, AWS, "custom", "Hijack")  # type: ignore[attr-defined]

    aws = next(lib for lib in env.admin_list() if lib["id"] == "aws-icons")
    assert aws["origin"] == "builtin"
    assert aws["name"] == "Renamed in DB"
    assert aws["retiredAt"]
    assert aws["retiredIconCount"] == 1


# --- delete ------------------------------------------------------------------------------------------


def test_deletes_an_unused_custom_library_with_its_icons_keywords_and_palette_rows(env: Env) -> None:
    lib = env.create_library("Del", [file("a.svg", keywords=["kw"])])
    env.put_palette(lib["id"], ["flowchart"])
    assert env.call("DELETE", f"/admin/libraries/{lib['id']}/1").status_code == 204
    for statement in (
        "SELECT COUNT(*) FROM icon_libraries WHERE id = :id",
        "SELECT COUNT(*) FROM icons WHERE library_id = :id",
        "SELECT COUNT(*) FROM icon_keywords WHERE library_id = :id",
        "SELECT COUNT(*) FROM diagram_type_palette_libraries WHERE library_id = :id",
    ):
        assert env.api.scalar(statement, id=lib["id"]) == 0, statement
    assert env.call("DELETE", f"/admin/libraries/{lib['id']}/1").status_code == 404


def test_keeps_palette_rows_while_another_version_of_the_library_remains(env: Env) -> None:
    m = manifest("multi", "1", ["a"])
    env.call("POST", "/admin/libraries/import-manifest", {"manifest": m})
    env.call("POST", "/admin/libraries/import-manifest", {"manifest": {**m, "version": "2"}})
    env.put_palette("multi", ["flowchart"])
    assert env.call("DELETE", "/admin/libraries/multi/1").status_code == 204
    assert next(lib for lib in env.admin_list() if lib["id"] == "multi")["diagramTypes"] != []
    assert env.call("DELETE", "/admin/libraries/multi/2").status_code == 204
    assert env.api.scalar("SELECT COUNT(*) FROM diagram_type_palette_libraries WHERE library_id = :id", id="multi") == 0


def test_409s_with_the_diagrams_listed_when_the_library_or_an_icon_is_in_use(env: Env) -> None:
    lib = env.create_library()
    diagram_id = env.make_diagram(icon_dsl(lib["id"], "1", "star"), "Uses it")
    library = env.call("DELETE", f"/admin/libraries/{lib['id']}/1")
    assert library.status_code == 409
    assert library.json() == {
        "error": "1 diagram uses this library; retire it instead.",
        "code": "in_use",
        "diagrams": [{"id": diagram_id, "name": "Uses it", "projectId": env.project_id}],
    }
    icon = env.call("DELETE", f"/admin/libraries/{lib['id']}/1/icons/star")
    assert icon.status_code == 409
    assert icon.json()["code"] == "in_use"
    assert icon.json()["error"] == "1 diagram uses this icon; retire it instead."
    assert env.call("DELETE", f"/admin/libraries/{lib['id']}/1/icons/moon").status_code == 204
    assert list(env.icons(lib["id"])) == ["star"]
    assert env.call("DELETE", f"/admin/libraries/{lib['id']}/1/icons/moon").status_code == 404


def test_the_in_use_message_counts_diagrams(env: Env) -> None:
    lib = env.create_library()
    env.make_diagram(icon_dsl(lib["id"], "1", "star"), "One")
    env.make_diagram(icon_dsl(lib["id"], "1", "star"), "Two")
    response = env.call("DELETE", f"/admin/libraries/{lib['id']}/1")
    assert response.json()["error"] == "2 diagrams use this library; retire it instead."
    assert len(response.json()["diagrams"]) == 2


def test_refuses_to_delete_built_in_libraries_and_icons(env: Env) -> None:
    env.seed_builtin()
    assert env.call("DELETE", f"/admin/libraries/generic/{GV}").status_code == 400
    assert env.call("DELETE", f"/admin/libraries/generic/{GV}/icons/rectangle").status_code == 400
    assert env.call("DELETE", "/admin/libraries/nope/1").status_code == 404


# --- palette -----------------------------------------------------------------------------------------


def palette(env: Env, type_id: str) -> list[tuple[str, int]]:
    with env.api.engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT library_id, position FROM diagram_type_palette_libraries WHERE diagram_type_id = :t"
                " ORDER BY position"
            ),
            {"t": type_id},
        ).all()
    return [(r.library_id, int(r.position)) for r in rows]


def test_adds_and_removes_a_library_from_diagram_types_appending_positions(env: Env) -> None:
    env.api.diagram_type("erd", "erd", name="ERD")
    lib = env.create_library()
    assert env.put_palette(lib["id"], ["flowchart", "erd"]).status_code == 204
    assert palette(env, "flowchart") == [("generic", 0), (lib["id"], 1)]
    assert sorted(t["id"] for t in env.admin_list()[1]["diagramTypes"]) == ["erd", "flowchart"]

    # Idempotent re-put leaves positions alone.
    env.put_palette(lib["id"], ["flowchart", "erd"])
    assert palette(env, "flowchart") == [("generic", 0), (lib["id"], 1)]

    env.put_palette(lib["id"], ["erd"])
    assert palette(env, "flowchart") == [("generic", 0)]
    assert [t["id"] for t in env.admin_list()[1]["diagramTypes"]] == ["erd"]


def test_palette_ignores_repeated_ids(env: Env) -> None:
    lib = env.create_library()
    assert env.put_palette(lib["id"], ["flowchart", "flowchart"]).status_code == 204
    assert palette(env, "flowchart") == [("generic", 0), (lib["id"], 1)]


def test_palette_400s_on_an_unknown_diagram_type_and_404s_on_an_unknown_library_changing_nothing(env: Env) -> None:
    lib = env.create_library()
    unknown = env.put_palette(lib["id"], ["flowchart", "no-such-type"])
    assert unknown.status_code == 400
    assert unknown.json() == {"error": "Unknown diagram type."}
    assert env.admin_list()[1]["diagramTypes"] == []
    assert env.put_palette("nope", []).status_code == 404


def test_palette_changes_mark_built_in_diagram_types_admin_edited_but_not_custom_ones(env: Env) -> None:
    env.api.diagram_type("erd", "erd")
    env.api.diagram_type("uml", "uml")
    env.api.diagram_type("my-custom", origin="custom")
    lib = env.create_library()
    env.put_palette(lib["id"], ["erd", "my-custom"])

    def edited(type_id: str) -> bool:
        return bool(env.api.scalar("SELECT admin_edited FROM diagram_types WHERE id = :id", id=type_id))

    assert edited("erd") is True
    assert edited("my-custom") is False
    assert edited("uml") is False
    assert edited("flowchart") is False
    # Removing the library edits the type again; a type left as it was is not marked.
    env.api.execute("UPDATE diagram_types SET admin_edited = :no", no=False)
    env.put_palette(lib["id"], ["erd"])
    assert [edited("erd"), edited("my-custom")] == [False, False]
    env.put_palette(lib["id"], [])
    assert edited("erd") is True


# --- audit -------------------------------------------------------------------------------------------


def test_records_icon_library_changed_with_the_right_action_for_each_change(env: Env) -> None:
    lib = env.create_library("Aud")
    env.call("POST", "/admin/libraries/import-manifest", {"manifest": manifest("from-manifest", "1", ["a"])})
    env.call("PATCH", f"/admin/libraries/{lib['id']}/1", {"name": "Aud2"})
    env.call("POST", f"/admin/libraries/{lib['id']}/1/icons", {"icons": [file("new.svg")]})
    env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/new", {"svg": svg_of()})
    env.call("POST", f"/admin/libraries/{lib['id']}/1/icons/new/retire")
    env.call("POST", f"/admin/libraries/{lib['id']}/1/icons/new/restore")
    env.call("POST", f"/admin/libraries/{lib['id']}/1/retire")
    env.call("POST", f"/admin/libraries/{lib['id']}/1/restore")
    env.put_palette(lib["id"], ["flowchart"])
    env.call("DELETE", f"/admin/libraries/{lib['id']}/1/icons/new")
    env.call("DELETE", f"/admin/libraries/{lib['id']}/1")

    events = env.audit()
    assert sorted(d["action"] for d in events) == sorted(
        [
            "imported",
            "imported",
            "updated",
            "icons_added",
            "icon_updated",
            "icon_retired",
            "icon_restored",
            "retired",
            "restored",
            "palette_set",
            "icon_deleted",
            "deleted",
        ]
    )

    def one(action: str, **where: Any) -> dict[str, Any]:
        [found] = [d for d in events if d["action"] == action and all(d.get(k) == v for k, v in where.items())]
        return found

    assert one("imported", **{"from": "svg"}) == {
        "action": "imported",
        "libraryId": lib["id"],
        "version": "1",
        "icons": 2,
        "from": "svg",
    }
    assert one("imported", **{"from": "manifest"}) == {
        "action": "imported",
        "libraryId": "from-manifest",
        "version": "1",
        "icons": 1,
        "from": "manifest",
    }
    assert one("updated") == {"action": "updated", "libraryId": lib["id"], "version": "1"}
    assert one("icons_added") == {"action": "icons_added", "libraryId": lib["id"], "version": "1", "icons": ["new"]}
    assert one("icon_updated") == {
        "action": "icon_updated",
        "libraryId": lib["id"],
        "version": "1",
        "iconId": "new",
        "replacedArtwork": True,
    }
    assert one("icon_retired")["iconId"] == "new"
    assert one("icon_restored")["iconId"] == "new"
    assert one("palette_set") == {"action": "palette_set", "libraryId": lib["id"], "diagramTypeIds": ["flowchart"]}
    assert one("icon_deleted")["iconId"] == "new"
    assert one("deleted") == {"action": "deleted", "libraryId": lib["id"], "version": "1"}


def test_an_icon_edit_without_new_artwork_says_so(env: Env) -> None:
    lib = env.create_library()
    env.call("PATCH", f"/admin/libraries/{lib['id']}/1/icons/star", {"displayName": "Starry"})
    [event] = [d for d in env.audit() if d["action"] == "icon_updated"]
    assert event["replacedArtwork"] is False


def test_the_audit_event_records_who(env: Env) -> None:
    env.call("POST", "/admin/libraries/import-svg", {"name": "x", "icons": [file("a.svg")]})
    events = env.call("GET", "/admin/audit?limit=200").json()["events"]
    [event] = [e for e in events if e["event"] == "icon_library_changed"]
    assert event["actorEmail"] == "admin@example.com"


def test_does_not_audit_failed_or_forbidden_changes(env: Env) -> None:
    env.call("DELETE", "/admin/libraries/nope/1")
    env.call("POST", "/admin/libraries/import-svg", {"name": "x", "icons": [file("a.svg")]}, who=env.architect)
    env.import_svg("Bad", [file("junk.svg", "nope")])
    env.call("PATCH", "/admin/libraries/generic/1.0.0", {"name": "x"})
    assert env.audit() == []
