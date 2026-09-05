import { loadWebConfig } from '../config';

const { apiBaseUrl } = loadWebConfig();

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON Content-Type when there's actually a JSON body — Fastify's default body
  // parser rejects "Content-Type: application/json" paired with an empty body (as happens on
  // e.g. POST /standards/:id/publish, which takes no payload).
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request to ${path} failed with status ${response.status}`, response.status, body.details);
  }
  // A 204 (or otherwise empty body) has nothing for .json() to parse — e.g. POST /auth/logout
  // and DELETE /shares/:id. Calling .json() on an empty body throws, so callers awaiting these
  // endpoints would never see their success path run.
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface DiagramDto {
  id: string;
  name: string;
  /** canvas-hbk: a few lines of free text describing the diagram — null until an architect sets
   *  one. Distinct from Mermaid's inline `%%` comments inside the DSL body. */
  description: string | null;
  diagramTypeId: string;
  dslFamily: string;
  dslContent: string;
  lastValidationResult: { elementId: string; rule: string; message: string; severity: string }[];
  /** canvas-hbk: resolved owner name (not a raw UUID) and creation/last-modified timestamps —
   *  already stored server-side, previously never sent to the client. */
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface StandardRulesDto {
  allowedShapeIds: string[];
  mandatoryShapeIds: string[];
  allowedIconLibraryRefs: { libraryId: string; libraryVersion: string }[];
  colorPalette: { role: string; colorHex: string }[];
  fontConstraints?: { family?: string; minSize?: number; maxSize?: number };
}

export interface StandardDto extends StandardRulesDto {
  id: string;
  diagramTypeId: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  /** Human-readable identity; backfilled for standards predating feature 006. */
  name: string | null;
  description: string | null;
  createdAt: string;
  /** Present only once the standard has left force. */
  retiredAt: string | null;
}

export interface DiagramTypeDto {
  id: string;
  name: string;
  personas: string[];
  abstractionLevel: string;
  dslFamily: string;
  defaultPaletteLibraryIds: string[];
}

export interface IconDto {
  libraryId: string;
  libraryVersion: string;
  id: string;
  displayName: string;
  keywords: string[];
  category: string;
  assetRef: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  parentProjectId: string | null;
  createdAt: string;
  /** Direct (non-recursive) count of the project's own non-deleted diagrams (canvas-228.1). */
  diagramCount: number;
  /** Who owns this project — only the owner (or an admin) may rename/delete it (canvas-228.3). */
  ownerId: string;
}

export interface DeletedProjectDto {
  id: string;
  name: string;
  ownerId: string;
  deletedAt: string;
}

export interface ProjectTreeNodeDto {
  id: string;
  name: string;
  diagrams: { id: string; name: string; diagramTypeId: string }[];
  children: ProjectTreeNodeDto[];
}

/** A project's direct (non-recursive) diagrams as returned by the search endpoint below —
 *  narrower than DiagramDto (no dslContent/lastValidationResult), matching what the list route
 *  actually sends. */
export interface DiagramSummaryDto {
  id: string;
  name: string;
  diagramTypeId: string;
  projectId: string;
  updatedAt: string;
}

export interface DiagramVersionDto {
  id: string;
  sequenceNumber: number;
  authorId: string;
  createdAt: string;
}

export type AccessLevel = 'view' | 'comment' | 'edit';

export interface ShareGrantDto {
  id: string;
  subjectType: 'diagram' | 'project';
  subjectId: string;
  granteeUserId: string;
  accessLevel: AccessLevel;
  grantedByUserId: string;
  createdAt: string;
}

export interface SharedDiagramDto {
  diagramId: string;
  diagramName: string;
  diagramTypeId: string;
  /** The diagram's immediate containing project only — never an ancestor (feature 008, FR-005). */
  projectName: string;
  accessLevel: AccessLevel;
  sharedByName: string;
  sharedByEmail: string;
  sharedAt: string;
}

export interface UserRecordDto {
  id: string;
  name: string;
  email: string;
  role: string;
  personas: string[];
  active: boolean;
}

export interface AdminOverviewDto {
  userCount: number;
  standardsCount: number;
  publishedStandardsCount: number;
  libraryCount: number;
}

export interface DeletedDiagramDto {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  projectId: string;
  projectName: string;
  deletedAt: string;
}

export interface AiPersonaDto {
  id: string;
  name: string;
  category: string;
  systemPrompt: string;
  status: 'active' | 'archived';
}

/** 010-ai-diagram-knowledge, User Story 4: an admin-curated reference-material entry attached to
 *  a persona, optionally scoped to specific diagram-type families (empty = unscoped). */
export interface PersonaReferenceMaterialDto {
  id: string;
  personaId: string;
  content: string;
  diagramFamilies: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallOutcomeDto {
  tool: string;
  applied: boolean;
  reason?: string;
}

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallOutcomeDto[] | null;
  createdAt: string;
}

export interface SendChatMessageResultDto {
  assistantMessage: string;
  updatedDslContent: string;
  toolCalls: ToolCallOutcomeDto[];
}

export type AiProviderKind = 'anthropic' | 'openai' | 'mock' | 'unconfigured';

export interface AiSettingsDto {
  chatEnabled: boolean;
  /** canvas-wuc: which provider AI_PROVIDER currently resolves to, for display only — lets the AI
   *  entry points (Create with AI, Chat panel) warn when a deployment is unexpectedly running the
   *  'mock' fake-NLU provider instead of a real one. */
  provider: AiProviderKind;
}

export const api = {
  me: () => request<{ user: SessionUser }>('/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('/auth/local/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  /** canvas-mi9: unauthenticated, always registered (unlike the SSO login/callback routes
   *  themselves, which don't exist at all server-side when OIDC is unconfigured) -- lets
   *  LoginForm.tsx decide whether to show a "Sign in with SSO" link without it 404ing.
   *  canvas-cpa: localAuthEnabled likewise lets it decide whether to show the password fields at
   *  all, rather than a 404 surfacing as a bare "Not Found" only after submitting them. */
  getAuthConfig: () => request<{ oidcEnabled: boolean; localAuthEnabled: boolean }>('/auth/config'),
  createDiagram: (projectId: string, body: { name: string; diagramTypeId: string; initialDslContent?: string }) =>
    request<{ diagram: DiagramDto }>(`/projects/${projectId}/diagrams`, { method: 'POST', body: JSON.stringify(body) }),
  importDiagram: (projectId: string, body: { name: string; dslContent: string; diagramTypeHint?: string }) =>
    request<{ diagram: DiagramDto }>(`/projects/${projectId}/diagrams/import`, { method: 'POST', body: JSON.stringify(body) }),
  getDiagram: (id: string) => request<{ diagram: DiagramDto }>(`/diagrams/${id}`),
  saveDiagram: (id: string, dslContent: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${id}`, { method: 'PATCH', body: JSON.stringify({ dslContent }) }),
  getActiveStandard: (diagramTypeId: string) =>
    request<{ standard: StandardDto }>(`/diagram-types/${diagramTypeId}/standard`),
  listStandards: (diagramTypeId: string) =>
    request<{ standards: StandardDto[] }>(`/diagram-types/${diagramTypeId}/standards`),
  createStandard: (
    diagramTypeId: string,
    rules: Partial<StandardRulesDto> & { name?: string; description?: string },
  ) =>
    request<{ standard: StandardDto }>(`/diagram-types/${diagramTypeId}/standards`, {
      method: 'POST',
      body: JSON.stringify(rules),
    }),
  publishStandard: (id: string) => request<{ standard: StandardDto }>(`/standards/${id}/publish`, { method: 'POST' }),
  retireStandard: (id: string) => request<{ standard: StandardDto }>(`/standards/${id}/retire`, { method: 'POST' }),
  listDiagramTypes: (persona?: string) =>
    request<{ diagramTypes: DiagramTypeDto[] }>(`/diagram-types${persona ? `?persona=${encodeURIComponent(persona)}` : ''}`),
  searchIcons: (diagramTypeId: string, query: string) =>
    request<{ icons: IconDto[] }>(`/icons/search?diagramTypeId=${encodeURIComponent(diagramTypeId)}&query=${encodeURIComponent(query)}`),
  /** canvas-8n7: every icon in one library/version, including `assetRef` (the real SVG markup) —
   *  used to resolve a placed node's icon ref back to artwork the canvas can actually draw. */
  getLibraryIcons: (libraryId: string, libraryVersion: string) =>
    request<{ icons: IconDto[] }>(
      `/libraries/${encodeURIComponent(libraryId)}/versions/${encodeURIComponent(libraryVersion)}/icons`,
    ),
  createProject: (body: { name: string; parentProjectId?: string }) =>
    request<{ project: ProjectDto }>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  /** Owner-or-admin only (canvas-228.3) — same bar as deleteDiagram below. Returns only the
   *  fields the server actually has available to return (no diagramCount re-query for a value
   *  a rename can't change) — callers should merge `.name` into their own ProjectDto, not treat
   *  this as a complete one. */
  renameProject: (id: string, name: string) =>
    request<{ project: { id: string; name: string; parentProjectId: string | null; createdAt: string } }>(
      `/projects/${id}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    ),
  getProjectTree: (id: string) => request<{ tree: ProjectTreeNodeDto }>(`/projects/${id}/tree`),
  /** canvas-3vq.1: GET /projects/:projectId/diagrams already existed (search.service.ts) but had
   *  no frontend caller — wires ProjectBrowser's search/type-filter to it. Direct diagrams of
   *  `projectId` only, not recursive into child projects (see ProjectBrowser.tsx's own note). */
  searchProjectDiagrams: (projectId: string, options: { query?: string; type?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.query) params.set('query', options.query);
    if (options.type) params.set('type', options.type);
    const qs = params.toString();
    return request<{ diagrams: DiagramSummaryDto[] }>(`/projects/${projectId}/diagrams${qs ? `?${qs}` : ''}`);
  },
  /** Projects available to the signed-in user — owned or shared (feature 007, FR-013a). */
  listProjects: () => request<{ projects: ProjectDto[] }>('/projects'),
  /** Moves a diagram to a different project (canvas-228.3) — requires edit access on the diagram
   *  and on the destination project. */
  moveDiagram: (diagramId: string, projectId: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${diagramId}/project`, { method: 'PATCH', body: JSON.stringify({ projectId }) }),
  /** Renames a diagram (canvas-8x1) — requires edit access on the diagram (same bar as saving its
   *  DSL), unlike renameProject which is owner-or-admin only. */
  renameDiagram: (diagramId: string, name: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${diagramId}/name`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  /** canvas-hbk: same access bar as renaming — edit access on the diagram. Unlike name, an empty
   *  string is a valid value (clears the description back to "none set"). */
  updateDiagramDescription: (diagramId: string, description: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${diagramId}/description`, {
      method: 'PATCH',
      body: JSON.stringify({ description }),
    }),
  /** Owner-or-admin only, and only if the project has no diagrams and no sub-projects
   *  (canvas-228.2) — soft-deleted, recoverable by an admin within the retention window. */
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  listDeletedProjects: () => request<{ projects: DeletedProjectDto[] }>('/admin/deleted-projects'),
  restoreProject: (id: string) =>
    request<{ project: { id: string; name: string; parentProjectId: string | null; createdAt: string } }>(
      `/projects/${id}/restore`,
      { method: 'POST' },
    ),
  listDiagramVersions: (diagramId: string, options: { limit?: number; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.q) params.set('q', options.q);
    const query = params.toString();
    return request<{ versions: DiagramVersionDto[]; hasMore: boolean }>(
      `/diagrams/${diagramId}/versions${query ? `?${query}` : ''}`,
    );
  },
  restoreDiagramVersion: (diagramId: string, versionId: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${diagramId}/versions/${versionId}/restore`, { method: 'POST' }),
  lookupUserByEmail: (email: string) =>
    request<{ user: { id: string; name: string; email: string } | null }>(`/users/lookup?email=${encodeURIComponent(email)}`),
  createDiagramShare: (diagramId: string, granteeUserId: string, accessLevel: AccessLevel) =>
    request<{ grant: ShareGrantDto }>(`/diagrams/${diagramId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ granteeUserId, accessLevel }),
    }),
  listDiagramShares: (diagramId: string) => request<{ grants: ShareGrantDto[] }>(`/diagrams/${diagramId}/shares`),
  /** Diagrams shared directly with the signed-in user (feature 008, FR-001). */
  listSharedDiagrams: () => request<{ diagrams: SharedDiagramDto[] }>('/shared-diagrams'),
  revokeShare: (grantId: string) => request<void>(`/shares/${grantId}`, { method: 'DELETE' }),
  listAdminUsers: () => request<{ users: UserRecordDto[] }>('/admin/users'),
  updateAdminUser: (id: string, body: { role?: string; personas?: string[]; active?: boolean }) =>
    request<{ user: UserRecordDto }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getAdminOverview: () => request<{ overview: AdminOverviewDto }>('/admin/overview'),
  deleteDiagram: (id: string) => request<void>(`/diagrams/${id}`, { method: 'DELETE' }),
  listDeletedDiagrams: (options: { limit?: number; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.q) params.set('q', options.q);
    const query = params.toString();
    return request<{ diagrams: DeletedDiagramDto[]; hasMore: boolean }>(
      `/admin/deleted-diagrams${query ? `?${query}` : ''}`,
    );
  },
  restoreDiagram: (id: string) => request<{ diagram: DiagramDto }>(`/diagrams/${id}/restore`, { method: 'POST' }),
  listAiPersonas: () => request<{ personas: AiPersonaDto[] }>('/ai-personas'),
  listAllAiPersonas: () => request<{ personas: AiPersonaDto[] }>('/admin/ai-personas'),
  createAiPersona: (body: { name: string; category: string; systemPrompt: string }) =>
    request<{ persona: AiPersonaDto }>('/admin/ai-personas', { method: 'POST', body: JSON.stringify(body) }),
  updateAiPersona: (id: string, body: { name?: string; category?: string; systemPrompt?: string }) =>
    request<{ persona: AiPersonaDto }>(`/admin/ai-personas/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveAiPersona: (id: string) => request<{ persona: AiPersonaDto }>(`/admin/ai-personas/${id}/archive`, { method: 'POST' }),
  listPersonaReferenceMaterial: (personaId: string) =>
    request<{ entries: PersonaReferenceMaterialDto[] }>(`/admin/ai-personas/${personaId}/reference-material`),
  createPersonaReferenceMaterial: (personaId: string, body: { content: string; diagramFamilies?: string[] }) =>
    request<{ entry: PersonaReferenceMaterialDto }>(`/admin/ai-personas/${personaId}/reference-material`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePersonaReferenceMaterial: (
    personaId: string,
    entryId: string,
    body: { content?: string; diagramFamilies?: string[] },
  ) =>
    request<{ entry: PersonaReferenceMaterialDto }>(`/admin/ai-personas/${personaId}/reference-material/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deletePersonaReferenceMaterial: (personaId: string, entryId: string) =>
    request<void>(`/admin/ai-personas/${personaId}/reference-material/${entryId}`, { method: 'DELETE' }),
  sendChatMessage: (diagramId: string, body: { message: string; currentDslContent: string; personaId?: string }) =>
    request<SendChatMessageResultDto>(`/diagrams/${diagramId}/chat/messages`, { method: 'POST', body: JSON.stringify(body) }),
  getChatMessages: (diagramId: string) => request<{ messages: ChatMessageDto[] }>(`/diagrams/${diagramId}/chat/messages`),
  getAiSettings: () => request<AiSettingsDto>('/admin/ai-settings'),
  setAiSettings: (body: { chatEnabled: boolean }) =>
    request<AiSettingsDto>('/admin/ai-settings', { method: 'PATCH', body: JSON.stringify(body) }),
  /** canvas-wuc: any authenticated user, not just admins — read-only, mirrors listAiPersonas vs
   *  listAllAiPersonas' split. Used to gate the AI entry points (Create with AI, Chat panel)
   *  client-side before the user can even start typing, rather than only after a 503. */
  getAiStatus: () => request<AiSettingsDto>('/ai-settings'),
};
