# Phase 0 Research: Editing & Lifecycle Enhancements

## 1. Soft-delete retention/purge enforcement mechanism

**Decision**: Enforce the 30-day retention window by comparing `deleted_at` against `now()` at
read/restore time (a plain `WHERE`/`CASE` check in the query or service layer), rather than
running a scheduled job that physically deletes expired rows. "Eligible for permanent removal"
is satisfied by the application-level check (FR-015: restoring/opening past the window reports
"no longer available"); actual physical purge of long-expired rows is deferred to a future
housekeeping task (e.g., a manual admin action or an ops-run script), not built now.
**Rationale**: Building a job scheduler/cron/queue purely to enforce a 30-day timestamp check is
disproportionate machinery for what the spec actually requires (Constitution VI). The visible
behavior — "gone after 30 days" — is fully achieved without ever running a background process.
**Alternatives considered**: A scheduled purge job (e.g., a nightly cron calling a `purgeExpired()`
function) — rejected for now as premature; nothing in the spec requires rows to be physically
gone from the database within any particular time of expiry, only that they behave as gone.

## 2. Deletion authorization model

**Decision**: Diagram deletion is authorized by direct ownership (`diagrams.owner_id`) or the
`admin` role — not by the existing `ShareGrant`/`resolveDiagramAccess` view/comment/edit ladder.
A `requireDiagramOwnerOrAdmin` check is added alongside (not built on top of) the existing
`requireDiagramAccess` middleware.
**Rationale**: Deletion is an ownership-level action, distinct from the collaborative
view/comment/edit access levels FR-020/FR-021 (001) define. Folding "delete" into the
`edit`-and-above ladder would let anyone granted "edit" access delete a diagram out from under
its owner — not what "edit access" implies to a user granting it.
**Alternatives considered**: Adding a fourth `AccessLevel` ("owner")` to the existing ladder —
rejected as unnecessary complexity; ownership is already a first-class, unambiguous concept
(`owner_id`) with no need to route it through the grant-resolution system.

## 3. Confirmation UI pattern

**Decision**: A small, custom, in-app confirmation control (not the browser's native
`window.confirm()`), consistent with every other interactive surface already built for this
project (StandardsEditor, ImportDialog, ShareDialog — all custom React UI, no native dialogs).
**Rationale**: Native dialogs are harder to style consistently, and — more importantly — this
project's existing accessibility audit (001, US6/Polish) exercises every interactive surface
with axe-core against real DOM elements; a native `confirm()` call is opaque to that tooling and
would be the one inconsistent interaction pattern in the app.
**Alternatives considered**: `window.confirm()` — rejected for the reasons above, despite being
marginally less code.

## 4. Mermaid `style` directive parsing strategy

**Decision**: The flowchart parser is extended to a two-pass approach: pass one parses the
existing node/edge/subgraph grammar exactly as today (Mermaid allows `style` lines anywhere,
typically at the end, so node declarations can't assume styles are already known); pass two
applies any collected `style <nodeId> <prop>:<value>,...` lines to the already-built node map,
mapping `fill`→`fillColor` and `stroke`→`strokeColor` (the two fields `NodeStyle` already has
that a CSS-like `style` line commonly sets). Properties `NodeStyle` has no field for (e.g.
`stroke-width`) are accepted (don't cause a parse error) but not modeled — consistent with the
spec's "at least fill and stroke" wording in FR-017.
**Rationale**: Matches how the two-pass idea already works for edge-endpoint-implies-node
handling in the current parser (`flowchart-parser.ts`'s existing "any edge endpoint not
explicitly declared becomes an implicit node" pass). Keeps this a parser-only extension — no
serializer change, since `flowchart-serializer.ts`'s existing front-matter `styles` block already
round-trips `NodeStyle` losslessly for diagrams this platform itself produces; native `style`
directive syntax only needs to be *accepted on import* per FR-017, not *emitted on export*.
**Alternatives considered**: Also emitting native `style` lines on serialize (for maximum
external-tool compatibility on export, not just import) — deferred as unnecessary scope; the
spec's acceptance criteria only exercise the import direction.

## 5. `graph` keyword handling

**Decision**: Treat `graph` as a pure header alias: the header-recognition regex accepts either
keyword with the same direction tokens, and the resulting `DiagramModel` and round-trip behavior
are identical regardless of which keyword was used to import it (re-serialization always emits
`flowchart`, the canonical form this platform already uses everywhere else).
**Rationale**: `graph` and `flowchart` are documented Mermaid synonyms for the same diagram type
with identical grammar — there's no semantic difference to preserve, so normalizing to one
canonical output form on save avoids introducing a second internal notion of "which header did
this diagram originally use."
**Alternatives considered**: Preserving the original keyword through round-trips — rejected,
adds a field with no behavioral payoff since the two keywords are strictly interchangeable.

## 6. Sign-out placement in the UI

**Decision**: Introduce a thin, persistent `AppShell` wrapper that renders a top-level header
(with the sign-out control) around whichever view is currently active (main screen, diagram
editor, admin pages) — rather than adding a sign-out button separately inside each view.
**Rationale**: FR-001 requires sign-out to be "visible" and "always-reachable." The application
today has no persistent chrome — `App.tsx` swaps entire full-screen views — so without a shared
shell, sign-out would need to be duplicated into every view (and would be missed on some, as
today's admin pages and the diagram editor already demonstrate no shared header exists).
**Alternatives considered**: Adding a sign-out button to each view individually — rejected,
violates Constitution VI (duplicated logic instead of one shared shell) and is exactly how a
control gets forgotten on the next new view.

---

All Technical Context items are resolved above; no `NEEDS CLARIFICATION` markers remain in
`plan.md`.
