/**
 * canvas-fkp: in-app Help is the repository's own user and admin guides (docs/user-guide,
 * docs/admin-guide), bundled at build time, so the docs and the app never drift. Each guide's
 * README is its contents page and sets the page order. Admin pages are for admins only.
 */

export type HelpGuide = 'user' | 'admin';

export interface HelpPage {
  /** 'user/editor', 'admin/people'; a guide's README is 'user' / 'admin'. */
  id: string;
  guide: HelpGuide;
  /** The file name without .md ('README' for the contents page). */
  slug: string;
  title: string;
  markdown: string;
}

const userFiles = import.meta.glob('../../../../docs/user-guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const adminFiles = import.meta.glob('../../../../docs/admin-guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const imageFiles = import.meta.glob('../../../../docs/images/*.{png,svg,jpg,gif}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** The bundled URL of a guide image, from a page's own `../images/x.png` reference. */
export function helpImageUrl(src: string): string | undefined {
  const name = fileName(src);
  const match = Object.entries(imageFiles).find(([path]) => fileName(path) === name);
  return match?.[1];
}

function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? fallback;
}

/** Page order: the README first, then pages in the order its links name them, then any others. */
function pagesFor(guide: HelpGuide, files: Record<string, string>): HelpPage[] {
  const bySlug = new Map(
    Object.entries(files).map(([path, markdown]) => {
      const slug = fileName(path).replace(/\.md$/, '');
      return [slug, { id: slug === 'README' ? guide : `${guide}/${slug}`, guide, slug, title: titleOf(markdown, slug), markdown }];
    }),
  );
  const readme = bySlug.get('README');
  const linked = readme ? [...readme.markdown.matchAll(/\]\(([\w-]+)\.md[)#]/g)].map((m) => m[1]) : [];
  const ordered = [...new Set(linked)].filter((slug) => slug !== 'README' && bySlug.has(slug));
  const rest = [...bySlug.keys()].filter((slug) => slug !== 'README' && !ordered.includes(slug)).sort();
  return [...(readme ? [readme] : []), ...[...ordered, ...rest].map((slug) => bySlug.get(slug)!)];
}

const ALL_PAGES: HelpPage[] = [...pagesFor('user', userFiles), ...pagesFor('admin', adminFiles)];

/** The pages a user may read: the admin guide only for admins. */
export function helpPages(isAdmin: boolean): HelpPage[] {
  return ALL_PAGES.filter((page) => isAdmin || page.guide === 'user');
}

export function findHelpPage(id: string, isAdmin: boolean): HelpPage | undefined {
  return helpPages(isAdmin).find((page) => page.id === id);
}

/**
 * Where a link inside a guide goes: another help page (with an optional section), or nowhere in
 * Help (an outside file such as the RUNBOOK). `from` is the page the link is on.
 */
export function resolveHelpLink(href: string, from: HelpPage): { page: string; section?: string } | undefined {
  const m = /^(?:\.\.\/(user|admin)-guide\/)?([\w-]+)\.md(?:#([\w-]+))?$/.exec(href);
  if (m) {
    const guide = (m[1] as HelpGuide | undefined) ?? from.guide;
    return { page: m[2] === 'README' ? guide : `${guide}/${m[2]}`, ...(m[3] ? { section: m[3] } : {}) };
  }
  const anchor = /^#([\w-]+)$/.exec(href);
  if (anchor) return { page: from.id, section: anchor[1] };
  return undefined;
}

/** GitHub-style heading anchors: lower case, spaces to hyphens, punctuation dropped. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Markdown reduced to searchable words: no image/link syntax, tables or emphasis marks. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`|>-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export interface HelpSearchHit {
  page: HelpPage;
  /** The nearest heading above the match, for a direct link. */
  section?: { id: string; title: string };
  snippet: string;
}

/**
 * Client-side search over the pages the user can read: every word of the query must appear in the
 * same section. One hit per section, best (title matches) first.
 */
export function searchHelp(query: string, isAdmin: boolean, limit = 12): HelpSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const hits: (HelpSearchHit & { score: number })[] = [];
  for (const page of helpPages(isAdmin)) {
    // Split into sections at ## / ### headings; the part before the first one belongs to the page.
    const parts = page.markdown.split(/^(?=#{2,3}\s)/m);
    for (const part of parts) {
      const heading = /^#{2,3}\s+(.+)$/m.exec(part);
      const title = heading?.[1].trim();
      const text = plainText(part);
      const lower = text.toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;
      const at = lower.indexOf(words[0]);
      const start = Math.max(0, at - 60);
      const snippet = `${start > 0 ? '…' : ''}${text.slice(start, at + 140).trim()}${at + 140 < text.length ? '…' : ''}`;
      const inTitle = `${page.title} ${title ?? ''}`.toLowerCase();
      hits.push({
        page,
        ...(title ? { section: { id: headingId(title), title } } : {}),
        snippet,
        score: words.filter((w) => inTitle.includes(w)).length,
      });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}
