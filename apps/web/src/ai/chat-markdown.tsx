import { Fragment, type ReactNode } from 'react';

/**
 * canvas-rfv: AI replies arrive as Markdown, and were shown as one raw line (`**bold**`, `- `
 * lists, newlines collapsed). This renders the subset a chat reply uses -- paragraphs and line
 * breaks, headings (as bold lines), bullet/numbered lists, block quotes, fenced code, inline code,
 * bold, italic and links -- by building React elements, never HTML: anything in the text that
 * looks like markup is just text. Links are kept only for http(s) and mailto.
 */

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; text: string };

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
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
      i++; // the closing fence (or the end)
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] });
      i++;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next && /\d/.test(next[1]) === ordered) {
          items.push(next[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += `\n${lines[i].trim()}`; // a continuation line
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
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !QUOTE.test(lines[i])) {
      paragraph.push(lines[i++].trim());
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

export const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

// Order matters: code first (nothing inside it is formatted), then links, bold, italic.
const INLINE = /(`[^`]+`)|\[([^\]]+)\]\(([^)\s]+)\)|(\*\*|__)(?=\S)([\s\S]*?\S)\4|(\*|_)(?=\S)([\s\S]*?\S)\6/;

/** canvas-fkp: lets Help render its own links (between help pages) with the same inline rules. */
export type RenderLink = (href: string, label: ReactNode[], key: string) => ReactNode;

export function renderInline(text: string, keyPrefix = 'i', renderLink?: RenderLink): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    } else if (m[2] !== undefined) {
      const label = renderInline(m[2], key, renderLink);
      out.push(
        renderLink ? (
          <Fragment key={key}>{renderLink(m[3], label, key)}</Fragment>
        ) : SAFE_LINK.test(m[3]) ? (
          <a key={key} href={m[3]} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    } else if (m[4]) {
      out.push(<strong key={key}>{renderInline(m[5], key, renderLink)}</strong>);
    } else if (m[6]) {
      // `snake_case_words` aren't emphasis: an underscore pair must not touch letters outside it.
      const before = rest[m.index - 1];
      const after = rest[m.index + m[0].length];
      if (m[6] === '_' && ((before && /\w/.test(before)) || (after && /\w/.test(after)))) {
        out.push(m[0]);
      } else {
        out.push(<em key={key}>{renderInline(m[7], key, renderLink)}</em>);
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function withBreaks(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, i) => [
    ...(i > 0 ? [<br key={`${keyPrefix}-br-${i}`} />] : []),
    <Fragment key={`${keyPrefix}-l-${i}`}>{renderInline(line, `${keyPrefix}-${i}`)}</Fragment>,
  ]);
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      {parseBlocks(text).map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case 'heading':
            return (
              <p key={key} className="chat-markdown__heading">
                <strong>{renderInline(block.text, key)}</strong>
              </p>
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
