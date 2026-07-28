import { useEffect, useState } from 'react';
import { api, type DiagramDto, type SessionUser } from './api';
import { LoginForm } from './LoginForm';
import { AppShell } from './AppShell';
import { DiagramEditor } from './DiagramEditor';
import { NewDiagramDialog } from './NewDiagramDialog';
import { StandardsEditor } from '../admin/StandardsEditor';
import { UsersPage } from '../admin/UsersPage';
import { AdminOverview } from '../admin/AdminOverview';
import { DeletedDiagramsPage } from '../admin/DeletedDiagramsPage';
import { ProjectBrowser } from '../projects/ProjectBrowser';
import { ImportDialog } from '../projects/ImportDialog';
import { CreateViaChatDialog } from '../ai/CreateViaChatDialog';
import { PersonaAdminPage } from '../ai/PersonaAdminPage';
import { Icon } from '../ui/Icon';

// The root project to browse/create diagrams in is supplied via a query param — a full
// multi-project chooser is out of scope for this reference implementation.
function getProjectIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('projectId');
}

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const [diagram, setDiagram] = useState<DiagramDto | null>(null);
  const [pickingType, setPickingType] = useState(false);
  const [importing, setImporting] = useState(false);
  const [creatingViaChat, setCreatingViaChat] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setCheckedSession(true));
  }, []);

  const createDiagram = async (diagramTypeId: string) => {
    setPickingType(false);
    const projectId = getProjectIdFromUrl();
    if (!projectId) {
      setError('Missing ?projectId= in the URL — create a project first (User Story 4).');
      return;
    }
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

  const adminParam = new URLSearchParams(window.location.search).get('admin');
  const projectId = getProjectIdFromUrl();

  if (!checkedSession) return <p>Loading…</p>;
  if (!user) return <LoginForm onSuccess={(loggedInUser) => setUser(loggedInUser)} />;

  const handleSignOut = () => {
    setUser(null);
    setDiagram(null);
    setPickingType(false);
    setImporting(false);
    setCreatingViaChat(false);
    setError(null);
  };

  let content: React.ReactNode;
  if (adminParam && user.role === 'admin') {
    if (adminParam === 'users') content = <UsersPage />;
    else if (adminParam === 'overview') content = <AdminOverview />;
    else if (adminParam === 'deleted') content = <DeletedDiagramsPage />;
    else if (adminParam === 'ai-personas') content = <PersonaAdminPage />;
    else content = <StandardsEditor diagramTypeId="flowchart" />;
  } else if (diagram) {
    content = <DiagramEditor diagram={diagram} />;
  } else {
    content = (
      <main className="page">
        <h1 className="page__title">Diagrams</h1>
        <div className="home__actions">
          <button type="button" className="btn btn--primary" data-testid="new-diagram" onClick={() => setPickingType(true)}>
            <Icon name="plus" />
            New Diagram
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="import-diagram-button"
            onClick={() => {
              if (!projectId) {
                setError('Missing ?projectId= in the URL — create a project first (User Story 4).');
                return;
              }
              setImporting(true);
            }}
          >
            <Icon name="download" />
            Import Diagram
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="create-via-ai-chat"
            onClick={() => {
              if (!projectId) {
                setError('Missing ?projectId= in the URL — create a project first (User Story 4).');
                return;
              }
              setCreatingViaChat(true);
            }}
          >
            <Icon name="sparkle" />
            Create with AI
          </button>
        </div>
        {error && (
          <p role="alert" data-testid="app-error">
            {error}
          </p>
        )}
        {projectId && <ProjectBrowser rootProjectId={projectId} onOpenDiagram={openDiagram} />}
        {user.role === 'admin' && (
          <nav className="home__admin" aria-label="Admin">
            <span className="section-label">Admin</span>
            <a data-testid="admin-overview-link" href="?admin=overview">
              Overview
            </a>
            <a data-testid="admin-console-link" href="?admin=true">
              Standards
            </a>
            <a data-testid="admin-users-link" href="?admin=users">
              Users
            </a>
            <a data-testid="admin-deleted-diagrams-link" href="?admin=deleted">
              Deleted Diagrams
            </a>
            <a data-testid="admin-ai-personas-link" href="?admin=ai-personas">
              AI Personas
            </a>
          </nav>
        )}
      </main>
    );
  }

  return (
    <AppShell user={user} onSignOut={handleSignOut}>
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
    </AppShell>
  );
}
