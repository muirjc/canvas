import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { api, ApiError } from '../../src/app/api';
import { AppShell } from '../../src/app/AppShell';
import { isPaused, resetPausedForTests } from '../../src/app/paused';

// canvas-mqk0: a tab that finds Canvas paused stops calling it, so the paused app can scale to zero.
describe('a paused Canvas', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetPausedForTests();
  });

  const pausedReply = () =>
    new Response(JSON.stringify({ error: 'Canvas is paused. Ask your admin to resume it.', code: 'paused' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

  it('stops every later request once the server says it is paused', async () => {
    const fetch = vi.fn(async () => pausedReply());
    vi.stubGlobal('fetch', fetch);
    await expect(api.listProjects()).rejects.toMatchObject({ status: 503, code: 'paused' });
    expect(isPaused()).toBe(true);

    await expect(api.getAppSettings()).rejects.toBeInstanceOf(ApiError);
    await expect(api.listProjects({ scope: 'mine' })).rejects.toMatchObject({ code: 'paused' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps going after any other 503', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.listProjects()).rejects.toMatchObject({ status: 503 });
    await expect(api.listProjects()).rejects.toMatchObject({ status: 503 });
    expect(isPaused()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('says so on every screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pausedReply()));
    const user = { id: 'u1', email: 'a@example.com', name: 'A', role: 'architect' };
    render(
      <AppShell user={user} onSignOut={() => undefined} currentSection={null} projectsHref="" onNavigateProjects={() => undefined} minimal>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.queryByTestId('paused-banner')).toBeNull();
    await act(async () => {
      await api.listProjects().catch(() => undefined);
    });
    expect(screen.getByTestId('paused-banner').textContent).toContain('Canvas has been paused');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});
