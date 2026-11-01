"""Export (phase 6, canvas-1bty.10): GET /diagrams/:id/export as Mermaid, SVG or PNG. Every response is also
checked against the API contract (tests/api.py), including that a file's content type is one the contract
lists. Mermaid and SVG go through the diagram-core bridge (`needs_bridge`), PNG is rasterised by resvg-py.

Covers apps/api/tests/contract: export-legend, export-icon-artwork, export-architecture-builtin-icons, the
export cases of diagrams (portable style lines; mermaid, svg and png), the export step at the end of import
and of standards ("soft-flags a diagram that violates the active standard"), and the export steps of
library-admin (an imported icon is drawn; a retired icon or library still resolves), plus what the routes
promise that no TypeScript test pinned down: the three headers per format, who may export, the 400 for an
unknown format, and a PNG's size matching its SVG's.

The icon libraries are seeded with `api.library` (loading a library is still TypeScript) with a recognisable
mark for each icon. The renderer inlines an icon's markup in the SVG, so the tests look for that markup.

Left out:
- export-icon-artwork.test.ts loads the real AWS pack through POST /libraries and checks its Lambda colour;
  here a seeded icon with its own mark stands in (the pack's artwork is diagram-core's, not this route's).
- export-architecture-builtin-icons.test.ts takes the five icons from diagram-core's manifest; here they are
  seeded with marks of their own, since the route's job is to look the artwork up, not to own it.
- library-admin.test.ts's other cases (import, retire and restore routes, search): library administration
  hasn't moved; only the export steps are here, with the library or icon retired directly in the database.
- aws-icons-seed.test.ts's "a diagram saved against the old placeholder version exports with the real
  artwork": it depends on what the TypeScript catalog seed does to the library's versions, not on this route.
- telemetry.test.ts's span for an export: Python telemetry is covered by test_telemetry.py.
"""

from __future__ import annotations

import struct
import xml.etree.ElementTree as ET

import httpx
import pytest

from tests.api import MISSING_ID, Api, User

STANDARD = {
    "name": "Order process rules",
    "description": "Steps for order flows.",
    "elementKinds": [{"id": "step", "label": "Process step", "shapes": ["rectangle"], "approvedFills": ["#dbeafe"]}],
    "connectorRules": [{"id": "flow", "label": "Hand-off", "from": "*", "to": "*"}],
}
BODY = "flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n"
WITH_LEGEND = f"---\ncanvas:\n  legend:\n    visible: true\n    title: Key\n---\n{BODY}"
EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
PNG_SIGNATURE = bytes.fromhex("89504e470d0a1a0a")
LAMBDA_MARK = '<path d="M0 0h9v9z" fill="#ec7211"/>'


def icon_dsl(library: str, version: str, icon: str, label: str = "Icon node") -> str:
    """What serializeFlowchart writes for one icon node (front matter holds the icon reference)."""
    return (
        "---\ncanvas:\n  positions:\n    A:\n      x: 10\n      y: 10\n  containers: {}\n  styles: {}\n"
        f'  edgeStyles: {{}}\n  icons:\n    A:\n      libraryId: {library}\n      libraryVersion: "{version}"\n'
        f"      iconId: {icon}\n---\nflowchart TD\n  A[{label}]\n"
    )


def seed_library(
    api: Api, library: str, version: str, marks: dict[str, str], *, retired: set[str] | None = None
) -> None:
    """A library whose icons carry the given markup (api.library gives every icon the same empty <svg/>)."""
    api.library(library, version, [{"id": i, "displayName": i, "retired": i in (retired or set())} for i in marks])
    for icon, mark in marks.items():
        api.execute(
            "UPDATE icons SET asset_ref = :mark WHERE library_id = :lib AND library_version = :v AND id = :id",
            mark=mark,
            lib=library,
            v=version,
            id=icon,
        )


@pytest.fixture()
def owner(api: Api, needs_bridge: str) -> User:
    api.diagram_type("flowchart", name="Generic Flowchart")
    return api.user("owner@example.com")


@pytest.fixture()
def project(api: Api, owner: User) -> str:
    return api.project(owner, "Test Project")


def export(api: Api, who: User | None, diagram_id: str, fmt: str | None = None) -> httpx.Response:
    return api.call("GET", f"/diagrams/{diagram_id}/export" + (f"?format={fmt}" if fmt else ""), who)


def svg_of(api: Api, who: User, diagram_id: str) -> str:
    response = export(api, who, diagram_id, "svg")
    assert response.status_code == 200, response.text
    return response.text


