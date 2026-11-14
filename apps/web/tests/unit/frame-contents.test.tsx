// canvas-8uh1.6: useFrameContents asks for what each frame shows (name, state, drawing).
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addFrame, createEmptyDiagramModel, type DiagramModel } from '@canvas/diagram-core';
import { api } from '../../src/app/api';
import { FRAME_REFRESH_MS, useFrameContents } from '../../src/app/diagram-links';

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function modelFraming(...ids: string[]): DiagramModel {
  let model = createEmptyDiagramModel('flowchart');
  for (const id of ids) model = addFrame(model, { diagramId: id });
  return model;
}
const answer = (diagramId: string, status: 'available' | 'deleted', name = 'Inner') => ({
  diagramId,
  status,
  diagram: status === 'available' ? { id: diagramId, name, diagramTypeId: 'flowchart', projectId: 'p', projectName: 'P' } : null,
  svg: status === 'available' ? '<svg/>' : null,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useFrameContents', () => {
  it('fetches once for the unique framed ids, sorted, and maps the answers', async () => {
    const fetch = vi.spyOn(api, 'getFrameContents').mockResolvedValue({ frames: [answer(A, 'available', 'Payments'), answer(B, 'deleted')] });
    const { result } = renderHook(() => useFrameContents('d-1', modelFraming(B, A, A), 0));
    await waitFor(() => expect(result.current.get(A)?.name).toBe('Payments'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('d-1', [A, B]);
    expect(result.current.get(A)).toMatchObject({ status: 'available', svg: '<svg/>', projectId: 'p' });
    expect(result.current.get(B)).toEqual({ status: 'deleted' });
  });

  it('does not fetch when the diagram has no frames', async () => {
    const fetch = vi.spyOn(api, 'getFrameContents').mockResolvedValue({ frames: [] });
    const { result } = renderHook(() => useFrameContents('d-1', createEmptyDiagramModel('flowchart'), 0));
    await act(async () => undefined);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it('fetches again when the refresh token changes (a save), and shows the newer drawing', async () => {
    const fetch = vi.spyOn(api, 'getFrameContents').mockResolvedValueOnce({ frames: [answer(A, 'available', 'Old name')] }).mockResolvedValue({ frames: [answer(A, 'available', 'New name')] });
    const model = modelFraming(A);
    const { result, rerender } = renderHook(({ token }) => useFrameContents('d-1', model, token), { initialProps: { token: 0 } });
    await waitFor(() => expect(result.current.get(A)?.name).toBe('Old name'));
    rerender({ token: 1 });
    await waitFor(() => expect(result.current.get(A)?.name).toBe('New name'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fetches again when a frame for another diagram is added, not when only the position changes', async () => {
    const fetch = vi.spyOn(api, 'getFrameContents').mockResolvedValue({ frames: [answer(A, 'available'), answer(B, 'available')] });
    const first = modelFraming(A);
    const { rerender } = renderHook(({ model }) => useFrameContents('d-1', model, 0), { initialProps: { model: first } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender({ model: { ...first, frames: first.frames!.map((f) => ({ ...f, position: { x: 999, y: 5 } })) } });
    await act(async () => undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender({ model: addFrame(first, { diagramId: B }) });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith('d-1', [A, B]);
  });

  it('keeps what it had when a refresh fails', async () => {
    vi.spyOn(api, 'getFrameContents').mockResolvedValueOnce({ frames: [answer(A, 'available', 'Kept')] }).mockRejectedValue(new Error('network'));
    const model = modelFraming(A);
    const { result, rerender } = renderHook(({ token }) => useFrameContents('d-1', model, token), { initialProps: { token: 0 } });
    await waitFor(() => expect(result.current.get(A)?.name).toBe('Kept'));
    rerender({ token: 1 });
    await act(async () => undefined);
    expect(result.current.get(A)?.name).toBe('Kept');
  });

  describe('every minute while visible', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));

    it('asks again after FRAME_REFRESH_MS', async () => {
      const fetch = vi.spyOn(api, 'getFrameContents').mockResolvedValue({ frames: [answer(A, 'available')] });
      renderHook(() => useFrameContents('d-1', modelFraming(A), 0));
      await act(async () => undefined);
      expect(fetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(FRAME_REFRESH_MS);
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not ask while the page is hidden', async () => {
      const fetch = vi.spyOn(api, 'getFrameContents').mockResolvedValue({ frames: [answer(A, 'available')] });
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      renderHook(() => useFrameContents('d-1', modelFraming(A), 0));
      await act(async () => undefined);
      await act(async () => {
        vi.advanceTimersByTime(FRAME_REFRESH_MS * 2);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      visibility.mockRestore();
    });
  });
});
