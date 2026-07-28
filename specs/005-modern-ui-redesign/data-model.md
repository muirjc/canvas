# Phase 1 Data Model: Modern UI Redesign

## No persisted entities

This feature introduces **no database tables, no API endpoints, no schema migration, and no
change to any existing entity**. Nothing it adds is stored, transmitted, or shared between users.

That is worth stating explicitly rather than omitting: a redesign of this size would normally be
expected to carry persisted preferences (a saved theme, a remembered active tab, remembered panel
widths). It deliberately does not — see "Deliberately not persisted" below.

What follows is the vocabulary this feature *does* define: the design token namespace and the
ephemeral in-memory UI state.

---

## 1. Design token vocabulary

Tokens are CSS custom properties declared once on `:root` in `styles/tokens.css`. They are a
shared naming contract: any component may consume them, and no component may hardcode a value
that a token already expresses.

| Group | Tokens | Notes |
|---|---|---|
| **Surface** | `--surface-base`, `--surface-raised`, `--surface-sunken`, `--surface-canvas` | `--surface-canvas` stays white so admin-defined diagram colors render truthfully (FR-027) |
| **Text** | `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-inverse` | all verified ≥4.5:1 on every surface they are used on |
| **Accent** | `--accent`, `--accent-hover`, `--accent-active`, `--accent-subtle` | the single accent; used only functionally (state, selection, focus) |
| **Border** | `--border-control`, `--border-default`, `--border-subtle` | **`--border-control` (3.59:1) is the only one permitted on a form control** — see the constraint below |
| **Feedback** | `--danger`, `--success`, `--warning` | never the sole carrier of meaning (FR-006) |
| **Focus** | `--focus-ring` | applied to every interactive element (FR-005) |
| **Canvas** | `--canvas-grid-dot` | decorative; CSS background only, never SVG content |
| **Type** | `--font-sans`, `--font-mono`, `--text-display` … `--text-caption`, `--text-mono` | system stacks only, nothing network-fetched (FR-003) |
| **Space** | `--space-1` … `--space-10` | 4px-based scale |
| **Shape** | `--radius-sm` … `--radius-xl`, `--border-width` | |
| **Elevation** | `--shadow-sm`, `--shadow-md`, `--shadow-modal`, `--overlay-scrim` | never applied to diagram nodes (performance, FR-028) |
| **Layout** | `--app-header-h`, `--doc-bar-h`, `--rail-left-w`, `--rail-right-w`, `--canvas-min-w`, `--app-min-w` | |

Literal values are in [`docs/ui-design-spec.md` §1](../../docs/ui-design-spec.md).

### Validation rule that must not be violated

**A form control's boundary must use `--border-control`.** WCAG 1.4.11 requires 3:1 for
boundaries needed to identify a control; `--border-default` (1.52:1) and `--border-subtle`
(1.25:1) are decorative separators and do not clear it. Substituting one on an input to soften
its appearance would silently fail the accessibility gate. This is the single most likely way to
break the build while producing something that looks fine.

---

## 2. Ephemeral UI state

All of this is component-local React state, discarded on unmount. None is persisted or
transmitted.

| State | Owner | Values | Lifecycle |
|---|---|---|---|
| **Active secondary panel** | `DiagramEditor` | `dsl` \| `chat` \| `issues` \| `history` | Initialized to `dsl` on every diagram open (FR-012). Not remembered across diagrams or reloads. |
| **Mounted panels** | `DiagramEditor` | set of panels selected at least once | A panel mounts on first selection and then stays mounted, hidden when inactive — preserves an unsent chat draft and scroll position, and avoids refetching (research §2). |
| **Open dialog** | `App`, `DiagramEditor`, `Canvas` | which dialog, if any | Already exists; unchanged except that the open state now drives `showModal()`. |
| **Panel load state** | each panel | `loading` \| `ready` \| `empty` \| `error` | Drives FR-019–FR-021. Today these are implicit; this feature makes them explicit. |
| **Control interaction state** | CSS only | rest / hover / focus-visible / active / disabled | Expressed entirely in CSS pseudo-classes — no React state (FR-022). |

### State transitions — secondary panel

```
                 ┌────────────────────────────────┐
  diagram opens  │                                │
  ──────────────►│  active = dsl   (mounted: dsl) │
                 └───────────────┬────────────────┘
                                 │ architect selects another tab
                                 ▼
                 ┌────────────────────────────────────────────┐
                 │  active = <tab>                            │
                 │  first selection → mount it (may fetch)    │
                 │  later selections → reveal it (no fetch)   │
                 │  previously active → display:none, alive   │
                 └────────────────────────────────────────────┘
```

---

## 3. Deliberately not persisted

| Candidate | Why not |
|---|---|
| Theme preference | Only one appearance exists in this feature; a preference with one option is not a preference. |
| Last active secondary panel | FR-012 requires DSL to be the default on **every** open. Remembering the last tab would contradict it and make the editor's initial state non-deterministic — including for the E2E suite. |
| Panel or rail widths | Rails are fixed width this pass; resizing is not in scope, so there is nothing to store. |
| Dismissed empty-state hints | The empty states are informational, not dismissible. |

Each of these is a plausible future feature that would introduce real persistence. None is needed
now, and adding storage for them would be speculative generalization (Constitution VI).
