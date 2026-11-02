"""AI chat and its administration (phase 8, canvas-1bty.12; apps/api/src/ai/*.routes.ts).

A diagram's chat (send a message, read the conversation), personas and their reference material, AI
settings (chat on/off, usage visible to users, the model), token usage and model prices.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, StrictBool, StrictFloat, StrictInt, StrictStr
from sqlalchemy import Engine

from canvas_api.access import require_diagram_access
from canvas_api.ai.chat import DslParseError, get_chat_messages, send_chat_message
from canvas_api.ai.model_list import AiModelListError, list_ai_models
from canvas_api.ai.personas import (
    InvalidPersonaCategoryError,
    InvalidReferenceMaterialError,
    archive_persona,
    create_persona,
    create_reference_material,
    delete_reference_material,
    get_persona,
    list_active_personas,
    list_all_personas,
    list_reference_material,
    update_persona,
    update_reference_material,
)
from canvas_api.ai.settings import can_see_usage, get_ai_settings, set_ai_settings
from canvas_api.ai.usage import (
    delete_price,
    diagram_usage_total,
    list_prices,
    own_usage,
    set_price,
    summarize_by_user,
    unpriced_models,
    user_detail,
)
from canvas_api.audit import client_ip, record_audit
from canvas_api.auth.roles import AdminUser, CurrentUser
from canvas_api.config import Settings
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramBridge
from canvas_api.errors import ApiError
from canvas_api.routes.diagrams import get_diagram
from canvas_api.timestamps import js_iso, now_utc

router = APIRouter(tags=["AI"])
Db = Annotated[Engine, Depends(get_engine)]
log = logging.getLogger(__name__)

Price = Annotated[StrictFloat | StrictInt, Field(ge=0, le=100000)]


class ChatBody(BaseModel):
    message: StrictStr = Field(min_length=1)
    currentDslContent: StrictStr = Field(min_length=1)
    personaId: StrictStr | None = None
    #: canvas-s3o: Create with AI's planning phase -- the model can talk but not draw.
    mode: Literal["plan", "build"] | None = None


class SettingsBody(BaseModel):
    chatEnabled: StrictBool | None = None
    showUsageToUsers: StrictBool | None = None
    modelId: Annotated[StrictStr, Field(min_length=1, max_length=200)] | None = None


class PersonaBody(BaseModel):
    name: StrictStr
    category: StrictStr
    systemPrompt: StrictStr


class PersonaPatch(BaseModel):
    name: StrictStr | None = None
    category: StrictStr | None = None
    systemPrompt: StrictStr | None = None


class ReferenceBody(BaseModel):
    content: StrictStr
    diagramFamilies: list[StrictStr] | None = None


class ReferencePatch(BaseModel):
    content: StrictStr | None = None
    diagramFamilies: list[StrictStr] | None = None


class PriceBody(BaseModel):
    provider: StrictStr = Field(min_length=1, max_length=100)
    modelId: StrictStr = Field(min_length=1, max_length=200)
    inputPerMillion: Price
    outputPerMillion: Price
    cacheReadPerMillion: Price | None = None
    cacheWritePerMillion: Price | None = None


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _bridge(request: Request) -> DiagramBridge:
    bridge: DiagramBridge | None = request.app.state.diagram_bridge
    if bridge is None:
        raise ApiError(503, "The diagram-core bridge is not configured (DIAGRAM_BRIDGE_URL).")
    return bridge


def _models(request: Request) -> list[dict[str, Any]]:
    state = request.app.state
    return list_ai_models(
        _settings(request),
        anthropic_client=getattr(state, "anthropic_client", None),
        openai_client=getattr(state, "openai_client", None),
    )


# --- diagram chat -------------------------------------------------------------------------------------
# FR-008b: both need edit access -- the conversation belongs to everyone who could make the same edit by hand.


@router.post("/diagrams/{id}/chat/messages")
def chat_send(id: str, body: ChatBody, request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    settings = _settings(request)
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        if not get_ai_settings(conn, settings)["chatEnabled"]:
            raise ApiError(503, "AI chat is currently disabled by an administrator.")
        diagram = get_diagram(conn, id)
    try:
        result = send_chat_message(
            db,
            _bridge(request),
            settings,
            diagram=diagram,
            message=body.message,
            current_dsl=body.currentDslContent,
            persona_id=body.personaId,
            mode=body.mode or "build",
            user_id=user.id,
            language_model=getattr(request.app.state, "language_model", None),
        )
    except DslParseError as error:
        raise ApiError(422, str(error)) from error
    # canvas-4k9: token counts only for users allowed to see them (setting; admins always).
    with db.connect() as conn:
        if not can_see_usage(conn, settings, user.role):
            del result["usage"]
    return result


@router.get("/diagrams/{id}/chat/messages")
def chat_history(id: str, request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "edit")
        with_usage = can_see_usage(conn, _settings(request), user.role)
        messages = get_chat_messages(conn, id, with_usage=with_usage)
        if with_usage:
            return {"messages": messages, "usageTotal": diagram_usage_total(conn, id)}
        return {"messages": messages}


# --- settings -----------------------------------------------------------------------------------------


@router.get("/admin/ai-models")
def ai_models(request: Request, _admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        settings = get_ai_settings(conn, _settings(request))
    base = {
        "provider": settings["provider"],
        "modelId": settings["modelId"],
        "defaultModelId": settings["defaultModelId"],
    }
    try:
        return {**base, "models": _models(request)}
    except AiModelListError as error:
        log.warning("listing AI models failed", extra={"reason": str(error)})
        return {**base, "models": [], "error": str(error)}


@router.get("/ai-settings")
def ai_settings(request: Request, _user: CurrentUser, db: Db) -> dict[str, Any]:
    """canvas-wuc: every signed-in user -- the AI entry points check chatEnabled/provider before use."""
    with db.connect() as conn:
        return get_ai_settings(conn, _settings(request))


@router.get("/admin/ai-settings")
def admin_ai_settings(request: Request, _admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        return get_ai_settings(conn, _settings(request))


@router.patch("/admin/ai-settings")
def patch_ai_settings(body: SettingsBody, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise ApiError(400, "body must NOT have fewer than 1 properties")
    model_id = changes.get("modelId")
    if isinstance(model_id, str):
        try:
            models = _models(request)
        except AiModelListError as error:
            raise ApiError(502, f"{error} The model wasn't changed.") from error
        if not any(m["id"] == model_id for m in models):
            raise ApiError(400, f'The AI provider doesn\'t offer the model "{model_id}".')
    settings = _settings(request)
    with db.begin() as conn:
        before = get_ai_settings(conn, settings) if "modelId" in changes else None
        set_ai_settings(conn, changes)
        after = get_ai_settings(conn, settings)
        if before is not None and before["modelId"] != after["modelId"]:
            record_audit(
                conn,
                "ai_model_set",
                actor_user_id=admin.id,
                ip=client_ip(request),
                detail={
                    "provider": after["provider"],
                    "from": before["effectiveModelId"],
                    "to": after["effectiveModelId"],
                    "chosen": after["modelId"],
                },
            )
    return after


# --- personas -----------------------------------------------------------------------------------------


@router.get("/ai-personas")
def personas(_user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        return {"personas": list_active_personas(conn)}


@router.get("/admin/ai-personas")
def admin_personas(_admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        return {"personas": list_all_personas(conn)}


@router.post("/admin/ai-personas", status_code=201)
def create_persona_route(body: PersonaBody, _admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        with db.begin() as conn:
            return {"persona": create_persona(conn, body.name, body.category, body.systemPrompt)}
    except InvalidPersonaCategoryError as error:
        raise ApiError(400, str(error)) from error


@router.patch("/admin/ai-personas/{id}")
def update_persona_route(id: str, body: PersonaPatch, _admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        with db.begin() as conn:
            persona = update_persona(conn, id, body.name, body.category, body.systemPrompt)
    except InvalidPersonaCategoryError as error:
        raise ApiError(400, str(error)) from error
    if persona is None:
        raise ApiError(404, "Persona not found")
    return {"persona": persona}


@router.post("/admin/ai-personas/{id}/archive")
def archive_persona_route(id: str, _admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.begin() as conn:
        persona = archive_persona(conn, id)
    if persona is None:
        raise ApiError(404, "Persona not found")
    return {"persona": persona}


# --- reference material (admins only; it only ever reaches users through chat replies) -----------------


@router.get("/admin/ai-personas/{id}/reference-material")
def reference_material(id: str, _admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        if get_persona(conn, id) is None:
            raise ApiError(404, "Persona not found")
        return {"entries": list_reference_material(conn, id)}


@router.post("/admin/ai-personas/{id}/reference-material", status_code=201)
def create_reference(id: str, body: ReferenceBody, _admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        with db.begin() as conn:
            if get_persona(conn, id) is None:
                raise ApiError(404, "Persona not found")
            return {"entry": create_reference_material(conn, id, body.content, body.diagramFamilies)}
    except InvalidReferenceMaterialError as error:
        raise ApiError(400, str(error)) from error


@router.patch("/admin/ai-personas/{personaId}/reference-material/{entryId}")
def update_reference(personaId: str, entryId: str, body: ReferencePatch, _admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        with db.begin() as conn:
            entry = update_reference_material(conn, personaId, entryId, body.content, body.diagramFamilies)
    except InvalidReferenceMaterialError as error:
        raise ApiError(400, str(error)) from error
    if entry is None:
        raise ApiError(404, "Reference material entry not found")
    return {"entry": entry}


@router.delete("/admin/ai-personas/{personaId}/reference-material/{entryId}", status_code=204)
def delete_reference(personaId: str, entryId: str, _admin: AdminUser, db: Db) -> Response:
    with db.begin() as conn:
        if not delete_reference_material(conn, personaId, entryId):
            raise ApiError(404, "Reference material entry not found")
    return Response(status_code=204)


# --- usage and prices ---------------------------------------------------------------------------------


def _instant(name: str, value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        parsed = None
    if parsed is None or parsed.tzinfo is None or "T" not in value.upper():
        raise ApiError(400, f'querystring/{name} must match format "date-time"')
    return parsed


def _period(from_: str | None, to: str | None) -> tuple[datetime, datetime]:
    """`to` defaults to just after now (a turn recorded this millisecond still counts), `from` to 30 days earlier."""
    end = _instant("to", to) or now_utc() + timedelta(milliseconds=1)
    start = _instant("from", from_) or end - timedelta(days=30)
    if start >= end:
        raise ApiError(400, "`from` must be before `to`.")
    return start, end


@router.get("/admin/ai-usage", tags=["Admin"])
def ai_usage(_admin: AdminUser, db: Db, request: Request) -> dict[str, Any]:
    start, end = _period(request.query_params.get("from"), request.query_params.get("to"))
    with db.connect() as conn:
        return {"from": js_iso(start), "to": js_iso(end), **summarize_by_user(conn, start, end)}


@router.get("/admin/ai-usage/users/{id}", tags=["Admin"])
def ai_usage_user(id: str, _admin: AdminUser, db: Db, request: Request) -> dict[str, Any]:
    start, end = _period(request.query_params.get("from"), request.query_params.get("to"))
    with db.connect() as conn:
        return {"from": js_iso(start), "to": js_iso(end), **user_detail(conn, id, start, end)}


@router.get("/admin/ai-prices", tags=["Admin"])
def ai_prices(_admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        return {"prices": list_prices(conn), "unpricedModels": unpriced_models(conn)}


@router.put("/admin/ai-prices", tags=["Admin"])
def put_ai_price(body: PriceBody, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    price = {
        "provider": body.provider,
        "modelId": body.modelId,
        "inputPerMillion": body.inputPerMillion,
        "outputPerMillion": body.outputPerMillion,
        "cacheReadPerMillion": body.cacheReadPerMillion if body.cacheReadPerMillion is not None else 0,
        "cacheWritePerMillion": body.cacheWritePerMillion if body.cacheWritePerMillion is not None else 0,
    }
    with db.begin() as conn:
        set_price(conn, price)
        record_audit(conn, "ai_price_set", actor_user_id=admin.id, ip=client_ip(request), detail=price)
    with db.connect() as conn:
        return {"prices": list_prices(conn)}


@router.delete("/admin/ai-prices", tags=["Admin"])
def delete_ai_price(provider: str, modelId: str, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    with db.begin() as conn:
        if not delete_price(conn, provider, modelId):
            raise ApiError(404, "No price for that model.")
        record_audit(
            conn,
            "ai_price_removed",
            actor_user_id=admin.id,
            ip=client_ip(request),
            detail={"provider": provider, "modelId": modelId},
        )
    with db.connect() as conn:
        return {"prices": list_prices(conn)}


@router.get("/me/ai-usage")
def my_ai_usage(request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        if not can_see_usage(conn, _settings(request), user.role):
            return {"visible": False}
        now = datetime.now(UTC)
        start = datetime(now.year, now.month, 1, tzinfo=UTC)
        end = datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=UTC)
        return {"visible": True, "from": js_iso(start), "to": js_iso(end), **own_usage(conn, user.id, start, end)}
