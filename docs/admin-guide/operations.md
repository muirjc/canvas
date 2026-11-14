# Operations

Running Canvas itself is covered in the repository's **[RUNBOOK](../../RUNBOOK.md)** and
**[Azure deployment README](../../infra/azure/README.md)**. They're written for whoever runs the
environment. The tasks an admin is most likely to need:

| Task | Where |
|---|---|
| Deploy a new version, pause and resume the environment | `infra/azure/README.md` |
| Add a network to the **IP allow-list** (someone can't reach the site) | RUNBOOK → "Azure IP allow-list" |
| Switch between **Entra** and **Canvas accounts** | RUNBOOK → "Local accounts" → "Choosing a mode" |
| Set up the **first admin** of a Canvas-accounts environment | RUNBOOK → "Local accounts" → "Setting up" |
| **The only admin is locked out**: `reset-admin.sh` | RUNBOOK → "A lone admin who can't sign in" |
| The encryption key for two-step verification | RUNBOOK → "Rotating the MFA key" (don't rotate it routinely) |
| Entra app registration, roles and assignment | RUNBOOK → "Entra ID SSO" |
| Move Canvas to a newer **Mermaid version** | [Below](#moving-to-a-newer-mermaid-version) |

Each night (03:00 UTC) a clean-up job permanently removes diagrams and projects deleted more than 30
days ago, and unsaved new diagrams abandoned for more than a day. It doesn't run while Canvas is
paused.

When Canvas is **paused** to save costs, the site shows "Canvas is paused" until someone resumes it.

## Moving to a newer Mermaid version

Canvas doesn't run Mermaid. It has its own reader and writer for Mermaid's syntax, which follows one
Mermaid release, shown on the admin **Overview** page with what it doesn't read yet. GitHub draws
submitted diagrams with real Mermaid, at whatever version GitHub runs. Moving Canvas to a newer
Mermaid version is a code change, made by whoever develops Canvas:

1. **Read Mermaid's release notes** between the two versions. For each diagram type Canvas supports
   (flowchart, sequence, class, ER, C4, architecture, state), list new syntax, removed syntax, and changes
   in meaning. Changes to how Mermaid lays out or colours diagrams don't affect Canvas's own
   drawing, but they do change how exports look on GitHub.
2. **Keep reading the old forms.** A saved diagram is plain text, so it only breaks if Canvas stops
   reading something it used to read. Add new syntax; don't remove old syntax. If Mermaid itself
   drops a form, Canvas keeps reading it and writes the new form when the diagram is next saved.
3. **Add the support with tests first**: a parse and save round-trip test, a golden corpus case,
   and the same change in the Python copy of diagram-core (the server's), which the corpus and the
   comparison tests check.
4. **Check the export**: the e2e test `apps/web/tests/e2e/mermaid-export.spec.ts` draws every
   golden-corpus diagram's export in real Mermaid, at the version GitHub runs (the `mermaid`
   devDependency of `apps/web`). It fails when GitHub's recorded version and that devDependency
   differ, so move them together; it lists the few cases that can't draw and why.
5. **Run the dry-run report** with the new code, against the real diagrams, before the app is updated.
   It lists every saved diagram the new code can't open, and every one whose text it would write
   differently on the next save. "Can't open" must be zero before release. Rewrites are expected
   when the saved form changes on purpose; check a few by hand.
   - **On Azure:** from the new checkout, run `infra/azure/syntax-report.sh --build`. It builds that
     code's image, runs the `canvas-syntax-report` job with it against the Azure database (which is
     private to Canvas's Azure network, so it can't be reached from a laptop) and prints the report;
     it exits with an error when a diagram can't be opened. It changes no data. Then deploy as usual
     with `deploy.sh`, which reuses the image it built. (`--image <tag>` uses an image already built;
     no option reports with the image that's running now.)
   - **Locally:** `python -m canvas_api.jobs.syntax_report` against a local database that holds real
     diagrams (see the RUNBOOK's Jobs table).
6. **Update the recorded versions** in `packages/diagram-core/src/mermaid-version.ts`: the syntax
   version, the notes on what isn't read yet, and GitHub's version with the date you checked it (put
   a `mermaid` block containing `info` in a GitHub Markdown preview and it prints the version). A
   test pins these values, so the change is deliberate. When GitHub's version changes, update the
   `mermaid` devDependency of `apps/web` to the same version (step 4's test checks they match).
7. **Say what changed** in the release notes: new syntax people can use, and any diagram that will
   look different on GitHub.

If a future Mermaid change ever made old diagrams unreadable in a way Canvas can't keep supporting,
the report's list is the starting point: rewrite them in one go, or list them for their owners.
That hasn't been needed so far, so Canvas doesn't store a syntax version per diagram.
