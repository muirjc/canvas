"""canvas-8uh1.2: the index of drill-down links between diagrams (docs/composite-diagrams-design.md).

A diagram's links live in its own text (front matter `canvas.links`, read into each element's `diagramRef`). This
table copies them out so the API can answer "which diagrams link to this one" without reading every diagram: it is
rebuilt from the parsed model whenever a diagram's text is written (create, save, restore, import) and goes with
the diagram when it is purged. The target is plain text, not a foreign key, so a link to a diagram that no longer
exists is still found (and shown as broken).
"""

from __future__ import annotations

import re
from typing import Any, Literal

from sqlalchemy import Connection, text

LinkStatus = Literal["available", "unavailable", "deleted", "missing"]

#: A Canvas diagram id (UUIDs). Anything else in `canvas.links` can't name a diagram here, so it is "missing"
#: without a query (and Postgres would refuse it as a uuid).
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

_CLEAR = text("DELETE FROM diagram_links WHERE source_diagram_id = :id AND kind = 'link'")
_INSERT = text(
    "INSERT INTO diagram_links (source_diagram_id, kind, element_id, target_diagram_id, position)"
    " VALUES (:id, 'link', :element, :target, :position)"
)
_OUTGOING = text(
    "SELECT element_id, target_diagram_id FROM diagram_links WHERE source_diagram_id = :id AND kind = 'link'"
    " ORDER BY position"
)
_TARGET = text(
    "SELECT d.id, d.name, d.diagram_type_id, d.project_id, p.name AS project_name, d.owner_id, d.draft,"
    " d.deleted_at, p.deleted_at AS project_deleted_at"
    " FROM diagrams d JOIN projects p ON p.id = d.project_id WHERE d.id = :id"
)
_USED_IN = text(
    "SELECT d.id, d.name, d.diagram_type_id, d.project_id, p.name AS project_name, d.owner_id, d.draft,"
    " l.element_id"
    " FROM diagram_links l JOIN diagrams d ON d.id = l.source_diagram_id JOIN projects p ON p.id = d.project_id"
    " WHERE l.target_diagram_id = :target AND l.kind = 'link' AND d.deleted_at IS NULL AND p.deleted_at IS NULL"
    " ORDER BY d.name, d.id, l.position"
)


def links_of(model: dict[str, Any]) -> list[tuple[str, str]]:
    """(element id, diagram id) for every node and group that links somewhere, nodes first, in model order."""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for element in [*model.get("nodes", []), *model.get("containers", [])]:
        ref = element.get("diagramRef")
        target = ref.get("diagramId") if isinstance(ref, dict) else None
        element_id = element.get("id")
        if isinstance(target, str) and isinstance(element_id, str) and element_id not in seen:
            seen.add(element_id)
            found.append((element_id, target))
    return found


def link_target_types(conn: Connection, model: dict[str, Any]) -> dict[str, str]:
    """canvas-8uh1.5: the diagram type of each diagram the model links to, for the `kind-link` standard rule. Only
    diagrams that can be opened by anyone: not in the bin (or in a binned project) and not an unsaved draft; a link to
    any other isn't judged by type."""
    ids = sorted({target for _, target in links_of(model) if _UUID.fullmatch(target)})
    types: dict[str, str] = {}
    for target in ids:
        row = conn.execute(
            text(
                "SELECT d.diagram_type_id FROM diagrams d JOIN projects p ON p.id = d.project_id"
                " WHERE d.id = :id AND d.deleted_at IS NULL AND p.deleted_at IS NULL AND d.draft = :no"
            ),
            {"id": target, "no": False},
        ).first()
        if row is not None:
            types[target] = row.diagram_type_id
    return types


def link_types_for_rules(conn: Connection, model: dict[str, Any], rules: Any) -> dict[str, str] | None:
    """link_target_types, looked up only when the standard has a `linkTo` rule (else None: nothing to judge)."""
    kinds = rules.get("elementKinds") if isinstance(rules, dict) else None
    if not any(isinstance(k, dict) and k.get("linkTo") for k in kinds or []):
        return None
    return link_target_types(conn, model)


def rebuild_links(conn: Connection, diagram_id: str, model: dict[str, Any]) -> None:
    """Replaces the diagram's rows with the links its (just written) model holds."""
    conn.execute(_CLEAR, {"id": diagram_id})
    for position, (element_id, target) in enumerate(links_of(model)):
        conn.execute(_INSERT, {"id": diagram_id, "element": element_id, "target": target, "position": position})


def _status(row: Any, user_id: str) -> LinkStatus:
    if row is None:
        return "missing"
    if row.deleted_at is not None or row.project_deleted_at is not None:
        return "deleted"
    # Someone else's unsaved draft doesn't exist for anyone but its creator.
    if bool(row.draft) and str(row.owner_id) != user_id:
        return "unavailable"
    return "available"


