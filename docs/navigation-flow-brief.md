# Requirements Brief: Projects ↔ Diagrams Navigation Flow

**Status**: Ready for `/speckit-specify` (one grouping at a time — see §6)
**Created**: 2026-08-02
**Source**: Design review of the Projects/Diagrams information architecture, requested directly
(not derived from `docs/ui-review-brief.md`, which predates `canvas-228`'s `ProjectsPage` and
never touched it). Verified against actual source (file:line citations throughout) and against
the running app via a disposable Playwright script hitting the real dev server/API as
`admin@example.com` — deleted afterward, nothing here required or left behind a code or database
change. Checked for conflicts against the locked `docs/ui-design-spec.md`; none of what follows
proposes changing a locked token or pattern, only extending patterns already established there
(`VersionHistory`'s search+cap, `Modal`, `card`/`row` primitives) into screens the spec's own
scope (dated 2026-07-27) predates.

---

## 1. Today's model, precisely

Three screens, three different relationships to "which project":

| Screen | Scope | How you reach it | How you leave it |
|---|---|---|---|
| `ProjectBrowser.tsx` (home, no diagram open) | The **one** project named by app state `projectId` — recurses into children if any exist (`ProjectBrowser.tsx:27-82`, `TreeNode`) | Default landing screen once signed in (`App.tsx:255-361`, the `else` branch) | Switch project via the header `ProjectPicker` `<select>`, or open a diagram |
| `ProjectsPage.tsx` | **Every** project the user can reach, flat, one `<li>` per project regardless of parent/child (`ProjectsPage.tsx:142-198`) | The header's "Projects" button (`AppShell.tsx:43`, wired at `App.tsx:372-383` → `requestViewProjects`) | The screen's own "Back" button (`ProjectsPage.tsx:77-80` → `onClose` → `App.tsx:252`) |
| `ProjectPicker.tsx` (header, always visible once ≥2 projects exist) | Every project, as `<option>`s in one native `<select>` (`ProjectPicker.tsx:37-48`) | N/A — it's chrome, not a screen | N/A |

These three don't reference each other. Confirmed by reading every line of `ProjectsPage.tsx`:
its `<li>` rows (`:149-196`) have no `onClick`, no link, nothing — clicking a project's name does
nothing. The only stated purpose of the file is management (rename/delete/create,
`ProjectsPage.tsx:16-19`'s own doc comment). To actually see that project's diagrams, a user must
close `ProjectsPage`, then use the header `<select>` to change "current project," which lands them
back on `ProjectBrowser`. Two different widgets (a card-list screen vs. a native `<select>`) serve
the same "which project" decision, with no visual link between them and no breadcrumb anywhere in
the app naming both a project and "diagrams" in the same view.

---

## 2. Finding A — `ProjectsPage` is a dead end by design, not by oversight

`ProjectsPage.tsx:15-19`'s own comment says this screen "generalizes" the old first-project-only
creation flow and gives rename/delete "a permanent, navigable home" — drill-in was never in scope.
That's consistent with what's in the file, but it means a user who opens Projects to, say, rename
one, has no way to then go look at its diagrams from there; they have to back out and use a
completely different control. This is the sharpest concrete gap in the current IA and the cheapest
to close (see §5, US1).

## 3. Finding B — no search anywhere in the frontend, despite a fully-built, perf-tested backend

Confirmed by reading every relevant file, not assumed:

- `ProjectsPage.tsx` renders all projects with zero filtering — no `<input>` anywhere in the file.
- `ProjectBrowser.tsx` — same; no `<input>` anywhere in the file, and its tree is not searchable at
  any depth.
- `ProjectPicker.tsx:9-19`'s own doc comment: *"the clarified scale is tens of projects with no
  search or paging (FR-013e)."* `project.service.ts:69-75`'s `listProjectsForUser` repeats the
  same assumption verbatim: *"No search or paging: the clarified scale is tens of projects."*
  `project.routes.ts:58-60`'s `GET /projects` takes no query parameters at all.
- **A live scale check against the seeded dev database directly contradicts that assumption by two
  orders of magnitude.** A disposable script (logged in as `admin@example.com`, deleted after)
  found **380 projects** and **1,477 diagrams** visible to that one user via the exact `GET
  /projects` call the app itself makes. `ProjectsPage` rendered all 380 as unpaginated `<li>` rows
  in one page (a full-page screenshot came out 28,719px tall). The header `<select>` rendered all
  380 as `<option>`s in one native control. **Caveat, in the same spirit as the previous brief's
  §3 item 3**: a large share of these are obviously accumulated e2e-test debris (names like `A11y
  Shared Source 1785595258420` — an epoch-millisecond suffix a human would never type), not organic
  usage, so 380 is not evidence real users have that many projects. But the *shape* of the problem
  — an unbounded list rendered with no cap, no pagination, no search — is real regardless of how
  many of the 380 are "real," and it is already reproducible today, not hypothetical.
- **The actual finding that should drive the fix**: `GET /projects/:projectId/diagrams` already
  exists (`diagram.routes.ts:70-81`), fully implemented, taking `query` (name, `ILIKE`) and `type`
  (`diagramTypeId`) filters, backed by `searchDiagrams` (`search.service.ts:11-39`), ordered by
  `updated_at DESC`. It is perf-tested against **1,200 diagrams in one project**
  (`apps/api/tests/performance/search.perf.test.ts:1-18`, explicitly validating SC-007: *"diagram
  save/load/search operations complete with no perceptible delay for projects containing at least
  1,000 diagrams"*). **The frontend never calls it.** `apps/web/src/app/api.ts` has exactly two
  calls to that route path — both `POST` (create at `:215`, import at `:217`) — and zero `GET`.
  This isn't a missing feature; it's a built, tested, spec'd (SC-007) capability with no UI
  consumer at all.
- The reusable pattern already exists in this codebase: `VersionHistory.tsx:89-108` — a search
  input, a `hasMore`-driven "Showing the N most recent" notice, per-item action. `Palette.tsx`'s
  icon search (`:16-22, 37-40`) is a second working precedent (search input + `Icon name="search"`
  prefix). Neither screen in this brief reuses either pattern today.

## 4. Finding C — the header `ProjectPicker` cannot be the sole cross-screen answer at this scale

`ProjectPicker.tsx` is a plain native `<select>` by deliberate design (`:9-19`'s comment: keyboard/
screen-reader correctness at the cost of no search, justified by the "tens of projects" scale
assumption Finding B already shows is false in the seeded data). A native `<select>` with 380
options has no in-app search — only the browser's own type-ahead-by-first-letter, which fails
outright when many names share a prefix, as the seeded `"A11y Shared Source …"` set does live.
This isn't a case for turning the picker into a custom searchable combobox — that repeats exactly
the accessibility regression its own comment already rejected. It's a case for **not asking the
one-line header control to be the search surface at all** — full search belongs on a dedicated
screen with room for it (see §6, Q2).

## 5. Finding D — three near-identical unsaved-changes guards, because there are three destinations

`App.tsx` has `requestProjectChange` (`:123-132`), `requestGoHome` (`:137-144`), and
`requestViewProjects` (`:147-155`) — three copies of the same "read `hasUnsavedChanges()` via ref,
confirm via modal, then navigate" logic, one per destination (switch project / close diagram /
open Projects). This isn't a bug (each is correctly implemented and tested — three `Modal`
instances at `App.tsx:410-514`), but it's a direct symptom of the IA having three distinct
"leave the diagram" destinations that don't share a screen. Fewer, better-connected destinations
would mean less of this duplication, not just a tidier diagram.

---

## 6. Answering the three questions directly

### Q1 — land at Projects first, or keep landing at "current project," with Projects secondary?

Neither of the two framings in the prompt is quite what's needed — the real fix in both cases is
making the two screens **reference each other**, which today's code does not do at all (§2).
Two genuinely different directions, with real tradeoffs:

**Option A — connect what exists (incremental).** Keep `ProjectBrowser` as the default landing
screen (unchanged). Fix `ProjectsPage` so it's no longer a dead end: add a per-row "View Diagrams"
action that sets `projectId` and returns to the diagram browser (reusing `App.tsx`'s existing
`applyProjectChange`/`setViewingProjects(false)` — no new state shape). Add a small breadcrumb-like
label on the diagram browser itself naming the current project with a link back to Projects,
so the relationship reads in both directions instead of only via the header button.
- *For*: smallest change; does not touch the default-landing assumption that **16 references
  across at least 14 e2e spec files** currently depend on (`grep` count against
  `apps/web/tests/e2e/*.spec.ts`); ships independently of the search work in Q2; keeps three
  existing, working, tested guards (`App.tsx:123-155`) intact rather than redesigning them.
- *Against*: still leaves two separate "browse" idioms (a management list and a diagram tree) that
  merely link to each other rather than being one coherent surface; a new user still has to learn
  both.

**Option B — unify into one unified browsing surface (structural).** Retire the "current project"
global-state concept. A single "Browse" screen: top level is the (searchable) project list
(`ProjectsPage`'s content), clicking a project drills into its diagrams (`ProjectBrowser`'s
content) with a real breadcrumb, and the header shrinks to sign-out plus, at most, a lightweight
"recently opened" shortcut rather than a full picker. This is closer to the Drive/Notion-style
mental model the prompt's own Q3 gestures at, and it would let `App.tsx` collapse
`requestProjectChange`/`requestGoHome`/`requestViewProjects` into one guarded navigation function,
since there would only be one place to navigate *to*.
- *For*: the more principled long-term IA; removes the split this whole brief is about, not just
  papers over it; removes duplicated guard logic (§5).
- *Against*: materially larger change — touches `App.tsx`'s core state model, the `withProjectContext`
  URL-carrying mechanism every admin link depends on (`project-context.ts:41-53`), the
  `AppShell.tsx:9-12` requirement that "every view needs to know which project it's in" (which
  would need a different, still-always-visible affordance once there's no single "current
  project"), and the 14+ specs anchored on today's default landing screen. Real work, not a
  same-day fix.

**My recommendation**: start with Option A. It closes the concrete, reproducible gap (§2) at low
cost and without touching what 14+ specs already assume, and it's not wasted work if Option B is
chosen later — the "View Diagrams" action and the breadcrumb both survive a later structural
merge. Option B is the better answer if the product wants to fully stop treating "current project"
as global state, but that's a bigger, separately-scoped decision, not something to fold into this
one.

### Q2 — where should search live, at which level(s)?

Three distinct levels, each with a different amount of work behind it:

1. **Diagrams within a project (`ProjectBrowser`)** — the cheapest, highest-value fix in this
   whole brief. `GET /projects/:projectId/diagrams?query=&type=` already exists, is already
   perf-tested at 1,200 diagrams, and is simply never called (§3). Add a search input to
   `ProjectBrowser` (mirroring `VersionHistory.tsx:89-108`'s input+cap shape) wired to the existing
   endpoint. This also gets a `type` filter for free — nothing in the UI today lets a user filter
   an existing diagram list by diagram type, even though `NewDiagramDialog` treats diagram type as
   a first-class choice at creation time.
2. **Projects (`ProjectsPage`, and the header picker)** — no server-side query support exists yet
   (`project.routes.ts:58-60`'s `GET /projects` takes no params; `project.service.ts:69-75`'s own
   comment says as much). Given `GET /projects` already returns the full list in one call, a
   **client-side filter over the already-fetched array** is enough for now and ships with zero API
   change. If real (non-test-debris) project counts ever approach the seeded number, the correct
   follow-up is a server `?q=` param on `GET /projects` mirroring `searchDiagrams`'s exact shape —
   symmetric work to what already had to be built for diagrams, not a new pattern.
3. **Global, cross-project search ("everything I have access to")** — does not exist anywhere
   today, including admin (`DeletedDiagramsPage` and `SharedDiagramsList` are both unsearchable
   too). Worth naming as a real gap, not urgent: there's no current evidence of demand for it
   beyond the raw scale numbers alone, and it would require genuinely new backend work (a
   cross-project query), unlike levels 1–2 which are mostly "wire up what's already built" or "add
   one query param." Backlog, not this round.

The header `ProjectPicker` itself should **not** grow its own search (§4) — it should stay a
compact, keyboard-correct native `<select>`, and full search should live on the dedicated screens
that have room for it.

### Q3 — general flow: fresh-eyes recommendation

Beyond closing Finding A and wiring up Finding B's dormant endpoint, the two things most worth
doing:

- **Give `ProjectBrowser`'s diagram-search a recursion caveat now, before it becomes a real bug.**
  `searchDiagrams` (`search.service.ts:20`) filters on `project_id = $1` only — it does not recurse
  into children the way `ProjectBrowser`'s own `TreeNode` component already does
  (`ProjectBrowser.tsx:76-78`, recursing into `node.children`) or the way `getProjectTree`
  (`project.service.ts:209-261`) already does via a recursive CTE. Today this is silently correct
  only because there is no UI to ever create a nested project (`project.service.ts:130-132`'s own
  comment: *"this app has no UI to ever create nested projects"*), so every project's tree is in
  practice one node deep. The moment nested-project creation UI is added, a search box wired
  directly to `searchDiagrams` would silently miss matches in child projects while the un-searched
  tree view below it still shows them — a real, if currently dormant, correctness gap between two
  already-existing pieces of code that just happen not to have been exercised together yet.
- **Reduce the three-guard duplication (§5) opportunistically, not as its own project.** Whichever
  of Q1's two options is chosen, don't leave `requestProjectChange`/`requestGoHome`/
  `requestViewProjects` as three copies of the same logic if the destinations end up sharing more
  structure than they do today — that's free cleanup riding on top of whichever navigation change
  ships, not a reason to delay one.
- **Don't introduce a new "clickable row" convention casually.** Nothing in this app today
  navigates on a bare row click — every existing action (Open, Move, Delete, Rename) is an
  explicit button, and `ui-design-spec.md` §3.2 is explicit that actions must "appear at full
  opacity always (not hover-only — hover-only actions fail keyboard discoverability)." Any drill-in
  affordance added to `ProjectsPage` (§6 Q1's "View Diagrams") should be the same kind of explicit,
  always-visible button as its existing Rename/Delete actions, not a row `onClick`, to stay
  consistent with that precedent and with keyboard/screen-reader discoverability.

---

## 7. Proposed breakdown

| # | Story | Addresses | Why this priority |
|---|---|---|---|
| **US1 (P1)** | Wire `ProjectBrowser`'s diagram list to the existing `GET /projects/:projectId/diagrams?query=&type=` search endpoint | Finding B (diagram-level) | The single cheapest, highest-value fix here — a tested, spec'd (SC-007) backend capability that already exists and simply has no UI. No new API work. |
| **US2 (P1)** | Add a "View Diagrams" action per row on `ProjectsPage`, plus a project-name breadcrumb/link back to Projects from the diagram browser | Finding A | Closes the one genuine dead end in the current IA at low cost (Option A of Q1), without touching the 14+ specs anchored on today's default landing screen. |
| **US3 (P2)** | Client-side filter over `ProjectsPage`'s already-fetched project list | Finding B (project-level) | Zero API change; immediately usable; matches `VersionHistory`'s existing search-input styling. |
| **US4 (P3)** | Server-side `?q=` param on `GET /projects`, mirroring `searchDiagrams`'s shape, if/when real project counts justify it | Finding B (project-level, at scale) | Same shape of work already done once for diagrams — symmetric, not novel — but only worth doing once organic (non-test-debris) counts approach a scale that makes the client filter from US3 insufficient. |
| **US5 (P3, structural, needs a decision first)** | Unify `ProjectsPage` and `ProjectBrowser` into one drill-in browsing surface; retire "current project" as global state | Findings A, D, Q1 Option B | The more principled long-term fix, but real work — touches `App.tsx`'s core state model and the `withProjectContext` mechanism every admin link depends on. Don't start until Q1 is decided. |

**On the ordering**: US1 and US2 are independent and both P1 — either can go first. US3 can ship
alongside or after either. US4 and US5 are both explicitly gated on decisions (real-scale evidence
for US4; the Q1 direction for US5) rather than being ready to spec today.

---

## 8. Out of scope

- Any change to diagram element rendering, the DSL grammar, or standards/validation.
- Re-opening anything already covered by `docs/ui-review-brief.md` (that brief's six confirmed
  fixes and its own six new findings are untouched here).
- Dark mode, mobile/tablet layouts — out of scope per `ui-design-spec.md` §0.3/§8's existing
  precedent, unaffected by anything in this brief.
- Nested-project creation UI itself (still explicitly out of scope per `project.service.ts:130-132`'s
  own comment) — §6 Q3's recursion caveat is about not letting search silently regress *if* that
  ever ships, not a proposal to build it now.

---

## 9. Open questions

1. **Q1's actual direction** (see §6 for the full tradeoff) — Option A (connect the two existing
   screens, cheap, ships now) vs. Option B (unify into one surface, retires "current project" as
   global state, more principled but a real rewrite). Recommended: start with A; it doesn't
   foreclose B later.
2. **US4's trigger condition** — what real (non-test-debris) project count should actually justify
   building server-side project search, given the 380 figure this brief found is known to be
   inflated by e2e debris? Worth a rough threshold (e.g. "when any single user's real project
   count exceeds ~50") rather than leaving it open-ended.
3. **The dev database's accumulated test debris itself** — 380 projects / 1,477 diagrams
   accumulated across prior test runs is now large enough to make manual verification of *any*
   Projects/Diagrams-screen change slower and noisier than it should be (this review's own
   full-page screenshot came out 28,719px tall). Not this brief's problem to fix, but worth
   flagging to whoever owns the shared dev environment — the same observation the previous review
   made in passing about `DeletedDiagramsPage`'s 30+ rows, now two orders of magnitude larger.
