# Browse Screen Design (canvas-t3b, Option B)

Status: **approved 2026-10-20** (canvas-t3b.1). Implementation follows in canvas-t3b.2–t3b.6.

Option B from [navigation-flow-brief.md](navigation-flow-brief.md) §6 Q1: retire "current project"
as global app state and replace today's two browsing screens — the Projects page and the
per-project diagram browser — with one **Browse** surface you drill into. This document settles
the seven questions canvas-t3b.1 lists.

## Today, in one paragraph

Signing in lands on a "Diagrams" page for an automatically chosen *current project*
(`App.tsx` picks `projects[0]`). The header switches the current project (`ProjectPicker`) and
opens a separate Projects page. The address bar carries `?projectId=` but is only ever *replaced*,
never pushed, so the browser's Back button does nothing useful; an open diagram isn't in the
address at all, so a reload loses it. Leaving a diagram has three entry points with three copies
of the unsaved-changes check (`requestProjectChange` / `requestGoHome` / `requestViewProjects`).
Admin links sit at the bottom of the home page and carry `projectId` so the admin "back" link can
return to it.

## 1. URL scheme

| Address | Screen |
|---|---|
| `/` (no `projectId`, no `diagramId`) | **Projects** — the Browse top level |
| `?projectId=<id>` | **Project** — that project's diagrams |
| `?diagramId=<id>` | **Editor** — the diagram open (new: diagrams become linkable and survive a reload) |
| `?admin=<page>` | Admin console (unchanged, minus `projectId`) |

- Old links keep working: `?projectId=<id>` already means "that project", it now opens the
  project level instead of selecting a current project. An id that's malformed, deleted or not the
  user's shows the top level with the existing "That project is not available to you" message.
- `?diagramId=` carries only the diagram; the editor's back target comes from the diagram's own
  `projectId` (see §7). A diagram the user can't open shows the top level with an error, the same
  way.
- No `?projectId=` alongside `?diagramId=`: one source of truth per screen, nothing to disagree.
- Filter and search text are **not** navigations: typing replaces the current entry (or isn't in
  the address at all), so Back never walks through keystrokes.

## 2. Back / Forward

- Drilling into a project and opening a diagram **push** a history entry; going up via the
  breadcrumb or the editor's back button also pushes (it's a navigation, so Forward works after
  Back). The browser's Back/Forward re-read the address (`popstate`) and render that screen.
- Today's deliberate `replaceState` (project-context.ts, FR-012) existed because switching the
  *current project* isn't a navigation. With no current project, every screen change is one.
- Deleting the project you're looking at *replaces* the entry with the top level, so Back can't
  return to a project that no longer exists.
- Opening a deep link (`?projectId=` or `?diagramId=`) in a fresh tab seeds the history with the
  top level first, so Back goes up within the app rather than leaving it.
- **Unsaved changes on Back:** a `popstate` can't be cancelled, so when Back would leave an editor
  with unsaved changes, the app re-pushes the editor's address (the user stays put) and shows the
  same confirm dialog; confirming then performs the navigation. Closing or reloading the tab gets a
  standard `beforeunload` prompt while there are unsaved changes (none exists today).

## 3. State model and the one guarded navigation

`App.tsx`'s `projectId` / `viewingProjects` / `pendingProjectId` / `confirmingHome` /
`confirmingViewProjects` collapse into one `location`:

```ts
type Location =
  | { screen: 'projects' }
  | { screen: 'project'; projectId: string }
  | { screen: 'diagram'; diagramId: string };
```

- `location` is derived from the address on load and on `popstate`, and written to it by one
  `navigate(to: Location)` — the **only** way screens change.
- `navigate` checks `diagramEditorRef.current?.hasUnsavedChanges()` synchronously (canvas-eow's
  ref read, unchanged) and, if needed, opens the single confirm dialog ("Leave without saving?")
  before proceeding. The three existing guards and their three `Modal`s go.
- Admin pages stay full-page loads from plain links (`?admin=`), outside `navigate`.

## 4. Header