def outgoing_links(conn: Connection, diagram_id: str, user_id: str) -> list[dict[str, Any]]:
    """The diagram's links in order, each with the linked diagram's state and (when it can be opened) its title,
    type and project."""
    out: list[dict[str, Any]] = []
    for link in conn.execute(_OUTGOING, {"id": diagram_id}):
        target = link.target_diagram_id
        row = conn.execute(_TARGET, {"id": target}).first() if _UUID.fullmatch(target) else None
        status = _status(row, user_id)
        out.append(
            {
                "elementId": link.element_id,
                "diagramId": target,
                "status": status,
                "diagram": (
                    {
                        "id": str(row.id),
                        "name": row.name,
                        "diagramTypeId": row.diagram_type_id,
                        "projectId": str(row.project_id),
                        "projectName": row.project_name,
                    }
                    if row is not None and status == "available"
                    else None
                ),
            }
        )
    return out


def used_in(conn: Connection, diagram_id: str, user_id: str) -> list[dict[str, Any]]:
    """The diagrams (not in the bin, not someone else's draft) whose current version links to this one, with
    the elements that do, by name."""
    by_source: dict[str, dict[str, Any]] = {}
    for row in conn.execute(_USED_IN, {"target": diagram_id}):
        if bool(row.draft) and str(row.owner_id) != user_id:
            continue
        source = str(row.id)
        entry = by_source.get(source)
        if entry is None:
            entry = by_source[source] = {
                "diagramId": source,
                "name": row.name,
                "diagramTypeId": row.diagram_type_id,
                "projectId": str(row.project_id),
                "projectName": row.project_name,
                "elementIds": [],
            }
        entry["elementIds"].append(row.element_id)
    return list(by_source.values())


def diagram_link_base(canvas_public_url: str) -> str:
    """canvas-8uh1.4: the start of a diagram's Canvas address, for links in exports (the diagram id is appended)."""
    return f"{canvas_public_url}/?diagramId="


_SUBMITTED_PATH = text(
    "SELECT path FROM diagram_submissions WHERE diagram_id = :id AND repo_id = :repo AND state IN ('open', 'merged')"
    " ORDER BY first_submitted_at DESC"
)
_VERSION = text("SELECT id, sequence_number FROM diagram_versions WHERE id = :id")


def submission_links(conn: Connection, diagram_id: str, repo_id: int) -> list[dict[str, Any]]:
    """canvas-8uh1.4: a GitHub submission's record of the diagram's links, in order: each linked diagram's version
    at submission (None when it can't be opened: in the bin, missing, or an unsaved draft), its name, and the
    folder it was submitted to in the same repository (open or merged), if any."""
    out: list[dict[str, Any]] = []
    for link in conn.execute(_OUTGOING, {"id": diagram_id}):
        target = link.target_diagram_id
        row = None
        if _UUID.fullmatch(target):
            row = conn.execute(
                text(
                    "SELECT d.name, d.diagram_type_id, d.current_version_id, d.draft, d.deleted_at,"
                    " p.deleted_at AS project_deleted_at"
                    " FROM diagrams d JOIN projects p ON p.id = d.project_id WHERE d.id = :id"
                ),
                {"id": target},
            ).first()
        available = (
            row is not None
            and row.deleted_at is None
            and row.project_deleted_at is None
            and not bool(row.draft)
            and row.current_version_id is not None
        )
        version = conn.execute(_VERSION, {"id": row.current_version_id}).first() if available and row else None
        path = conn.execute(_SUBMITTED_PATH, {"id": target, "repo": repo_id}).first() if available else None
        out.append(
            {
                "elementId": link.element_id,
                "diagramId": target,
                "name": row.name if available and row else None,
                "diagramType": row.diagram_type_id if available and row else None,
                "versionId": str(version.id) if version else None,
                "versionSequence": int(version.sequence_number) if version else None,
                "repoPath": str(path.path) if path else None,
            }
        )
    return out


#: canvas-8uh1.5: at most this many diagrams are offered to the AI chat to link to (the prompt stays short).
MAX_AI_LINK_TARGETS = 100


def project_link_targets(conn: Connection, project_id: str, diagram_id: str) -> list[dict[str, Any]]:
    """The diagrams the AI chat may link this diagram's elements to: the project's other saved diagrams (not in the
    bin, not drafts), by name, [{id, name, diagramTypeId}]."""
    rows = conn.execute(
        text(
            "SELECT id, name, diagram_type_id FROM diagrams WHERE project_id = :project AND id <> :id"
            " AND deleted_at IS NULL AND draft = :no ORDER BY name, id LIMIT :limit"
        ),
        {"project": project_id, "id": diagram_id, "no": False, "limit": MAX_AI_LINK_TARGETS},
    ).all()
    return [{"id": str(r.id), "name": r.name, "diagramTypeId": r.diagram_type_id} for r in rows]
