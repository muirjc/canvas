import type { StandardRules, Violation } from '@canvas/diagram-core';
import { loadWebConfig } from '../config';

const { apiBaseUrl } = loadWebConfig();

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    /** Machine-readable reason some routes add alongside `error` (e.g. GitHub submit: `must_fix`). */
    public readonly code?: string,
  ) {
    super(message);
  }
}

const enc = encodeURIComponent;

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
    throw new ApiError(body.error ?? `Request to ${path} failed with status ${response.status}`, response.status, body.details ?? body.violations ?? body.diagrams, body.code);
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
  /** Business / Enterprise / Solution / Technical: which diagram types this user is offered first. */
  personas?: string[];
  /** Signed in with a Canvas-managed password (as opposed to SSO). */
  localAccount?: boolean;
  /** Signed in without two-step verification set up where it is required: set it up first. */
  mustEnrollMfa?: boolean;
  mfaEnabled?: boolean;
  /** Signed in with a one-time password: every route but /auth/* refuses until it is changed. */
  mustChangePassword?: boolean;
}

/** canvas-obp0: someone else with the diagram open in the editor. */
export interface OtherEditorDto {
  userId: string;
  name: string;
  since: string;
  /** The signed-in user in another tab or browser. */
  isYou: boolean;
}

/** canvas-obp0: the 409 a stale save or restore gets back (ApiError.details, code version_conflict). */
export interface VersionConflictDto {
  currentVersionId: string;
  savedBy: { id: string | null; name: string };
  savedAt: string;
}

export interface DiagramDto {
  id: string;
  name: string;
  /** The project the diagram belongs to (canvas-t3b.2: the editor's back button goes there). */
  projectId: string;
  /** canvas-hbk: a few lines of free text describing the diagram — null until an architect sets
   *  one. Distinct from Mermaid's inline `%%` comments inside the DSL body. */
  description: string | null;
  diagramTypeId: string;
  dslFamily: string;
  dslContent: string;
  lastValidationResult: Violation[];
  /** canvas-tfr: version of the standard the last save was checked against (null = none). */
  standardVersionAtLastCheck?: number | null;
  /** canvas-obp0: the version on screen. Saves and restores send it back as their base; the API
   *  answers 409 (code version_conflict) if someone else has saved since. */
  currentVersionId: string;
  /** canvas-hbk: resolved owner name (not a raw UUID) and creation/last-modified timestamps —
   *  already stored server-side, previously never sent to the client. */
  ownerName: string;
  /** Lets the comments panel show "delete" on others' comments to the owner. */
  ownerId?: string;
  /** The caller's own access level (view | comment | edit; admins and owners resolve to edit). */
  accessLevel?: AccessLevel;
  createdAt: string;
  updatedAt: string;
  /** canvas-j6v: drawn by Create with AI and not yet saved -- only its creator can see it, it's in
   *  no list, and leaving without saving deletes it. */
  draft?: boolean;
}

/** canvas-tfr: the full rule set (v1 fields + v2 element kinds), diagram-core's own type -- the
 *  server returns it nested under `rules`. (The previous flattened DTO didn't match the server's
 *  actual response shape; it went unnoticed only because nothing read it.) */
export type StandardRulesDto = StandardRules;

export interface StandardDto {
  id: string;
  diagramTypeId: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  /** Human-readable identity; backfilled for standards predating feature 006. */
  name: string | null;
  description: string | null;
  rules: StandardRules;
  publishedAt: string | null;
  createdAt: string;
  /** Present only once the standard has left force. */
  retiredAt: string | null;
}

/** canvas-tfr: a 400 from POST/PUT standards carries these. */
export interface DefinitionIssueDto {
  path: string;
  message: string;
}

/** canvas-3dq: Admin -> Libraries. */
export interface AdminLibraryDto {
  id: string;
  version: string;
  name: string;
  origin: 'builtin' | 'custom';
  license: string | null;
  iconCount: number;
  retiredIconCount: number;
  retiredAt: string | null;
  diagramTypes: { id: string; name: string }[];
  usedByDiagramCount: number;
}
export interface AdminIconDto {
  id: string;
  displayName: string;
  category: string;
  keywords: string[];
  assetRef: string;
  retiredAt: string | null;
  usedByDiagramCount: number;
}
export interface LibraryUploadIcon {
  fileName: string;
  svg: string;
  displayName?: string;
  category?: string;
  keywords?: string[];
}
export interface LibraryRejectedIcon {
  fileName: string;
  reason: string;
}
export interface LibraryUsageDiagramDto {
  id: string;
  name: string;
  projectId: string;
}