def publish_standard(api: Api) -> None:
    admin = api.user("admin@example.com", role="admin")
    created = api.call("POST", "/diagram-types/flowchart/standards", admin, json=STANDARD)
    assert created.status_code == 201, created.text
    assert api.call("POST", f"/standards/{created.json()['standard']['id']}/publish", admin).status_code == 200


# --- diagrams.test.ts ---------------------------------------------------------------------------------


def test_exports_a_diagram_as_mermaid_svg_and_png(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, "Export Test", dsl="flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n")

    mermaid = export(api, owner, diagram["id"], "mermaid")
    assert mermaid.status_code == 200
    assert "text/plain" in mermaid.headers["content-type"]
    assert "A[Start]" in mermaid.text
    assert "attachment" in mermaid.headers["content-disposition"]

    svg = export(api, owner, diagram["id"], "svg")
    assert svg.status_code == 200
    assert "image/svg+xml" in svg.headers["content-type"]
    assert "<svg" in svg.text
    assert "attachment" in svg.headers["content-disposition"]

    png = export(api, owner, diagram["id"], "png")
    assert png.status_code == 200
    assert "image/png" in png.headers["content-type"]
    assert "attachment" in png.headers["content-disposition"]
    assert png.content[:8] == PNG_SIGNATURE


def test_a_flowcharts_colours_are_exported_as_style_lines_other_mermaid_tools_understand(
    api: Api, owner: User, project: str
) -> None:
    dsl = '---\ncanvas:\n  styles:\n    A:\n      fillColor: "#dbeafe"\n---\nflowchart TD\n  A[Start] --> B[End]\n'
    diagram = api.new_diagram(project, owner, "Portable Export", dsl=dsl)

    exported = export(api, owner, diagram["id"], "mermaid")
    assert exported.status_code == 200
    assert "A[Start]" in exported.text
    assert "style A fill:#dbeafe" in exported.text

    stored = api.call("GET", f"/diagrams/{diagram['id']}", owner).json()["diagram"]
    assert "style A" not in stored["dslContent"]


def test_the_default_format_is_mermaid(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, dsl="flowchart TD\n  A[Start]\n")
    response = export(api, owner, diagram["id"])
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "A[Start]" in response.text


# --- import.test.ts / standards.test.ts ---------------------------------------------------------------


def test_an_imported_diagram_exports_after_it_is_edited(api: Api, owner: User, project: str) -> None:
    imported = api.call(
        "POST",
        f"/projects/{project}/diagrams/import",
        owner,
        json={"name": "Round Trip Import", "dslContent": "flowchart TD\n  A[Start]\n"},
    )
    assert imported.status_code == 201, imported.text
    diagram = imported.json()["diagram"]
    assert api.save_diagram(owner, diagram, "flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n").status_code == 200
    assert export(api, owner, diagram["id"], "svg").status_code == 200


def test_a_diagram_that_violates_the_standard_is_flagged_but_still_exports(api: Api, owner: User, project: str) -> None:
    admin = api.user("admin@example.com", role="admin")
    draft = api.call("POST", "/diagram-types/flowchart/standards", admin, json={"allowedShapeIds": ["rectangle"]})
    assert draft.status_code == 201, draft.text
    assert api.call("POST", f"/standards/{draft.json()['standard']['id']}/publish", admin).status_code == 200

    diagram = api.new_diagram(project, owner, "Violating Diagram", dsl="flowchart TD\n  A((Circle Not Allowed))\n")
    assert any(v["elementId"] == "A" and v["rule"] == "allowed-shapes" for v in diagram["lastValidationResult"])
    # A violation never blocks save or export.
    assert export(api, owner, diagram["id"], "svg").status_code == 200


# --- export-legend.test.ts ----------------------------------------------------------------------------


def test_the_legend_has_the_standards_element_kinds_and_connector_rules(api: Api, owner: User, project: str) -> None:
    publish_standard(api)
    svg = svg_of(api, owner, api.new_diagram(project, owner, "Orders", dsl=WITH_LEGEND)["id"])
    assert 'class="legend"' in svg
    for label in ("Key", "Process step", "Hand-off"):
        assert f">{label}<" in svg


def test_without_a_standard_a_visible_legend_with_no_entries_of_its_own_draws_nothing(
    api: Api, owner: User, project: str
) -> None:
    svg = svg_of(api, owner, api.new_diagram(project, owner, "Orders", dsl=WITH_LEGEND)["id"])
    assert 'class="legend"' not in svg


