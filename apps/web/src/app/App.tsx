import { useEffect, useRef, useState } from 'react';
import { api, type AiSettingsDto, type DiagramDto, type ProjectDto, type SessionUser, type SharedDiagramDto } from './api';
import { LoginForm } from './LoginForm';
import { AppShell } from './AppShell';
import { DiagramEditor, type DiagramEditorHandle } from './DiagramEditor';
import { NewDiagramDialog } from './NewDiagramDialog';
import { ProjectPicker } from './ProjectPicker';
import { withProjectContext } from './project-context';
import {
  isBareAddress,
  locationToSearch,
  parseLocation,
  readLastProjectId,
  resolveLanding,
  sameLocation,
  writeLastProjectId,
  type Location,
} from './navigation';
import { StandardsAdminPage } from '../admin/StandardsAdminPage';
import { UsersPage } from '../admin/UsersPage';
import { AdminOverview } from '../admin/AdminOverview';
import { DeletedDiagramsPage } from '../admin/DeletedDiagramsPage';
import { DeletedProjectsPage } from '../admin/DeletedProjectsPage';
import { ProjectBrowser } from '../projects/ProjectBrowser';
import { ProjectsPage } from '../projects/ProjectsPage';
import { SharedDiagramsList } from '../projects/SharedDiagramsList';
import { ImportDialog } from '../projects/ImportDialog';
import { ImportTemplateDialog } from '../projects/ImportTemplateDialog';
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
  // canvas-ltm: open the editor's Chat tab when Create with AI involved a back-and-forth.
  const [openDiagramOnChat, setOpenDiagramOnChat] = useState(false);
  useEffect(() => {
    // Only the diagram Create with AI just opened gets the Chat tab; any later open starts on DSL.
    if (!diagram) setOpenDiagramOnChat(false);
  }, [diagram]);
  const [pickingType, setPickingType] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingTemplate, setImportingTemplate] = useState(false);
  const [creatingViaChat, setCreatingViaChat] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // canvas-t3b.2: where the user is -- one value read from and written to the address, replacing
  // the global "current project" (docs/browse-screen-design.md §1-§3). navigate() is the only way
  // it changes; the browser's Back/Forward re-read it (popstate).
  const [location, setLocation] = useState<Location>(() => parseLocation(window.location.search));
  const locationRef = useRef(location);
  // Landing rules apply once, to a bare address (design decisions 1-2).
  const landingPending = useRef(isBareAddress(window.location.search));
  // A navigation waiting on the "leave without saving?" confirm; viaHistory = it came from Back/Forward.
  const [pendingNav, setPendingNav] = useState<{ to: Location; viaHistory: boolean } | null>(null);
  const skipGuardOnce = useRef(false);
  // Set by user-made navigations so the next screen's heading takes focus (canvas-t3b.3).
  const focusAfterNavigation = useRef(false);
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  // Diagrams shared directly with this user, independent of project access (feature 008,
  // FR-001/FR-002). Fetched alongside — not gated on — the project list, since a user with zero
  // projects still needs to see this.
  const [sharedDiagrams, setSharedDiagrams] = useState<SharedDiagramDto[]>([]);
  const [sharedLoaded, setSharedLoaded] = useState(false);
  // canvas-wuc: gates the "Create with AI" button client-side (chatEnabled) and warns when the
  // configured provider is the mock/placeholder one, rather than only surfacing either as a 503
  // after the user has already typed a request. `null` while unknown — kept enabled during that
  // brief window rather than flashing disabled-then-enabled on every load.
  const [aiStatus, setAiStatus] = useState<AiSettingsDto | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
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

  // The projects this user can see. Which one (if any) they're in comes from the address
  // (location), checked against this list below.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .listProjects()
      .then(({ projects: available }) => {
        if (!cancelled) setProjects(available);
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
      })
      .finally(() => {
        if (!cancelled) setSharedLoaded(true);
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

  const adminParam = new URLSearchParams(window.location.search).get('admin');

  /** Shows a location without touching the address (the address is already right, or written by
   *  the caller). */
  const applyLocation = (to: Location) => {
    locationRef.current = to;
    setLocation(to);
  };

  const urlFor = (to: Location) => {
    const search = locationToSearch(to);
    return `${window.location.pathname}${search === '?' ? '' : search}`;
  };

  /**
   * The one way screens change (design §3). Leaving an editor with unsaved changes asks first --
   * read synchronously via ref (canvas-eow) -- unless `force`. Pushes a history entry so Back goes
   * up a level (design §2); `replace` for redirects that shouldn't be returnable to.
   */
  const navigate = (to: Location, options: { replace?: boolean; force?: boolean } = {}) => {
    const from = locationRef.current;
    if (!options.force && from.screen === 'diagram' && !sameLocation(from, to) && diagramEditorRef.current?.hasUnsavedChanges()) {
      setPendingNav({ to, viaHistory: false });
      return;
    }
    if (options.replace) window.history.replaceState(null, '', urlFor(to));
    else if (!sameLocation(from, to)) {
      window.history.pushState(null, '', urlFor(to));
      focusAfterNavigation.current = true;
    }
    setError(null);
    applyLocation(to);
  };

  // Back/Forward: show what the address now names. A popstate can't be cancelled, so leaving a
  // dirty editor this way puts the editor's address back and asks; confirming goes back again.
  useEffect(() => {
    const onPopState = () => {
      const to = parseLocation(window.location.search);
      const from = locationRef.current;
      if (skipGuardOnce.current) {
        skipGuardOnce.current = false;
      } else if (from.screen === 'diagram' && !sameLocation(from, to) && diagramEditorRef.current?.hasUnsavedChanges()) {
        window.history.pushState(null, '', urlFor(from));
        setPendingNav({ to, viaHistory: true });
        return;
      }
      setError(null);
      focusAfterNavigation.current = true;
      applyLocation(to);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // Registered once: applyLocation/urlFor only use refs, state setters and window.
  }, []);

  // Closing or reloading the tab with unsaved changes gets the browser's own prompt (design §2).
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (locationRef.current.screen === 'diagram' && diagramEditorRef.current?.hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // A deep link opened in a fresh tab: put the top level underneath it, so Back goes up within the
  // app rather than leaving it (design §2).
  useEffect(() => {
    if (window.history.length !== 1 || adminParam || parseLocation(window.location.search).screen === 'projects') return;
    const deepLink = window.location.href;
    window.history.replaceState(null, '', window.location.pathname);
    window.history.pushState(null, '', deepLink);
  }, []);

  // A bare address lands per the landing rules, once the projects and shared diagrams are known.
  useEffect(() => {
    if (!landingPending.current || projects === null || !sharedLoaded) return;
    landingPending.current = false;
    if (locationRef.current.screen !== 'projects') return; // the user already went somewhere
    const landing = resolveLanding(projects.map((p) => p.id), sharedDiagrams.length, readLastProjectId());
    if (landing.screen !== 'projects') navigate(landing, { replace: true, force: true });
  }, [projects, sharedLoaded, sharedDiagrams]);

  // An address naming a project that is gone, or was never theirs: say so and show the top level
  // rather than a dead screen (feature 007 FR-013). A project that is theirs -- however it was
  // reached, link included -- becomes the landing hint for next time (design decision 2).
  useEffect(() => {
    if (projects === null || adminParam || location.screen !== 'project') return;
    if (projects.some((p) => p.id === location.projectId)) {
      writeLastProjectId(location.projectId);
      return;
    }
    navigate({ screen: 'projects' }, { replace: true, force: true });
    setError('That project is not available to you. Showing your projects instead.');
  }, [projects, location]);

  // The open diagram follows the address: fetched for ?diagramId= (a link or a reload), dropped on
  // any other screen. A diagram the user can't open shows the top level with an error.
  useEffect(() => {
    if (location.screen !== 'diagram') {
      setDiagram(null);
      return;
    }
    if (!user || diagram?.id === location.diagramId) return;
    let cancelled = false;
    api
      .getDiagram(location.diagramId)
      .then(({ diagram: loaded }) => {
        if (!cancelled) setDiagram(loaded);
      })
      .catch(() => {
        if (cancelled) return;
        navigate({ screen: 'projects' }, { replace: true, force: true });
        setError('That diagram is not available to you.');
      });
    return () => {
      cancelled = true;
    };
  }, [location, user, diagram?.id]);

  /** The project in view: the one a project screen shows, or the open diagram's. */
  const currentProjectId =
    location.screen === 'project' ? location.projectId : location.screen === 'diagram' ? (diagram?.projectId ?? null) : null;
  const currentProject = (projects ?? []).find((p) => p.id === currentProjectId) ?? null;

  // canvas-t3b.3: each screen names itself in the tab title -- the cheapest reliable cue for a
  // screen-reader user that the view changed (design: Accessibility and focus).
  useEffect(() => {
    const name =
      location.screen === 'diagram' ? diagram?.name : location.screen === 'project' ? currentProject?.name : 'Projects';
    document.title = name ? `${name} – Canvas` : 'Canvas';
  }, [location, diagram?.name, currentProject?.name]);

  // After a navigation the user made (a click, Back/Forward -- never the first load or a redirect),
  // move focus to the new screen's <h1>, so the screen reader announces where the user is instead
  // of focus falling to <body> with the button that was clicked. Retried briefly because a screen
  // may render its heading a moment later.
  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    let attempts = 0;
    let timer: number | undefined;
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>('[data-browse-heading]');
      if (heading) heading.focus();
      else if (attempts++ < 10) timer = window.setTimeout(focusHeading, 50);
    };
    focusHeading();
    // A further navigation mid-retry must not let this one's timer steal focus later.
    return () => window.clearTimeout(timer);
  }, [location]);

  /** Opens a diagram the app already has (just created or imported) without fetching it again. */
  const showDiagram = (loaded: DiagramDto) => {
    setDiagram(loaded);
    navigate({ screen: 'diagram', diagramId: loaded.id });
  };

  const confirmPendingNav = () => {
    const pending = pendingNav;
    setPendingNav(null);
    if (!pending) return;
    if (pending.viaHistory) {
      // The editor's address was put back on top of the destination; step back onto it.
      skipGuardOnce.current = true;
      window.history.back();
    } else {
      navigate(pending.to, { force: true });
    }
  };

  const createDiagram = async (diagramTypeId: string) => {
    // The guard runs BEFORE the picker closes. It used to run after, so a failure threw away the
    // diagram type the user had just chosen and made them pick again (FR-003).
    if (!currentProjectId) {
      setError('Choose or create a project first.');
      return;
    }
    setPickingType(false);
    try {
      const { diagram: created } = await api.createDiagram(currentProjectId, { name: 'Untitled Diagram', diagramTypeId });
      showDiagram(created);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openDiagram = (diagramId: string) => navigate({ screen: 'diagram', diagramId });

  const createFirstProject = async (name: string) => {
    try {
      const { project } = await api.createProject({ name });
      setProjects((current) => [...(current ?? []), project]);
      setCreatingProject(false);
      navigate({ screen: 'project', projectId: project.id });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!checkedSession) return <p>Loading…</p>;
  if (!user) return <LoginForm onSuccess={(loggedInUser) => setUser(loggedInUser)} />;

  const handleSignOut = () => {
    setUser(null);
    setDiagram(null);
    setPickingType(false);
    setImporting(false);
    setImportingTemplate(false);
    setCreatingViaChat(false);
    setError(null);
    setProjects(null);
    setSharedLoaded(false);
    setPendingNav(null);
    // Signing back in starts from a bare address again, landing rules included.
    window.history.replaceState(null, '', window.location.pathname);
    landingPending.current = true;
    applyLocation({ screen: 'projects' });
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
    else adminScreen = <StandardsAdminPage />;
    // Wrapping here rather than inside each screen is what centres and navigates all five
    // without any of them being edited (research §10).
    content = (
      <AdminShell activeParam={adminParam === 'true' ? 'standards' : adminParam} projectId={currentProjectId}>
        {adminScreen}
      </AdminShell>
    );
  } else if (
    (location.screen === 'projects' && (projects === null || (landingPending.current && !sharedLoaded))) ||
    (location.screen === 'diagram' && diagram?.id !== location.diagramId)
  ) {
    // Waiting for the project list (or, on a bare address, what to land on), or the diagram.
    content = (
      <main className="page">
        <p className="state" aria-busy="true">
          Loading…
        </p>
      </main>
    );
  } else if (location.screen === 'projects' && !hasNoProjects) {
    content = (
      <>
        {error && (
          <p role="alert" className="page" data-testid="app-error">
            {error}
          </p>
        )}
        <ProjectsPage
          projects={projects ?? []}
          currentUser={user}
          onCreated={(project) => {
            setProjects((current) => [...(current ?? []), project]);
            navigate({ screen: 'project', projectId: project.id });
          }}
          onRenamed={(renamedProjectId, name) => {
            setProjects((current) => current?.map((p) => (p.id === renamedProjectId ? { ...p, name } : p)) ?? current);
          }}
          onDeleted={(deletedProjectId) => {
            setProjects((current) => current?.filter((p) => p.id !== deletedProjectId) ?? current);
            if (readLastProjectId() === deletedProjectId) writeLastProjectId(null);
          }}
          onViewDiagrams={(viewProjectId) => navigate({ screen: 'project', projectId: viewProjectId })}
          sharedDiagrams={sharedDiagrams}
          onOpenDiagram={openDiagram}
          projectHref={(id) => urlFor({ screen: 'project', projectId: id })}
        />
      </>
    );
  } else if (location.screen === 'diagram' && diagram) {
    // (Only reached once `diagram` is the one the address names -- see the loading branch above.)
    // The back button names where it goes (design §7): the diagram's project when the user can
    // see it -- taken from the diagram as it is now, so it's right after a Move -- else Projects.
    const diagramProject = (projects ?? []).find((p) => p.id === diagram.projectId);
    content = (
      <DiagramEditor
        diagram={diagram}
        ref={diagramEditorRef}
        backLabel={diagramProject ? diagramProject.name : 'Projects'}
        onRequestClose={() =>
          navigate(diagramProject ? { screen: 'project', projectId: diagramProject.id } : { screen: 'projects' })
        }
        initialRailTab={openDiagramOnChat ? 'chat' : 'dsl'}
      />
    );
  } else {
    content = (
      <main className="page">
        {location.screen === 'project' ? (
          <>
            {/* canvas-t3b.3: where you are, and the way back up (design: project level). */}
            <nav className="project-browser__breadcrumb" data-testid="project-browser-breadcrumb" aria-label="Breadcrumb">
              <ol>
                <li>
                  <a
                    href={urlFor({ screen: 'projects' })}
                    data-testid="project-browser-breadcrumb-back"
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      navigate({ screen: 'projects' });
                    }}
                  >
                    Projects
                  </a>
                </li>
                <li aria-current="page" data-testid="project-browser-breadcrumb-current">
                  {currentProject?.name ?? 'Project'}
                </li>
              </ol>
            </nav>
            <h1 className="page__title" tabIndex={-1} data-browse-heading>
              {currentProject?.name ?? 'Project'}
            </h1>
          </>
        ) : (
          // The top level for a user with no projects (design: zero-projects states).
          <h1 className="page__title" tabIndex={-1} data-browse-heading>
            Projects
          </h1>
        )}

        {/* The top level only: a user with zero projects still needs to see this (feature 008,
            FR-002); omitted entirely, not shown empty, when nothing is shared. A user with
            projects sees it on the project list (ProjectsPage). */}
        {location.screen !== 'project' && sharedDiagrams.length > 0 && (
          <SharedDiagramsList diagrams={sharedDiagrams} onOpenDiagram={openDiagram} />
        )}

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
              data-testid="import-template-button"
              onClick={() => setImportingTemplate(true)}
            >
              <Icon name="upload" />
              Import from Template
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
        {location.screen === 'project' && (
          <ProjectBrowser
            rootProjectId={location.projectId}
            projects={projects ?? []}
            onOpenDiagram={openDiagram}
          />
        )}
        {user.role === 'admin' && (
          <nav className="home__admin" aria-label="Admin">
            <span className="section-label">Admin</span>
            {/* Built through withProjectContext so the project survives the hop. These links being
                absolute query-string replacements is exactly how the context was lost — on the way
                IN to the admin console, one hop before the back link that gets blamed for it. */}
            <a data-testid="admin-overview-link" href={withProjectContext({ admin: 'overview' }, currentProjectId)}>
              Overview
            </a>
            <a data-testid="admin-console-link" href={withProjectContext({ admin: 'standards' }, currentProjectId)}>
              Standards
            </a>
            <a data-testid="admin-users-link" href={withProjectContext({ admin: 'users' }, currentProjectId)}>
              Users
            </a>
            <a data-testid="admin-deleted-diagrams-link" href={withProjectContext({ admin: 'deleted' }, currentProjectId)}>
              Deleted Diagrams
            </a>
            <a data-testid="admin-ai-personas-link" href={withProjectContext({ admin: 'ai-personas' }, currentProjectId)}>
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
          <ProjectPicker
            projects={projects}
            currentProjectId={currentProjectId}
            onSelect={(selected) => navigate({ screen: 'project', projectId: selected })}
          />
        ) : null
      }
      projectsLink={
        projects !== null ? (
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            data-testid="view-projects"
            onClick={() => navigate({ screen: 'projects' })}
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
      {importing && currentProjectId && (
        <ImportDialog
          projectId={currentProjectId}
          onImported={(imported) => {
            setImporting(false);
            showDiagram(imported);
          }}
          onCancel={() => setImporting(false)}
        />
      )}
      {importingTemplate && currentProjectId && (
        <ImportTemplateDialog
          projectId={currentProjectId}
          onImported={(imported) => {
            setImportingTemplate(false);
            showDiagram(imported);
          }}
          onCancel={() => setImportingTemplate(false)}
        />
      )}
      {creatingViaChat && currentProjectId && (
        <CreateViaChatDialog
          projectId={currentProjectId}
          onCreated={(created, { openChat }) => {
            setCreatingViaChat(false);
            setOpenDiagramOnChat(openChat);
            showDiagram(created);
          }}
          onCancel={() => setCreatingViaChat(false)}
        />
      )}
      {/* canvas-t3b.2: the one unsaved-changes confirm, for every way out of the editor -- its
          buttons, the header, and the browser's Back/Forward. */}
      {pendingNav && (
        <Modal
          role="alertdialog"
          label="Unsaved changes"
          title={null}
          testId="home-nav-confirm"
          onClose={() => setPendingNav(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="cancel-home-nav" onClick={() => setPendingNav(null)}>
                Keep editing
              </button>
              <button type="button" className="btn btn--primary" data-testid="confirm-home-nav" onClick={confirmPendingNav}>
                Discard and leave
              </button>
            </>
          }
        >
          <p>This diagram has unsaved changes. Leaving will discard them.</p>
        </Modal>
      )}
    </AppShell>
  );
}
