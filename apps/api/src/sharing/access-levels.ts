/**
 * canvas-2h2w.1: the four access levels and how they combine (docs/sharing-design.md, "Effective
 * access"). A person's access is the HIGHEST level any source gives them -- open read, project
 * membership, a diagram share, ownership, admin -- then capped by their global role.
 */
export type AccessLevel = 'view' | 'comment' | 'edit' | 'manage';

const ACCESS_RANK: Record<AccessLevel, number> = { view: 1, comment: 2, edit: 3, manage: 4 };

export function accessAtLeast(level: AccessLevel | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return ACCESS_RANK[level] >= ACCESS_RANK[required];
}

/** The highest of the given levels (undefined entries ignored). */
export function highestAccess(...levels: (AccessLevel | undefined | null)[]): AccessLevel | undefined {
  let best: AccessLevel | undefined;
  for (const level of levels) {
    if (level && (!best || ACCESS_RANK[level] > ACCESS_RANK[best])) best = level;
  }
  return best;
}

/** Decided 2026-10-29: the global `viewer` role never gets more than Comment, whatever it is granted. */
export const VIEWER_ROLE_CAP: AccessLevel = 'comment';

export function capForRole(level: AccessLevel | undefined, role: string | undefined): AccessLevel | undefined {
  if (!level || role !== 'viewer') return level;
  return ACCESS_RANK[level] > ACCESS_RANK[VIEWER_ROLE_CAP] ? VIEWER_ROLE_CAP : level;
}
