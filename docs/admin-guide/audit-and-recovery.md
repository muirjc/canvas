# Audit log and recovery

## The audit log

**Admin → Audit log** records, newest first:
- sign-ins, and failed sign-ins with the reason (wrong password, wrong code, locked, deactivated,
  unknown email);
- lockouts and unlocks;
- password changes and resets;
- two-step verification set-ups and resets;
- every change an admin makes to users: created, updated, deleted;
- changes to AI model prices.

Each entry shows **when**, **what**, **who did it**, **who it was about**, and from which **network
address**. Passwords and codes are never recorded. Use **View activity** on a person (Users page) to
see only their entries, and **Load older** to go further back.

![The audit log](../images/admin-audit-log.png)

## Restoring deleted work

Deleting a diagram or a project moves it to a bin for **30 days**:
- **Admin → Deleted Diagrams** and **Deleted Projects** list them.
- **Restore** brings one back. After 30 days it can no longer be restored.

![Deleted diagrams](../images/admin-deleted-diagrams.png)

A project can only be deleted once it has no diagrams.

An AI drawing its author never saved (Create with AI, then **Discard and leave**) isn't in the bin:
it was never saved, so it is deleted outright. Admins can't see other people's unsaved AI drawings,
and any left behind by a closed tab are removed by the purge after 24 hours.
