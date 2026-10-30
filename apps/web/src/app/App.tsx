import { useEffect, useRef, useState } from 'react';
import { accessAtLeast, api, type AiSettingsDto, type DiagramDto, type ProjectDto, type SessionUser, type SharedDiagramDto } from './api';
import { LoginForm } from './LoginForm';
import { ChangePasswordPage } from './ChangePasswordPage';
import { MfaSetup } from './MfaSetup';
import { MyAiUsage } from '../ai/MyAiUsage';
import { AppShell } from './AppShell';
import { DiagramEditor, type DiagramEditorHandle } from './DiagramEditor';
import { NewDiagramDialog } from './NewDiagramDialog';
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
import { AuditLogPage } from '../admin/AuditLogPage';
import { AiUsagePage } from '../admin/AiUsagePage';
import { GitHubAdminPage } from '../admin/GitHubAdminPage';
import { LibrariesAdminPage } from '../admin/LibrariesAdminPage';
import { AdminOverview } from '../admin/AdminOverview';
import { DeletedDiagramsPage } from '../admin/DeletedDiagramsPage';
import { DeletedProjectsPage } from '../admin/DeletedProjectsPage';
import { ProjectBrowser } from '../projects/ProjectBrowser';
import { ProjectsPage } from '../projects/ProjectsPage';
import { ImportDialog } from '../projects/ImportDialog';
import { ImportTemplateDialog } from '../projects/ImportTemplateDialog';
import { CreateViaChatDialog } from '../ai/CreateViaChatDialog';
import { PersonaAdminPage } from '../ai/PersonaAdminPage';
import { Icon } from '../ui/Icon';
import { ADMIN_DESTINATIONS, AdminShell } from '../ui/AdminShell';
import { Modal } from '../ui/Modal';
import { CopyLinkButton } from '../ui/CopyLinkButton';
import { MembersDialog } from '../projects/MembersDialog';
import { AI_CHAT_DISABLED_MESSAGE } from '../ai/ai-status-messages';

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
  // canvas-eow: read synchronously at switch-time via ref, not mirrored into a parent useState —
  // see DiagramEditorHandle's doc comment for why the mirrored-state version was a genuine race.
  const diagramEditorRef = useRef<DiagramEditorHandle>(null);

  // canvas-ao2: Entra sign-in returns with ?signin=sso. Landing signed out after it means the
  // browser dropped the session cookie -- the sign-in page says so. The marker is removed at once.
  const [ssoCookieBlocked, setSsoCookieBlocked] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cameFromSso = params.get('signin') === 'sso';
    if (cameFromSso) {
      params.delete('signin');
      const search = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
    }
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => {
        setUser(null);
        if (cameFromSso) setSsoCookieBlocked(true);
      })
      .finally(() => setCheckedSession(true));
  }, []);

  // canvas-ez1.6: nothing loads while a forced step (one-time password change, MFA set-up) is
  // showing -- the API refuses it then, and that refusal used to stay on screen after the step
  // (found in the live check). The effects below re-run once the step clears (`user` changes).
  const signedInFully = Boolean(user && !user.mustChangePassword && !user.mustEnrollMfa);

  // canvas-2h2w.2: the project page's Members dialog.
  const [showingMembers, setShowingMembers] = useState(false);

  // The projects this user can see. Which one (if any) they're in comes from the address
  // (location), checked against this list below.
  useEffect(() => {
    if (!signedInFully) return;
    let cancelled = false;
    api
      .listProjects()
      .then(({ projects: available }) => {
        if (cancelled) return;
        setProjects(available);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [user, signedInFully]);

  // Diagrams shared directly with this user (feature 008, FR-001). Independent of the project
  // list above — it must populate even for a user with zero project access.
  useEffect(() => {
    if (!signedInFully) return;
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
  }, [user, signedInFully]);

  // canvas-wuc: whether AI chat is admin-enabled, and which provider is actually configured.
  useEffect(() => {
    if (!signedInFully) return;
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
  }, [user, signedInFully]);

  // canvas-513: the admin page being shown (?admin=...), as state rather than re-read from the
  // address on each render. Entering admin is a full page load (a plain link); leaving it is an
  // in-app navigation that clears this -- before, navigate() saw the admin address as "already on
  // the project list" (no projectId), changed nothing, and the header's Projects link did nothing.
  const [adminParam, setAdminParamState] = useState<string | null>(() => new URLSearchParams(window.location.search).get('admin'));
  const adminParamRef = useRef(adminParam);
  const setAdminParam = (value: string | null) => {
    adminParamRef.current = value;
    setAdminParamState(value);
  };

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
    // Leaving an admin page is always a navigation, even to the same Browse location (canvas-513).
    const leavingAdmin = adminParamRef.current !== null;
    if (options.replace) window.history.replaceState(null, '', urlFor(to));
    else if (leavingAdmin || !sameLocation(from, to)) {
      window.history.pushState(null, '', urlFor(to));
      focusAfterNavigation.current = true;
    }
    if (leavingAdmin) setAdminParam(null);
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
      // Back/Forward may land on (or leave) an admin page's history entry (canvas-513).
      setAdminParam(new URLSearchParams(window.location.search).get('admin'));
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
    // canvas-2h2w.1: every project is listed now; landing only considers the user's own (owned or
    // member), so "your only project" still means yours, not the only one in the installation.
    const mine = projects.filter((p) => p.membership !== null).map((p) => p.id);
    const landing = resolveLanding(mine, sharedDiagrams.length, readLastProjectId());
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
    if (adminParam && user?.role === 'admin') {
      // canvas-4pw: admin pages name themselves too.
      const page = ADMIN_DESTINATIONS.find((d) => d.param === (adminParam === 'true' ? 'standards' : adminParam));
      document.title = `${page?.label ?? 'Standards'} – Admin – Canvas`;
      return;
    }
    const name =
      location.screen === 'diagram'
        ? diagram?.name
        : location.screen === 'project'
          ? currentProject?.name
          : location.screen === 'account'
            ? 'Change password'
            : 'Projects';
    document.title = name ? `${name} – Canvas` : 'Canvas';
  }, [location, diagram?.name, currentProject?.name, adminParam, user?.role]);

  // ?account=password only exists for Canvas-password accounts; for anyone else show the top level.
  useEffect(() => {
    if (user && !user.localAccount && location.screen === 'account') navigate({ screen: 'projects' }, { replace: true, force: true });
  }, [user, location]);

  // A forced password change names itself too.
  useEffect(() => {
    if (user?.mustChangePassword) document.title = 'Change password – Canvas';
    else if (user?.mustEnrollMfa) document.title = 'Two-step verification – Canvas';
  }, [user?.mustChangePassword, user?.mustEnrollMfa]);

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
  }, [location, adminParam]);

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

  if (!checkedSession) return <p>Loading…</p>;
  if (!user) return <LoginForm ssoCookieBlocked={ssoCookieBlocked} onSuccess={(loggedInUser) => setUser(loggedInUser)} />;

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
    setAdminParam(null);
    setPendingNav(null);
    // Signing back in starts from a bare address again, landing rules included.
    window.history.replaceState(null, '', window.location.pathname);
    landingPending.current = true;
    applyLocation({ screen: 'projects' });
  };


  // Signed in with a one-time password: nothing else is reachable (the API refuses it too), so
  // render only the change-password step in a minimal shell.
  if (user.mustChangePassword) {
    return (
      <AppShell user={user} onSignOut={handleSignOut} currentSection={null} projectsHref="" onNavigateProjects={() => {}} minimal>
        <ChangePasswordPage forced onChanged={(updated) => setUser(updated)} />
      </AppShell>
    );
  }

  // After the password change: set up two-step verification before anything else.
  if (user.mustEnrollMfa) {
    return (
      <AppShell user={user} onSignOut={handleSignOut} currentSection={null} projectsHref="" onNavigateProjects={() => {}} minimal>
        <MfaSetup forced mfaEnabled={false} onDone={(updated) => setUser(updated)} />
      </AppShell>
    );
  }

  let content: React.ReactNode;
  if (adminParam && user.role === 'admin') {
    let adminScreen: React.ReactNode;
    if (adminParam === 'users') adminScreen = <UsersPage />;
    else if (adminParam === 'overview') adminScreen = <AdminOverview />;
    else if (adminParam === 'deleted') adminScreen = <DeletedDiagramsPage />;
    else if (adminParam === 'deleted-projects') adminScreen = <DeletedProjectsPage />;
    else if (adminParam === 'ai-usage') adminScreen = <AiUsagePage />;
    else if (adminParam === 'audit') adminScreen = <AuditLogPage />;
    else if (adminParam === 'libraries') adminScreen = <LibrariesAdminPage />;
    else if (adminParam === 'github') adminScreen = <GitHubAdminPage />;
    else if (adminParam === 'ai-personas') adminScreen = <PersonaAdminPage />;
    else adminScreen = <StandardsAdminPage />;
    // Wrapping here rather than inside each screen is what centres and navigates all five
    // without any of them being edited (research §10).
    content = (
      <AdminShell activeParam={adminParam === 'true' ? 'standards' : adminParam}>
        {adminScreen}
      </AdminShell>
    );
  } else if (location.screen === 'account' && user.localAccount) {
    content = (
      <ChangePasswordPage
        forced={false}
        onChanged={(updated) => setUser(updated)}
        projectsHref={urlFor({ screen: 'projects' })}
        onNavigateProjects={() => navigate({ screen: 'projects' })}
      >
        <MyAiUsage />
        <MfaSetup forced={false} mfaEnabled={!!user.mfaEnabled} onDone={(updated) => setUser(updated)} />
      </ChangePasswordPage>
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
  } else if (location.screen === 'projects') {
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
        currentUser={user}
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
        <div className="cluster">
          <h1 className="page__title" tabIndex={-1} data-browse-heading>
            {currentProject?.name ?? 'Project'}
          </h1>
          <span className="spacer" />
          {location.screen === 'project' && (
            <>
              <button type="button" className="btn btn--secondary btn--compact" data-testid="open-members" onClick={() => setShowingMembers(true)}>
                <Icon name="share" />
                Members
              </button>
              <CopyLinkButton to={{ screen: 'project', projectId: location.projectId }} testId="copy-project-link" />
            </>
          )}
        </div>

        {/* canvas-2h2w.1: every project is readable; adding to it needs Edit. */}
        {!accessAtLeast(currentProject?.accessLevel ?? 'edit', 'edit') ? (
          <p className="meta" data-testid="project-read-only-note">
            You can read this project. Ask its owner to add you if you need to change it.
          </p>
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
          </div>
        )}

        {error && (
          <p role="alert" data-testid="app-error">
            {error}
          </p>
        )}
        {location.screen === 'project' && showingMembers && user && (
          <MembersDialog
            projectId={location.projectId}
            projectName={currentProject?.name ?? 'Project'}
            currentUser={user}
            onClose={() => setShowingMembers(false)}
            onAccessChanged={() => api.listProjects().then(({ projects: available }) => setProjects(available)).catch(() => undefined)}
          />
        )}
        {location.screen === 'project' && (
          <ProjectBrowser
            rootProjectId={location.projectId}
            projects={projects ?? []}
            onOpenDiagram={openDiagram}
          />
        )}
      </main>
    );
  }

  return (
    <AppShell
      user={user}
      onSignOut={handleSignOut}
      // canvas-t3b.4: the header names its sections, no project (design §4).
      currentSection={
        adminParam && user.role === 'admin'
          ? 'admin'
          : location.screen === 'diagram'
            ? null
            : location.screen === 'account'
              ? 'account'
              : 'browse'
      }
      accountHref={urlFor({ screen: 'account' })}
      onNavigateAccount={() => navigate({ screen: 'account' })}
      projectsHref={urlFor({ screen: 'projects' })}
      onNavigateProjects={() => navigate({ screen: 'projects' })}
    >
      {content}
      {/* Dialogs render alongside the current screen rather than replacing it, so the context
          behind them stays visible (FR-016). They are native <dialog> elements opened with
          showModal(), so they overlay everything regardless of where they sit in the tree. */}
      {pickingType && <NewDiagramDialog userPersonas={user.personas} onCreate={createDiagram} onCancel={() => setPickingType(false)} />}
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
          userPersonas={user.personas}
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
          mockMode={aiStatus?.provider === 'mock'}
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
