# Submitting a diagram for approval

If your admin has linked a project to a GitHub repository, its diagrams can be sent there for
approval. Each submission opens a **pull request**, where reviewers comment and approve. Merging the
pull request approves the diagram, and closing it without merging rejects it.

You'll only see **Submit for approval** in the editor when the diagram's project is linked.

## Submitting

1. **Save** your changes first. Canvas submits the saved version, so the button is disabled while
   there are unsaved changes.
2. Choose **Submit for approval**. The dialog shows the repository and folder the diagram goes to,
   and how many standard warnings will be listed in the pull request.
3. Confirm. Canvas opens the pull request and links to it.

You need **edit** access to the diagram to submit it.

**Must fix issues block submitting.** If the diagram breaks a rule that its standard marks as Must
fix, fix it first. The **Issues** tab lists the problems. Warnings and info don't block, but they are
listed in the pull request so reviewers can see them.

## Changing a diagram under review

You can keep editing while the pull request is open. The status next to the button changes to
**Changes since submitting**. When you're ready, choose **Push update to PR #n**. Canvas adds your
saved changes to the same pull request, so reviewers see what changed. If nothing has changed since
the last submission, Canvas tells you it's already up to date.

## The status

| Status | Meaning |
|---|---|
| Not submitted | The diagram has never been submitted |
| In review · PR #n | The pull request is open |
| Changes since submitting | You've saved changes that aren't in the pull request yet |
| Approved | The pull request was merged |
| Rejected | The pull request was closed without merging |

Once a diagram is approved or rejected, submitting it again opens a new pull request.

For now, Canvas finds out that a pull request was merged or closed the next time the diagram is
submitted. Automatic status updates are coming in a later release.

Edit diagrams in Canvas, not in GitHub. Changes made in the repository aren't copied back.
