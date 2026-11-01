# diagram-core golden corpus

The contract between diagram-core's two implementations: TypeScript (the browser, and the server
today) and Python (the server, as the backend moves there; canvas-1bty,
[docs/python-backend-assessment.md](../../../docs/python-backend-assessment.md)). Both must produce
exactly these outputs from these inputs. Language-neutral: plain files, no code.

```
cases/<name>/input.mmd                 Mermaid as a user or Canvas would save it
cases/<name>/case.json                 optional: {"standards": ["value-chain"]}
cases/<name>/expected/family.txt       the detected family (flowchart, c4, ...)
cases/<name>/expected/model.json       the parsed model
cases/<name>/expected/serialized.mmd   the model serialized back to Mermaid (Canvas's own form)
cases/<name>/expected/portable.mmd     portable Mermaid for other tools (front matter removed)
cases/<name>/expected/render.svg       the server-side SVG (no icon artwork)
cases/<name>/expected/violations-<standard>.json   findings against standards/<standard>.json
cases/<name>/expected/errors.json      instead of the above, for input that doesn't parse
standards/<id>.json                    standard rules the cases are checked against
```

Rules for comparing:
- **JSON** is canonical: keys sorted at every level, two-space indent, trailing newline, and a
  missing value is left out, never written as `null`. Compare as text.
- **Mermaid** files compare as exact text.
- **SVG**: the TypeScript implementation must match byte for byte. A Python implementation may
  instead compare as normalised XML (same elements, attributes and text, attribute order ignored,
  numbers equal), as the port plan allows.

A parsed case must also be stable: what its serialized output parses to keeps every node and edge,
and serializing it again changes nothing (the first round trip may still reorder elements declared
inside groups, canvas-ra0g).

## Running and updating

TypeScript (part of diagram-core's tests, so it runs in CI):

```bash
npx vitest run tests/contract/golden-corpus.test.ts                     # check
UPDATE_CORPUS=1 npx vitest run tests/contract/golden-corpus.test.ts     # regenerate
```

Regenerate only for an intended change, and review every changed file: each one is a behaviour
change both implementations must make. Any change to diagram-core's server-side behaviour adds or
updates cases here in the same pull request (Constitution Principle IV).
