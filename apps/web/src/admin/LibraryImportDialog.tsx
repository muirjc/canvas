import { useState } from 'react';
import { api, ApiError, type AdminLibraryDto, type LibraryRejectedIcon } from '../app/api';
import { Modal } from '../ui/Modal';
import { iconDataUri, readSvgDrafts, toUploadIcons, type SvgDraft } from './library-svg';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message);

/** Per-icon cards (preview, or the file's error) with editable name/category/keywords. */
export function SvgDraftList({ drafts, onChange }: { drafts: SvgDraft[]; onChange: (drafts: SvgDraft[]) => void }) {
  const update = (index: number, patch: Partial<SvgDraft>) => onChange(drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  return (
    <ul className="library-draft-list" data-testid="library-import-previews">
      {drafts.map((draft, index) => (
        <li key={draft.key} className="card library-draft" data-testid={`library-import-preview-${index}`}>
          {draft.error ? (
            <div className="library-draft__art library-draft__art--error" aria-hidden="true">
              !
            </div>
          ) : (
            <img className="library-draft__art" src={iconDataUri(draft.preview ?? '')} alt={`Preview of ${draft.fileName}`} width={48} height={48} />
          )}
          <div className="stack library-draft__fields">
            <span className="meta mono">{draft.fileName}</span>
            {draft.error ? (
              <p role="alert" className="field__error" data-testid={`library-import-error-${index}`}>
                {draft.error} This file will not be imported.
              </p>
            ) : (
              <>
                <label className="field__label" htmlFor={`library-import-name-${index}`}>
                  Name
                </label>
                <input
                  id={`library-import-name-${index}`}
                  data-testid={`library-import-name-${index}`}
                  value={draft.displayName}
                  maxLength={120}
                  onChange={(e) => update(index, { displayName: e.target.value })}
                />
                <label className="field__label" htmlFor={`library-import-category-${index}`}>
                  Category
                </label>
                <input
                  id={`library-import-category-${index}`}
                  value={draft.category}
                  maxLength={60}
                  placeholder="General"
                  onChange={(e) => update(index, { category: e.target.value })}
                />
                <label className="field__label" htmlFor={`library-import-keywords-${index}`}>
                  Keywords (comma separated)
                </label>
                <input id={`library-import-keywords-${index}`} value={draft.keywords} onChange={(e) => update(index, { keywords: e.target.value })} />
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RejectedList({ rejected }: { rejected: LibraryRejectedIcon[] }) {
  if (rejected.length === 0) return null;
  return (
    <div role="alert" className="field__error" data-testid="library-import-rejected">
      <p>These files were not imported:</p>
      <ul>
        {rejected.map((r) => (
          <li key={r.fileName}>
            <span className="mono">{r.fileName}</span>: {r.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ManifestInfo {
  fileName: string;
  manifest?: unknown;
  id?: string;
  version?: string;
  iconCount?: number;
  error?: string;
}

async function readManifest(file: File): Promise<ManifestInfo> {
  if (file.size > 50 * 1024 * 1024) return { fileName: file.name, error: 'The file is too large.' };
  try {
    const manifest = JSON.parse(await file.text()) as { id?: unknown; version?: unknown; icons?: unknown };
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || !Array.isArray(manifest.icons)) {
      return { fileName: file.name, error: 'A manifest needs an id, a version and an icons list.' };
    }
    if (manifest.icons.length === 0) return { fileName: file.name, error: 'The manifest has no icons.' };
    return { fileName: file.name, manifest, id: manifest.id, version: manifest.version, iconCount: manifest.icons.length };
  } catch {
    return { fileName: file.name, error: "This isn't valid JSON." };
  }
}

interface Props {
  onClose: () => void;
  /** Called with the new library once saved. */
  onImported: (library: AdminLibraryDto) => void;
}

/** canvas-3dq: import a custom library from SVG files or from a manifest. */
export function LibraryImportDialog({ onClose, onImported }: Props) {
  const [mode, setMode] = useState<'svg' | 'manifest'>('svg');
  const [name, setName] = useState('');
  const [license, setLicense] = useState('');
  const [drafts, setDrafts] = useState<SvgDraft[]>([]);
  const [manifest, setManifest] = useState<ManifestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<LibraryRejectedIcon[]>([]);
  const [saving, setSaving] = useState(false);
  // When the server refused some files, the library already exists: offer "Open library".
  const [created, setCreated] = useState<AdminLibraryDto | null>(null);

  const usable = toUploadIcons(drafts).length;
  const canSave = !saving && (mode === 'svg' ? name.trim().length > 0 && usable > 0 : Boolean(manifest?.manifest));

  const save = async () => {
    setSaving(true);
    setError(null);
    setRejected([]);
    try {
      if (mode === 'svg') {
        const result = await api.importSvgLibrary({ name: name.trim(), ...(license.trim() ? { license: license.trim() } : {}), icons: toUploadIcons(drafts) });
        if (result.rejected.length > 0) {
          // Show what the server refused before moving on; the admin continues from there.
          setRejected(result.rejected);
          setCreated(result.library);
        } else onImported(result.library);
      } else {
        const result = await api.importManifestLibrary({ ...(name.trim() ? { name: name.trim() } : {}), manifest: manifest!.manifest });
        onImported(result.library);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      label="Import library"
      wide
      testId="library-import-dialog"
      onClose={onClose}
      footer={
        created ? (
          <button type="button" className="btn btn--primary" data-testid="library-import-open" onClick={() => onImported(created)}>
            Open library
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--secondary" data-testid="library-import-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" data-testid="library-import-save" disabled={!canSave} onClick={() => void save()}>
              {saving ? 'Importing…' : 'Import'}
            </button>
          </>
        )
      }
    >
      <div className="stack">
        {created ? (
          <p role="status" data-testid="library-import-created">
            Imported <strong>{created.name}</strong> with {created.iconCount} {created.iconCount === 1 ? 'icon' : 'icons'}.
          </p>
        ) : (
          <>
            <div className="cluster" role="group" aria-label="Import from">
              <button
                type="button"
                className={`btn btn--compact ${mode === 'svg' ? 'btn--primary' : 'btn--secondary'}`}
                aria-pressed={mode === 'svg'}
                data-testid="library-import-mode-svg"
                onClick={() => setMode('svg')}
              >
                SVG files
              </button>
              <button
                type="button"
                className={`btn btn--compact ${mode === 'manifest' ? 'btn--primary' : 'btn--secondary'}`}
                aria-pressed={mode === 'manifest'}
                data-testid="library-import-mode-manifest"
                onClick={() => setMode('manifest')}
              >
                Manifest (JSON)
              </button>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="library-import-library-name">
                {mode === 'svg' ? 'Library name' : 'Display name (optional)'}
              </label>
              <input
                id="library-import-library-name"
                data-testid="library-import-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {mode === 'svg' ? (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="library-import-license">
                    License (optional)
                  </label>
                  <input id="library-import-license" data-testid="library-import-license" value={license} onChange={(e) => setLicense(e.target.value)} />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="library-import-files">
                    SVG files
                  </label>
                  <input
                    id="library-import-files"
                    data-testid="library-import-files"
                    type="file"
                    accept=".svg,image/svg+xml"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      void readSvgDrafts(files).then(setDrafts);
                    }}
                  />
                  <span className="meta">Each file is cleaned up and fitted into the 48 x 48 icon space. Files over 200 KB are refused.</span>
                </div>
                {drafts.length > 0 && (
                  <>
                    <p className="meta" data-testid="library-import-summary">
                      {usable} of {drafts.length} {drafts.length === 1 ? 'file' : 'files'} can be imported.
                    </p>
                    <SvgDraftList drafts={drafts} onChange={setDrafts} />
                  </>
                )}
              </>
            ) : (
              <div className="field">
                <label className="field__label" htmlFor="library-import-manifest-file">
                  Manifest file
                </label>
                <input
                  id="library-import-manifest-file"
                  data-testid="library-import-manifest-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return setManifest(null);
                    void readManifest(file).then(setManifest);
                  }}
                />
                <span className="meta">The same format as the built-in libraries: an id, a version and a list of icons whose artwork is already in the 48 x 48 space.</span>
                {manifest &&
                  (manifest.error ? (
                    <p role="alert" className="field__error" data-testid="library-import-manifest-error">
                      {manifest.fileName}: {manifest.error}
                    </p>
                  ) : (
                    <p role="status" data-testid="library-import-manifest-summary">
                      <span className="mono">
                        {manifest.id}@{manifest.version}
                      </span>{' '}
                      with {manifest.iconCount} {manifest.iconCount === 1 ? 'icon' : 'icons'}.
                    </p>
                  ))}
              </div>
            )}
          </>
        )}
        <RejectedList rejected={rejected} />
        {error && (
          <p role="alert" className="field__error" data-testid="library-import-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
