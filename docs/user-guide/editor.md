# The editor

Opening a diagram shows it on the **canvas** in the middle:
- **Left:** a rail of tools.
- **Right:** panels in tabs: **DSL**, **Chat**, **Issues**, **History**.
- **Top:** the diagram's name and the **Save**, **Share** and **Export** buttons.

![The editor](../images/editor.png)

**Save often.** The editor shows when you have unsaved changes. If you try to leave with unsaved
changes, it asks first.

## Drawing

- **Add a shape:** pick one under **Shapes** in the left rail. The shapes offered depend on the
  diagram type: a flowchart has rectangles, diamonds, circles and more; a C4 diagram has people,
  systems and containers; and so on.
- **Elements:** if your organisation has a **standard** for this diagram type, an **Elements** list
  offers its named element kinds (for example *Primary Activity* or *External System*), already
  shaped and coloured correctly. Use these when you can.
- **Move:** drag shapes. Shift- or Ctrl-click to select several, or drag a box around them.
- **Rename:** click the pencil next to a shape or connector and type.
- **Colour:** click the palette icon. If a standard applies, you choose from its approved colours.
- **Connect:** click **Connect**, then the first shape, then the second. While connecting you can
  choose the arrow direction (forward, reversed, both or none). Some types add more choices, such as
  cardinality for ERD and UML class diagrams.
- **Group:** **Add Container** draws a box (a subgraph, boundary or namespace, depending on the
  type). Select shapes and choose **Group into Container** to put them inside one.
- **Delete:** select something and press **Delete** or use **Delete Selected**. Canvas asks first.
- **Auto Layout** (flowcharts): arranges the shapes for you, top-down or left-to-right.

Sequence diagrams work differently: the layout follows the order of messages, so you don't drag.
The **Tools** section adds notes, loop/alt/opt blocks, activations and numbering.

## The DSL tab: the diagram as text

Every diagram is also Mermaid text. Edit either side and the other follows. Typing in the DSL tab
updates the canvas; drawing updates the text. If the text has an error, the tab shows the line.

## The Issues tab: standards

If a standard applies to the diagram type, the **Issues** tab lists where the diagram breaks it,
in three levels:
- **Must fix:** a rule the diagram has to meet.
- **Warning:** something to look at.
- **Info:** a suggestion.

Click an issue to select the shapes it's about. Issues never stop you saving. They show what to
fix.

![The Issues tab](../images/editor-issues.png)

## The History tab: versions

Each save makes a **version**. The History tab lists the last five, with their dates, and you can
search them. **Restore** brings an earlier version back as the current diagram.

![Version history](../images/version-history.png)

## Name and description

Click the diagram's name at the top to rename it. Its description, owner and creation date are
under **Diagram details**.
