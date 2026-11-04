import { useEffect, useState } from 'react';
import { api } from '../app/api';

/** An Entra group a share can name (canvas-2h2w.3). */
export interface PickerGroup {
  kind: 'group';
  id: string;
  name: string;
}

/** Whether this deployment lets people share with Entra groups (`groupsEnabled` in /auth/config). */
export function useGroupsEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .getAuthConfig()
      .then((config) => {
        if (live) setEnabled(config.groupsEnabled === true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}

export const GROUPS_HINT = 'People in a group get access at their next Microsoft sign-in.';
