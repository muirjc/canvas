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
  diagramTypeId: string;
  dslFamily: string;
  dslContent: string;
  lastValidationResult: { elementId: string; rule: string; message: string; severity: string }[];
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
}

export interface ProjectTreeNodeDto {
  id: string;
  name: string;
  diagrams: { id: string; name: string; diagramTypeId: string }[];
  children: ProjectTreeNodeDto[];
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
  projectId: string;
  deletedAt: string;
}

export interface AiPersonaDto {
  id: string;
  name: string;
  category: string;
  systemPrompt: string;
  status: 'active' | 'archived';
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

export interface AiSettingsDto {
  chatEnabled: boolean;
}

export const api = {
  me: () => request<{ user: SessionUser }>('/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('/auth/local/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
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
  createStandard: (diagramTypeId: string, rules: Partial<StandardRulesDto>) =>
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
  createProject: (body: { name: string; parentProjectId?: string }) =>
    request<{ project: ProjectDto }>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  getProjectTree: (id: string) => request<{ tree: ProjectTreeNodeDto }>(`/projects/${id}/tree`),
  listDiagramVersions: (diagramId: string) =>
    request<{ versions: DiagramVersionDto[] }>(`/diagrams/${diagramId}/versions`),
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
  revokeShare: (grantId: string) => request<void>(`/shares/${grantId}`, { method: 'DELETE' }),
  listAdminUsers: () => request<{ users: UserRecordDto[] }>('/admin/users'),
  updateAdminUser: (id: string, body: { role?: string; personas?: string[]; active?: boolean }) =>
    request<{ user: UserRecordDto }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  getAdminOverview: () => request<{ overview: AdminOverviewDto }>('/admin/overview'),
  deleteDiagram: (id: string) => request<void>(`/diagrams/${id}`, { method: 'DELETE' }),
  listDeletedDiagrams: () => request<{ diagrams: DeletedDiagramDto[] }>('/admin/deleted-diagrams'),
  restoreDiagram: (id: string) => request<{ diagram: DiagramDto }>(`/diagrams/${id}/restore`, { method: 'POST' }),
  listAiPersonas: () => request<{ personas: AiPersonaDto[] }>('/ai-personas'),
  listAllAiPersonas: () => request<{ personas: AiPersonaDto[] }>('/admin/ai-personas'),
  createAiPersona: (body: { name: string; category: string; systemPrompt: string }) =>
    request<{ persona: AiPersonaDto }>('/admin/ai-personas', { method: 'POST', body: JSON.stringify(body) }),
  updateAiPersona: (id: string, body: { name?: string; category?: string; systemPrompt?: string }) =>
    request<{ persona: AiPersonaDto }>(`/admin/ai-personas/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveAiPersona: (id: string) => request<{ persona: AiPersonaDto }>(`/admin/ai-personas/${id}/archive`, { method: 'POST' }),
  sendChatMessage: (diagramId: string, body: { message: string; currentDslContent: string; personaId?: string }) =>
    request<SendChatMessageResultDto>(`/diagrams/${diagramId}/chat/messages`, { method: 'POST', body: JSON.stringify(body) }),
  getChatMessages: (diagramId: string) => request<{ messages: ChatMessageDto[] }>(`/diagrams/${diagramId}/chat/messages`),
  getAiSettings: () => request<AiSettingsDto>('/admin/ai-settings'),
  setAiSettings: (body: AiSettingsDto) => request<AiSettingsDto>('/admin/ai-settings', { method: 'PATCH', body: JSON.stringify(body) }),
};
