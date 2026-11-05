import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersPage } from '../../src/admin/UsersPage';
import { api } from '../../src/app/api';

/** canvas-hl75: changing your own role must reload (the server signed you out), even when the page's own
 *  "who am I" request has not answered yet. */
const ME = 'user-me';
const OTHER = 'user-other';

function userRecord(id: string, name: string) {
  return { id, name, email: `${name}@example.com`, role: 'viewer', active: true, personas: [], mfaEnabled: false, locked: false };
}

describe('UsersPage role change', () => {
  const reload = vi.fn();
  let listAdminUsers: ReturnType<typeof vi.spyOn>;
  let updateAdminUser: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(api, 'getAuthConfig').mockResolvedValue({ localAuthEnabled: false, authMode: 'local' } as never);
    listAdminUsers = vi
      .spyOn(api, 'listAdminUsers')
      .mockResolvedValue({ users: [userRecord(ME, 'Me'), userRecord(OTHER, 'Other')] } as never);
    updateAdminUser = vi.spyOn(api, 'updateAdminUser').mockResolvedValue({} as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** The page's own load of me() never answers; any later call gets `later`. */
  function meAnswersOnlyLater(later: () => Promise<never>) {
    const me = vi.spyOn(api, 'me');
    me.mockImplementationOnce(() => new Promise(() => {}));
    me.mockImplementation(later);
  }

  async function changeRole(id: string) {
    const select = await screen.findByTestId(`user-role-${id}`);
    fireEvent.change(select, { target: { value: 'admin' } });
  }

  it('reloads on a change to your own role even though the page\'s me() has not answered', async () => {
    meAnswersOnlyLater(() => Promise.resolve({ user: { id: ME } } as never));
    render(<UsersPage />);
    await changeRole(ME);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(updateAdminUser).toHaveBeenCalledWith(ME, { role: 'admin' });
    expect(listAdminUsers).toHaveBeenCalledTimes(1);
  });

  it('does not reload on a change to someone else\'s role, and refreshes the list', async () => {
    meAnswersOnlyLater(() => Promise.resolve({ user: { id: ME } } as never));
    render(<UsersPage />);
    await changeRole(OTHER);
    await waitFor(() => expect(listAdminUsers).toHaveBeenCalledTimes(2));
    expect(updateAdminUser).toHaveBeenCalledWith(OTHER, { role: 'admin' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload, and does not throw, when me() fails', async () => {
    meAnswersOnlyLater(() => Promise.reject(new Error('offline')));
    render(<UsersPage />);
    await changeRole(ME);
    await waitFor(() => expect(listAdminUsers).toHaveBeenCalledTimes(2));
    expect(updateAdminUser).toHaveBeenCalledWith(ME, { role: 'admin' });
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('user-update-error')).toBeNull();
  });
});
