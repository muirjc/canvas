// canvas-8uh1.3: useLinkTargets asks the links index first. A diagram in the bin is a 404 when read on its own,
// so a lookup racing the index used to win and call a deleted link "missing" (seen in CI).
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDiagramModel, type DiagramModel } from '@canvas/diagram-core';
import { api, ApiError } from '../../src/app/api';
import { useLinkTargets } from '../../src/app/diagram-links';

const BINNED = '11111111-2222-4333-8444-555555555555';
const NEW = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function modelLinking(...targets: string[]): DiagramModel {
  const model = createEmptyDiagramModel('flowchart');
  model.nodes = targets.map((t, i) => ({ id: `n${i}`, label: `N${i}`, shape: 'rectangle', position: { x: 0, y: 0 }, diagramRef: { diagramId: t } }));
  return model;
}

afterEach(() => vi.restoreAllMocks());

describe('useLinkTargets', () => {
  it('takes a saved link’s state from the index, even when a lookup would answer first', async () => {
    let answerIndex: (value: Awaited<ReturnType<typeof api.getDiagramLinks>>) => void = () => undefined;
    vi.spyOn(api, 'getDiagramLinks').mockImplementation(() => new Promise((resolve) => (answerIndex = resolve)));
    const lookup = vi.spyOn(api, 'getDiagram').mockRejectedValue(new ApiError('Not found', 404));

    const { result } = renderHook(() => useLinkTargets('d-1', modelLinking(BINNED), 0));
    await act(async () => {
      answerIndex({ links: [{ elementId: 'n0', diagramId: BINNED, status: 'deleted', diagram: null }] });
    });
    await waitFor(() => expect(result.current.targets.get(BINNED)?.status).toBe('deleted'));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks up a link the index doesn’t know (made since the last save) once the index has answered', async () => {
    vi.spyOn(api, 'getDiagramLinks').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getDiagram').mockResolvedValue({ diagram: { id: NEW, name: 'New one', diagramTypeId: 'flowchart', projectId: 'p' } } as never);

    const { result } = renderHook(() => useLinkTargets('d-1', modelLinking(NEW, 'not-a-uuid'), 0));
    await waitFor(() => expect(result.current.targets.get(NEW)).toMatchObject({ status: 'available', name: 'New one' }));
    expect(result.current.targets.get('not-a-uuid')?.status).toBe('missing');
  });

  it('keeps a lookup that failed for another reason as checking, and asks again after a save', async () => {
    vi.spyOn(api, 'getDiagramLinks').mockResolvedValue({ links: [] });
    const lookup = vi.spyOn(api, 'getDiagram').mockRejectedValueOnce(new Error('network')).mockResolvedValue({
      diagram: { id: NEW, name: 'Back online', diagramTypeId: 'flowchart', projectId: 'p' },
    } as never);
    const model = modelLinking(NEW);
    const { result, rerender } = renderHook(({ token }) => useLinkTargets('d-1', model, token), { initialProps: { token: 0 } });
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(result.current.targets.get(NEW)?.status).toBe('checking');
    rerender({ token: 1 });
    await waitFor(() => expect(result.current.targets.get(NEW)?.status).toBe('available'));
  });
});
