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

Each night (03:00 UTC) a clean-up job permanently removes diagrams and projects deleted more than 30
days ago, and unsaved new diagrams abandoned for more than a day. It doesn't run while Canvas is
paused.

When Canvas is **paused** to save costs, the site shows "Canvas is paused" until someone resumes it.
