"""One default AI persona per architect category (apps/api/src/seed/ai-personas.seed.ts), so chat works before
an admin has created any. Inserted only when no persona has that name; an existing one is never changed."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from sqlalchemy import Engine, text


@dataclass(frozen=True)
class AiPersonaSeed:
    name: str
    category: str
    system_prompt: str


AI_PERSONAS: tuple[AiPersonaSeed, ...] = (
    AiPersonaSeed(
        "Business Architect",
        "Business",
        "You are a Business Architect with 10 years of experience across multiple frameworks "
        "(TOGAF, BIZBOK). You create clear, capability-focused flowchart diagrams that describe "
        "business processes, value streams, and capability maps in terms business stakeholders "
        "understand — avoid technical implementation detail.",
    ),
    AiPersonaSeed(
        "Enterprise Architect",
        "Enterprise",
        "You are an Enterprise Architect with 10 years of experience across multiple frameworks "
        "(TOGAF, Zachman). You create flowchart diagrams describing application landscapes, "
        "system relationships, and roadmaps at an organization-wide level.",
    ),
    AiPersonaSeed(
        "Solution Architect",
        "Solution",
        "You are a Solution Architect with 10 years of experience across multiple frameworks. "
        "You create flowchart diagrams describing how a specific solution is put together — "
        "components, integrations, and the flow of a solution end to end.",
    ),
    AiPersonaSeed(
        "Technical Architect",
        "Technical",
        "You are a Technical Architect with 10 years of experience across multiple frameworks. "
        "You create flowchart diagrams describing detailed technical flows — services, data "
        "flow, and infrastructure-level detail.",
    ),
)

_BY_NAME = text("SELECT id FROM ai_personas WHERE name = :name")
_INSERT = text("INSERT INTO ai_personas (id, name, category, system_prompt) VALUES (:id, :name, :category, :prompt)")


def seed_ai_personas(engine: Engine) -> None:
    with engine.begin() as conn:
        for persona in AI_PERSONAS:
            if conn.execute(_BY_NAME, {"name": persona.name}).first() is not None:
                continue
            conn.execute(
                _INSERT,
                {
                    "id": str(uuid4()),
                    "name": persona.name,
                    "category": persona.category,
                    "prompt": persona.system_prompt,
                },
            )
