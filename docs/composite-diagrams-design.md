# Composite diagrams

A composite diagram is a diagram whose parts are other diagrams (canvas-8uh1). Example: a C4 Context diagram's
Payments System opens the Payments Container diagram. Another: an overview flowchart has the login sequence
diagram drawn inside it.

Decided with the user (2026-11-13):

- **Both kinds, links first.**
  - **Drill-down links:** an element stands for another diagram and opens it.
  - **Embedded frames:** another diagram's drawing appears inside this one.
  - Links are built first and frames are a second phase. The model below makes room for both.
- **Always the latest saved version.** A link or frame shows the other diagram's latest saved version.
  - An export or a GitHub submission records which version that was at the time.
  - Nothing is pinned or copied.
- **Stored in Canvas front matter.** Mermaid has no include or embed syntax. Links and frames are kept in the
  `canvas:` front matter, like positions are, and work the same way in every family.
  - The portable export also writes a Mermaid `click` line where the family has one (flowchart, state).

Prior art:
- **Structurizr:** C4 zoom, where an element links to the diagram one level down.
- **draw.io:** links to other pages.
- **Miro and Lucid:** embedded frames.
- **Confluence:** the include macro.

Canvas follows Structurizr for links and Miro for frames.

## The model

**A link** is one field on an element, either a node or a group (container):

```ts
diagramRef?: { diagramId: string };
```

The front matter holds them by element id, for every family:

```yaml
---
canvas:
  links:
    PaymentsSystem: 7b0c…   # the linked diagram's id
---
```

- **What the reference is:** it names the diagram by id, never by title. Renaming or moving the inner diagram
  to another project doesn't break the link, and the editor always shows the current title.
- **Which elements can link:** any element in any family, and the inner diagram can be of any type: mixed
  families are allowed. The picker *suggests* the natural next level. For C4 that means Context → Container →
  Component → Code. A C4 System offers Container diagrams first.
- **Writing it back:** the writer keeps an element's link under the id the reader will give that element. Two
  families need care:
  - **Wardley maps:** a map element's id is its name, so a renamed element's link moves to the new name.
  - **Sequence diagrams:** they write no positions today. They and Wardley maps get front matter only when
    they have links or frames.
- **Editing:** a link is set and cleared with new pure edits, `setDiagramLink(model, elementId, diagramId |
  null)`, in TypeScript and Python. Live editing carries the field like any other element field.

**A frame** (phase 2) is drawn over the diagram, not written in the Mermaid body:

```yaml
canvas:
  frames:
    - id: f1
      diagramId: 9e1d…
      x: 400
      y: 80
      width: 360
      height: 240
```

- **Why not a node:** a frame can't be a node, because most families can't write an arbitrary node (a
  sequence diagram's nodes are participants, a Wardley map's are components).
- **What it does:** a frame has a place and a size. It can be moved, resized and selected like a group.
- **Connectors:** in phase 2 no connector ends on a frame. If that's wanted later, flowchart could also write a
  frame as a node.

## What is shown

**A linked element** carries a small "opens a diagram" badge with the inner diagram's title as its tooltip.
It opens from the badge (a click, or Enter on it), in edit and view-only modes alike. As built (canvas-8uh1.3),
Ctrl/Cmd-click stays "add to the selection", as everywhere else in the editor, rather than opening the link. A
**Links** tab in the editor lists every link with its state, and the diagrams that link here.

Opening it is an ordinary in-app navigation, so the unsaved-changes guard and the browser's Back button work as
they do today.
- **Breadcrumbs:** the editor shows how you got there, for example *Projects › Payments › Context › Payments
  System*. The trail lives in the browser history's state, not in the address, because a diagram can be linked
  from many others. A diagram opened directly shows the usual breadcrumb only.

**A frame** draws the inner diagram's latest saved version, scaled to fit, with its title on a header bar.
- **Drawing:** it is drawn by the same renderer as an export, as the canvas draws icons. It updates when the
  inner diagram is saved, by polling, as the notifications do.
- **Inside a frame:** you can't edit it there. **Open** goes to the inner diagram.
- **Depth:** frames inside a framed diagram are drawn one level deep only, so a cycle can't recurse. Deeper
  frames show as a titled placeholder box.

## Access, deletes and renames

Every signed-in person can already read every saved diagram (see `docs/sharing-design.md`, "Open, read-only").
A link or frame never shows anyone a diagram they couldn't open anyway.

Three states need handling, both for a link badge and a frame placeholder:

| Inner diagram | Shown |
|---|---|
| Someone else's unsaved draft | "Not available" |
| In the bin | "Deleted (in the bin)". Restoring the diagram repairs the link. |
| Purged | "Diagram no longer exists", with **Remove link**. |

- **Renames:** they need nothing, since references are ids.
- **Cycles:** a cycle of links (A links B links A) is fine, because each click is a navigation. A cycle of
  frames is cut off by the depth limit.
