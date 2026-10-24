# Design: submitting Canvas diagrams to GitHub for approval

Status: **approved** (2026-10-24). Epic canvas-3s5; phases canvas-3s5.1–.4. Background ideas (not requirements): `docs/github_ci.md`, `docs/github_ci.yml`, `docs/github_for _stoarge.md`.


## Context
Architects want an approved, version-controlled record of their diagrams outside Canvas: a diagram is sent to a GitHub repository as a **pull request**, the repo's CI/CD checks it, reviewers approve it in GitHub, and **merging = approved**. Canvas stays the editing tool; GitHub is the approval gate and the long-term record. The user's `docs/github_ci.md`, `docs/github_ci.yml` and `docs/github_for _stoarge.md` are background ideas (architecture-as-code repo, single "gate" check, branch protection, CODEOWNERS), not requirements.

**Decisions made with the user**
- One-way Canvas → GitHub; Canvas is the source of truth.
- An admin links a project to a repo + folder (several projects may share a repo, different folders); explicit per project (no inheritance — the UI has no sub-projects).
- Auth: a **GitHub App** on github.com (selected repos, short-lived tokens). Commits authored by the app with `Co-authored-by: <Name> <email>` of the Canvas user.
- PR files: reviewer-facing README (SVG + metadata + mermaid block), portable `.mmd` (front-matter stripped), lossless `.canvas.mmd`, rendered SVG, a manifest, and the diagram type's active standard as JSON.
- Editing continues during review; **Submit again pushes a new commit to the same open PR**; Canvas shows "changes since submitting".
- Status by **polling** (the IP allow-list blocks webhooks): on-demand refresh + a scheduled job.
- Anyone with **Edit** access can submit; **Must-fix** issues block submit; warnings go in the PR description.
- Canvas provides a **validator CLI + example workflow** the repo's CI runs (parse + render + the committed standard; fails on Must-fix).
- **Merged = approved** (that version recorded); closed unmerged = rejected; review/check state shown while open.
- Renames/deletes are not propagated to the repo (paths fixed at first submission).
- First step of Phase 1: confirm the GitHub org has no IP allow-list (if it does, a NAT gateway / static egress IP or the org's "allow installed GitHub Apps" setting is needed).

## Approach

### Repo layout (per link folder)
```
<folder>/<slug>/README.md          SVG first, metadata table, <details> with ```mermaid
<folder>/<slug>/<slug>.svg         exportSvg output (icons included)
<folder>/<slug>/<slug>.mmd         portable Mermaid, front-matter stripped
<folder>/<slug>/<slug>.canvas.mmd  stored DSL, byte-for-byte (lossless)
<folder>/<slug>/canvas.json        manifest: diagramId, name, type, dslFamily, versionSequence,
                                   sourceSha256, standard {path,id,version}, canvasUrl, validatorVersion
.canvas/standards/<typeId>/v<version>.json   active standard rules (immutable per version)
.canvas/validator.mjs              validator bundle (Phase 3)
```
Slug from the name at first submission (kebab, ≤60, `-<id8>` on collision); reused for every later PR. Branch `canvas/<id8>-<slug>-r<n>`.

### Data model (Postgres `0026_github_integration.sql`, SQLite `0014_…`)
- `github_links`: project_id UNIQUE, repo_id (BIGINT), repo_owner/name (cached), installation_id, base_branch, folder, audit cols, last_checked_at/error; UNIQUE(repo_id, folder).
- `diagram_submissions` (one per PR): diagram_id, github_link_id (SET NULL) + copied repo/installation/branch fields, path, branch, pr_number/url, state open|merged|closed, submitted_version_sequence + fingerprint (sha256 of DSL+name+description), last_pushed/head sha, submitting_since (lock), review_state, checks_state, status_detail JSON, last_synced_at/error, merged_at/by/commit sha, merged_head_matches, closed_at. **Partial unique index: one open PR per diagram.**
- `diagram_submission_pushes`: push history.

### Server (`apps/api/src/github/`)
- `github-config.ts` (+ `config.ts`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM or base64; `'unset'` = disabled), `GITHUB_APP_API_URL` (default api.github.com), `CANVAS_PUBLIC_URL` (deep links; default first WEB_ORIGINS).
- `github-app-auth.ts`: App JWT via `node:crypto` (RS256), installation-token cache, tokens scoped to the one repo + minimal permissions. **No octokit** — plain `fetch` client.
- `github-client.ts`: typed errors (API, rate-limit, access-lost), 15s timeout, one GET retry, never log tokens; Git Data API (blobs/trees/commits/refs) + Pulls/Reviews/Check-runs/Status.
- `folder-path.ts`: strict folder/slug validation (no `..`, `.git*`, `.github`, `.canvas`, control chars); every generated path re-validated.
- `submission-files.ts`: pure file-set builder, Markdown escaping (@mention neutralised), PR body template, local git blob SHAs to skip unchanged files.
- `github-link.service/routes`, `submission.service/routes`, `status-sync.service`, `sync-run.ts` (job entry, like `purge/run.ts`).
- **Submit flow**: link resolved → re-validate against the current active standard (refuse on Must-fix, 422 with violations) → per-diagram lock → sync existing PR first → build files (reuse `exportSvg`, `toPortableMermaid`) → commit on top of the PR head (never force-push; no-op if tree unchanged) → create/update PR → record push + audit.
- **Sync**: merged → approved record (+ `merged_head_matches` flags edits made on GitHub); closed → rejected; open → latest-per-reviewer review state, combined checks; access errors mark the link "needs attention".
- Reuse: `exportSvg`/`buildIconResolver` (`apps/api/src/export/export.service.ts`), `toPortableMermaid` (+ new `stripFrontMatter` option, tests first) in `packages/diagram-core/src/dsl/portable-mermaid.ts`, `getActiveStandard` (`standards/standard.service.ts`), `validate` + `getDslFamily` (diagram-core), `computeValidation` (export from `diagram.service.ts`), `requireDiagramAccess`, `recordAudit` (new events: github_link_set/removed, diagram_submitted, diagram_submission_merged/closed/withdrawn), `runInBackground` (`background/tasks.ts`).

### API
Admin: `GET /admin/github/status`, `GET /admin/github/repositories` (installed repos only — the link form accepts only these repoIds), `GET /admin/github/links`, `PUT|DELETE /projects/:id/github-link`, `POST /admin/github/links/:id/test` (permission checklist), `GET /admin/github/workflow-example` (Phase 3).
Users: `GET /projects/:id/github-link`, `POST /diagrams/:id/submissions` (edit), `GET /diagrams/:id/submission` (current/approved/changesSince…/canSubmit), `POST …/submission/refresh` (throttled), `GET /diagrams/:id/submissions` (history), `POST …/submission/withdraw`, `GET /projects/:id/submission-statuses` (badges).

### Web
- Admin → **GitHub** page (`apps/web/src/admin/GitHubAdminPage.tsx`, AdminShell entry): app status, linked projects (test/edit/remove), link dialog (installed-repo picker, branch, folder with preview), workflow download.
- Editor doc bar: **Submit for approval** button (edit access; disabled with unsaved changes / not linked / Must-fix, linking to Issues) with a confirm dialog (repo, path, warnings) → "Push update to PR #n" when open; **status chip** (Not submitted · In review PR #n checks/review · changes since submitting · Approved vN by @x · Rejected) + **Approval** rail panel (PR link, checks, push history, refresh, withdraw, "merged with changes made outside Canvas").
- Project page badges; `useSubmission` polls every 60s while a PR is open and the tab is visible.

### Validator CLI + workflow (Phase 3)
`packages/diagram-core-cli` (private) → esbuild single-file `validator.mjs` (no deps; keep icon libraries out), shipped in the API image and **committed by Canvas to `.canvas/validator.mjs`** when it changes (no npm publish needed). `node .canvas/validator.mjs --format github --render-dir rendered`: finds `canvas.json` manifests, parses `.canvas.mmd`, validates against the referenced standard, GitHub annotations + step summary, renders SVGs, exits 1 on parse errors/Must-fix. Example workflow (`examples/canvas-diagrams.yml`, from `docs/github_ci.yml`'s pattern: validate job + "Architecture gate", no `paths:`, pinned SHAs). Canvas never commits workflows. Advise CODEOWNERS on the folder + `.canvas/`.

### Infra
`apiapp.bicep`: `githubAppId`, `githubApiUrl` params; KV secret `github-app-private-key`; env vars. New `modules/githubsyncjob.bicep` (Schedule `*/15 * * * *`, modelled on `seedjob.bicep`), conditional on `githubAppId`. `deploy.sh`: `CANVAS_GITHUB_APP_ID`, `CANVAS_GITHUB_APP_PRIVATE_KEY_FILE` cached in `.secrets/` (key base64), KV write + reference refresh. `pause.sh`/`resume.sh` suspend/resume the job. App permissions: Contents RW, Pull requests RW, Checks R, Commit statuses R, Metadata R; webhook off; selected repos.

### Docs
`docs/admin-guide/github.md` (create + install the App, deploy vars, linking, workflow + branch protection on "Architecture gate", CODEOWNERS, don't edit generated files), `docs/user-guide/submitting-for-approval.md` (+ editor.md), RUNBOOK (key rotation, run sync manually, troubleshooting, live checklist), infra README, solution architecture doc, CLAUDE.md.

## Phases (each its own bead/PR, filed under canvas-3s5 as an epic)
1. **Link + submit** — confirm org IP allow-list; config/auth/client, folder-path, submission-files, migrations, link routes + admin page, submit route + button + basic chip, `stripFrontMatter`, audit, fake GitHub server, infra for the key, setup + submit docs.
2. **Status + approval** — sync service, refresh, scheduled job, merged/closed/review/check display, approval panel + push history, project badges, withdraw, move/unlink rules.
3. **CI validator** — CLI package + bundle, Docker/CI build, committed `.canvas/validator.mjs`, example workflow + download, CI docs.
4. **Hardening + live check** — real sandbox org/repo run (RUNBOOK checklist), ETag caching / rate-limit backoff, screenshots.

## Verification
- **Fake GitHub server** (`apps/api/tests/helpers/fake-github.ts`, real `node:http`, verifies App JWTs with a test key via `jose`): contract tests on both engines for linking (admin-only, installed repos only, test checklist), submit (unlinked 409, Must-fix 422, view-only 403, branch/commit/PR/file set, co-author trailer, resubmit = same PR, unchanged = upToDate, concurrent = one 409, moved = 409), sync (review/check states, merged → approved, head mismatch flagged, closed → rejected, access lost → needs attention, throttle).
- Unit: JWT + token cache, folder-path traversal, file builder (front-matter stripped, lossless source, escaping, truncation, blob SHA), diagram-core `stripFrontMatter` contract tests (written first).
- CLI: fixtures for all six families, exit codes, annotations, render dir; run the **built bundle**.
- E2E (`apps/web/tests/e2e/github-submit.spec.ts`) against the fake as a standalone process: link → submit → In review → edit → changes since submitting → fake merge → Approved.
- Phase 4 live check against a real sandbox org/repo with the example workflow and branch protection.