export interface DiagramTypeDto {
  id: string;
  name: string;
  personas: string[];
  abstractionLevel: string;
  dslFamily: string;
  defaultPaletteLibraryIds: string[];
  /** canvas-tfr: 'builtin' (seeded catalog) or 'custom' (admin-created). */
  origin: 'builtin' | 'custom';
  /** canvas-chq: a built-in type an admin has edited (the catalog seed no longer overwrites it). */
  adminEdited?: boolean;
  description: string | null;
  /** canvas-9ff: hidden from the create pickers (listed only with includeHidden); existing diagrams
   *  of it keep working. */
  hidden?: boolean;
}

export interface CustomDiagramTypeInput {
  name: string;
  dslFamily: string;
  personas: string[];
  paletteLibraryIds?: string[];
  description?: string | null;
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
  /** canvas-zfe: who saved it ("Deleted user" for a deleted account). */
  authorName: string;
  createdAt: string;
  /** canvas-3fha: set when this version restored an earlier one ("Restored from v1"). */
  restoredFromSequence: number | null;
}

/** canvas-3fha: one version with its content, for the read-only preview. */
export interface DiagramVersionDetailDto extends DiagramVersionDto {
  dslContent: string;
}

export type AccessLevel = 'view' | 'comment' | 'edit';

export interface ShareGrantDto {
  id: string;
  subjectType: 'diagram' | 'project';
  subjectId: string;
  granteeUserId: string;
  /** Null when the grantee no longer exists. */
  granteeName?: string | null;
  granteeEmail?: string | null;
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
  /** Has a Canvas-managed password (a local account). */
  hasPassword?: boolean;
  /** Locked after too many failed sign-ins; an admin unlock or password reset clears it. */
  locked?: boolean;
  mfaEnabled?: boolean;
}

