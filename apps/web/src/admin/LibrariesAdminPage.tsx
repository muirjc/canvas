import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type AdminIconDto,
  type AdminLibraryDto,
  type DiagramTypeDto,
  type LibraryRejectedIcon,
  type LibraryUsageDiagramDto,
} from '../app/api';
import { Modal } from '../ui/Modal';
import { LibraryImportDialog, RejectedList, SvgDraftList } from './LibraryImportDialog';
import { iconDataUri, parseKeywords, readSvgDrafts, toUploadIcons, type SvgDraft } from './library-svg';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message);
const key = (l: { id: string; version: string }) => `${l.id}@${l.version}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A failed delete: the message, plus the diagrams that block it when the server names them. */
interface DeleteFailure {
  message: string;
  diagrams: LibraryUsageDiagramDto[];
}
function toDeleteFailure(err: unknown): DeleteFailure {
  const diagrams = err instanceof ApiError && err.code === 'in_use' && Array.isArray(err.details) ? (err.details as LibraryUsageDiagramDto[]) : [];
  return { message: errorText(err), diagrams };
}
function DiagramLinks({ diagrams }: { diagrams: LibraryUsageDiagramDto[] }) {
  if (diagrams.length === 0) return null;
  return (
    <ul data-testid="library-in-use-diagrams">
      {diagrams.map((d) => (
        <li key={d.id}>
          <a href={`?projectId=${d.projectId}&diagramId=${d.id}`}>{d.name}</a>
        </li>
      ))}
    </ul>
  );
}

/**
 * canvas-3dq: Admin -> Libraries. The library list, and (in the same page, with a back link) one
 * library's icons. Built-in libraries can only be retired/restored and have their palette changed;
 * custom ones can be edited and, when no diagram uses them, deleted.
 */
export function LibrariesAdminPage() {
  const [libraries, setLibraries] = useState<AdminLibraryDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<AdminLibraryDto | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<DeleteFailure | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setLibraries((await api.listAdminLibraries()).libraries);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = libraries?.find((l) => key(l) === openKey) ?? null;

  const toggleRetired = async (library: AdminLibraryDto) => {
    setRowError(null);
    try {
      await api.setLibraryRetired(library.id, library.version, !library.retiredAt);
      await load();
    } catch (err) {
      setRowError(errorText(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteFailure(null);
    try {
      await api.deleteLibrary(deleting.id, deleting.version);
      setDeleting(null);
      await load();
    } catch (err) {
      setDeleteFailure(toDeleteFailure(err));
    }
  };

  if (open) {
    return (
      <LibraryDetail
        library={open}
        onBack={() => {
          setOpenKey(null);
          void load();
        }}
        onChanged={load}
      />
    );
  }

  return (
    <div className="stack library-page" data-testid="libraries-page">
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Libraries
      </h1>
      <p className="meta">
        Icon and shape libraries offered in the diagram palette. Built-in libraries ship with Canvas and can be retired or assigned to diagram types;
        custom libraries are yours to import, edit and delete.
      </p>
      {loadError && (
        <p role="alert" className="field__error" data-testid="libraries-load-error">
          {loadError}
        </p>
      )}
      <div className="row">
        <span className="spacer" />
        <button type="button" className="btn btn--primary btn--compact" data-testid="libraries-import" onClick={() => setImporting(true)}>
          Import library
        </button>
      </div>
      {rowError && (
        <p role="alert" className="field__error" data-testid="libraries-error">
          {rowError}
        </p>
      )}
      {libraries === null ? (
        <p className="state">Loading…</p>
      ) : libraries.length === 0 ? (
        <p className="state" data-testid="libraries-empty">
          No libraries yet.
        </p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Libraries">
          <table data-testid="libraries-table">
            <thead>
              <tr>
                <th scope="col">Library</th>
                <th scope="col">Icons</th>
                <th scope="col">Used by</th>
                <th scope="col">Offered in</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {libraries.map((library) => {
                const k = key(library);
                return (
                  <tr key={k} data-testid={`library-row-${k}`}>
                    <td className="library-cell--wrap">
                      <strong>{library.name}</strong>{' '}
                      <span className={library.origin === 'builtin' ? 'badge' : 'badge badge--success'} data-testid={`library-origin-${k}`}>
                        {library.origin === 'builtin' ? 'Built-in' : 'Custom'}
                      </span>
                      {library.retiredAt && (
                        <>
                          {' '}
                          <span className="badge badge--warning" data-testid={`library-retired-${k}`}>
                            Retired
                          </span>
                        </>
                      )}
                      <br />
                      <span className="meta mono">{k}</span>
                    </td>
                    <td data-testid={`library-icons-${k}`}>
                      {library.iconCount}
                      {library.retiredIconCount > 0 && <span className="meta"> ({library.retiredIconCount} retired)</span>}
                    </td>
                    <td data-testid={`library-used-${k}`}>{library.usedByDiagramCount === 0 ? <span className="meta">No diagrams</span> : `Used by ${plural(library.usedByDiagramCount, 'diagram')}`}</td>
                    <td className="library-cell--wrap library-offered">
                      {library.diagramTypes.length === 0 ? (
                        <span className="meta">No diagram types</span>
                      ) : (
                        library.diagramTypes.map((t) => t.name).join(', ')
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          data-testid={`library-open-${k}`}
                          aria-label={`Open ${library.name}`}
                          onClick={() => setOpenKey(k)}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          data-testid={`library-retire-${k}`}
                          aria-label={`${library.retiredAt ? 'Restore' : 'Retire'} ${library.name}`}
                          onClick={() => void toggleRetired(library)}
                        >
                          {library.retiredAt ? 'Restore' : 'Retire'}
                        </button>
                        {library.origin === 'custom' && (
                          <button
                            type="button"
                            className="btn btn--danger btn--compact"
                            data-testid={`library-delete-${k}`}
                            aria-label={`Delete ${library.name}`}
                            onClick={() => {
                              setDeleteFailure(null);
                              setDeleting(library);
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {importing && (
        <LibraryImportDialog
          onClose={() => {
            setImporting(false);
            void load();
          }}
          onImported={(library) => {
            setImporting(false);
            void load();
            setOpenKey(key(library));
          }}
        />
      )}

      {deleting && (
        <Modal
          label="Delete library"
          role="alertdialog"
          testId="library-delete-confirm"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="library-delete-cancel" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" data-testid="library-delete-confirm-button" onClick={() => void confirmDelete()}>
                Delete library
              </button>
            </>
          }
        >
          <p>
            Delete <strong>{deleting.name}</strong> and its {plural(deleting.iconCount, 'icon')}? This cannot be undone. A library that diagrams use cannot be deleted; retire it
            instead.
          </p>
          {deleteFailure && (
            <div role="alert" className="field__error" data-testid="library-delete-error">
              <p>{deleteFailure.message}</p>
              <DiagramLinks diagrams={deleteFailure.diagrams} />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function LibraryDetail({ library, onBack, onChanged }: { library: AdminLibraryDto; onBack: () => void; onChanged: () => Promise<void> }) {
  const custom = library.origin === 'custom';
  const k = key(library);
  const [icons, setIcons] = useState<AdminIconDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<AdminIconDto | null>(null);
  const [deleting, setDeleting] = useState<AdminIconDto | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<DeleteFailure | null>(null);
  const [adding, setAdding] = useState(false);

  const [name, setName] = useState(library.name);
  const [license, setLicense] = useState(library.license ?? '');
  const [metaMessage, setMetaMessage] = useState<string | null>(null);

  const [types, setTypes] = useState<DiagramTypeDto[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => new Set(library.diagramTypes.map((t) => t.id)));
  const [paletteMessage, setPaletteMessage] = useState<string | null>(null);

  const loadIcons = useCallback(async () => {
    try {
      setIcons((await api.listAdminLibraryIcons(library.id, library.version)).icons);
    } catch (err) {
      setError(errorText(err));
    }
  }, [library.id, library.version]);

  useEffect(() => {
    void loadIcons();
    api.listDiagramTypes(undefined, { includeHidden: true }).then(({ diagramTypes }) => setTypes(diagramTypes)).catch((e) => setError(errorText(e)));
  }, [loadIcons]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (icons ?? []).filter((icon) => {
      if (icon.retiredAt && !showRetired) return false;
      if (!q) return true;
      return [icon.displayName, icon.id, icon.category, ...icon.keywords].some((t) => t.toLowerCase().includes(q));
    });
  }, [icons, query, showRetired]);

  const saveMeta = async () => {
    setMetaMessage(null);
    try {
      await api.updateLibrary(library.id, library.version, { name: name.trim(), license: license.trim() || null });
      setMetaMessage('Saved.');
      await onChanged();
    } catch (err) {
      setMetaMessage(errorText(err));
    }
  };

  const savePalette = async () => {
    setPaletteMessage(null);
    try {
      await api.setLibraryPalette(library.id, [...selectedTypes]);
      setPaletteMessage('Palette saved.');
      await onChanged();
    } catch (err) {
      setPaletteMessage(errorText(err));
    }
  };

  const toggleIconRetired = async (icon: AdminIconDto) => {
    setError(null);
    try {
      await api.setLibraryIconRetired(library.id, library.version, icon.id, !icon.retiredAt);
      await Promise.all([loadIcons(), onChanged()]);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const confirmDeleteIcon = async () => {
    if (!deleting) return;
    setDeleteFailure(null);
    try {
      await api.deleteLibraryIcon(library.id, library.version, deleting.id);
      setDeleting(null);
      await Promise.all([loadIcons(), onChanged()]);
    } catch (err) {
      setDeleteFailure(toDeleteFailure(err));
    }
  };

  return (
    <div className="stack library-page" data-testid="library-detail">
      <p className="meta">
        <button type="button" className="btn btn--tertiary btn--compact" data-testid="library-back" onClick={onBack}>
          Back to libraries
        </button>
      </p>
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        {library.name}
      </h1>
      <p className="meta">
        <span className="mono">{k}</span> · {custom ? 'Custom' : 'Built-in'}
        {library.retiredAt && <> · <span className="badge badge--warning">Retired</span></>}
      </p>
      {error && (
        <p role="alert" className="field__error" data-testid="library-error">
          {error}
        </p>
      )}

      <section className="card stack library-section" aria-labelledby="library-details-heading">
        <h2 id="library-details-heading" className="section-label">
          Details
        </h2>
        <div className="field">
          <label className="field__label" htmlFor="library-name">
            Name
          </label>
          <input id="library-name" data-testid="library-name" value={name} disabled={!custom} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="library-license">
            License
          </label>
          <input id="library-license" data-testid="library-license" value={license} disabled={!custom} onChange={(e) => setLicense(e.target.value)} />
        </div>
        {custom ? (
          <div className="row">
            <button type="button" className="btn btn--primary btn--compact" data-testid="library-meta-save" disabled={!name.trim()} onClick={() => void saveMeta()}>
              Save details
            </button>
            {metaMessage && <span role="status" data-testid="library-meta-message">{metaMessage}</span>}
          </div>
        ) : (
          <p className="meta">Built-in libraries ship with Canvas, so their name, license and icons are read-only. You can retire them or change where they are offered.</p>
        )}
      </section>

      <section className="card stack library-section" aria-labelledby="library-palette-heading">
        <h2 id="library-palette-heading" className="section-label">
          Offered in these diagram types
        </h2>
        <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="visually-hidden">Diagram types that show this library in their palette</legend>
          {types.map((t) => (
            <label key={t.id} className="cluster cluster--tight">
              <input
                type="checkbox"
                data-testid={`library-palette-${t.id}`}
                checked={selectedTypes.has(t.id)}
                onChange={(e) =>
                  setSelectedTypes((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(t.id);
                    else next.delete(t.id);
                    return next;
                  })
                }
              />
              {t.name}
            </label>
          ))}
        </fieldset>
        <p className="meta">
          Changing the palette of a built-in diagram type marks it as edited, so a Canvas update no longer resets its palette to the default.
        </p>
        <div className="row">
          <button type="button" className="btn btn--primary btn--compact" data-testid="library-palette-save" onClick={() => void savePalette()}>
            Save palette
          </button>
          {paletteMessage && <span role="status" data-testid="library-palette-message">{paletteMessage}</span>}
        </div>
      </section>

      <section className="stack" aria-labelledby="library-icons-heading">
        <div className="row">
          <h2 id="library-icons-heading" className="section-label">
            Icons
          </h2>
          <span className="spacer" />
          {custom && (
            <button type="button" className="btn btn--primary btn--compact" data-testid="library-add-icons" onClick={() => setAdding(true)}>
              Add icons
            </button>
          )}
        </div>
        <div className="row">
          <input
            type="search"
            data-testid="library-search"
            aria-label="Search icons"
            placeholder="Search icons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="cluster cluster--tight">
            <input type="checkbox" data-testid="library-show-retired" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
            Show retired
          </label>
        </div>
        {icons === null ? (
          <p className="state">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="state" data-testid="library-icons-empty">
            {icons.length === 0 ? 'This library has no icons.' : 'No icons match.'}
          </p>
        ) : (
          <ul className="library-grid" data-testid="library-icon-grid">
            {visible.map((icon) => (
              <li key={icon.id} className="card library-tile" data-testid={`library-icon-${icon.id}`}>
                <img className="library-tile__art" src={iconDataUri(icon.assetRef)} alt="" width={48} height={48} />
                <strong className="library-tile__name">{icon.displayName}</strong>
                <span className="meta">{icon.category}</span>
                {icon.keywords.length > 0 && <span className="meta">{icon.keywords.join(', ')}</span>}
                <span className="meta" data-testid={`library-icon-used-${icon.id}`}>
                  {icon.usedByDiagramCount === 0 ? 'Not used' : `Used by ${plural(icon.usedByDiagramCount, 'diagram')}`}
                </span>
                {icon.retiredAt && (
                  <span className="badge badge--warning" data-testid={`library-icon-retired-${icon.id}`}>
                    Retired
                  </span>
                )}
                <div className="cluster cluster--tight">
                  <button
                    type="button"
                    className="btn btn--secondary btn--compact"
                    data-testid={`library-icon-retire-${icon.id}`}
                    aria-label={`${icon.retiredAt ? 'Restore' : 'Retire'} ${icon.displayName}`}
                    onClick={() => void toggleIconRetired(icon)}
                  >
                    {icon.retiredAt ? 'Restore' : 'Retire'}
                  </button>
                  {custom && (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary btn--compact"
                        data-testid={`library-icon-edit-${icon.id}`}
                        aria-label={`Edit ${icon.displayName}`}
                        onClick={() => setEditing(icon)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger btn--compact"
                        data-testid={`library-icon-delete-${icon.id}`}
                        aria-label={`Delete ${icon.displayName}`}
                        onClick={() => {
                          setDeleteFailure(null);
                          setDeleting(icon);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <IconEditDialog
          library={library}
          icon={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void loadIcons();
          }}
        />
      )}
      {adding && (
        <AddIconsDialog
          library={library}
          onClose={() => {
            setAdding(false);
            void Promise.all([loadIcons(), onChanged()]);
          }}
        />
      )}
      {deleting && (
        <Modal
          label="Delete icon"
          role="alertdialog"
          testId="library-icon-delete-confirm"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" data-testid="library-icon-delete-confirm-button" onClick={() => void confirmDeleteIcon()}>
                Delete icon
              </button>
            </>
          }
        >
          <p>
            Delete <strong>{deleting.displayName}</strong>? This cannot be undone. An icon that diagrams use cannot be deleted; retire it instead.
          </p>
          {deleteFailure && (
            <div role="alert" className="field__error" data-testid="library-icon-delete-error">
              <p>{deleteFailure.message}</p>
              <DiagramLinks diagrams={deleteFailure.diagrams} />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function IconEditDialog({ library, icon, onClose, onSaved }: { library: AdminLibraryDto; icon: AdminIconDto; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(icon.displayName);
  const [category, setCategory] = useState(icon.category);
  const [keywords, setKeywords] = useState(icon.keywords.join(', '));
  const [replacement, setReplacement] = useState<SvgDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.updateLibraryIcon(library.id, library.version, icon.id, {
        displayName: displayName.trim(),
        category: category.trim(),
        keywords: parseKeywords(keywords),
        ...(replacement && !replacement.error ? { svg: replacement.svg } : {}),
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <Modal label={`Edit ${icon.displayName}`} testId="library-icon-edit-dialog" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="field">
          <label className="field__label" htmlFor="library-icon-edit-name">
            Name
          </label>
          <input id="library-icon-edit-name" data-testid="library-icon-edit-name" value={displayName} required maxLength={120} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="library-icon-edit-category">
            Category
          </label>
          <input id="library-icon-edit-category" data-testid="library-icon-edit-category" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="library-icon-edit-keywords">
            Keywords (comma separated)
          </label>
          <input id="library-icon-edit-keywords" data-testid="library-icon-edit-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="library-icon-edit-file">
            Replace artwork (optional .svg file)
          </label>
          <input
            id="library-icon-edit-file"
            data-testid="library-icon-edit-file"
            type="file"
            accept=".svg,image/svg+xml"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return setReplacement(null);
              void readSvgDrafts([file]).then(([d]) => setReplacement(d));
            }}
          />
          {replacement?.error && (
            <p role="alert" className="field__error">
              {replacement.error}
            </p>
          )}
          {replacement?.preview && <img src={iconDataUri(replacement.preview)} alt="Preview of the new artwork" width={48} height={48} />}
        </div>
        {error && (
          <p role="alert" className="field__error" data-testid="library-icon-edit-error">
            {error}
          </p>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" data-testid="library-icon-edit-save" disabled={saving || !displayName.trim() || Boolean(replacement?.error)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddIconsDialog({ library, onClose }: { library: AdminLibraryDto; onClose: () => void }) {
  const [drafts, setDrafts] = useState<SvgDraft[]>([]);
  const [rejected, setRejected] = useState<LibraryRejectedIcon[]>([]);
  const [added, setAdded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const usable = toUploadIcons(drafts).length;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.addLibraryIcons(library.id, library.version, toUploadIcons(drafts));
      setAdded(result.added.length);
      setRejected(result.rejected);
      if (result.rejected.length === 0) onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      label="Add icons"
      wide
      testId="library-add-dialog"
      onClose={onClose}
      footer={
        added !== null ? (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" data-testid="library-add-save" disabled={saving || usable === 0} onClick={() => void save()}>
              {saving ? 'Adding…' : 'Add icons'}
            </button>
          </>
        )
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor="library-add-files">
            SVG files
          </label>
          <input
            id="library-add-files"
            data-testid="library-add-files"
            type="file"
            accept=".svg,image/svg+xml"
            multiple
            onChange={(e) => void readSvgDrafts(Array.from(e.target.files ?? [])).then(setDrafts)}
          />
        </div>
        {added !== null && <p role="status">Added {plural(added, 'icon')}.</p>}
        {added === null && drafts.length > 0 && <SvgDraftList drafts={drafts} onChange={setDrafts} />}
        <RejectedList rejected={rejected} />
        {error && (
          <p role="alert" className="field__error" data-testid="library-add-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
