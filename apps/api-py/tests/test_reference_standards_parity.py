"""canvas-keg8: the seeded Value Chain standard matches the one diagram-core exports.

diagram-core exports VALUE_CHAIN_STANDARD as TypeScript (packages/diagram-core/src/standards/reference/value-chain.ts)
for consumers such as ADP; the API seeds the same standard from a Python dict. Both are pinned to one committed
fixture -- this test for the Python side, packages/diagram-core/tests/contract/reference-standards.test.ts for the
TypeScript side -- so neither can drift from the other. Key order is part of the contract: the stored JSON text is
compared, not just the parsed value.
"""

from __future__ import annotations

import json
from pathlib import Path

from canvas_api.seed.reference_standards import VALUE_CHAIN_STANDARD

FIXTURE = (
    Path(__file__).resolve().parents[3] / "packages/diagram-core/tests/fixtures/reference-standards/value-chain.json"
)


def test_value_chain_standard_matches_the_diagram_core_export() -> None:
    expected = FIXTURE.read_text(encoding="utf-8")
    # JSON.stringify(value, null, 2) + "\n" on the TypeScript side.
    assert json.dumps(VALUE_CHAIN_STANDARD, indent=2, ensure_ascii=False) + "\n" == expected
