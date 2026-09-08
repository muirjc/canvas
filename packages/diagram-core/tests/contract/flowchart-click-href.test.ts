import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { isAllowedLinkHref } from '../../src/model/diagram-model.js';

/**
 * jmuir-dzd.5 (grouping G, the last deferred item under jmuir-dzd): `click <id> href "<url>"
 * ["<tooltip>"] [_blank]` -- href/tooltip form only, per this feature's own already-decided
 * design (bd show jmuir-dzd's notes). `click <id> call fn()` is a security REJECTION, not a
 * deferral: a clean, named parse error, never silent tolerance or execution. The href scheme
 * allowlist (http(s):// or a relative path only) is the one non-negotiable implementation detail
 * — an unrestricted href becomes a stored XSS vector the moment it's exported as a real, clickable
 * SVG `<a href>` (see svg-renderer.test.ts / render-svg.test.ts for the export-side coverage).
 */
describe('flowchart parser: click href/tooltip (jmuir-dzd.5)', () => {
  it('parses "click <id> href "<url>"" with no tooltip/target', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "https://example.com"\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const node = result.model.nodes.find((n) => n.id === 'A')!;
    expect(node.link).toEqual({ href: 'https://example.com' });
  });

  it('parses a tooltip when given', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "https://example.com" "Visit site"\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const node = result.model.nodes.find((n) => n.id === 'A')!;
    expect(node.link).toEqual({ href: 'https://example.com', tooltip: 'Visit site' });
  });

  it('parses the _blank target when given, alongside a tooltip', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "https://example.com" "Visit site" _blank\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const node = result.model.nodes.find((n) => n.id === 'A')!;
    expect(node.link).toEqual({ href: 'https://example.com', tooltip: 'Visit site', target: '_blank' });
  });

  it('parses _blank with no tooltip', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "https://example.com" _blank\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const node = result.model.nodes.find((n) => n.id === 'A')!;
    expect(node.link).toEqual({ href: 'https://example.com', target: '_blank' });
  });

  it('accepts a scheme-less relative path', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "/docs/getting-started"\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.nodes.find((n) => n.id === 'A')!.link?.href).toBe('/docs/getting-started');
  });

  it('is a no-op (link stays unset) for a click line referencing a node id not otherwise present', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click Z href "https://example.com"\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.nodes.map((n) => n.id)).toEqual(['A']);
    expect(result.model.nodes[0].link).toBeUndefined();
  });

  it('applies a click line declared at the end of the file to a node declared earlier', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n\n  click A href "https://example.com"\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.nodes.find((n) => n.id === 'A')!.link?.href).toBe('https://example.com');
  });

  it('round-trips href/tooltip/target through serialize -> reparse', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  click A href "https://example.com" "Visit site" _blank\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const serialized = serializeFlowchart(result.model);
    expect(serialized).toContain('click A href "https://example.com" "Visit site" _blank');
    const reparsed = parseFlowchart(serialized);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.nodes.find((n) => n.id === 'A')!.link).toEqual({
      href: 'https://example.com',
      tooltip: 'Visit site',
      target: '_blank',
    });
  });

  it('a model with no linked nodes omits every "click" line entirely on serialize (no regression)', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(serializeFlowchart(result.model)).not.toContain('click');
  });

  // appsec review (jmuir-dzd.5): serializeClickHref (flowchart-serializer.ts) defensively
  // re-validates href/tooltip too, even though setNodeLink (the one intended entry point) already
  // rejects both classes of unsafe value -- node.link is still just a plain model field, reachable
  // by anything that constructs/mutates a DiagramModel directly (a hand-built fixture, like this
  // test itself, standing in for any future code path that skips setNodeLink). A link that fails
  // either check must be treated exactly like "no link" on serialize, never emitted.
  it('omits the click line entirely for a disallowed-scheme href set directly on the model (bypassing setNodeLink)', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    result.model.nodes[0].link = { href: 'javascript:alert(1)' };
    expect(serializeFlowchart(result.model)).not.toContain('click');
  });

  it('omits the click line entirely for an href containing a double-quote, set directly on the model', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    result.model.nodes[0].link = { href: 'https://example.com/"><script>' };
    expect(serializeFlowchart(result.model)).not.toContain('click');
  });

  it('omits the click line entirely for a tooltip containing a newline, set directly on the model', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    result.model.nodes[0].link = { href: 'https://example.com', tooltip: 'line1\nclick B href "javascript:alert(1)' };
    expect(serializeFlowchart(result.model)).not.toContain('click A');
  });
});

