import { describe, expect, it } from 'vitest';
import { detectDslFamily } from '../../src/dsl/detect.js';
import { getDslFamily, isParseSuccess } from '../../src/index.js';

/**
 * User Story 5 (Import): a pasted/uploaded Mermaid diagram must be identifiable and parseable
 * for every supported DSL family without already knowing its diagram type.
 */
describe('import — DSL family auto-detection', () => {
  const samples: Record<string, string> = {
    flowchart: 'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n',
    c4: 'C4Context\nPerson(user, "User")\nSystem(sys, "System")\nRel(user, sys, "Uses")\n',
    sequence: 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: Hello\n',
    erd: 'erDiagram\nCUSTOMER ||--o{ ORDER : places\n',
    uml: 'classDiagram\nclass Animal\nclass Dog\nAnimal <|-- Dog\n',
    architecture: 'architecture-beta\nservice fn1(lambda)[Function]\n',
  };

  for (const [family, dsl] of Object.entries(samples)) {
    it(`detects and parses a hand-authored ${family} diagram`, () => {
      expect(detectDslFamily(dsl)).toBe(family);
      const parser = getDslFamily(family);
      expect(parser).toBeDefined();
      const result = parser!.parse(dsl);
      expect(isParseSuccess(result)).toBe(true);
    });
  }

  it('returns undefined for empty or unrecognized input rather than guessing', () => {
    expect(detectDslFamily('')).toBeUndefined();
    expect(detectDslFamily('this is not any known diagram type\n')).toBeUndefined();
  });

  it('detects the family through a front-matter block (imported content with metadata)', () => {
    const withFrontMatter = '---\ncanvas:\n  positions:\n    A: {x: 0, y: 0}\n---\nflowchart TD\n  A[Node]\n';
    expect(detectDslFamily(withFrontMatter)).toBe('flowchart');
  });

  it('detects the flowchart family via the "graph" header alias (User Story 5)', () => {
    expect(detectDslFamily('graph TD\n  A[Start]\n  B[End]\n  A --> B\n')).toBe('flowchart');
  });

  // jmuir-dtu.15: c4.ts's own parser has supported C4Deployment since jmuir-dtu.3.2, but this
  // detector's C4 pattern never gained the header -- a raw C4Deployment import failed family
  // detection here and never reached parseC4 at all. Distinct from the "c4" sample above
  // (C4Context), which this pattern already matched before the fix.
  it('detects the c4 family for a C4Deployment header (jmuir-dtu.15)', () => {
    const dsl = 'C4Deployment\n  Deployment_Node(live, "Live") {\n  }\n';
    expect(detectDslFamily(dsl)).toBe('c4');
    const parser = getDslFamily('c4');
    expect(parser).toBeDefined();
    const result = parser!.parse(dsl);
    expect(isParseSuccess(result)).toBe(true);
  });
});
