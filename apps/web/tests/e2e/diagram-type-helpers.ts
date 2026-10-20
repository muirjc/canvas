import { expect, type APIRequestContext } from '@playwright/test';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ALL_PERSONAS = ['Business', 'Enterprise', 'Solution', 'Technical'];

/**
 * canvas-lj9: a custom diagram type that diagrams use can never be deleted (even soft-deleted
 * diagrams count), so specs that need one reuse a single fixed-name "E2E ..." type instead of
 * creating a timestamped one per run. Finds a custom type with this exact name and family
 * (un-hiding it if a previous run's cleanup hid it), or creates it. `request` must be signed in as
 * an admin. Returns the type id.
 */
export async function ensureCustomDiagramType(
  request: APIRequestContext,
  opts: { name: string; dslFamily: string; personas?: string[] },
): Promise<string> {
  const list = await request.get(`${API_BASE_URL}/diagram-types?includeHidden=true`);
  expect(list.ok()).toBe(true);
  const types = (await list.json()).diagramTypes as {
    id: string;
    name: string;
    origin: string;
    dslFamily: string;
    hidden?: boolean;
  }[];
  const existing = types.find((t) => t.origin === 'custom' && t.name === opts.name && t.dslFamily === opts.dslFamily);
  if (existing) {
    if (existing.hidden) {
      const res = await request.patch(`${API_BASE_URL}/admin/diagram-types/${existing.id}`, { data: { hidden: false } });
      expect(res.ok()).toBe(true);
    }
    return existing.id;
  }
  const res = await request.post(`${API_BASE_URL}/admin/diagram-types`, {
    data: { name: opts.name, dslFamily: opts.dslFamily, personas: opts.personas ?? ALL_PERSONAS },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).diagramType.id as string;
}

/** Deletes a custom type created by a spec; tolerates it already being gone. */
export async function deleteCustomDiagramType(request: APIRequestContext, id: string): Promise<void> {
  if (!id) return;
  const res = await request.delete(`${API_BASE_URL}/admin/diagram-types/${id}`);
  expect([200, 204, 404]).toContain(res.status());
}

/** Hides a fixed "E2E ..." type after a spec, so it stays out of the developer's create pickers
 *  between runs; ensureCustomDiagramType un-hides it next time. */
export async function hideCustomDiagramType(request: APIRequestContext, id: string): Promise<void> {
  if (!id) return;
  const res = await request.patch(`${API_BASE_URL}/admin/diagram-types/${id}`, { data: { hidden: true } });
  expect([200, 404]).toContain(res.status());
}