**Wordmark** · **Projects** link (to the top level) · **Admin** link (admins only — moved from the
bottom of the home page) · user email · **Sign Out**.

- No `ProjectPicker`: changing project is "go to Projects, open another".
- No "recently opened" shortcut in v1 (decision 4 below). The header is the same on every
  screen and no longer needs to know a project.

## 5. Where the create actions live

**New Diagram**, **Import Diagram**, **Import from Template** and **Create with AI** create into a
project, so they appear on the **project level only**, in that project's header. The top level's
own action is **New Project**. A user with no projects sees today's "create your first project"
empty state at the top level. (Rejected: create actions at the top level with a project chooser in
each dialog — four dialogs gain a picker for a flow that's one click away anyway.)

## 6. Shared with me

A **Shared with me** section on the top level, below the project list, listing diagrams shared
directly with the user (today's `SharedDiagramsList`, unchanged; hidden when empty, feature 008
FR-002). A user with no projects but some shared diagrams sees only that section — no "create your
first project" invitation contradicting it (FR-003, as today).

## 7. Leaving the editor, and the admin console

- **Editor back button** (doc bar): reads **‹ <project name>** and goes to that project — when the
  user can see the project. The name comes from the diagram's *current* `projectId` at render time,
  so it's right after a Move; the target is that fixed screen, not `history.back()` (the browser's
  Back and this button can therefore differ after a deep link — intended). For a diagram shared
  with them whose project they can't see, it reads **‹ Projects** and goes to the top level. Both go through `navigate`, so the unsaved-changes check
  applies.
- **Admin console**: entry links no longer carry `projectId`. Its back link returns to **the last
  Browse location in this tab** (kept in `sessionStorage` by `navigate`), falling back to the top
  level. `withProjectContext` is no longer needed for admin links (t3b.6 removes what's unused).

## Screen layouts

Drafted with the ui-design-expert agent; classes are the existing ones in `apps/web/src/styles`
(`.page`, `.page__title`, `.card`, `.btn--primary/--secondary`, `.section-label`, `.meta`).

**Header**

```
[◇ Canvas]  Projects  Admin*                         jo@example.com  [Sign Out]
                      * admins only
```

`<nav aria-label="Primary">` with real links; the current section has `aria-current="page"`
(Projects at both Browse levels, Admin on `?admin=`). Admin goes to `?admin=overview`, whose own
side navigation already lists every admin page, so the five links at the bottom of today's home
page are dropped rather than moved. Add a "Skip to main content" link (none exists today).

**Top level** — `<h1>` "Projects"

```
Projects
[ Filter projects…                ]                        [+ New Project]
┌──────────────────────────────────────────────────────────────────────────┐
│ Q3 Planning            4 diagrams                [Open] [Rename] [Delete]│
│ Payments               0 diagrams                [Open] [Rename] [Delete]│
└──────────────────────────────────────────────────────────────────────────┘
Shared with me                                                     (<h2>)
│ Billing flow   shared by alice · view                             [Open] │
```

- The project **name is also a link** to the same place as Open: buttons stay the explicit,
  always-visible actions (ui-design-spec §3.2), but the name no longer reads as dead text — the very
  complaint in the brief's Finding A. No whole-row click targets.
- Delete stays disabled, with its explanation, while a project has diagrams (canvas-228.2).
- Zero projects, nothing shared: the "You don't have any projects yet" card with **Create Project**.
  Zero projects but something shared: only "Shared with me", plus **New Project** in the toolbar row.
- Narrow screens: the row's buttons wrap onto a second line (no overflow menu, which would hide
  actions).

**Project level** — `<h1>` the project's name

```
Projects › Q3 Planning                       (<nav aria-label="Breadcrumb"><ol>…, last item aria-current="page")
Q3 Planning
[+ New Diagram] [Import Diagram] [Import from Template] [Create with AI]
[ Search diagrams…        ] [ All types ▾ ]
┌──────────────────────────────────────────────────────────────────────────┐
│ Order flow        Flowchart                        [Open] [Move] [Delete]│
└──────────────────────────────────────────────────────────────────────────┘
```

