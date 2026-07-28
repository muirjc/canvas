# UI Contract: Modern UI Redesign

For a UI feature layered over a fully-tested application, the interface contract is the set of
identifiers and semantics the automated suite and assistive technology depend on. This file is
that contract.

**The rule**: every identifier and role below is **preserved**. None is removed, renamed, or
merged. Additions are permitted; subtractions are not. Restyling, rewrapping, and relocating an
element is free, as long as its identifier travels with it and it still does the same job.

Regenerate the inventory at any time with:

```bash
grep -rhoP 'data-testid=\{?[`"]\K[^`"$]*' apps/web/src --include=*.tsx | sort -u
```

---

## 1. Preserved `data-testid` identifiers (108)

Trailing `-` marks a dynamic prefix completed at runtime (e.g. `node-a1`, `persona-row-<uuid>`).

| Component | Identifiers |
|---|---|
| `app/AppShell.tsx` | `sign-out` |
| `app/App.tsx` | `new-diagram`, `import-diagram-button`, `create-via-ai-chat`, `app-error`, `admin-overview-link`, `admin-console-link`, `admin-users-link`, `admin-deleted-diagrams-link`, `admin-ai-personas-link` |
| `app/LoginForm.tsx` | `login-email`, `login-password`, `login-submit`, `login-error` |
| `app/NewDiagramDialog.tsx` | `diagram-type-`, `confirm-new-diagram`, `cancel-new-diagram` |
| `app/DiagramEditor.tsx` | `save-diagram`, `save-status`, `open-share-dialog` |
| `canvas/Canvas.tsx` | `diagram-canvas`, `canvas-root`, `node-`, `edge-`, `container-`, `node-label-input-`, `edge-label-input-`, `add-shape-`, `connect-mode-toggle`, `group-selected`, `delete-selected` |
| `canvas/DslPanel.tsx` | `dsl-panel`, `apply-dsl` |
| `canvas/ViolationsPanel.tsx` | `violations-panel`, `violations-panel-empty`, `violation-item` |
| `canvas/ExportMenu.tsx` | `export-` |
| `canvas/ConfirmDialog.tsx` | `confirm-dialog`, `confirm-dialog-confirm`, `confirm-dialog-cancel` |
| `canvas/UnsupportedElementNotice.tsx` | `unsupported-element-notice`, `unsupported-element-item` |
| `palette/Palette.tsx` | `palette-search`, `palette-results`, `palette-icon-`, `palette-no-results` |
| `projects/ProjectBrowser.tsx` | `project-browser`, `project-node-`, `open-diagram-`, `delete-diagram-` |
| `projects/VersionHistory.tsx` | `version-history`, `version-`, `restore-version-` |
| `projects/ShareDialog.tsx` | `share-email`, `share-access-level`, `confirm-share`, `share-grants`, `share-grant-`, `revoke-share-`, `close-share-dialog`, `share-error` |
| `projects/ImportDialog.tsx` | `import-name`, `import-file`, `import-textarea`, `confirm-import`, `cancel-import`, `import-error` |
| `ai/ChatPanel.tsx` | `chat-panel`, `chat-messages`, `chat-message-`, `chat-input`, `chat-send`, `chat-error` |
| `ai/CreateViaChatDialog.tsx` | `ai-create-name`, `ai-create-persona`, `ai-create-description`, `ai-create-confirm`, `ai-create-cancel`, `ai-create-error` |
| `ai/PersonaAdminPage.tsx` | `ai-chat-enabled-toggle`, `persona-create-name`, `persona-create-category`, `persona-create-prompt`, `persona-create-submit`, `persona-create-error`, `persona-row-`, `persona-status-`, `persona-prompt-`, `persona-archive-` |
| `admin/AdminOverview.tsx` | `overview-user-count`, `overview-standards-count`, `overview-library-count`, `overview-link-users`, `overview-link-standards` |
| `admin/StandardsEditor.tsx` | `allowed-shape-`, `mandatory-shape-`, `color-role-input`, `color-hex-input`, `add-color-entry`, `create-publish-standard`, `standards-editor-message`, `standards-history` |
| `admin/UsersPage.tsx` | `user-row-`, `user-role-`, `user-active-` |
| `admin/DeletedDiagramsPage.tsx` | `deleted-diagram-row-`, `restore-diagram-`, `deleted-diagrams-message` |

The last four rows belong to files this feature does not edit — they are listed because
`base.css` restyles those screens, and that must not disturb them.

---

## 2. Preserved ARIA semantics

Several tests select by role, and the accessibility audit depends on all of it. Verified by
inspection of the current source.

| Role | Location | Accessible name | Note |
|---|---|---|---|
| `alertdialog` | `ConfirmDialog` | "Confirm action" | **Not `dialog`.** Must be set explicitly when adopting the native `<dialog>` element, which would otherwise imply `dialog`. |
| `dialog` | `NewDiagramDialog` | "New diagram" | implicit on `<dialog>`; keep the `aria-label` |
| `dialog` | `ImportDialog` | "Import diagram" | |
| `dialog` | `ShareDialog` | "Share diagram" | |
| `dialog` | `CreateViaChatDialog` | "Create via AI Chat" | asserted by `ai-create-diagram.spec.ts` via `getByRole` |
| `toolbar` | `Canvas` | "Diagram tools" | the tools relocate into the palette rail; the role and its name travel with them |
| `group` | `ExportMenu` | "Export diagram" | |
| `status` | `ViolationsPanel`, `DeletedDiagramsPage` | — | polite live regions |
| `alert` | `LoginForm`, `App`, `ImportDialog`, `ShareDialog`, `ChatPanel`, `CreateViaChatDialog`, `PersonaAdminPage`, `UnsupportedElementNotice` | — | assertive live regions; all 8 preserved |

Accessible names on labelled controls (e.g. `aria-label="Search shapes and icons"`,
`aria-label="Describe a change"`) are likewise preserved.

Also preserved: `<optgroup>` grouping inside `ai-create-persona`, asserted by
`ai-persona-admin.spec.ts`.

---

## 3. Additions

### New identifiers

| Identifier | Purpose |
|---|---|
| `doc-bar` | The editor's persistent document action bar (FR-009) |
| `canvas-surface` | The container wrapping the canvas `<svg>` — carries the dot-grid background |
| `rail-tab-dsl` | Selects the DSL panel |
| `rail-tab-chat` | Selects the AI chat panel |
| `rail-tab-issues` | Selects the violations panel |
| `rail-tab-history` | Selects the version history panel |

### New ARIA

| Semantic | Where | Requirement |
|---|---|---|
| `tablist` / `tab` / `tabpanel` | secondary rail | `aria-selected` maintained; arrow-key navigation between tabs; each panel labelled by its tab |
| `aria-pressed` | `connect-mode-toggle` | exposes active mode state (FR-015) |
| `aria-modal="true"` | all five dialogs | native on `<dialog>` opened via `showModal()`; `ConfirmDialog` already declares it |
| `aria-invalid` | invalid form fields | paired with a visible message |

---

## 4. Behavioral contract

Requirements a reviewer or test must be able to check.

### Secondary rail

1. On every diagram open, the **DSL** panel is active (FR-012) — not the last-used panel.
2. Exactly one panel is visible at a time.
3. A panel never selected in the current editor session is **absent from the DOM**; once
   selected it remains mounted and is hidden when inactive (research §2).
4. Switching away from the chat panel and back **preserves an unsent draft and scroll position**,
   and issues no refetch.
5. The outstanding violation count is visible on the Issues tab without activating it (FR-013).

### Dialogs

6. Opening a dialog leaves the underlying screen visible behind a scrim.
7. Focus moves into the dialog on open and cannot leave it via Tab while open.
8. `Escape` closes the dialog and applies no change.
9. On close, focus returns to the control that opened it.
10. React open-state stays in sync when the browser closes the dialog natively (the `cancel`
    event must be handled).

### Global

11. Every interactive element shows a visible focus indicator on keyboard focus (FR-005).
12. No information is conveyed by color alone (FR-006).
13. Every panel that can be empty, loading, or failed renders a specific message for that
    condition (FR-019–FR-021).
14. With `prefers-reduced-motion: reduce`, no animation or transition plays (FR-023).

### Preservation

15. The axe-core audit reports zero WCAG 2.1 A/AA violations on all 7 audited screens.
16. No file under `packages/diagram-core/src/render/` is modified (SC-004).
17. No diagram node carries a shadow, filter, blur, or transition — the drag performance gate
    depends on it (FR-028).
18. Every existing E2E test passes with **no change to its assertions or logic**; the only
    permitted edits are tab activations in the 4 files identified in the design spec's change
    manifest.
