import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { locationToSearch, parseLocation } from '../../src/app/navigation';
import { findHelpPage, headingId, helpPages, resolveHelpLink, searchHelp, type HelpPage } from '../../src/help/help-content';
import { HelpMarkdown, parseHelpBlocks } from '../../src/help/HelpMarkdown';

/** canvas-fkp: in-app Help, rendered from docs/user-guide and docs/admin-guide. */
describe('help content', () => {
  it('bundles both guides, README first and pages in the README order; admin pages for admins only', () => {
    const user = helpPages(false);
    expect(user.every((p) => p.guide === 'user')).toBe(true);
    expect(user.map((p) => p.id).slice(0, 4)).toEqual(['user', 'user/signing-in', 'user/browsing', 'user/creating-diagrams']);
    expect(user.find((p) => p.id === 'user/common-questions')?.title).toBe('Common questions');
    expect(helpPages(true).some((p) => p.id === 'admin/people')).toBe(true);
    expect(findHelpPage('admin/people', false)).toBeUndefined();
  });

  it('resolves links between guide pages, to sections, and leaves outside files alone', () => {
    const editor = findHelpPage('user/editor', true)!;
    expect(resolveHelpLink('ai-chat.md', editor)).toEqual({ page: 'user/ai-chat' });
    expect(resolveHelpLink('editor.md#comments', editor)).toEqual({ page: 'user/editor', section: 'comments' });
    expect(resolveHelpLink('../admin-guide/README.md', editor)).toEqual({ page: 'admin' });
    expect(resolveHelpLink('#zoom', editor)).toEqual({ page: 'user/editor', section: 'zoom' });
    expect(resolveHelpLink('../../RUNBOOK.md', editor)).toBeUndefined();
    expect(headingId('The DSL tab: the diagram as text')).toBe('the-dsl-tab-the-diagram-as-text');
  });

  it('searches the sections a user may read, linking straight to the section', () => {
    const hits = searchHelp('zoom fit', false);
    expect(hits[0]).toMatchObject({ page: { id: 'user/editor' }, section: { id: 'zoom', title: 'Zoom' } });
    expect(searchHelp('GitHub App private key', false)).toEqual([]);
    expect(searchHelp('GitHub App private key', true).length).toBeGreaterThan(0);
    expect(searchHelp('x', false)).toEqual([]);
  });

  it('every "?" section link in the app points at a heading that exists', () => {
    const links = [
      ['user/editor', 'the-dsl-tab-the-diagram-as-text'],
      ['user/editor', 'comments'],
      ['user/editor', 'the-issues-tab-standards'],
      ['user/editor', 'the-history-tab-versions'],
      ['user/sharing-and-exporting', 'sharing-a-single-diagram'],
      ['user/sharing-and-exporting', 'project-members'],
      ['admin/standards-and-diagram-types', 'what-a-standard-says'],
      ['admin/standards-and-diagram-types', 'what-authors-can-add'],
    ];
    for (const [page, section] of links) {
      const md = findHelpPage(page, true)!.markdown;
      const ids = [...md.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => headingId(m[1]));
      expect(ids, `${page}#${section}`).toContain(section);
    }
  });

  it('?help= addresses round-trip', () => {
    expect(parseLocation('?help=user/editor&section=zoom')).toEqual({ screen: 'help', page: 'user/editor', section: 'zoom' });
    expect(parseLocation('?help=')).toEqual({ screen: 'help', page: 'user' });
    expect(parseLocation('?help=../etc')).toEqual({ screen: 'projects' });
    expect(locationToSearch({ screen: 'help', page: 'admin/people', section: 'roles' })).toBe('?help=admin/people&section=roles');
  });
});

describe('HelpMarkdown', () => {
  const page = (markdown: string): HelpPage => ({ id: 'user/test', guide: 'user', slug: 'test', title: 'Test', markdown });
  const draw = (markdown: string) =>
    render(<HelpMarkdown page={page(markdown)} hrefFor={(p, s) => `?help=${p}${s ? `&section=${s}` : ''}`} onNavigate={() => undefined} />).container;

  it('renders tables, headings with ids, lists and help links', () => {
    const el = draw('# Title\n\n## Two words\n\n| A | B |\n|---|---|\n| [Editor](editor.md) | **bold** |\n\n- one\n- two\n');
    expect(el.querySelector('h1')?.textContent).toBe('Title');
    expect(el.querySelector('h2')?.id).toBe('two-words');
    expect(el.querySelectorAll('td')).toHaveLength(2);
    expect(el.querySelector('td a')?.getAttribute('href')).toBe('?help=user/editor');
    expect(el.querySelector('td strong')?.textContent).toBe('bold');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(parseHelpBlocks('| A |\n|---|\n| 1 |\n')[0]).toMatchObject({ kind: 'table', rows: [['1']] });
  });

  it('never turns page text into HTML or script', () => {
    const el = draw('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
  });
});