def test_no_legend_in_the_diagram_no_legend_in_the_export(api: Api, owner: User, project: str) -> None:
    publish_standard(api)
    svg = svg_of(api, owner, api.new_diagram(project, owner, "Orders", dsl=BODY)["id"])
    assert 'class="legend"' not in svg


def test_png_export_renders_with_a_legend(api: Api, owner: User, project: str) -> None:
    publish_standard(api)
    response = export(api, owner, api.new_diagram(project, owner, "Orders", dsl=WITH_LEGEND)["id"], "png")
    assert response.status_code == 200
    assert "image/png" in response.headers["content-type"]
    assert response.content[:8] == PNG_SIGNATURE


@pytest.mark.parametrize("fmt", ["svg", "png", "mermaid"])
def test_every_format_is_sent_with_a_locked_down_sandboxed_content_security_policy(
    api: Api, owner: User, project: str, fmt: str
) -> None:
    response = export(api, owner, api.new_diagram(project, owner, "Orders", dsl=BODY)["id"], fmt)
    assert response.status_code == 200
    assert response.headers["content-security-policy"] == EXPORT_CSP


# apps/api/src/app.ts sets X-Content-Type-Options: nosniff on every response; so does canvas_api.app.
@pytest.mark.parametrize("fmt", ["svg", "png", "mermaid"])
def test_every_format_is_sent_with_nosniff(api: Api, owner: User, project: str, fmt: str) -> None:
    response = export(api, owner, api.new_diagram(project, owner, "Orders", dsl=BODY)["id"], fmt)
    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"


# --- the headers per format ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fmt", "content_type", "disposition"),
    [
        ("mermaid", "text/plain; charset=utf-8", 'attachment; filename="diagram.mmd"'),
        ("svg", "image/svg+xml", 'attachment; filename="diagram.svg"'),
        ("png", "image/png", 'attachment; filename="diagram.png"'),
    ],
)
def test_each_format_has_its_content_type_and_a_fixed_file_name_whatever_the_diagram_is_called(
    api: Api, owner: User, project: str, fmt: str, content_type: str, disposition: str
) -> None:
    diagram = api.new_diagram(project, owner, 'evil"; filename="x.html', dsl=BODY)
    response = export(api, owner, diagram["id"], fmt)
    assert response.status_code == 200
    assert response.headers["content-type"] == content_type
    assert response.headers["content-disposition"] == disposition


# --- who may export, and what -------------------------------------------------------------------------


def test_signed_out_is_401(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, dsl=BODY)
    assert export(api, None, diagram["id"], "svg").status_code == 401


def test_a_viewer_with_only_view_access_can_export_every_format(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, dsl=BODY)
    viewer = api.user("viewer@example.com", role="viewer")
    for fmt in ("mermaid", "svg", "png"):
        assert export(api, viewer, diagram["id"], fmt).status_code == 200, fmt


def test_someone_elses_draft_is_404_but_its_creator_can_export_it(api: Api, owner: User, project: str) -> None:
    draft = api.new_diagram(project, owner, "AI drawn", dsl=BODY, draft=True)
    other = api.user("other@example.com")
    assert export(api, other, draft["id"], "svg").status_code == 404
    assert export(api, owner, draft["id"], "svg").status_code == 200


def test_a_deleted_diagram_is_404(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, dsl=BODY)
    assert export(api, owner, diagram["id"], "svg").status_code == 200
    assert api.call("DELETE", f"/diagrams/{diagram['id']}", owner).status_code == 204
    for fmt in ("mermaid", "svg", "png"):
        assert export(api, owner, diagram["id"], fmt).status_code == 404, fmt


def test_a_diagram_that_does_not_exist_is_404(api: Api, owner: User) -> None:
    assert export(api, owner, MISSING_ID, "svg").status_code == 404


def test_an_unknown_format_is_400(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, dsl=BODY)
    assert export(api, owner, diagram["id"], "pdf").status_code == 400


def test_a_png_starts_with_the_signature_and_is_the_size_of_its_svg(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, "Sized", dsl="flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n")
    root = ET.fromstring(svg_of(api, owner, diagram["id"]))  # noqa: S314 - our own renderer's output
    png = export(api, owner, diagram["id"], "png").content
    assert png[:8] == PNG_SIGNATURE
    assert png[12:16] == b"IHDR"
    width, height = struct.unpack(">II", png[16:24])
    assert width == round(float(root.attrib["width"]))
    assert height == round(float(root.attrib["height"]))


# --- export-icon-artwork.test.ts ----------------------------------------------------------------------