A stale or inaccessible `?projectId=` shows the top level with the existing "not available"
message.

**Editor doc bar**

```
[‹ Q3 Planning]  Order flow   …   Save  Export
[‹ Projects]     (a shared diagram whose project the user can't see)
```

A `<button>` (it runs the unsaved-changes check), chevron `aria-hidden`, long names truncated with
an ellipsis, accessible name "Back to project Q3 Planning".

## Accessibility and focus

There's no router, so the app manages focus itself:

- Each screen sets `document.title` ("Projects – Canvas", "Q3 Planning – Canvas", "<diagram> –
  Canvas").
- After an in-app navigation, focus moves to the new screen's `<h1>` (`tabIndex={-1}`), so a
  screen reader announces where the user is. The initial page load doesn't move focus. (Nice to
  have: after Back to a list, focus the row you came from.)
- No live region for navigation (the focus move announces it); `role="status"` only for async
  results such as a search's result count. Existing `role="alert"` errors stay.
- Every row button gets a unique accessible name — "Open project Q3 Planning", "Delete diagram
  Order flow" — instead of today's repeated bare "Open"/"Delete".
- Keyboard order — top level: skip link, header links, Sign Out, `<h1>`, filter, New Project, then
  per row Open, Rename, Delete, then Shared with me. Project level: breadcrumb link, the four create
  actions, search, type filter, then per row Open, Move, Delete.
- Inline rename: focus the input on edit; return focus to that row's Rename button afterwards.

## Test ids (keeping e2e churn down)

- **Kept** wherever the control survives, even where the name says "page": all `projects-page-*`
  (filter, list, rows, counts, create, rename, delete, errors), all `project-browser-*` (search,
  type filter, results, breadcrumb, empty/loading/error states), the four create actions
  (`new-diagram`, `import-diagram-button`, `import-template-button`, `create-via-ai-chat`), diagram
  rows (`open-/move-/delete-diagram-{id}`), `shared-*`, `sign-out`, the admin console's own ids.
- **New:** `nav-projects`, `nav-admin`.
- **Renamed:** `projects-page-view-diagrams-{id}` → `projects-page-open-{id}`.
- **Removed:** `close-projects-page`, `view-projects`, the `ProjectPicker` ids, the project-switch
  and view-projects confirm ids (only the leave-the-editor confirm remains), the five home-page
  `admin-*-link`s, and the second "create first project" form's ids once it's the same component as
  New Project.

## Landing and product decisions (answered 2026-10-20)

1. **Landing with exactly one project** (and nothing shared): open that project straight away —
   but only on first landing from a bare address; clicking **Projects** always shows the list, and a
   user who also has shared diagrams lands on the top level so "Shared with me" is visible.
2. **Landing with two or more projects:** resume the last project the user opened in this browser
   (`localStorage`, a landing hint — not global state); if it's gone or no longer theirs, the top
   level. A bare address only; an explicit `?projectId=` / `?diagramId=` always wins.
3. **Rename/Delete project:** on the top level's list only, not inside a project (v1).
4. **Recently opened diagrams:** later — filed as canvas-93n.

Settled during the review: admin pages don't need any project (only the admin console's back link
used it), and losing `ProjectPicker`'s one-click project switch is replaced by the breadcrumb's
**Projects** link (two clicks: Projects, then Open).

## How the tasks map

- **t3b.2** — §1–§3, the editor half of §7 and the landing rules (decisions 1–2): `location`,
  `navigate`, address sync, Back/Forward, `beforeunload`, one confirm dialog. Existing screens render from the new state.
- **t3b.3** — the Browse screen (§5, §6, the layouts, focus handling and per-row accessible
  names above).
- **t3b.4** — §4 (including the skip link) and the admin half of §7.
- **t3b.5** — e2e migration and new coverage (drill-in, breadcrumb, Back/Forward, old links,
  `?diagramId=` reload, the confirm from every exit, shared-diagram back).
- **t3b.6** — remove `ProjectPicker`, superseded components and helpers; update docs.
