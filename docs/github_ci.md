> **Background notes, not requirements.** Ideas gathered while planning GitHub approval (canvas-3s5). What was built is described in [github-approval-design.md](github-approval-design.md) and [admin-guide/github.md](admin-guide/github.md).

I'll write the workflow as a file you can drop into `.github/workflows/`.

The workflow is in `architecture-ci.yml`. Save it as `.github/workflows/architecture-ci.yml`.

It runs six parallel jobs, then one aggregate job:

- **validate:** lint, `tsc`, and the Vitest schema and graph-integrity tests.
- **status-transitions:** diffs ADR and spec frontmatter against the base branch to enforce the status rules, such as no editing accepted ADRs. This runs on PRs only.
- **diagrams:** generates views from the typed model and checks that they render. The rendered output is uploaded as an artifact so reviewers can see the diagrams.
- **fitness:** `dependency-cruiser` checks that the code conforms to the model.
- **api-contract:** `oasdiff` fails the PR on breaking OpenAPI changes against the base.
- **docs-build:** builds the docs site, with a preview artifact on PRs and a Pages artifact on `main`.
- **gate:** the single required check, which passes only if none of the jobs above failed or were cancelled.

Publishing to GitHub Pages is a separate job that runs only on pushes to `main`, after the gate passes. Readers therefore only ever see accepted state.

To set it up:

1. **Branch protection:** require only the "Architecture gate" check, and enable the merge queue if you want it. The `merge_group` trigger is already included.
2. **Scripts:** the workflow calls `pnpm` scripts (`lint`, `typecheck`, `test`, `check:status-transitions`, `generate:views`, `check:views`, `depcruise`, `docs:build`), so the real logic stays in the repo and runs the same locally and in CI.
3. **Placeholders:** the OpenAPI path (`specs/api/openapi.yaml`) and the docs output directory (`docs/.vitepress/dist`) are placeholders to adjust.
4. **No `paths:` filters:** a required check skipped by a path filter never reports, which leaves PRs blocked.
5. **Action pinning:** pin third-party actions to commit SHAs once this is stable. They are on major version tags for readability.

The `check:status-transitions` script is the piece that needs the most custom code. I can sketch it in TypeScript next, or add a CODEOWNERS file and a Dependabot config for the workspace.