- **"Used in":** the API keeps an index of links and frames, rebuilt from the front matter on every save,
  restore and import. It drives:
  - a **Used in** list on each diagram, with clickable diagrams that link or embed it;
  - the delete prompt: "this diagram is used in 3 diagrams";
  - finding broken links after a purge.

## Exports and GitHub

**SVG and PNG:**
- A linked element is wrapped in `<a href>` to the inner diagram's Canvas address (`CANVAS_PUBLIC_URL`). The
  SVG renderer already does this for a flowchart node's link. In a PNG the link is lost.
- Frames are drawn in the export: the renderer gets the inner models through a resolver, as it gets icon
  artwork.

**Portable Mermaid (`.mmd`):**
- The front matter is left out, so links and frames disappear.
- Exceptions: a flowchart or state diagram gets `click X href "<Canvas address>"` for each linked node.
- A frame is not written at all; the export notes this in a `%%` comment.

**GitHub submission:**
- The lossless `.canvas.mmd` keeps the front matter.
- `canvas.json` records each link's and frame's diagram id and the version id it had at submission.
- The README lists the linked diagrams. A diagram submitted to the same repository folder gets a relative
  link; any other gets its Canvas address.
- The committed SVG is the export above, frames drawn.

## Standards, validation and AI

- **Validation:** each diagram is checked against its own type's standard, as today. Nothing is checked across
  levels.
- **New rule:** a standard may say that an element kind *should* link to a diagram of a given type. For
  example, a C4 Context's Software System links to a C4 Container diagram, as a Warning. Validation knows only
  that a link exists and the type it points to, which the API supplies.
- **AI chat:**
  - it gets a tool to link an element to a diagram, choosing from a list of the project's diagrams (id, title,
    type) given in the prompt;
  - `describe_model` says which elements link to what;
  - "Create the container diagram for this system" becomes possible later, as a separate feature.

## As built

All seven parts shipped (canvas-8uh1.1 to .7, PRs #366 to #372). Where the build differs from, or adds to, the
design above:

- **Opening a link:** from the badge (click or Enter), not Ctrl/Cmd-click, which stays "add to the selection".
  The Links tab and a frame's **Open** open them too.
- **Which elements link:** any shape or group, but a sequence diagram's participants only (its blocks' ids are
  made up when the text is read, so a link on one wouldn't last).
- **"Used in"** counts links and frames. The delete prompt names the diagrams that use the one being deleted
  (built in part 7). There is no admin report of broken links after a purge: each diagram's Links tab and badges
  show them.
- **Frames refresh** after each save and every 60 seconds while the page is visible (not through the
  notifications poll). Inner diagrams are drawn by the API with the export renderer and shown as images, so
  nothing in them runs. A frame inside a framed diagram is a titled placeholder ("Embedded diagram").
- **Live editing** carries frames as one field: if two people move different frames at the same moment, the last
  change wins for the whole list. Links are per element, like any other element field.
- **Standards:** an element kind's `linkTo` lists diagram types; rule `kind-link` (Warning) flags an element of the
  kind that links to nothing, or to a diagram of a type not listed. A link whose target can't be opened isn't
  judged by type. Element kinds classify shapes only, so groups aren't checked.
- **AI chat:** `linkToDiagram` is offered with the project's other saved diagrams (at most 100), and only in build
  mode. Its "new violations" feedback is keyed by element and rule, so linking an already-flagged element to the
  wrong type isn't reported as new; the AI still sees it in the prompt's list of current violations.
- **GitHub:** `canvas.json` gains `links` and `frames` (with each target's type and version) only when there are
  some, so a diagram without them submits exactly the same files as before. A linked diagram submitted (open or
  merged) to the same repository gets a relative README link.
- **Not built:** connectors ending on a frame, and "create the container diagram for this system" from the AI.

## Child beads

1. **Model and text:** `diagramRef` on nodes and groups, and `canvas.links` front matter in every family,
   TypeScript and Python. Includes `setDiagramLink`, corpus cases and the parity fuzz.
2. **API:** the links index (migration, rebuilt on save, restore and import, cleared on purge). Plus routes for
   outgoing links (title, type and state of each) and for "used in", and the delete prompt count.
3. **Editor, links:**
   - a link picker with search and suggested types, plus "new diagram for this element";
   - the badge and the ways to open a link;
   - breadcrumbs from history state;
   - the not-available, deleted and purged states;
   - the "Used in" list.
4. **Exports and GitHub, links:** SVG `<a>` links, portable `click` lines (flowchart, state), and `canvas.json`
   versions plus the README list.
5. **AI and standards, links:** the link tool, `describe_model` lines, and the "should link to" rule.
6. **Frames (phase 2):** `canvas.frames` front matter, drawing in the editor and in exports, moving and resizing,
   the depth limit and the placeholder states.
7. **Docs:** the user guide (a "Linked diagrams" section in the editor page, and frames when they ship) and the
   admin guide (the standards rule).
