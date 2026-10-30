import { Fragment, type ReactNode } from 'react';
import { renderInline, SAFE_LINK } from '../ai/chat-markdown';
import { headingId, helpImageUrl, resolveHelpLink, type HelpPage } from './help-content';

/**
 * canvas-fkp: renders a guide page -- the Markdown the docs use: headings (h2/h3 get anchor ids),
 * paragraphs, lists, tables, images, block quotes and fenced code. Like chat replies it builds
 * React elements, never HTML, so nothing in a page can inject markup or script. Links to other
 * guide pages stay in Help; http(s)/mailto links open in a new tab; anything else is plain text.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'image'; alt: string; src: string };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const IMAGE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

export function parseHelpBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const startsBlock = (line: string) =>
    FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || TABLE_ROW.test(line) || IMAGE.test(line);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const image = IMAGE.exec(line);
    if (image) {
      blocks.push({ kind: 'image', alt: image[1], src: image[2] });
      i++;
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next && /\d/.test(next[1]) === ordered && !/^\s{2,}/.test(lines[i])) {
          items.push(next[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // A continuation line, or a nested item: kept with its parent as a line of its own.
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(item[1], 10) || 1 : 1, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++].trim());
    blocks.push({ kind: 'paragraph', lines: paragraph.length ? paragraph : [lines[i++].trim()] });
  }
  return blocks;
}

export interface HelpMarkdownProps {
  page: HelpPage;
  /** The address of a help page (for real hrefs), and the in-app way to open it. */
  hrefFor: (page: string, section?: string) => string;
  onNavigate: (page: string, section?: string) => void;
  /** The title takes focus after navigating -- unless a section is named, which takes it instead. */
  titleTakesFocus?: boolean;
}

export function HelpMarkdown({ page, hrefFor, onNavigate, titleTakesFocus = true }: HelpMarkdownProps) {
  const renderLink = (href: string, label: ReactNode[], key: string): ReactNode => {
    const target = resolveHelpLink(href, page);
    if (target) {
      return (
        <a
          key={key}
          href={hrefFor(target.page, target.section)}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onNavigate(target.page, target.section);
          }}
        >
          {label}
        </a>
      );
    }
    if (SAFE_LINK.test(href)) {
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    }
    return <Fragment key={key}>{label}</Fragment>;
  };
  const inline = (text: string, key: string) => renderInline(text, key, renderLink);
  const withBreaks = (lines: string[], key: string) =>
    lines.flatMap((line, i) => [...(i > 0 ? [<br key={`${key}-br-${i}`} />] : []), <Fragment key={`${key}-l-${i}`}>{inline(line, `${key}-${i}`)}</Fragment>]);

  return (
    <div className="help-markdown">
      {parseHelpBlocks(page.markdown).map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case 'heading': {
            // The page's own title is the screen's <h1> (focus lands there after navigating).
            if (block.level === 1) {
              return (
                <h1 key={key} tabIndex={-1} data-testid="help-title" data-browse-heading={titleTakesFocus ? '' : undefined}>
                  {inline(block.text, key)}
                </h1>
              );
            }
            const Tag = (block.level === 2 ? 'h2' : 'h3') as 'h2' | 'h3';
            return (
              <Tag key={key} id={headingId(block.text)}>
                {inline(block.text, key)}
              </Tag>
            );
          }
          case 'image': {
            const url = helpImageUrl(block.src);
            return url ? <img key={key} className="help-markdown__image" src={url} alt={block.alt} loading="lazy" /> : null;
          }
          case 'table':
            return (
              <div key={key} className="help-markdown__table">
                <table>
                  {block.header.some((cell) => cell) && (
                    <thead>
                      <tr>
                        {block.header.map((cell, c) => (
                          <th key={c} scope="col">
                            {inline(cell, `${key}-h${c}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{inline(cell, `${key}-${r}-${c}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list': {
            const items = block.items.map((item, i) => <li key={i}>{withBreaks(item.split('\n'), `${key}-${i}`)}</li>);
            return block.ordered ? (
              <ol key={key} start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case 'quote':
            return <blockquote key={key}>{withBreaks(block.lines, key)}</blockquote>;
          case 'code':
            return (
              <pre key={key} tabIndex={0}>
                <code>{block.text}</code>
              </pre>
            );
          default:
            return <p key={key}>{withBreaks(block.lines, key)}</p>;
        }
      })}
    </div>
  );
}
