import type { APIRequestContext, APIResponse } from '@playwright/test';

/** canvas-obp0: a save names the version it starts from, so fetch the current one first. */
export async function saveDsl(request: APIRequestContext, apiBase: string, diagramId: string, dslContent: string): Promise<APIResponse> {
  const current = await request.get(`${apiBase}/diagrams/${diagramId}`);
  const baseVersionId = (await current.json()).diagram.currentVersionId as string;
  return request.patch(`${apiBase}/diagrams/${diagramId}`, { data: { dslContent, baseVersionId } });
}
