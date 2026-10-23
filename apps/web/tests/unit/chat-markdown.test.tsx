import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMarkdown, parseBlocks } from '../../src/ai/chat-markdown';

const html = (text: string) => renderToStaticMarkup(<ChatMarkdown text={text} />);

describe('ChatMarkdown (canvas-rfv)', () => {
  it('keeps paragraphs and line breaks', () => {
    expect(html('First line\nsecond line\n\nNew paragraph')).toBe(
      '<div class="chat-markdown"><p>First line<br/>second line</p><p>New paragraph</p></div>',
    );
  });

  it('renders bold, italic and inline code', () => {
    expect(html('Use **bold**, *italic* and `code`.')).toContain('Use <strong>bold</strong>, <em>italic</em> and <code>code</code>.');
  });

  it('leaves snake_case identifiers alone', () => {
    expect(html('Rename primary_activity_node now')).toContain('Rename primary_activity_node now');
  });

  it('renders bullet and numbered lists, keeping the start number', () => {
    const out = html('Steps:\n- one\n- two\n\n3. three\n4. four');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('shows headings as bold lines', () => {
    expect(html('## Summary\nDone')).toContain('<p class="chat-markdown__heading"><strong>Summary</strong></p>');
  });

  it('renders fenced code verbatim, without formatting inside', () => {
    const out = html('```\nflowchart TD\n  A[**not bold**] --> B\n```');
    expect(out).toContain('<pre tabindex="0"><code>flowchart TD\n  A[**not bold**] --&gt; B</code></pre>');
  });

  it('renders block quotes', () => {
    expect(html('> quoted\n> text')).toContain('<blockquote>quoted<br/>text</blockquote>');
  });

  it('keeps http(s) and mailto links, opening safely', () => {
    expect(html('[docs](https://example.com/a)')).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(html('[mail](mailto:a@example.com)')).toContain('href="mailto:a@example.com"');
  });

  it('drops javascript: and other unsafe links, keeping the label as text', () => {
    const out = html('[click](javascript:alert(1)) and [x](data:text/html,hi)');
    expect(out).not.toContain('href');
    expect(out).toContain('click');
  });

  it('never renders HTML from the text -- markup is shown as text', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>hi</b>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('handles an unterminated code fence and empty input', () => {
    expect(parseBlocks('```\nopen')).toEqual([{ kind: 'code', text: 'open' }]);
    expect(parseBlocks('')).toEqual([]);
  });
});
