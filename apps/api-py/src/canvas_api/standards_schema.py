"""A standard's request body, as apps/api/src/standards/standard-rules.schema.ts checks it with zod.

Structure only: unknown keys are dropped at every level, list fields default to empty, optional fields
left out stay out (in the TypeScript schema's field order). Whether the rules make sense for the
diagram family (kind ids, shapes, hex colours, connector references) is diagram-core's
checkStandardDefinition, called through the bridge, exactly as in TypeScript.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, ValidationError

from canvas_api.catalog import RULE_IDS

Severity = Literal["error", "warning", "info"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class KindMatch(_Model):
    role: StrictStr
    external: StrictBool | None = None


class ElementKind(_Model):
    id: StrictStr
    label: StrictStr
    description: StrictStr | None = None
    shapes: list[StrictStr] = []
    approvedFills: list[StrictStr] = []
    approvedStrokes: list[StrictStr] | None = None
    match: KindMatch | None = None
    minCount: StrictInt | None = None
    maxCount: StrictInt | None = None
    requireConnection: StrictBool | None = None


class KindGroup(_Model):
    id: StrictStr
    label: StrictStr
    kindIds: list[StrictStr] = []
    minCount: StrictInt | None = None
    maxCount: StrictInt | None = None


class ConnectorRule(_Model):
    id: StrictStr
    label: StrictStr
    from_: StrictStr = Field(alias="from")
    to: StrictStr
    lineStyles: list[Literal["solid", "dotted", "thick", "invisible"]] | None = None
    arrows: list[Literal["none", "source", "target", "both", "cross", "open"]] | None = None
    approvedStrokes: list[StrictStr] | None = None
    requireLabel: StrictBool | None = None
    maxPerSource: StrictInt | None = Field(default=None, ge=0)


class IconLibraryRef(_Model):
    libraryId: StrictStr
    libraryVersion: StrictStr


class PaletteEntry(_Model):
    role: StrictStr
    colorHex: StrictStr


class FontConstraints(_Model):
    family: StrictStr | None = None
    minSize: StrictInt | StrictFloat | None = None
    maxSize: StrictInt | StrictFloat | None = None


class Containers(_Model):
    allowed: StrictBool
    allowedRoles: list[StrictStr] | None = None


class Authoring(_Model):
    shapes: Literal["all", "listed", "none"] | None = None
    icons: Literal["all", "listed", "none"] | None = None


class StandardBody(_Model):
    name: StrictStr | None = None
    description: StrictStr | None = None
    # v1
    allowedShapeIds: list[StrictStr] = []
    mandatoryShapeIds: list[StrictStr] = []
    allowedIconLibraryRefs: list[IconLibraryRef] = []
    colorPalette: list[PaletteEntry] = []
    fontConstraints: FontConstraints | None = None
    # v2
    elementKinds: list[ElementKind] | None = None
    kindGroups: list[KindGroup] | None = None
    connectorRules: list[ConnectorRule] | None = None
    connectorPolicy: Literal["listed-only", "any"] | None = None
    containers: Containers | None = None
    requireKnownKinds: StrictBool | None = None
    severityOverrides: dict[str, Severity] | None = None
    guidance: StrictStr | None = None
    authoring: Authoring | None = None


def parse_standard_body(body: Any) -> tuple[StandardBody | None, dict[str, Any], list[dict[str, str]]]:
    """(the body, its rules as plain JSON, structural issues). Issues are {path, message}, like zod's."""
    try:
        parsed = StandardBody.model_validate({} if body is None else body)
    except ValidationError as exc:
        return (
            None,
            {},
            [{"path": ".".join(str(part) for part in error["loc"]), "message": error["msg"]} for error in exc.errors()],
        )
    unknown = [key for key in (parsed.severityOverrides or {}) if key not in RULE_IDS]
    if unknown:
        return None, {}, [{"path": f"severityOverrides.{key}", "message": "Invalid key"} for key in unknown]
    rules = parsed.model_dump(by_alias=True, exclude_none=True, exclude={"name", "description"})
    return parsed, rules, []
