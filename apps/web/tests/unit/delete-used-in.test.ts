// canvas-8uh1.7: the diagram delete prompt says which diagrams link to or embed the one being deleted.
import { describe, expect, it } from 'vitest';
import { usedInWarning } from '../../src/projects/ProjectBrowser';
import type { DiagramUsedInDto } from '../../src/app/api';

const use = (name: string): DiagramUsedInDto => ({ diagramId: name, name, diagramTypeId: 'flowchart', projectId: 'p', projectName: 'P', elementIds: ['A'] });

describe('usedInWarning', () => {
  it('says nothing when nothing uses the diagram, or before the answer arrives', () => {
    expect(usedInWarning(null)).toBe('');
    expect(usedInWarning([])).toBe('');
  });
  it('names up to three and counts the rest', () => {
    expect(usedInWarning([use('Context')])).toBe(' It is used in 1 other diagram ("Context"); their links and frames will show it as deleted until it is restored.');
    expect(usedInWarning(['A', 'B', 'C', 'D', 'E'].map(use))).toBe(' It is used in 5 other diagrams ("A", "B", "C" and 2 more); their links and frames will show it as deleted until it is restored.');
  });
});
