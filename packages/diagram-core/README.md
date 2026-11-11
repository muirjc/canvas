# diagram-core

Canvas's diagram engine, as a plain TypeScript library with no UI and no server:

- **DSL**: parse and serialize Mermaid text for the flowchart, C4, architecture, sequence, ER, UML class and state families (`getDslFamily`, `detectDslFamily`).
- **Model**: the `DiagramModel` (nodes, edges, containers, legend) and the operations that edit it (`createEmptyDiagramModel`, `addNode`, `addEdge`, ...).
- **Layout**: `autoLayout`, using dagre.
- **Rendering**: `renderToSvg` and `toPortableMermaid`.
- **Standards**: `validate` a model against a standard's element kinds and connector rules.

Inside this repository it is the `@canvas/diagram-core` workspace. It is published to GitHub Packages as `@muirjc/diagram-core` (GitHub Packages requires the scope to match the repository owner). Releases are cut by pushing a `diagram-core-v<version>` tag; see `.github/workflows/publish-diagram-core.yml`.

## Installing it in another project

The package is private, so npm needs a GitHub token to read it. The token must be a classic personal access token with `read:packages`; GitHub Packages' npm registry doesn't accept fine-grained tokens.

`.npmrc` in the consuming project (safe to commit):

```
@muirjc:registry=https://npm.pkg.github.com
```

`~/.npmrc` on each machine (never commit this):

```
//npm.pkg.github.com/:_authToken=<token>
```

To keep the `@canvas/diagram-core` import name, install it under an alias:

```json
"dependencies": {
  "@canvas/diagram-core": "npm:@muirjc/diagram-core@0.2.0"
}
```

Before 1.0, a minor version can contain breaking changes. Pin an exact version and run your own tests when you move to a new one.
