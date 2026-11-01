"""Importing diagrams (phase 4, canvas-1bty.8): raw Mermaid and filled-in Markdown intake templates, the cases of
apps/api/tests/contract/import and import-template, and the import cases of project-access. Every response is
also checked against the API contract (tests/api.py). Detection, parsing and template compiling go through the
diagram-core bridge (`needs_bridge`).

Left out:
- import.test.ts's last case ends by exporting the imported diagram as SVG: that step is in test_export.py
  (the case here keeps the import and the save).
- docs/*-template.md files other than the C4 context one: the TypeScript test only sends that template, and
  compiling the others is diagram-core's own tests (and the bridge corpus), not this route's.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.api import MISSING_ID, T0, Api, User

VALID_TEMPLATE = "\n".join(
    [
        "# C4 Context Diagram — Intake Template",
        "",
        "## 1. Diagram metadata",
        "",
        "| Field | Value |",
        "|---|---|",
        "| Diagram title | Order Service Context |",
        "| Central system name | OrderService |",
        "| Central system description (one line) | Handles order creation and fulfillment |",
        "| Central system technology (optional) | |",
        "",
        "## 2. Boundaries (optional)",
        "",
        "| Boundary name | Type (Enterprise / System) | Entities inside |",
        "|---|---|---|",
        "| | | |",
        "",
        "## 3. Surrounding entities",
        "",
        "| Name | Type | Internal/External | Description (one line) | Technology (optional) |",
        "|---|---|---|---|---|",
        "| Customer | Person | Internal | Places and tracks orders | |",
        "| Payment Gateway | System | External | Processes credit card payments | |",
        "",
        "## 4. Relationships",
        "",
        "| From | To | Label (short verb phrase) | Technology/protocol (optional) |",
        "|---|---|---|---|",
        "| Customer | OrderService | Places orders using | HTTPS |",
        "| OrderService | Payment Gateway | Sends payment requests to | HTTPS/JSON |",
        "",
        "## 5. Styling notes (optional)",
        "",
        "| Entity name | Background color | Font color | Border color |",
        "|---|---|---|---|",
        "| | | | |",
        "",
    ]
)


@pytest.fixture()
def architect(api: Api, needs_bridge: str) -> User:
    api.diagram_type("flowchart", name="Generic Flowchart")
    api.diagram_type("c4-context", "c4", name="C4 Context", personas=["Technical"], palette=["c4-notation"])
    api.diagram_type("sequence", "sequence", name="Sequence Diagram", personas=["Solution", "Technical"])
    return api.user("architect@example.com")


@pytest.fixture()
def project(api: Api, architect: User) -> str:
    return api.project(architect, "Test Project")


def do_import(api: Api, who: User | None, project: str, **payload: Any) -> Any:
    return api.call("POST", f"/projects/{project}/diagrams/import", who, json=payload)


def do_template(api: Api, who: User | None, project: str, **payload: Any) -> Any:
    return api.call("POST", f"/projects/{project}/diagrams/import-template", who, json=payload)


# --- import.test.ts -----------------------------------------------------------------------------------


def test_imports_a_valid_flowchart_with_no_hint(api: Api, architect: User, project: str) -> None:
    response = do_import(
        api, architect, project, name="Imported Flowchart", dslContent="flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n"
    )
    assert response.status_code == 201
    assert response.json()["diagram"]["diagramTypeId"] == "flowchart"


def test_imports_as_a_draft_when_asked_hidden_from_the_tree_listed_once_saved(
    api: Api, architect: User, project: str
) -> None:
    response = do_import(
        api, architect, project, name="Draft Import", dslContent="flowchart TD\n  A[Start]\n", draft=True
    )
    assert response.status_code == 201
    diagram = response.json()["diagram"]
    assert diagram["draft"] is True
    assert diagram["id"] not in api.call("GET", f"/projects/{project}/tree", architect).text

    saved = api.save_diagram(architect, diagram, diagram["dslContent"], diagram["currentVersionId"])
    assert saved.status_code == 200
    assert saved.json()["diagram"]["draft"] is False
    assert diagram["id"] in api.call("GET", f"/projects/{project}/tree", architect).text


def test_imports_a_graph_header_with_style_directives_and_comments(api: Api, architect: User, project: str) -> None:
    dsl = "\n".join(
        [
            "graph TD",
            "    A[🚀 Welcome to Playground] --> B{Try Mermaid}",
            "    %% this is a comment",
            "    B -->|Edit Code| C[📝 Live Preview]",
            "    B -->|Love It?| D[✨ Sign Up]",
            "    C --> E[🎯 See Changes Instantly]",
            "    D --> F[💾 Save & Export]",
            "",
            "    style A fill:#e1f5fe",
            "    style D fill:#f3e5f5",
            "    style F fill:#e8f5e8",
            "",
        ]
    )
    response = do_import(api, architect, project, name="Imported Graph Alias", dslContent=dsl)
    assert response.status_code == 201
    assert response.json()["diagram"]["diagramTypeId"] == "flowchart"


def test_imports_a_sequence_diagram_and_resolves_its_type_without_a_hint(
    api: Api, architect: User, project: str
) -> None:
    response = do_import(
        api,
        architect,
        project,
        name="Imported Sequence",
        dslContent="sequenceDiagram\nparticipant A\nparticipant B\nA->>B: Hi\n",
    )
    assert response.status_code == 201
    assert response.json()["diagram"]["diagramTypeId"] == "sequence"


def test_honors_an_explicit_hint_that_matches_the_detected_family(api: Api, architect: User, project: str) -> None:
    response = do_import(
        api,
        architect,
        project,
        name="Imported C4",
        dslContent='C4Context\nPerson(user, "User")\n',
        diagramTypeHint="c4-context",
    )
    assert response.status_code == 201
    assert response.json()["diagram"]["diagramTypeId"] == "c4-context"


def test_imports_a_c4_deployment_diagram_and_resolves_a_c4_family_type_without_a_hint(
    api: Api, architect: User, project: str
) -> None:
    response = do_import(
        api,
        architect,
        project,
        name="Imported C4 Deployment",
        dslContent='C4Deployment\n  Deployment_Node(live, "Live") {\n  }\n',
    )
    assert response.status_code == 201
    assert response.json()["diagram"]["diagramTypeId"] == "c4-context"


class TestTypeFromTheHeader:
    """Without a hint the type named by the DSL header wins over "first type in the family by id": these extra
    types all sort before the right answer alphabetically."""

    @pytest.fixture(autouse=True)
    def more_types(self, api: Api, architect: User) -> None:
        api.diagram_type("c4-code", "c4", name="C4 Code")
        api.diagram_type("c4-container", "c4", name="C4 Container")
        api.diagram_type("business-capability-map", "flowchart", name="Business Capability Map")

    def imported_type(self, api: Api, who: User, project: str, dsl: str, hint: str | None = None) -> str:
        payload = {"name": "Imported", "dslContent": dsl, **({"diagramTypeHint": hint} if hint else {})}
        response = do_import(api, who, project, **payload)
        assert response.status_code == 201, response.text
        return str(response.json()["diagram"]["diagramTypeId"])

    def test_c4_context_is_c4_context_not_the_alphabetically_first_c4_code(
        self, api: Api, architect: User, project: str
    ) -> None:
        assert self.imported_type(api, architect, project, 'C4Context\n  Person(user, "User")\n') == "c4-context"

    def test_c4_container_is_c4_container(self, api: Api, architect: User, project: str) -> None:
        assert self.imported_type(api, architect, project, 'C4Container\n  Container(api, "API")\n') == "c4-container"

    def test_a_plain_flowchart_is_the_generic_flowchart_type(self, api: Api, architect: User, project: str) -> None:
        assert self.imported_type(api, architect, project, "flowchart TD\n  A --> B\n") == "flowchart"

    def test_a_header_whose_type_is_not_registered_falls_back_to_the_familys_generic_type(
        self, api: Api, architect: User, project: str
    ) -> None:
        dsl = 'C4Deployment\n  Deployment_Node(live, "Live") {\n  }\n'
        assert self.imported_type(api, architect, project, dsl) == "c4-context"

    def test_an_explicit_hint_still_wins_over_the_header(self, api: Api, architect: User, project: str) -> None:
        dsl = 'C4Context\n  Person(user, "User")\n'
        assert self.imported_type(api, architect, project, dsl, "c4-container") == "c4-container"


def test_rejects_a_hint_whose_family_does_not_match_the_content(api: Api, architect: User, project: str) -> None:
    response = do_import(
        api,
        architect,
        project,
        name="Mismatched",
        dslContent="flowchart TD\n  A[Start]\n",
        diagramTypeHint="c4-context",
    )
    assert response.status_code == 422
    assert "flowchart" in response.json()["error"]
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0


def test_rejects_an_unknown_hint(api: Api, architect: User, project: str) -> None:
    response = do_import(
        api, architect, project, name="X", dslContent="flowchart TD\n  A[Start]\n", diagramTypeHint="no-such-type"
    )
    assert response.status_code == 422
    assert response.json()["error"] == "Unknown diagram type hint: no-such-type"


def test_rejects_unrecognized_text_with_a_specific_error(api: Api, architect: User, project: str) -> None:
    response = do_import(
        api, architect, project, name="Garbage", dslContent="this is not any known diagram syntax at all\n"
    )
    assert response.status_code == 422
    assert response.json()["error"].startswith("Could not recognize this text")


def test_rejects_a_recognized_header_with_unmappable_content_with_structured_details(
    api: Api, architect: User, project: str
) -> None:
    response = do_import(
        api, architect, project, name="Partially Bad", dslContent="flowchart TD\n  ???not-valid-syntax???\n"
    )
    assert response.status_code == 422
    details = response.json()["details"]
    assert isinstance(details, list)
    assert "line" in details[0]
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0


def test_an_imported_diagram_is_editable_afterward_like_a_native_one(api: Api, architect: User, project: str) -> None:
    diagram = do_import(
        api, architect, project, name="Round Trip Import", dslContent="flowchart TD\n  A[Start]\n"
    ).json()["diagram"]
    saved = api.save_diagram(architect, diagram, "flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n")
    assert saved.status_code == 200
    assert "B[End]" in api.call("GET", f"/diagrams/{diagram['id']}", architect).json()["diagram"]["dslContent"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": "X"},
        {"dslContent": "flowchart TD\n"},
        {"name": "", "dslContent": "flowchart TD\n"},
        {"name": "X", "dslContent": ""},
    ],
)
def test_rejects_a_malformed_import(api: Api, architect: User, project: str, payload: dict[str, object]) -> None:
    assert do_import(api, architect, project, **payload).status_code == 400


def test_import_requires_authentication(api: Api, project: str) -> None:
    assert do_import(api, None, project, name="X", dslContent="flowchart TD\n  A --> B").status_code == 401


# --- project-access.test.ts ---------------------------------------------------------------------------


def test_a_user_with_no_grant_cannot_import_into_a_project(api: Api, architect: User, project: str) -> None:
    outsider = api.user("outsider@example.com")
    response = do_import(api, outsider, project, name="Trespass", dslContent="flowchart TD\n  A --> B")
    assert response.status_code == 403
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0


def test_a_user_with_edit_on_the_project_can_import(api: Api, architect: User, project: str) -> None:
    editor = api.user("editor@example.com")
    api.grant("project", project, editor, "edit", architect)
    assert do_import(api, editor, project, name="Ok", dslContent="flowchart TD\n  A --> B").status_code == 201


# --- import-template.test.ts --------------------------------------------------------------------------


def test_imports_a_filled_c4_context_template_and_compiles_it_to_the_expected_dsl(
    api: Api, architect: User, project: str
) -> None:
    response = do_template(
        api,
        architect,
        project,
        name="Order Service Context",
        diagramTypeId="c4-context",
        templateContent=VALID_TEMPLATE,
    )
    assert response.status_code == 201
    diagram = response.json()["diagram"]
    assert diagram["diagramTypeId"] == "c4-context"
    for expected in (
        "System(orderService,",
        "Person(customer,",
        "System_Ext(paymentGateway,",
        "Rel(customer, orderService,",
    ):
        assert expected in diagram["dslContent"]


def test_a_template_imports_as_a_draft_when_asked_kept_out_of_the_tree(api: Api, architect: User, project: str) -> None:
    response = do_template(
        api,
        architect,
        project,
        name="Draft Context",
        diagramTypeId="c4-context",
        templateContent=VALID_TEMPLATE,
        draft=True,
    )
    assert response.status_code == 201
    diagram = response.json()["diagram"]
    assert diagram["draft"] is True
    assert "System(orderService," in diagram["dslContent"]
    tree = api.call("GET", f"/projects/{project}/tree", architect)
    assert tree.status_code == 200
    assert diagram["id"] not in tree.text


def test_rejects_a_malformed_template_with_structured_422_details(api: Api, architect: User, project: str) -> None:
    # A required field the compiler checks for, left empty.
    malformed = VALID_TEMPLATE.replace("| Central system name | OrderService |", "| Central system name | |")
    response = do_template(
        api, architect, project, name="Bad Template", diagramTypeId="c4-context", templateContent=malformed
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "Template could not be compiled"
    assert isinstance(body["details"], list)
    assert len(body["details"]) > 0
    for key in ("line", "content", "message"):
        assert key in body["details"][0]
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0


def test_rejects_an_unrecognized_entity_type_with_structured_422_details(
    api: Api, architect: User, project: str
) -> None:
    malformed = VALID_TEMPLATE.replace(
        "| Customer | Person | Internal | Places and tracks orders | |",
        "| Customer | Human | Internal | Places and tracks orders | |",
    )
    response = do_template(
        api, architect, project, name="Bad Type", diagramTypeId="c4-context", templateContent=malformed
    )
    assert response.status_code == 422
    body = response.json()
    assert isinstance(body["error"], str)
    assert len(body["details"]) > 0
    assert "Human" in body["details"][0]["message"]


def test_rejects_a_diagram_type_with_no_template_compiler_with_no_details_key(
    api: Api, architect: User, project: str
) -> None:
    # flowchart has no template compiler.
    response = do_template(
        api, architect, project, name="Unsupported", diagramTypeId="flowchart", templateContent=VALID_TEMPLATE
    )
    assert response.status_code == 422
    body = response.json()
    assert isinstance(body["error"], str)
    assert "details" not in body


@pytest.mark.parametrize("missing", ["name", "diagramTypeId", "templateContent"])
def test_rejects_a_template_import_missing_a_field_with_400(
    api: Api, architect: User, project: str, missing: str
) -> None:
    payload = {"name": "N", "diagramTypeId": "c4-context", "templateContent": VALID_TEMPLATE}
    del payload[missing]
    response = do_template(api, architect, project, **payload)
    assert response.status_code == 400
    assert isinstance(response.json()["error"], str)


def test_template_import_requires_authentication(api: Api, project: str) -> None:
    response = do_template(
        api, None, project, name="Trespass", diagramTypeId="c4-context", templateContent=VALID_TEMPLATE
    )
    assert response.status_code == 401


def test_a_signed_in_user_with_no_access_to_the_project_is_refused_a_template_import(
    api: Api, architect: User, project: str
) -> None:
    outsider = api.user("outsider@example.com")
    response = do_template(
        api, outsider, project, name="Trespass", diagramTypeId="c4-context", templateContent=VALID_TEMPLATE
    )
    assert response.status_code == 403


# --- diagram-missing-project.test.ts (canvas-1bty.18) -------------------------------------------------


@pytest.mark.parametrize("which", ["missing", "soft-deleted"])
@pytest.mark.parametrize("route", ["create", "import", "import-template"])
def test_a_diagram_cannot_go_into_a_missing_or_deleted_project(
    api: Api, architect: User, route: str, which: str
) -> None:
    project = MISSING_ID if which == "missing" else api.project(architect, "Gone", deleted_at=T0)
    url, payload = {
        "create": ("diagrams", {"name": "D", "diagramTypeId": "flowchart"}),
        "import": ("diagrams/import", {"name": "D", "dslContent": "flowchart TD\n  A --> B\n"}),
        "import-template": (
            "diagrams/import-template",
            {"name": "D", "diagramTypeId": "c4-context", "templateContent": "# x"},
        ),
    }[route]
    response = api.call("POST", f"/projects/{project}/{url}", architect, json=payload)
    assert response.status_code == 404
    assert response.json() == {"error": f"No project with id {project}"}
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0
