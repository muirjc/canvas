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
 * jmuir-dtu.17: `accTitle: <text>` / `accDescr: <text>` — Mermaid's generic accessibility
 * title/description statements — were unhandled in all 6 families (would hard-error). Same
 * cross-family, mirror-every-parser precedent `title` itself already established (canvas-vtg).
 * Scoped to the single-line colon form only; the multi-line `accDescr { ... }` block form is a
 * disclosed out-of-scope, not a silent drop — covered by the last case in each family below.
 */
describe('accTitle/accDescr accessibility directives, in every diagram type', () => {
  const cases: {
    family: string;
    parse: (dsl: string) => ReturnType<typeof parseFlowchart>;
    serialize: (model: never) => string;
    header: string;
    // one line of otherwise-valid content, so a parse succeeds
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
    it(`${family}: parses accTitle/accDescr and round-trips them through serialize -> reparse`, () => {
      const dsl = `${header}\naccTitle: An accessible title\naccDescr: A longer accessible description\n${content}\n`;
      const result = parse(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.accTitle).toBe('An accessible title');
      expect(result.model.accDescr).toBe('A longer accessible description');

      const reserialized = serialize(result.model as never);
      expect(reserialized).toContain('accTitle: An accessible title');
      expect(reserialized).toContain('accDescr: A longer accessible description');

      const reparsed = parse(reserialized);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.accTitle).toBe('An accessible title');
      expect(reparsed.model.accDescr).toBe('A longer accessible description');
    });

    it(`${family}: a model with neither set omits both lines entirely on serialize`, () => {
      const result = parse(`${header}\n${content}\n`);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.accTitle).toBeUndefined();
      expect(result.model.accDescr).toBeUndefined();
      const reserialized = serialize(result.model as never);
      expect(reserialized).not.toContain('accTitle');
      expect(reserialized).not.toContain('accDescr');
    });

    it(`${family}: the multi-line "accDescr { ... }" block form is a disclosed out-of-scope error, not a silent drop`, () => {
      const dsl = `${header}\naccDescr {\n  multiple\n  lines\n}\n${content}\n`;
      expect(isParseSuccess(parse(dsl))).toBe(false);
    });
  }
});
