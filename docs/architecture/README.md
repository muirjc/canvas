# Canvas architecture, as Canvas diagrams

Canvas documented with its own diagram types. Each file is Mermaid text that Canvas reads: import it
(**Import** on a project page, or paste it into a new diagram's **DSL** tab) and run **Auto Layout**. GitHub
and other Mermaid tools draw them too. A test (`packages/diagram-core/tests/contract/architecture-docs.test.ts`)
reads every file with Canvas's own parser, so a file that stops parsing fails the build. Keep them in step
with the code when the architecture changes.

| File | Type | Shows |
|---|---|---|
| [c4-context.mmd](c4-context.mmd) | C4 Context | Who uses Canvas and the outside systems it talks to |
| [c4-container.mmd](c4-container.mmd) | C4 Container | Web app, API, database, jobs, Key Vault |
| [c4-component.mmd](c4-component.mmd) | C4 Component | The parts of the API (`apps/api-py`) |
| [azure-deployment.mmd](azure-deployment.mmd) | C4 Deployment | What `infra/azure` deploys |
| [erd.mmd](erd.mmd) | ER | The main tables and how they relate |
| [diagram-core-model.mmd](diagram-core-model.mmd) | UML class | diagram-core's model and standard rules |
| [sequence-sign-in.mmd](sequence-sign-in.mmd) | Sequence | Signing in with two-step verification |
| [sequence-save.mmd](sequence-save.mmd) | Sequence | Saving with the compare-and-set conflict check |
| [sequence-ai-chat.mmd](sequence-ai-chat.mmd) | Sequence | One AI chat turn |
| [sequence-github-approval.mmd](sequence-github-approval.mmd) | Sequence | Submitting for approval on GitHub, and the status sync |
| [flowchart-validation.mmd](flowchart-validation.mmd) | Flowchart | Checking a diagram against its standard |
| [flowchart-auto-layout.mmd](flowchart-auto-layout.mmd) | Flowchart | How Auto Layout arranges a diagram |
| [flowchart-purge.mmd](flowchart-purge.mmd) | Flowchart | The nightly clean-up job |
| [state-diagram-lifecycle.mmd](state-diagram-lifecycle.mmd) | State | A diagram from draft to purged, and its GitHub review |
| [state-standard-lifecycle.mmd](state-standard-lifecycle.mmd) | State | A standard's versions |
| [state-github-submission.mmd](state-github-submission.mmd) | State | A pull request's life |
| [state-user-account.mmd](state-user-account.mmd) | State | A Canvas account (local sign-in) |