export interface AiUsageTotals {
  /** Estimated USD cost (admin-only); excludes `unpricedTokens`. */
  estimatedCost: number;
  unpricedTokens: number;
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface AiUsageUserDto extends AiUsageTotals {
  userId: string | null;
  email: string | null;
  name: string | null;
  lastUsedAt: string | null;
}

export interface AiUsageDetailDto {
  byDay: Array<AiUsageTotals & { day: string }>;
  byModel: Array<AiUsageTotals & { provider: string; modelId: string; priced: boolean }>;
}

/** What a comment thread is pinned to (canvas-eac: groups/boundaries too). */
export interface CommentAnchor {
  type: 'node' | 'edge' | 'container';
  id: string;
}

export interface CommentDto {
  id: string;
  threadRootId: string | null;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface CommentThreadDto extends CommentDto {
  anchor: CommentAnchor | null;
  resolved: { at: string; by: string } | null;
  replies: CommentDto[];
}

export interface GitHubInstallationDto {
  id: number;
  account: string;
  repositorySelection: string;
  permissions: Record<string, string>;
}
export interface GitHubStatusDto {
  enabled: boolean;
  appId?: number | string;
  apiUrl?: string;
  installations: GitHubInstallationDto[];
  error?: string;
  /** canvas-3s5.3: whether this Canvas build bundles the validator committed with submissions. */
  validatorAvailable?: boolean;
}
export interface GitHubRepositoryDto {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  installationId: number;
}
export interface GitHubLinkDto {
  id: string;
  projectId: string;
  projectName: string;
  repoId: number;
  repoFullName: string;
  installationId: number;
  baseBranch: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  openSubmissionCount?: number;
}
export interface GitHubTestResultDto {
  ok: boolean;
  checks: { id: string; label: string; ok: boolean; detail?: string }[];
}
export interface SubmissionDto {
  id: string;
  state: 'open' | 'merged' | 'closed';
  prNumber: number;
  prUrl: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  path: string;
  submittedVersionSequence: number;
  submittedBy: string | null;
  firstSubmittedAt: string;
  lastSubmittedAt: string;
  reviewState: string | null;
  checksState: string | null;
  mergedAt: string | null;
  mergedBy: string | null;
  closedAt: string | null;
  /** canvas-3s5.2 fields; optional so Phase 1 shaped fixtures stay valid. */
  mergedHeadMatches?: boolean | null;
  withdrawnAt?: string | null;
  withdrawnBy?: string | null;
  statusDetail?: SubmissionStatusDetailDto | null;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
}
export interface SubmissionStatusDetailDto {
  checks: { name: string; state: string; url: string | null }[];
  reviews: { login: string; state: string }[];
  requestedReviewers: string[];
}
export interface SubmissionPushDto {
  versionSequence: number;
  commitSha: string;
  pushedBy: string | null;
  pushedAt: string;
  warningCount: number;
}
export interface SubmissionHistoryItemDto extends SubmissionDto {
  pushes: SubmissionPushDto[];
}
export interface SubmissionBadgeDto {
  state: 'open' | 'merged' | 'closed';
  prNumber: number | null;
  prUrl: string | null;
  reviewState: string | null;
  checksState: string | null;
  submittedVersionSequence: number | null;
  changesSinceSubmitting: boolean;
  withdrawn: boolean;
}
export interface SubmissionStatusDto {
  enabled: boolean;
  link: { repoFullName: string; folder: string; baseBranch: string } | null;
  current: SubmissionDto | null;
  approved?: SubmissionDto | null;
  canWithdraw?: boolean;
  changesSinceSubmitting: boolean;
  canSubmit: {
    allowed: boolean;
    reason: null | 'github_disabled' | 'not_linked' | 'no_edit_access' | 'must_fix';
    mustFixCount: number;
    warningCount: number;
  };
}
export interface SubmitResultDto {
  outcome: 'created' | 'updated' | 'upToDate';
  submission: SubmissionDto;
  warnings: Violation[];
}

export interface AuditEventDto {
  id: string;
  occurredAt: string;
  event: string;
  actorEmail: string | null;
  targetEmail: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
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

/** Present only when the signed-in user may see token counts. */
export interface ChatUsageDto {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatUsageTotalDto extends ChatUsageDto {
  requests: number;
}

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallOutcomeDto[] | null;
  createdAt: string;
  usage?: ChatUsageDto;
}

export interface SendChatMessageResultDto {
  assistantMessage: string;
  updatedDslContent: string;
  toolCalls: ToolCallOutcomeDto[];
  assistantMessageId?: string;
  usage?: ChatUsageDto;
}

export interface AiPriceDto {
  provider: string;
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  updatedAt: string;
}

export interface AiPriceInput {
  provider: string;
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export type MyAiUsageDto =
  | { visible: false }
  | { visible: true; from: string; to: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number };

export type AiProviderKind = 'anthropic' | 'openai' | 'mock' | 'unconfigured';

/** canvas-8em: admin feature switches, readable by every signed-in user. */
export interface AppSettingsDto {
  /** Whether the editor shows the Share button (sharing itself works either way). */
  sharingEnabled: boolean;
}

export interface AiSettingsDto {
  chatEnabled: boolean;
  /** Whether non-admins see token counts (admins always do). */
  showUsageToUsers: boolean;
  /** canvas-wuc: which provider AI_PROVIDER currently resolves to, for display only — lets the AI
   *  entry points (Create with AI, Chat panel) warn when a deployment is unexpectedly running the
   *  'mock' fake-NLU provider instead of a real one. */
  provider: AiProviderKind;
  /** canvas-tj1: the admin's chosen model; null = use the provider default. */
  modelId: string | null;
  defaultModelId: string | null;
  /** The model chats actually use (choice, else default). */
  effectiveModelId: string | null;
}

export interface AiModelDto {
  id: string;
  name: string;
  createdAt: string | null;
}

export interface AiModelsDto {
  provider: AiProviderKind;
  models: AiModelDto[];
  modelId: string | null;
  defaultModelId: string | null;
  error?: string;
}

export const api = {
  me: () => request<{ user: SessionUser }>('/auth/me'),
  /** canvas-ao2: whether this request carried a session -- 'none' right after a sign-in means the
   *  browser blocked the session cookie. */
  sessionCheck: () => request<{ session: 'signed-in' | 'pending-mfa' | 'none' }>('/auth/session-check'),
  login: (email: string, password: string) =>
    request<{ user?: SessionUser; mfaRequired?: boolean }>('/auth/local/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  verifyMfa: (code: string) =>
    request<{ user: SessionUser; recoveryCodesRemaining?: number }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  /** The secret and recovery codes these return are shown once and must never be stored. */
  enrollMfa: () => request<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', { method: 'POST' }),
  confirmMfaEnrollment: (code: string) =>
    request<{ user: SessionUser; recoveryCodes: string[] }>('/auth/mfa/enroll/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  resetUserMfa: (id: string) => request<{ reset: boolean }>(`/admin/users/${id}/reset-mfa`, { method: 'POST' }),
  // canvas-252: a 204 (no body) means the local session was destroyed and there's nothing else
  // to do -- exactly the old behavior. A 200 with logoutUrl means this session came from SSO;
  // the caller (AppShell.tsx) must navigate the browser there (a real top-level page load, not
  // another fetch) so Keycloak's own end_session_endpoint can actually clear its session cookie.
  logout: () => request<{ logoutUrl?: string } | undefined>('/auth/logout', { method: 'POST' }),
  /** canvas-mi9: unauthenticated, always registered (unlike the SSO login/callback routes
   *  themselves, which don't exist at all server-side when OIDC is unconfigured) -- lets
   *  LoginForm.tsx decide whether to show a "Sign in with SSO" link without it 404ing.
   *  canvas-cpa: localAuthEnabled likewise lets it decide whether to show the password fields at
   *  all, rather than a 404 surfacing as a bare "Not Found" only after submitting them. */
  getAuthConfig: () => request<{ authMode: 'entra' | 'local'; mfaRequired?: boolean; oidcEnabled: boolean; localAuthEnabled: boolean }>('/auth/config'),
  createDiagram: (projectId: string, body: { name: string; diagramTypeId: string; initialDslContent?: string; draft?: boolean }) =>
    request<{ diagram: DiagramDto }>(`/projects/${projectId}/diagrams`, { method: 'POST', body: JSON.stringify(body) }),
  importDiagram: (projectId: string, body: { name: string; dslContent: string; diagramTypeHint?: string; draft?: boolean }) =>
    request<{ diagram: DiagramDto }>(`/projects/${projectId}/diagrams/import`, { method: 'POST', body: JSON.stringify(body) }),
  importTemplate: (projectId: string, body: { name: string; diagramTypeId: string; templateContent: string; draft?: boolean }) =>
    request<{ diagram: DiagramDto }>(`/projects/${projectId}/diagrams/import-template`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getDiagram: (id: string) => request<{ diagram: DiagramDto }>(`/diagrams/${id}`),
  saveDiagram: (id: string, dslContent: string, baseVersionId: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${id}`, { method: 'PATCH', body: JSON.stringify({ dslContent, baseVersionId }) }),
  /** canvas-obp0: this editor tab is open; returns everyone else who has the diagram open. */
  presenceHeartbeat: (id: string, sessionId: string) =>
    request<{ others: OtherEditorDto[]; heartbeatSeconds: number }>(`/diagrams/${id}/presence`, {
      method: 'PUT',
      body: JSON.stringify({ sessionId }),
    }),
  /** Best effort, and `keepalive` so it still goes out while the tab is closing. */
  presenceLeave: (id: string, sessionId: string) =>
    request<void>(`/diagrams/${id}/presence/leave`, { method: 'POST', body: JSON.stringify({ sessionId }), keepalive: true }),
  getActiveStandard: (diagramTypeId: string) =>
    request<{ standard: StandardDto }>(`/diagram-types/${diagramTypeId}/standard`),
  listStandards: (diagramTypeId: string) =>
    request<{ standards: StandardDto[] }>(`/diagram-types/${diagramTypeId}/standards`),
  createStandard: (
    diagramTypeId: string,
    rules: Partial<StandardRulesDto> & { name?: string; description?: string | null },
  ) =>
    request<{ standard: StandardDto }>(`/diagram-types/${diagramTypeId}/standards`, {
      method: 'POST',
      body: JSON.stringify(rules),
    }),
  /** canvas-tfr: drafts only (409 otherwise). */
  updateStandard: (id: string, rules: StandardRulesDto & { name?: string; description?: string | null }) =>
    request<{ standard: StandardDto }>(`/standards/${id}`, { method: 'PUT', body: JSON.stringify(rules) }),
  cloneStandard: (id: string) => request<{ standard: StandardDto }>(`/standards/${id}/clone`, { method: 'POST' }),
  createDiagramType: (input: CustomDiagramTypeInput) =>
    request<{ diagramType: DiagramTypeDto }>('/admin/diagram-types', { method: 'POST', body: JSON.stringify(input) }),
  updateDiagramType: (id: string, patch: Partial<CustomDiagramTypeInput>) =>
    request<{ diagramType: DiagramTypeDto }>(`/admin/diagram-types/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  publishStandard: (id: string) => request<{ standard: StandardDto }>(`/standards/${id}/publish`, { method: 'POST' }),
  retireStandard: (id: string) => request<{ standard: StandardDto }>(`/standards/${id}/retire`, { method: 'POST' }),
  /** canvas-9ff: hidden types are left out unless `includeHidden` -- the create pickers want them
   *  out; the admin page and the project browser (labelling existing diagrams) want them in. */
  listDiagramTypes: (persona?: string, options: { includeHidden?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (persona) params.set('persona', persona);
    if (options.includeHidden) params.set('includeHidden', 'true');
    const query = params.toString();
    return request<{ diagramTypes: DiagramTypeDto[] }>(`/diagram-types${query ? `?${query}` : ''}`);
  },
  /** canvas-9ff: show or hide any diagram type (admin). */
  setDiagramTypeHidden: (id: string, hidden: boolean) =>
    request<{ diagramType: DiagramTypeDto }>(`/admin/diagram-types/${id}`, { method: 'PATCH', body: JSON.stringify({ hidden }) }),
  /** canvas-9ff: delete an unused custom diagram type (admin); 409 when built-in or in use. */
  deleteDiagramType: (id: string) => request<void>(`/admin/diagram-types/${id}`, { method: 'DELETE' }),
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
  listDiagramVersions: (diagramId: string, options: { limit?: number; q?: string; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.q) params.set('q', options.q);
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    const query = params.toString();
    return request<{ versions: DiagramVersionDto[]; hasMore: boolean }>(
      `/diagrams/${diagramId}/versions${query ? `?${query}` : ''}`,
    );
  },
  getDiagramVersion: (diagramId: string, versionId: string) =>
    request<{ version: DiagramVersionDetailDto }>(`/diagrams/${diagramId}/versions/${versionId}`),
  restoreDiagramVersion: (diagramId: string, versionId: string, baseVersionId: string) =>
    request<{ diagram: DiagramDto }>(`/diagrams/${diagramId}/versions/${versionId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ baseVersionId }),
    }),
  lookupUserByEmail: (email: string) =>
    request<{ user: { id: string; name: string; email: string } | null }>(`/users/lookup?email=${encodeURIComponent(email)}`),
  /** Active users whose name or email contains `q` (max 20) — the share picker (canvas-cyt). */
  searchUsers: (q: string) =>
    request<{ users: { id: string; name: string; email: string }[] }>(`/users/search?q=${encodeURIComponent(q)}`),
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
  /** Local auth only. The returned temporaryPassword is shown once and must not be stored. */
  createUser: (body: { email: string; name: string; role: string; personas?: string[] }) =>
    request<{ user: UserRecordDto; temporaryPassword: string }>('/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  resetUserPassword: (id: string) =>
    request<{ temporaryPassword: string }>(`/admin/users/${id}/reset-password`, { method: 'POST' }),
  unlockUser: (id: string) => request<{ unlocked: boolean }>(`/admin/users/${id}/unlock`, { method: 'POST' }),
  getAuditEvents: (options: { limit?: number; before?: string; userId?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.before) params.set('before', options.before);
    if (options.userId) params.set('userId', options.userId);
    return request<{ events: AuditEventDto[] }>(`/admin/audit?${params.toString()}`);
  },
  getAiUsage: (range: { from: string; to: string }) =>
    request<{ from: string; to: string; users: AiUsageUserDto[]; totals: AiUsageTotals }>(
      `/admin/ai-usage?${new URLSearchParams(range).toString()}`,
    ),
  getAiUsageForUser: (id: string, range: { from: string; to: string }) =>
    request<AiUsageDetailDto & { from: string; to: string }>(
      `/admin/ai-usage/users/${id}?${new URLSearchParams(range).toString()}`,
    ),
  getUserDeletionImpact: (id: string) =>
    request<{ ownedProjects: number; ownedDiagrams: number; sharesReceived: number; isLastActiveAdmin: boolean }>(
      `/admin/users/${id}/deletion-impact`,
    ),
  deleteUser: (id: string, transferToUserId?: string) =>
    request<{ deleted: true; transferredProjects: number; transferredDiagrams: number }>(`/admin/users/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(transferToUserId ? { transferToUserId } : {}),
    }),
  listComments: (diagramId: string) =>
    request<{ threads: CommentThreadDto[]; unread: number }>(`/diagrams/${diagramId}/comments`),
  getUnreadComments: (diagramId: string) => request<{ unread: number }>(`/diagrams/${diagramId}/comments/unread`),
  markCommentsRead: (diagramId: string) => request<void>(`/diagrams/${diagramId}/comments/read`, { method: 'POST' }),
  addComment: (diagramId: string, body: { body: string; threadRootId?: string; anchor?: CommentAnchor }) =>
    request<{ id: string; threads: CommentThreadDto[] }>(`/diagrams/${diagramId}/comments`, { method: 'POST', body: JSON.stringify(body) }),
  editComment: (diagramId: string, commentId: string, body: string) =>
    request<{ threads: CommentThreadDto[] }>(`/diagrams/${diagramId}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) }),
  deleteComment: (diagramId: string, commentId: string) =>
    request<{ threads: CommentThreadDto[] }>(`/diagrams/${diagramId}/comments/${commentId}`, { method: 'DELETE' }),
  resolveComment: (diagramId: string, commentId: string) =>
    request<{ threads: CommentThreadDto[] }>(`/diagrams/${diagramId}/comments/${commentId}/resolve`, { method: 'POST' }),
  reopenComment: (diagramId: string, commentId: string) =>
    request<{ threads: CommentThreadDto[] }>(`/diagrams/${diagramId}/comments/${commentId}/reopen`, { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ user: SessionUser }>('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
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
  /** canvas-s3o: `mode: 'plan'` = Create with AI's planning phase (the AI can talk but not draw). */
  sendChatMessage: (diagramId: string, body: { message: string; currentDslContent: string; personaId?: string; mode?: 'plan' | 'build' }) =>
    request<SendChatMessageResultDto>(`/diagrams/${diagramId}/chat/messages`, { method: 'POST', body: JSON.stringify(body) }),
  getChatMessages: (diagramId: string) => request<{ messages: ChatMessageDto[]; usageTotal?: ChatUsageTotalDto }>(`/diagrams/${diagramId}/chat/messages`),
  getAiSettings: () => request<AiSettingsDto>('/admin/ai-settings'),
  setAiSettings: (body: { chatEnabled?: boolean; showUsageToUsers?: boolean; modelId?: string | null }) =>
    request<AiSettingsDto>('/admin/ai-settings', { method: 'PATCH', body: JSON.stringify(body) }),
  /** canvas-wuc: any authenticated user, not just admins — read-only, mirrors listAiPersonas vs
   *  listAllAiPersonas' split. Used to gate the AI entry points (Create with AI, Chat panel)
   *  client-side before the user can even start typing, rather than only after a 503. */
  getMyAiUsage: () => request<MyAiUsageDto>('/me/ai-usage'),
  listAiPrices: () => request<{ prices: AiPriceDto[]; unpricedModels: Array<{ provider: string; modelId: string }> }>('/admin/ai-prices'),
  saveAiPrice: (body: AiPriceInput) =>
    request<{ prices: AiPriceDto[] }>('/admin/ai-prices', { method: 'PUT', body: JSON.stringify(body) }),
  deleteAiPrice: (provider: string, modelId: string) =>
    request<{ prices: AiPriceDto[] }>(`/admin/ai-prices?${new URLSearchParams({ provider, modelId }).toString()}`, { method: 'DELETE' }),
  listAiModels: () => request<AiModelsDto>('/admin/ai-models'),
  getAiStatus: () => request<AiSettingsDto>('/ai-settings'),
  getAppSettings: () => request<AppSettingsDto>('/app-settings'),
  setAppSettings: (body: Partial<AppSettingsDto>) =>
    request<AppSettingsDto>('/admin/app-settings', { method: 'PATCH', body: JSON.stringify(body) }),
  getGitHubStatus: () => request<GitHubStatusDto>('/admin/github/status'),
  /** Fetches the example workflow with the session cookie; returns the file text. */
  downloadGitHubWorkflowExample: async (): Promise<string> => {
    const path = '/admin/github/workflow-example';
    const response = await fetch(`${apiBaseUrl}${path}`, { credentials: 'include' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(body.error ?? `Request to ${path} failed with status ${response.status}`, response.status);
    }
    return response.text();
  },
  listGitHubRepositories: () => request<{ repositories: GitHubRepositoryDto[] }>('/admin/github/repositories'),
  listGitHubLinks: () => request<{ links: GitHubLinkDto[] }>('/admin/github/links'),
  testGitHubLink: (projectId: string) =>
    request<GitHubTestResultDto>(`/admin/github/links/${projectId}/test`, { method: 'POST' }),
  setGitHubLink: (projectId: string, body: { repoId: number; folder: string; baseBranch?: string }) =>
    request<{ link: GitHubLinkDto }>(`/projects/${projectId}/github-link`, { method: 'PUT', body: JSON.stringify(body) }),
  removeGitHubLink: (projectId: string) => request<void>(`/projects/${projectId}/github-link`, { method: 'DELETE' }),
  listAdminLibraries: () => request<{ libraries: AdminLibraryDto[] }>('/admin/libraries'),
  listAdminLibraryIcons: (id: string, version: string) =>
    request<{ icons: AdminIconDto[] }>(`/admin/libraries/${enc(id)}/${enc(version)}/icons`),
  importSvgLibrary: (body: { name: string; license?: string; icons: LibraryUploadIcon[] }) =>
    request<{ library: AdminLibraryDto; rejected: LibraryRejectedIcon[] }>('/admin/libraries/import-svg', { method: 'POST', body: JSON.stringify(body) }),
  importManifestLibrary: (body: { name?: string; manifest: unknown }) =>
    request<{ library: AdminLibraryDto }>('/admin/libraries/import-manifest', { method: 'POST', body: JSON.stringify(body) }),
  updateLibrary: (id: string, version: string, patch: { name?: string; license?: string | null }) =>
    request<void>(`/admin/libraries/${enc(id)}/${enc(version)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addLibraryIcons: (id: string, version: string, icons: LibraryUploadIcon[]) =>
    request<{ added: string[]; rejected: LibraryRejectedIcon[] }>(`/admin/libraries/${enc(id)}/${enc(version)}/icons`, { method: 'POST', body: JSON.stringify({ icons }) }),
  updateLibraryIcon: (id: string, version: string, iconId: string, patch: { displayName?: string; category?: string; keywords?: string[]; svg?: string }) =>
    request<void>(`/admin/libraries/${enc(id)}/${enc(version)}/icons/${enc(iconId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  setLibraryRetired: (id: string, version: string, retired: boolean) =>
    request<void>(`/admin/libraries/${enc(id)}/${enc(version)}/${retired ? 'retire' : 'restore'}`, { method: 'POST' }),
  setLibraryIconRetired: (id: string, version: string, iconId: string, retired: boolean) =>
    request<void>(`/admin/libraries/${enc(id)}/${enc(version)}/icons/${enc(iconId)}/${retired ? 'retire' : 'restore'}`, { method: 'POST' }),
  deleteLibrary: (id: string, version: string) => request<void>(`/admin/libraries/${enc(id)}/${enc(version)}`, { method: 'DELETE' }),
  deleteLibraryIcon: (id: string, version: string, iconId: string) =>
    request<void>(`/admin/libraries/${enc(id)}/${enc(version)}/icons/${enc(iconId)}`, { method: 'DELETE' }),
  setLibraryPalette: (id: string, diagramTypeIds: string[]) =>
    request<void>(`/admin/libraries/${enc(id)}/diagram-types`, { method: 'PUT', body: JSON.stringify({ diagramTypeIds }) }),
  getSubmissionStatus: (diagramId: string) => request<SubmissionStatusDto>(`/diagrams/${diagramId}/submission`),
  refreshSubmission: (diagramId: string) => request<SubmissionStatusDto>(`/diagrams/${diagramId}/submission/refresh`, { method: 'POST' }),
  withdrawSubmission: (diagramId: string) => request<SubmissionStatusDto>(`/diagrams/${diagramId}/submission/withdraw`, { method: 'POST' }),
  listSubmissions: (diagramId: string) => request<{ submissions: SubmissionHistoryItemDto[] }>(`/diagrams/${diagramId}/submissions`),
  getSubmissionBadges: (projectId: string) =>
    request<{ statuses: Record<string, SubmissionBadgeDto> }>(`/projects/${projectId}/submission-statuses`),
  submitDiagram: (diagramId: string) => request<SubmitResultDto>(`/diagrams/${diagramId}/submissions`, { method: 'POST' }),
};
