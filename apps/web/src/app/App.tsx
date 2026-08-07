import { useEffect, useRef, useState } from 'react';
import { api, type AiSettingsDto, type DiagramDto, type ProjectDto, type SessionUser, type SharedDiagramDto } from './api';
import { LoginForm } from './LoginForm';
import { AppShell } from './AppShell';
import { DiagramEditor, type DiagramEditorHandle } from './DiagramEditor';
import { NewDiagramDialog } from './NewDiagramDialog';
import { ProjectPicker } from './ProjectPicker';
import { readProjectIdFromUrl, syncProjectIdToUrl, withProjectContext } from './project-context';
import { StandardsEditor } from '../admin/StandardsEditor';
import { UsersPage } from '../admin/UsersPage';
import { AdminOverview } from '../admin/AdminOverview';
import { DeletedDiagramsPage } from '../admin/DeletedDiagramsPage';
import { DeletedProjectsPage } from '../admin/DeletedProjectsPage';
import { ProjectBrowser } from '../projects/ProjectBrowser';
import { ProjectsPage } from '../projects/ProjectsPage';
import { SharedDiagramsList } from '../projects/SharedDiagramsList';
import { ImportDialog } from '../projects/ImportDialog';
import { CreateViaChatDialog } from '../ai/CreateViaChatDialog';
import { PersonaAdminPage } from '../ai/PersonaAdminPage';
import { Icon } from '../ui/Icon';
import { AdminShell } from '../ui/AdminShell';
import { Modal } from '../ui/Modal';
import { AI_CHAT_DISABLED_MESSAGE, AI_MOCK_MODE_MESSAGE } from '../ai/ai-status-messages';

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const [diagram, setDiagram] = useState<DiagramDto | null>(null);
  const [pickingType, setPickingType] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creatingViaChat, setCreatingViaChat] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The project the user is working in. Seeded from the address so existing links keep working
  // (FR-016), then held in application state so navigation cannot discard it (FR-005) — which is
  // the whole defect this feature fixes.
  const [projectId, setProjectId] = useState<string | null>(() => readProjectIdFromUrl());
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  // Diagrams shared directly with this user, independent of project access (feature 008,
  // FR-001/FR-002). Fetched alongside — not gated on — the project list, since a user with zero
  // projects still needs to see this.
  const [sharedDiagrams, setSharedDiagrams] = useState<SharedDiagramDto[]>([]);
  // canvas-wuc: gates the "Create with AI" button client-side (chatEnabled) and warns when the
  // configured provider is the mock/placeholder one, rather than only surfacing either as a 503
  // after the user has already typed a request. `null` while unknown — kept enabled during that
  // brief window rather than flashing disabled-then-enabled on every load.
  const [aiStatus, setAiStatus] = useState<AiSettingsDto | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [confirmingHome, setConfirmingHome] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  // canvas-228.1: a third navigation destination alongside "go home" and "switch project", with
  // its own pending-confirm state rather than folding into either — it needs the exact same
  // unsaved-changes guard, but lands somewhere else (the new Projects screen, not the current
  // project's diagram list).
  const [viewingProjects, setViewingProjects] = useState(false);
  const [confirmingViewProjects, setConfirmingViewProjects] = useState(false);
  // canvas-eow: read synchronously at switch-time via ref, not mirrored into a parent useState —
  // see DiagramEditorHandle's doc comment for why the mirrored-state version was a genuine race.
  const diagramEditorRef = useRef<DiagramEditorHandle>(null);

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setCheckedSession(true));
  }, []);

  // Resolve which project to work in, once we know who the user is: the one the address names if
  // it is actually available to them, else the only one they have, else the first. Never invent
  // one (FR-015).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .listProjects()
      .then(({ projects: available }) => {
        if (cancelled) return;
        setProjects(available);
        setProjectId((current) => {
          if (current && available.some((p) => p.id === current)) return current;
          if (current) {
            // An address naming a project that is gone, or was never theirs. Say so and leave
            // them somewhere usable rather than on a dead screen (FR-013).
            setError('That project is not available to you. Showing your projects instead.');
          }
          return available[0]?.id ?? null;
        });
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Diagrams shared directly with this user (feature 008, FR-001). Independent of the project
  // list above — it must populate even for a user with zero project access.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .listSharedDiagrams()
      .then(({ diagrams }) => {
        if (!cancelled) setSharedDiagrams(diagrams);
      })
      .catch(() => {
        if (!cancelled) setSharedDiagrams([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // canvas-wuc: whether AI chat is admin-enabled, and which provider is actually configured.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .getAiStatus()
      .then((status) => {
        if (!cancelled) setAiStatus(status);
      })
      .catch(() => {
        // Unreachable/erroring is treated the same as "unknown" — the button stays enabled and
        // simply surfaces its own error if actually clicked, same as before this bead.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Keep the address naming the project in view so a copied link opens it (FR-011), without
  // adding a history entry per switch (FR-012).
  useEffect(() => {
    if (projects === null) return; // don't strip a valid id from the address before it is checked
    syncProjectIdToUrl(projectId);
  }, [projectId, projects]);

  const applyProjectChange = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    setDiagram(null);
    setError(null);
  };

  const requestProjectChange = (nextProjectId: string) => {
    if (nextProjectId === projectId) return;
    // Never discard unsaved work silently (FR-013d). Read synchronously via ref — see
    // DiagramEditorHandle's doc comment for why a mirrored parent state was a genuine race.
    if (diagram && diagramEditorRef.current?.hasUnsavedChanges()) {
      setPendingProjectId(nextProjectId);
      return;
    }
    applyProjectChange(nextProjectId);
  };

  /** Closes the open diagram back to the project browser, staying in the same project — the
   *  same unsaved-changes guard as switching project, since discarding work silently is exactly
   *  as wrong here as it is there. */
  const requestGoHome = () => {
    if (diagram && diagramEditorRef.current?.hasUnsavedChanges()) {
      setConfirmingHome(true);
      return;
    }
    setDiagram(null);
    setError(null);
  };

  /** canvas-228.1: reaches the new Projects screen, guarded exactly like requestGoHome. */
  const requestViewProjects = () => {
    if (diagram && diagramEditorRef.current?.hasUnsavedChanges()) {
      setConfirmingViewProjects(true);
      return;
    }
    setDiagram(null);
    setError(null);
    setViewingProjects(true);
  };

  const createDiagram = async (diagramTypeId: string) => {
    // The guard runs BEFORE the picker closes. It used to run after, so a failure threw away the
    // diagram type the user had just chosen and made them pick again (FR-003).
    if (!projectId) {
      setError('Choose or create a project first.');
      return;
    }
    setPickingType(false);
    try {
      const { diagram } = await api.createDiagram(projectId, { name: 'Untitled Diagram', diagramTypeId });
      setDiagram(diagram);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openDiagram = async (diagramId: string) => {
    try {
      const { diagram } = await api.getDiagram(diagramId);
      setDiagram(diagram);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const createFirstProject = async (name: string) => {
    try {
      const { project } = await api.createProject({ name });
      setProjects((current) => [...(current ?? []), project]);
      setProjectId(project.id);
      setCreatingProject(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const adminParam = new URLSearchParams(window.location.search).get('admin');

  if (!checkedSession) return <p>Loading…</p>;
  if (!user) return <LoginForm onSuccess={(loggedInUser) => setUser(loggedInUser)} />;

  const handleSignOut = () => {
    setUser(null);
    setDiagram(null);
    setPickingType(false);
    setImporting(false);
    setCreatingViaChat(false);
    setError(null);
    setProjects(null);
    setProjectId(null);
  };

  const hasNoProjects = projects !== null && projects.length === 0;

  let content: React.ReactNode;
  if (adminParam && user.role === 'admin') {
    let adminScreen: React.ReactNode;
    if (adminParam === 'users') adminScreen = <UsersPage />;
    else if (adminParam === 'overview') adminScreen = <AdminOverview />;
    else if (adminParam === 'deleted') adminScreen = <DeletedDiagramsPage />;
    else if (adminParam === 'deleted-projects') adminScreen = <DeletedProjectsPage />;
    else if (adminParam === 'ai-personas') adminScreen = <PersonaAdminPage />;
    else adminScreen = <StandardsEditor diagramTypeId="flowchart" />;
    // Wrapping here rather than inside each screen is what centres and navigates all five
    // without any of them being edited (research §10).
    content = (
      <AdminShell activeParam={adminParam} projectId={projectId}>
        {adminScreen}
      </AdminShell>
    );
  } else if (viewingProjects) {
    content = (
      <ProjectsPage
        projects={projects ?? []}
        currentUser={user}
        onCreated={(project) => {
          setProjects((current) => [...(current ?? []), project]);
          setProjectId(project.id);
          setViewingProjects(false);
        }}
        onRenamed={(renamedProjectId, name) => {
          setProjects((current) => current?.map((p) => (p.id === renamedProjectId ? { ...p, name } : p)) ?? current);
        }}
        onDeleted={(deletedProjectId) => {
          const remaining = (projects ?? []).filter((p) => p.id !== deletedProjectId);
          setProjects(remaining);
          // The current project just got deleted out from under the user — same "never invent
          // one, fall back to the first available" rule the initial project-resolution effect
          // already uses (App.tsx's own useEffect for user/projects above).
          if (projectId === deletedProjectId) {
            setDiagram(null);
            setProjectId(remaining[0]?.id ?? null);
          }
        }}
        onViewDiagrams={(viewProjectId) => {
          applyProjectChange(viewProjectId);
          setViewingProjects(false);
        }}
        onClose={() => setViewingProjects(false)}
      />
    );
  } else if (diagram) {
    content = <DiagramEditor diagram={diagram} ref={diagramEditorRef} onRequestClose={requestGoHome} />;
  } else {
    content = (
      <main className="page">
        <h1 className="page__title">Diagrams</h1>

        {/* Rendered independent of hasNoProjects below — a user with zero projects still needs
            to see this (feature 008, FR-002). Omitted entirely, not shown empty, when there is
            nothing shared (FR-002's clarified behavior). */}
        {sharedDiagrams.length > 0 && <SharedDiagramsList diagrams={sharedDiagrams} onOpenDiagram={openDiagram} />}

        {hasNoProjects && sharedDiagrams.length > 0 ? null : hasNoProjects ? (
          /* No projects: invite, never invent. Reachable two ways — an empty installation, and a
             user who owns nothing and has been given nothing, which is newly possible now that
             visibility is access-controlled (FR-014, FR-015). Suppressed entirely — not shown
             alongside the shared list — for a user who has no projects but does have a diagram
             shared with them (feature 008, FR-003): the invitation would otherwise misinform them
             they have no work, immediately above a list proving otherwise. */
          <section className="empty-state" data-testid="create-first-project">
            <p>You do not have any projects yet. Create one to start drawing diagrams.</p>
            {creatingProject ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = new FormData(event.currentTarget).get('projectName');
                  const name = String(input ?? '').trim();
                  if (name) void createFirstProject(name);
                }}
              >
                <label htmlFor="new-project-name">Project name</label>{' '}
                <input id="new-project-name" name="projectName" data-testid="new-project-name" required />{' '}
                <button type="submit" className="btn btn--primary" data-testid="confirm-create-project">
                  Create Project
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                data-testid="start-create-project"
                onClick={() => setCreatingProject(true)}
              >
                <Icon name="plus" />
                Create Project
              </button>
            )}
          </section>
        ) : (
          <div className="home__actions">
            <button type="button" className="btn btn--primary" data-testid="new-diagram" onClick={() => setPickingType(true)}>
              <Icon name="plus" />
              New Diagram
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="import-diagram-button"
              onClick={() => setImporting(true)}
            >
              <Icon name="download" />
              Import Diagram
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="create-via-ai-chat"
              disabled={aiStatus?.chatEnabled === false}
              title={aiStatus?.chatEnabled === false ? AI_CHAT_DISABLED_MESSAGE : undefined}
              onClick={() => setCreatingViaChat(true)}
            >
              <Icon name="sparkle" />
              Create with AI
            </button>
            {aiStatus?.chatEnabled === false && (
              <span className="meta" data-testid="create-via-ai-disabled-note">
                {AI_CHAT_DISABLED_MESSAGE}
              </span>
            )}
            {aiStatus?.provider === 'mock' && (
              <span className="meta" data-testid="ai-mock-mode-note" title={AI_MOCK_MODE_MESSAGE}>
                {AI_MOCK_MODE_MESSAGE}
              </span>
            )}
          </div>
        )}

        {error && (
          <p role="alert" data-testid="app-error">
            {error}
          </p>
        )}
        {projectId && (
          <ProjectBrowser
            rootProjectId={projectId}
            projects={projects ?? []}
            onOpenDiagram={openDiagram}
            onBackToProjects={requestViewProjects}
          />
        )}
        {user.role === 'admin' && (
          <nav className="home__admin" aria-label="Admin">
            <span className="section-label">Admin</span>
            {/* Built through withProjectContext so the project survives the hop. These links being
                absolute query-string replacements is exactly how the context was lost — on the way
                IN to the admin console, one hop before the back link that gets blamed for it. */}
            <a data-testid="admin-overview-link" href={withProjectContext({ admin: 'overview' }, projectId)}>
              Overview
            </a>
            <a data-testid="admin-console-link" href={withProjectContext({ admin: 'true' }, projectId)}>
              Standards
            </a>
            <a data-testid="admin-users-link" href={withProjectContext({ admin: 'users' }, projectId)}>
              Users
            </a>
            <a data-testid="admin-deleted-diagrams-link" href={withProjectContext({ admin: 'deleted' }, projectId)}>
              Deleted Diagrams
            </a>
            <a data-testid="admin-ai-personas-link" href={withProjectContext({ admin: 'ai-personas' }, projectId)}>
              AI Personas
            </a>
          </nav>
        )}
      </main>
    );
  }

  return (
    <AppShell
      user={user}
      onSignOut={handleSignOut}
      projectPicker={
        projects !== null && projects.length > 0 ? (
          <ProjectPicker projects={projects} currentProjectId={projectId} onSelect={requestProjectChange} />
        ) : null
      }
      projectsLink={
        projects !== null ? (
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            data-testid="view-projects"
            onClick={requestViewProjects}
          >
            Projects
          </button>
        ) : null
      }
    >
      {content}
      {/* Dialogs render alongside the current screen rather than replacing it, so the context
          behind them stays visible (FR-016). They are native <dialog> elements opened with
          showModal(), so they overlay everything regardless of where they sit in the tree. */}
      {pickingType && <NewDiagramDialog onCreate={createDiagram} onCancel={() => setPickingType(false)} />}
      {importing && projectId && (
        <ImportDialog
          projectId={projectId}
          onImported={(imported) => {
            setImporting(false);
            setDiagram(imported);
          }}
          onCancel={() => setImporting(false)}
        />
      )}
      {creatingViaChat && projectId && (
        <CreateViaChatDialog
          projectId={projectId}
          onCreated={(created) => {
            setCreatingViaChat(false);
            setDiagram(created);
          }}
          onCancel={() => setCreatingViaChat(false)}
        />
      )}
      {pendingProjectId && (
        <Modal
          role="alertdialog"
          label="Unsaved changes"
          title={null}
          testId="project-switch-confirm"
          onClose={() => setPendingProjectId(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="cancel-project-switch"
                onClick={() => setPendingProjectId(null)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="confirm-project-switch"
                onClick={() => {
                  applyProjectChange(pendingProjectId);
                  setPendingProjectId(null);
                }}
              >
                Discard and switch
              </button>
            </>
          }
        >
          <p>This diagram has unsaved changes. Switching project will discard them.</p>
        </Modal>
      )}
      {confirmingHome && (
        <Modal
          role="alertdialog"
          label="Unsaved changes"
          title={null}
          testId="home-nav-confirm"
          onClose={() => setConfirmingHome(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="cancel-home-nav"
                onClick={() => setConfirmingHome(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="confirm-home-nav"
                onClick={() => {
                  setDiagram(null);
                  setError(null);
                  setConfirmingHome(false);
                }}
              >
                Discard and leave
              </button>
            </>
          }
        >
          <p>This diagram has unsaved changes. Returning to Diagrams will discard them.</p>
        </Modal>
      )}
      {confirmingViewProjects && (
        <Modal
          role="alertdialog"
          label="Unsaved changes"
          title={null}
          testId="view-projects-confirm"
          onClose={() => setConfirmingViewProjects(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="cancel-view-projects"
                onClick={() => setConfirmingViewProjects(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="confirm-view-projects"
                onClick={() => {
                  setDiagram(null);
                  setError(null);
                  setViewingProjects(true);
                  setConfirmingViewProjects(false);
                }}
              >
                Discard and leave
              </button>
            </>
          }
        >
          <p>This diagram has unsaved changes. Viewing Projects will discard them.</p>
        </Modal>
      )}
    </AppShell>
  );
}
