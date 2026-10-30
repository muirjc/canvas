# Sharing and exporting

## Sharing a diagram

The **Share** button only appears once an admin has turned sharing on (it's off by default). With
it off, diagrams already shared with you still appear under **Shared with me**.

Click **Share** in the editor and start typing a colleague's name or email address. A list of
matching people appears: use the Up and Down arrow keys and Enter (or click) to pick one, and
press Escape to close the list. Then choose their access and click **Share**:

| Level | They can |
|---|---|
| **View** | Open and read the diagram (everyone signed in can already do this) |
| **Comment** | Read the diagram and add comments (see [Comments](editor.md#comments)) |
| **Edit** | Change it (and use its AI chat) |

Projects have a fourth level, **Manage**: Edit, plus deciding who else has access. A project's
owner always has Manage, and only the owner or someone with Manage can give or remove it.

Someone's access is the highest level they get from anywhere: the project, a share of the
diagram itself, or owning it. People with the **viewer** role never get more than Comment,
whatever they're given.

![Sharing a diagram](../images/share-dialog.png)

People who already have access are shown in the list as "has view access" (or comment/edit)
and can't be picked again; to change someone's level, revoke their access and share again. You
appear as "(you)". The list below the form shows each person who has access, with their name and email.

If the person you want isn't listed, type their full email address and press **Share** without
picking: Canvas looks up that exact address. They must already have a Canvas account (with
single sign-on, that means they have signed in at least once). The diagram then appears under **Shared with me** on their
project list. Access to a project covers all its diagrams; sharing a diagram is for giving someone
more access to that one diagram without the whole project.

You need **edit** access to share a diagram or remove someone's access; the **Share** button only
appears for people who have it. Anyone can see who has access.

## Exporting

**Export** in the editor downloads the diagram as:
- **Mermaid** (`.mmd`): the text, to use in other tools or documentation that renders Mermaid.
- **SVG**: a sharp, scalable picture for documents and wikis.
- **PNG**: an image.

![The Export menu](../images/export-menu.png)

Export always uses the **saved** diagram, so save first. The buttons are disabled while you have
unsaved changes.
