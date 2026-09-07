import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { parseSequence, serializeSequence } from '../../src/dsl/sequence.js';
import { parseUml, serializeUml } from '../../src/dsl/uml.js';
import { parseErd, serializeErd } from '../../src/dsl/erd.js';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * jmuir-dtu.18: a `%%{init: {...}}%%` (or other `%%{...}%%`) Mermaid config/theme directive
 * previously matched the generic `%%`-comment check and was silently discarded with no trace,
 * losing whatever config it carried. Not modeled (this app has no theming concept), but now
 * captured verbatim and re-emitted unchanged as the diagram's first line on serialize — the same
 * "accept, don't model, don't lose it" treatment `architectureAlignments` already established.
 * Real Mermaid places this directive BEFORE the diagram-type header line, so that placement is
 * covered explicitly below, not just a trailing/mid-body occurrence.
 */
describe('%%{...}%% config directive is preserved verbatim, in every diagram type', () => {
  const CONFIG_LINE = '%%{init: {"theme": "dark"}}%%';

  const cases: {
    family: string;
    parse: (dsl: string) => ReturnType<typeof parseFlowchart>;
    serialize: (model: never) => string;
    header: string;
    content: string;
  }[] = [
    { family: 'flowchart', parse: parseFlowchart, serialize: serializeFlowchart as never, header: 'flowchart TD', content: '  A[Start]' },
    { family: 'sequence', parse: parseSequence, serialize: serializeSequence as never, header: 'sequenceDiagram', content: 'participant A' },
    { family: 'uml', parse: parseUml, serialize: serializeUml as never, header: 'classDiagram', content: 'class Animal' },
    { family: 'erd', parse: parseErd, serialize: serializeErd as never, header: 'erDiagram', content: 'CUSTOMER' },
    { family: 'c4', parse: parseC4, serialize: serializeC4 as never, header: 'C4Context', content: 'Person(user, "User")' },
    { family: 'architecture', parse: parseArchitecture, serialize: serializeArchitecture as never, header: 'architecture-beta', content: 'service a(server)[A]' },
  ];

  for (const { family, parse, serialize, header, content } of cases) {
    it(`${family}: preceding the header (real Mermaid's own placement) is captured and doesn't break header detection`, () => {
      const dsl = `${CONFIG_LINE}\n${header}\n${content}\n`;
      const result = parse(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.mermaidConfigDirective).toBe(CONFIG_LINE);
    });

    it(`${family}: round-trips the exact literal text through serialize -> reparse, as the first line`, () => {
      const dsl = `${header}\n${CONFIG_LINE}\n${content}\n`;
      const result = parse(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.mermaidConfigDirective).toBe(CONFIG_LINE);

      // The config line must precede the diagram's own header line -- but the *document's* first
      // line may instead be this app's own canvas front-matter block (a distinct concept from
      // Mermaid's own frontmatter), so the check is "immediately before the header," not
      // "the document's literal first line."
      const reserialized = serialize(result.model as never);
      const bodyLines = reserialized.split('\n');
      const headerIndex = bodyLines.findIndex((l) => l === header);
      expect(headerIndex).toBeGreaterThan(0);
      expect(bodyLines[headerIndex - 1]).toBe(CONFIG_LINE);

      const reparsed = parse(reserialized);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.mermaidConfigDirective).toBe(CONFIG_LINE);
    });

    it(`${family}: a model with none set omits the line entirely on serialize`, () => {
      const result = parse(`${header}\n${content}\n`);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.mermaidConfigDirective).toBeUndefined();
      expect(serialize(result.model as never)).not.toContain('%%{');
    });

    it(`${family}: a genuinely unrecognized line is still an error (the config check doesn't swallow real errors)`, () => {
      expect(isParseSuccess(parse(`${header}\n${CONFIG_LINE}\n???not-valid???\n`))).toBe(false);
    });
  }
});
