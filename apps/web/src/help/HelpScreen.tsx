import { useEffect, useMemo, useState } from 'react';
import { findHelpPage, helpPages, searchHelp, type HelpGuide } from './help-content';
import { HelpMarkdown } from './HelpMarkdown';

/**
 * canvas-fkp: the Help screen (`?help=<page>&section=<heading>`): search and contents on the left,
 * the page on the right. The user guide for everyone; the admin guide for admins.
 */
export interface HelpScreenProps {
  page: string;
  section?: string;
  isAdmin: boolean;
  hrefFor: (page: string, section?: string) => string;
  onNavigate: (page: string, section?: string) => void;
}

const GUIDE_NAMES: Record<HelpGuide, string> = { user: 'User guide', admin: 'Admin guide' };

export function HelpScreen({ page: pageId, section, isAdmin, hrefFor, onNavigate }: HelpScreenProps) {
  const pages = helpPages(isAdmin);
  // An unknown page (or an admin page for a non-admin) shows the user guide's contents.
  const page = findHelpPage(pageId, isAdmin) ?? findHelpPage('user', isAdmin)!;
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchHelp(query, isAdmin), [query, isAdmin]);

  // Jump to the named section once the page has rendered; otherwise start at the top.
  useEffect(() => {
    const target = section ? document.getElementById(section) : null;
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    } else {
      document.querySelector('.app-content')?.scrollTo({ top: 0 });
    }
  }, [page.id, section]);

  const link = (id: string, label: string, sectionId?: string, testId?: string) => (
    <a
      href={hrefFor(id, sectionId)}
      data-testid={testId}
      aria-current={!sectionId && id === page.id ? 'page' : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setQuery('');
        onNavigate(id, sectionId);
      }}
    >
      {label}
    </a>
  );

  return (
    <main className="page help" data-testid="help-screen">
      <nav className="help__nav" aria-label="Help contents">
        <div className="field">
          <label className="field__label" htmlFor="help-search">
            Search help
          </label>
          <input id="help-search" type="search" data-testid="help-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. share, zoom, standard" />
        </div>
        {query.trim().length > 1 ? (
          <div data-testid="help-search-results" aria-live="polite">
            {hits.length === 0 ? (
              <p className="meta" data-testid="help-search-empty">
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              <ul className="help__results">
                {hits.map((hit, i) => (
                  <li key={`${hit.page.id}-${hit.section?.id ?? ''}-${i}`}>
                    {link(hit.page.id, hit.section ? `${hit.page.title}: ${hit.section.title}` : hit.page.title, hit.section?.id, `help-hit-${i}`)}
                    <span className="meta">{hit.snippet}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          (['user', 'admin'] as const)
            .filter((guide) => pages.some((p) => p.guide === guide))
            .map((guide) => (
              <div key={guide} className="help__group">
                <p className="section-label">{GUIDE_NAMES[guide]}</p>
                <ul>
                  {pages
                    .filter((p) => p.guide === guide)
                    .map((p) => (
                      <li key={p.id}>{link(p.id, p.slug === 'README' ? 'Contents' : p.title, undefined, `help-nav-${p.id.replace('/', '-')}`)}</li>
                    ))}
                </ul>
              </div>
            ))
        )}
        <p className="meta help__legal">
          <a href="/third-party-notices.txt" target="_blank" rel="noopener noreferrer" data-testid="help-third-party-notices">
            Third-party notices
          </a>{' '}
          ·{' '}
          <a href="/license.txt" target="_blank" rel="noopener noreferrer">
            Licence
          </a>
        </p>
      </nav>
      <article className="help__article card" data-testid={`help-page-${page.id.replace('/', '-')}`}>
        <HelpMarkdown page={page} hrefFor={hrefFor} onNavigate={onNavigate} titleTakesFocus={!section} />
      </article>
    </main>
  );
}