def test_the_real_icon_artwork_is_drawn_in_an_svg_export_not_just_the_label(
    api: Api, owner: User, project: str
) -> None:
    seed_library(api, "aws-icons", "2024.1", {"lambda": LAMBDA_MARK})
    dsl = icon_dsl("aws-icons", "2024.1", "lambda", "AWS Lambda")
    svg = svg_of(api, owner, api.new_diagram(project, owner, "Icon Export Test", dsl=dsl)["id"])
    assert LAMBDA_MARK in svg
    assert "AWS Lambda" in svg


def test_a_missing_icon_is_drawn_as_a_plain_node_without_a_crash(api: Api, owner: User, project: str) -> None:
    seed_library(api, "aws-icons", "2024.1", {"lambda": LAMBDA_MARK})
    dsl = icon_dsl("aws-icons", "2024.1", "does-not-exist", "Ghost")
    svg = svg_of(api, owner, api.new_diagram(project, owner, "Missing Icon", dsl=dsl)["id"])
    assert "Ghost" in svg
    assert LAMBDA_MARK not in svg


def test_an_icon_is_looked_up_by_its_own_library_version(api: Api, owner: User, project: str) -> None:
    seed_library(api, "aws-icons", "2024.1", {"lambda": LAMBDA_MARK})
    seed_library(api, "aws-icons", "2025.1", {"lambda": '<path d="M1 1h2v2z" fill="#112233"/>'})
    svg = svg_of(api, owner, api.new_diagram(project, owner, dsl=icon_dsl("aws-icons", "2025.1", "lambda"))["id"])
    assert "#112233" in svg
    assert "#ec7211" not in svg


# --- library-admin.test.ts (export steps) -------------------------------------------------------------


def test_a_retired_icon_is_still_drawn_in_an_export(api: Api, owner: User, project: str) -> None:
    seed_library(api, "ret", "1", {"keep": "<g/>", "hide": '<path d="M0 0h9v9z" fill="#fedcba"/>'}, retired={"hide"})
    svg = svg_of(api, owner, api.new_diagram(project, owner, dsl=icon_dsl("ret", "1", "hide"))["id"])
    assert "#fedcba" in svg


def test_a_retired_library_is_still_drawn_in_an_export(api: Api, owner: User, project: str) -> None:
    seed_library(api, "gone", "1", {"x": '<path d="M0 0h9v9z" fill="#112233"/>'})
    api.execute("UPDATE icon_libraries SET retired_at = CURRENT_TIMESTAMP WHERE id = 'gone'")
    svg = svg_of(api, owner, api.new_diagram(project, owner, dsl=icon_dsl("gone", "1", "x"))["id"])
    assert "#112233" in svg


# --- export-architecture-builtin-icons.test.ts --------------------------------------------------------

BUILT_IN_MARKS = {
    name: f'<path d="M{i} 0h4v4z" fill="#0a0b0{i}" data-icon="{name}"/>'
    for i, name in enumerate(["cloud", "database", "disk", "internet", "server"], start=1)
}


@pytest.fixture()
def architect_project(api: Api, owner: User, project: str) -> str:
    api.diagram_type("cloud-infrastructure", "architecture", name="Cloud Infrastructure Diagram")
    seed_library(api, "mermaid-architecture", "1.0.0", BUILT_IN_MARKS)
    return project


def test_every_built_in_icon_is_drawn_in_an_svg_export_of_a_freshly_imported_diagram(
    api: Api, owner: User, architect_project: str
) -> None:
    dsl = "\n".join(
        [
            "architecture-beta",
            "    group api(cloud)[API]",
            "    service c(cloud)[Cloud] in api",
            "    service db(database)[Database] in api",
            "    service d(disk)[Disk] in api",
            "    service net(internet)[Internet]",
            "    service srv(server)[Server] in api",
            "",
        ]
    )
    diagram = api.new_diagram(architect_project, owner, "Built-in icons", "cloud-infrastructure", dsl)
    svg = svg_of(api, owner, diagram["id"])
    for name, mark in BUILT_IN_MARKS.items():
        assert mark in svg, f"{name} artwork"


def test_an_architecture_groups_icon_is_drawn_in_its_header(api: Api, owner: User, architect_project: str) -> None:
    dsl = "architecture-beta\n    group vpc(server)[VPC]\n"
    diagram = api.new_diagram(architect_project, owner, "Group icon", "cloud-infrastructure", dsl)
    svg = svg_of(api, owner, diagram["id"])
    group = svg[svg.index('data-container-id="vpc"') :]
    assert BUILT_IN_MARKS["server"] in group
