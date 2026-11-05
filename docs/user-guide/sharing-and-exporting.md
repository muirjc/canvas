# Sharing and exporting

Everyone who signs in can read every project and diagram. Sharing gives people **more** than that:
the right to comment, change things, or manage who else can.

## Project members

Most sharing happens on a project: its members see all its diagrams at their level. Click
**Members** on a project's page to see who owns the project and who has been added.

The owner, members with **Manage**, and admins can:
- **add someone:** type their name or email, pick them, choose **Comment**, **Edit** or **Manage**,
  and click **Add**;
- **change someone's level** with the list next to their name;
- **remove someone**;
- **Make owner** (owner and admins only): hands the project to that member. You stay on as a
  member with Manage. To hand it to someone who isn't a member yet, add them first.

Everyone else sees the list but can't change it. Each change is recorded in the admin audit log.

## Sharing with a group

If your organisation signs in with Microsoft and your admin has turned group sharing on, the
**Members** and **Share** pickers also list **groups**, marked with a group icon and "Group". Pick a
group instead of a person, choose a level and add it. Everyone in the group then gets that access.

- Only groups your admin has made available to Canvas appear. If a group you need is missing, ask
  your admin.
- People get the access **the next time they sign in with Microsoft**. If someone leaves the group,
  they lose it at their next sign-in.
- A group share doesn't send notifications: Canvas only knows the group members who have already
  signed in.
- You can change a group's level or remove it from the list, just as for a person. A group can't
  become a project's owner.

## Copying a link

**Copy link** (in the editor, and on a project's page) copies the address of that diagram or
project. Anyone who signs in can open it; it doesn't give them any extra access.

## Sharing a single diagram

To give someone more access to just one diagram, rather than the whole project, use **Share** in
the editor. The **Share** button only appears once an admin has turned sharing on (it's off by default). With
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

## Notifications

The bell in the header tells you when someone adds you to a project, shares a diagram with you, changes or removes your access, or makes you an owner. A number on the bell shows how many you haven't read.

Select the bell to see them, newest first. Select one to open the project or diagram. You can also choose **Mark all as read**. A notification about removed access has nothing to open.

A diagram that was shared with you, or whose access changed, shows a **New** tag in **Shared with me** until you open it.

Canvas keeps notifications for 90 days. It doesn't send email about this yet.

## Exporting

**Export** in the editor downloads the diagram as:
- **Mermaid** (`.mmd`): the text, to use in other tools or documentation that renders Mermaid.
  Colours are written so other tools can show them where Mermaid allows (see
  [What reviewers see on GitHub](submitting-for-approval.md#what-reviewers-see-on-github)). Other
  tools arrange the shapes themselves. In an architecture diagram, Mermaid needs to know which side
  of each shape a connector leaves and joins: where you didn't choose one, the export uses the side
  facing the other shape. Mermaid allows one connector each way between two shapes, so any extra
  ones are left out of the file (they stay in your diagram). The export also adjusts a few other
  things Canvas reads but Mermaid doesn't: C4 layout hints (`Lay_R` and the like) and empty
  boundaries or namespaces are left out, ER relationship labels are quoted, a flowchart's title
  moves to the file's front matter, and a sequence note over three or more participants spans the
  first to the last. Your diagram itself is unchanged.
- **SVG**: a sharp, scalable picture for documents and wikis.
- **PNG**: an image. Its text is drawn in Liberation Sans, so it can look slightly different from the editor, which uses your system's font.

![The Export menu](../images/export-menu.png)

Export always uses the **saved** diagram, so save first. The buttons are disabled while you have
unsaved changes.
