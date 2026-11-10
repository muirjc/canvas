# Live editing

When several people have the same diagram open, each sees the others' changes as they happen (canvas-vvi).

Decided with the user (2026-11-10):

- **Changes merge element by element.** A change carries only the fields of the shapes, connectors and groups it
  touched. Two people changing different elements, or different fields of one element (one moves a shape while
  the other renames it), both keep their change. When both change the same field at once, the later one wins.
- **Anyone's Save saves for everyone.** The Save button stays. Everyone has the same diagram, so one person's
  Save clears "Not saved" for all, with no conflict dialog between people in the same session.
- **Viewers watch live.** People who can only view or comment see changes as they happen. Only people with edit
  access can make them.

## How it works

```
browser A ──patch──▶ ┌──────────── API (one process) ────────────┐ ──patch (seq 7)──▶ browser A (its ack)
                     │ room for diagram D                        │ ──patch (seq 7)──▶ browser B
browser B ──patch──▶ │  live model · seq · version last saved    │ ──patch (seq 8)──▶ browser A, B
                     └───────────────────────────────────────────┘
```

- **The change format** is `ModelPatch` (`packages/diagram-core/src/live/model-patch.ts`):
  - `diffModels(a, b)` lists the top-level fields set or removed, and for nodes, edges and containers: elements
    added, removed or changed (fields set / removed), and the new order when it changed;
  - `applyPatch` applies one. A change to an element that's gone is dropped (the delete wins);
  - Python's `diagram_core/live_patch.py` applies patches exactly as TypeScript does (held to it by vectors) and
    checks a patch's shape.
- **One room per open diagram**, in the API's memory (`canvas_api/live/hub.py`). The first person to open it
  loads the saved version; the room is dropped when the last one leaves, and its unsaved changes go with it, as an
  unsaved tab's do. People who join later get the room's live model, not the saved text: reading the text back
  would renumber the connectors (`e1`, `e2`, …), and everyone's patches name them by id.
- **Order.** The room applies patches in the order they arrive and gives each a sequence number. Every browser
  applies the same patches in the same order. A browser shows the room's model with its own not-yet-acknowledged
  patches on top; when someone else's patch arrives, it applies that one and puts its own back on top. So
  everyone ends on the same model.
- **Checking a patch.** The server applies a patch only if:
  - its shape is right;
  - the patched model still writes and reads back as Mermaid;
  - every web address in it (`href`, `url`, `img`, `src`) is one the parser accepts.

  A patch that fails goes back to its sender as `rejected` and reaches no one else. The check runs at most every
  100 ms per room, on everything that arrived meanwhile (a drag sends about 20 patches a second).
- **Saving** is the usual `PATCH /diagrams/{id}` (compare-and-set on the version). Once a save commits, the room
  is told:
  - a save from the room's own version is everyone's save (`saved`);
  - a restore, or a save from somewhere else, replaces the live model (`reset`).
- **Deleting** the diagram ends the session (`closed`, 4404).

## The connection

`WS /diagrams/{id}/live`, JSON messages. A WebSocket passes by the HTTP middleware, so the route itself checks,
in order:

1. **Origin:** one of `WEB_ORIGINS`, or this server's own host. Otherwise the server refuses it (1008).
2. **Paused:** closes with 1013 while the environment is paused.
3. **Session cookie:** a signed-in session with no unfinished sign-in step (password change, two-step set-up).
   Otherwise it closes with 4401.
4. **Access to the diagram:** view at least (4404 when missing, in the bin or someone else's draft). Edit access
   decides whether the person may send patches.

While messages arrive, the session and access are checked again at least once a minute. The editor pings every
25 s, so a sign-out or a removed share is noticed within a minute:
- a sign-out closes the connection (4401);
- a share lowered below edit turns the person into a watcher.

| From | Message | Meaning |
|---|---|---|
| server | `hello {seq, model, baseVersionId, you, people}` | The room's live model and who is here. `you` is this connection: `{connectionId, userId, name, canEdit, since, selection}`. |
| client | `patch {clientPatchId, patch}` | A change (edit access only). `clientPatchId` is the client's own id for it. |
| server | `patch {seq, by, clientPatchId, patch}` | A change everyone applies. `by` is the sender's `connectionId`; the sender takes it as acknowledgement. |
| server | `rejected {clientPatchId, message}` | Your change wasn't applied; drop it and show the room's model again. |
| server | `saved {seq, versionId, by, at, dsl}` | Someone in the room saved: the version to save from next, and the text that was saved. |
| server | `reset {seq, model, baseVersionId, by, reason}` | The live model was replaced (`reason`: `restored`, `saved-elsewhere`). Drop unacknowledged changes. |
| server | `people {people}` | Who is here now (on every join, leave or access change). Each person carries `selection` (ids). |
| client | `select {ids}` | What this person has selected (anyone, watchers too: they select to comment). At most 500 ids. |
| server | `selection {connectionId, ids}` | Someone else's selection changed. The editor outlines it in their colour (`personColor(userId)`). |
| server | `closed {code, reason}` | Sent just before the server closes the connection. |
| client | `ping` | Every 25 s. The server answers `pong`. |

Close codes:

| Code | Reason |
|---|---|
| 1008 | Origin not allowed |
| 1009 | Message over 1 MB |
| 1013 | Paused |
| 4400 | Not a message |
| 4401 | Not signed in, or signed out |
| 4403 | No access |
| 4404 | Diagram missing or deleted |

## Limits

- **One API process.** Rooms live in memory, so Canvas must run one replica (Azure: `maxReplicas: 1`, as today).
  More replicas would need the rooms shared, for example through Postgres LISTEN/NOTIFY.
- **Connections drop** when the API restarts or scales to zero (a deploy, an idle night). The editor reconnects,
  and a room with nobody left has lost its unsaved changes.
- **No undo** (the editor has none yet).