describe('flowchart parser: click call is a security rejection, not a deferral (jmuir-dzd.5)', () => {
  it('"click <id> call fn()" produces a clean, named parse error', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A call doSomething()\n');
    expect(isParseSuccess(result)).toBe(false);
    if (isParseSuccess(result)) return;
    expect(result.errors[0].message.toLowerCase()).toContain('not supported');
    expect(result.errors[0].message.toLowerCase()).toContain('security');
    expect(result.errors[0].line).toBe(3);
  });

  it('"click <id> call fn(arg1, arg2)" with arguments is also rejected, not silently accepted', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A call doSomething("a", "b")\n');
    expect(isParseSuccess(result)).toBe(false);
  });
});

describe('flowchart parser: click href scheme allowlist is a hard rejection, not silent tolerance (jmuir-dzd.5)', () => {
  it('rejects a "javascript:" scheme href with a clean, named parse error (the XSS payload case)', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "javascript:alert(document.cookie)"\n');
    expect(isParseSuccess(result)).toBe(false);
    if (isParseSuccess(result)) return;
    expect(result.errors[0].message.toLowerCase()).toContain('scheme');
    expect(result.errors[0].message).toContain('javascript');
  });

  it('rejects a "data:" scheme href', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "data:text/html,<script>alert(1)</script>"\n');
    expect(isParseSuccess(result)).toBe(false);
  });

  it('rejects a "vbscript:" scheme href', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "vbscript:msgbox(1)"\n');
    expect(isParseSuccess(result)).toBe(false);
  });

  it('rejects a "file:" scheme href', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "file:///etc/passwd"\n');
    expect(isParseSuccess(result)).toBe(false);
  });

  it('rejects a "mailto:" scheme href (allowlist is exactly http(s)/relative, per the design decision -- no broader "reasonable schemes" list)', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "mailto:someone@example.com"\n');
    expect(isParseSuccess(result)).toBe(false);
  });

  it('accepts "http://" (not just "https://")', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href "http://example.com"\n');
    expect(isParseSuccess(result)).toBe(true);
  });

  // appsec review (jmuir-dzd.5): the full parse -> model chain, not just the isAllowedLinkHref
  // unit itself, for the exact bypass an earlier version of this feature shipped with.
  it('rejects a "javascript:" scheme obfuscated by a leading space, and names the real scheme in the error (not "(unknown)")', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  click A href " javascript:alert(document.cookie)"\n');
    expect(isParseSuccess(result)).toBe(false);
    if (isParseSuccess(result)) return;
    expect(result.errors[0].message).toContain('javascript');
  });
});

describe('isAllowedLinkHref (jmuir-dzd.5) — the shared check every consumer (parser, export renderer) must use', () => {
  it('allows http:// and https://', () => {
    expect(isAllowedLinkHref('http://example.com')).toBe(true);
    expect(isAllowedLinkHref('https://example.com')).toBe(true);
  });

  it('allows a scheme-less relative path', () => {
    expect(isAllowedLinkHref('/docs/x')).toBe(true);
    expect(isAllowedLinkHref('./x')).toBe(true);
    expect(isAllowedLinkHref('x.html')).toBe(true);
  });

  it('rejects javascript:, data:, vbscript:, file:, and mailto: schemes', () => {
    expect(isAllowedLinkHref('javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('data:text/html,x')).toBe(false);
    expect(isAllowedLinkHref('vbscript:msgbox(1)')).toBe(false);
    expect(isAllowedLinkHref('file:///etc/passwd')).toBe(false);
    expect(isAllowedLinkHref('mailto:x@example.com')).toBe(false);
  });

  it('is case-insensitive on the scheme (JavaScript:alert(1) is still rejected)', () => {
    expect(isAllowedLinkHref('JavaScript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('HTTPS://example.com')).toBe(true);
  });

  // appsec review (jmuir-dzd.5): a real, live bypass found in an earlier, regex-based version of
  // this function -- a leading C0 control character or space doesn't match `^[a-zA-Z]...:`, so
  // the old code concluded "no scheme, must be relative" and ALLOWED it, but the WHATWG URL
  // Standard (which every browser's own href-resolution algorithm implements) strips leading
  // C0-control-or-space characters as its very first parsing step, so a browser resolves the SAME
  // string as a real javascript: URL. Fixed by delegating to the platform's own URL parser
  // instead of re-implementing its normalization by hand.
  it('rejects a scheme obfuscated by a leading space, tab, or other C0 control character', () => {
    expect(isAllowedLinkHref(' javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('\tjavascript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('\x01javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkHref('java\tscript:alert(1)')).toBe(false);
  });

  it('rejects an unparseable string outright, rather than treating it as "probably a relative path"', () => {
    expect(isAllowedLinkHref('http://')).toBe(false);
  });
});
