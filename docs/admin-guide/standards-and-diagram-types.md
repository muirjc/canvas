# Standards and diagram types

**Admin → Standards** holds the rules diagrams are checked against, one standard per diagram type,
and the diagram types themselves.

![The Standards page](../images/admin-standards.png)

## What a standard says

A standard is a set of **element kinds**: the named things a diagram of that type is made of, such
as a value chain's *Primary Activity* or a C4 context's *Person* and *External System*. For each kind
you can set:
- **which shapes** it may use;
- **approved colours** (fill and outline swatches). People pick from these instead of any colour;
- **how many** a diagram must or may have (minimum and maximum). Once a diagram has the maximum (for
  example a *Max count* of 1 for "one Component per diagram"), the editor won't add another: the
  kind's button is greyed out and says why, and the AI is refused too. Typed or imported Mermaid can
  still go over, and is flagged as *Must fix*;
- **Kind groups** count several kinds together. Use one when a diagram may hold one thing that comes
  in variants: for example a group *Component* of *New Component*, *Reused Component* and *Retired
  Component* with a Max count of 1 means one Component in all, whichever variant. Give the group a
  name, tick its kinds (at least two) and set a minimum and/or maximum. A full group greys out every
  kind in it, the AI is refused too, and going over (or under) is flagged as *Must fix*. Each kind's
  own counts still apply;
- whether each one **must be connected** to something;
- for C4 types, **which C4 elements it applies to**: under *Applies to C4 elements*, the role
  (person, system, container or component) and whether it's the **External** (`_Ext`) variant. The
  role decides which shapes the kind can have: people are always the person shape; systems are
  rectangles, cylinders (databases) or stadiums (queues); containers and components are rounded
  rectangles, cylinders or stadiums. The editor only offers those, and won't save a kind whose shapes
  don't fit its role. Two kinds can share a role (elements drawn in the editor or by the AI are tagged
  with their kind), but an untagged element, such as one in imported Mermaid, counts as the first
  matching kind in the list;
- **connector rules**: which kinds may connect to which, and whether a connection needs a label.

### What authors can add

Besides its element kinds (always offered), a standard decides what else the editor and the AI
offer authors:
- **Generic shapes:** *All* the shapes the diagram family has, *Only these* (tick them), or *None*.
- **Icons:** *All of this type's libraries*, *Only these libraries* (tick them), or *None*. For
  architecture diagrams this includes the **Services** buttons (Mermaid's built-in Cloud, Database,
  Disk, Internet and Server).

With both set to *None*, authors can only add the standard's element kinds. That's how to make, say,
a Product Context Diagram offer just its own elements. Ticking **Every element must be one of these
kinds** (under Strictness) sets both to *None* for you. Shapes or icons that arrive another way,
such as typed or imported Mermaid, are flagged in the Issues tab.

Each rule has a **severity**: *Must fix*, *Warning* or *Info*. Standards never block anyone. They
shape what the editor and the AI offer, and flag the rest in the diagram's **Issues** tab.

![Editing a standard](../images/admin-standard-editor.png)

## Lifecycle

- **Draft:** being written; not applied yet. Edit it freely.
- **Published:** the active standard for its diagram type. Every diagram of that type is checked
  against it.
- **Retired:** an earlier published version, kept for reference.

Any version can be opened read-only. **Edit** on a published or retired version starts a new
version from it. **Publish**, then **Save and publish** to confirm, makes the new version active,
retires the old one and re-checks the diagrams. Publishing is blocked while the standard itself has
errors.

Each built-in type comes with a **starter standard**. It describes the type rather than restricting
it, and is a good base for your own.

In the built-in C4 Context, Container and Component standards, every element kind is set to **Must
be connected**: an element with no relationships is flagged as a Warning. You can ignore it, and it
never blocks submitting a diagram for approval. Built-in standards are only added to a diagram type
that has none yet, so an installation set up before this change keeps its existing standard. To get
the warning there, edit that standard, tick **Must be connected** on each element kind, under
**Strictness** set `kind-unconnected` to Warning (its default is Info), and choose **Save & publish**.

## Diagram types

Also on this page:
- **Built-in types** (flowchart, C4, sequence, ERD and so on): you can change their name, description
  and which personas see them. You can't change their underlying diagram family.
- **New diagram type:** add your own type that uses an existing family, with its own name and
  standard. For example, a *Customer Journey* built on flowchart, with its own element kinds.
- **Hide type:** takes a type out of the New Diagram, Create with AI and Import choices. Existing
  diagrams of that type keep working. **Show type** brings it back.
