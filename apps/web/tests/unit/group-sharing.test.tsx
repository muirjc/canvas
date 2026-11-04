import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/app/api';
import { MembersDialog } from '../../src/projects/MembersDialog';
import { ShareDialog } from '../../src/projects/ShareDialog';

const config = (groupsEnabled: boolean) => ({ authMode: 'entra' as const, oidcEnabled: true, localAuthEnabled: true, groupsEnabled });

function mockApi(groupsEnabled: boolean) {
  vi.spyOn(api, 'getAuthConfig').mockResolvedValue(config(groupsEnabled));
  vi.spyOn(api, 'searchUsers').mockResolvedValue({ users: [{ id: 'u1', name: 'Gail Person', email: 'gail@x.io' }] });
  const searchGroups = vi.spyOn(api, 'searchGroups').mockResolvedValue({ groups: [{ id: 'g1', displayName: 'Gail Guild' }] });
  return { searchGroups };
}

const grant = {
  id: 'gr1', subjectType: 'diagram' as const, subjectId: 'd1', granteeUserId: null, granteeGroupId: 'g9',
  granteeName: 'Architects', granteeEmail: null, accessLevel: 'comment' as const, grantedByUserId: 'u0', createdAt: '',
};

async function typeInto(testId: string, text: string) {
  fireEvent.change(await screen.findByTestId(testId), { target: { value: text } });
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ||= function () {};
  HTMLDialogElement.prototype.close ||= function () {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ShareDialog with groups', () => {
  it('offers groups beside people, and shares with the picked group', async () => {
    mockApi(true);
    vi.spyOn(api, 'listDiagramShares').mockResolvedValue({ grants: [grant] });
    const create = vi.spyOn(api, 'createDiagramShare').mockResolvedValue({ grant } as never);
    render(<ShareDialog diagramId="d1" currentUserId="me" onClose={() => undefined} />);
    expect(await screen.findByTestId('share-groups-hint')).toBeTruthy();
    await typeInto('share-email', 'gail');
    expect(await screen.findByTestId('share-user-option-u1')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('share-group-option-g1'));
    fireEvent.click(screen.getByTestId('confirm-share'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('d1', { groupId: 'g1' }, 'view'));
  });

  it('lists a group grant with its name and Group label, and revokes it', async () => {
    mockApi(true);
    vi.spyOn(api, 'listDiagramShares').mockResolvedValue({ grants: [grant] });
    const revoke = vi.spyOn(api, 'revokeShare').mockResolvedValue(undefined as never);
    render(<ShareDialog diagramId="d1" currentUserId="me" onClose={() => undefined} />);
    const row = await screen.findByTestId('share-grant-group-g9');
    expect(row.textContent).toContain('Architects');
    expect(row.textContent).toContain('Group');
    fireEvent.click(screen.getByTestId('revoke-share-group-g9'));
    expect(revoke).toHaveBeenCalledWith('gr1');
  });

  it('is unchanged when groups are off: no group search, no hint', async () => {
    const { searchGroups } = mockApi(false);
    vi.spyOn(api, 'listDiagramShares').mockResolvedValue({ grants: [] });
    render(<ShareDialog diagramId="d1" currentUserId="me" onClose={() => undefined} />);
    await typeInto('share-email', 'gail');
    expect(await screen.findByTestId('share-user-option-u1')).toBeTruthy();
    expect(searchGroups).not.toHaveBeenCalled();
    expect(screen.queryByTestId('share-groups-hint')).toBeNull();
    expect(screen.queryByTestId('share-group-option-g1')).toBeNull();
  });

  it('still shows people when Microsoft cannot be reached', async () => {
    mockApi(true);
    vi.spyOn(api, 'searchGroups').mockRejectedValue(new Error('503'));
    vi.spyOn(api, 'listDiagramShares').mockResolvedValue({ grants: [] });
    render(<ShareDialog diagramId="d1" currentUserId="me" onClose={() => undefined} />);
    await typeInto('share-email', 'gail');
    expect(await screen.findByTestId('share-user-option-u1')).toBeTruthy();
    expect((await screen.findByTestId('share-groups-error')).textContent).toContain("Couldn't load groups from Microsoft");
  });
});

describe('MembersDialog with groups', () => {
  const members = {
    owner: { id: 'o1', name: 'Olive', email: 'o@x.io' },
    members: [
      { grantId: 'm1', userId: 'u5', groupId: null, name: 'Pat', email: 'pat@x.io', accessLevel: 'edit' as const },
      { grantId: 'm2', userId: null, groupId: 'g9', name: 'Architects', email: null, accessLevel: 'comment' as const },
    ],
    yourAccess: 'manage' as const,
  };

  it('shows a group member, changes its level, never offers Make owner for it', async () => {
    mockApi(true);
    vi.spyOn(api, 'getProjectMembers').mockResolvedValue(members);
    const set = vi.spyOn(api, 'setProjectMember').mockResolvedValue({ grant } as never);
    render(<MembersDialog projectId="p1" projectName="P" currentUser={{ id: 'o1', role: 'architect' }} onClose={() => undefined} onAccessChanged={() => undefined} />);
    const row = await screen.findByTestId('member-group-g9');
    expect(row.textContent).toContain('Architects');
    expect(row.textContent).toContain('Group');
    expect(screen.queryByTestId('member-make-owner-group-g9')).toBeNull();
    expect(screen.getByTestId('member-make-owner-u5')).toBeTruthy();
    fireEvent.change(screen.getByTestId('member-level-group-g9'), { target: { value: 'edit' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('p1', { groupId: 'g9' }, 'edit'));
  });

  it('adds a picked group', async () => {
    mockApi(true);
    vi.spyOn(api, 'getProjectMembers').mockResolvedValue({ ...members, members: [] });
    const set = vi.spyOn(api, 'setProjectMember').mockResolvedValue({ grant } as never);
    render(<MembersDialog projectId="p1" projectName="P" currentUser={{ id: 'o1', role: 'architect' }} onClose={() => undefined} onAccessChanged={() => undefined} />);
    await typeInto('member-email', 'gail');
    fireEvent.click(await screen.findByTestId('member-group-option-g1'));
    fireEvent.click(screen.getByTestId('member-add'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('p1', { groupId: 'g1' }, 'edit'));
  });
});
