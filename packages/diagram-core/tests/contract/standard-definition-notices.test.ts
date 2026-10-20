import { describe, expect, it } from 'vitest';
import { checkStandardDefinition, standardDefinitionNotices } from '../../src/standards/definition-check.js';
import { emptyStandardRules, type ElementKind, type StandardRules } from '../../src/standards/schema.js';

/**
 * canvas-e05: a standard with several C4 kinds sharing one match (the AXA XL Product Context
 * standard had six, all {role: system, external: false}) was published with no word to its author.
 * Since canvas-7hp that's legitimate -- elements carry their kind in $tags -- so it's a non-blocking
 * notice naming the kind an untagged element would count as, never a save-blocking error.
 */

const k = (id: string, match: ElementKind['match'], label = id): ElementKind => ({ id, label, shapes: [], approvedFills: [], match });
const rules = (elementKinds: ElementKind[]): StandardRules => ({ ...emptyStandardRules(), elementKinds });

describe('standardDefinitionNotices', () => {
  it('flags each later kind with the same match, naming the earlier kind that shadows it', () => {
    const r = rules([
      k('platform', { role: 'system', external: false }, 'Platform'),
      k('product', { role: 'system', external: false }, 'Product'),
      k('service', { role: 'system', external: false }, 'Service'),
    ]);
    const notices = standardDefinitionNotices(r, 'c4');
    expect(notices.map((n) => n.path)).toEqual(['elementKinds[1].match', 'elementKinds[2].match']);
    expect(notices[0].message).toContain('"Product"');
    expect(notices[0].message).toContain('"Platform"');
    expect(notices[1].message).toContain('"Platform"');
  });

  it('is not an error: the same standard passes checkStandardDefinition', () => {
    const r = rules([k('a', { role: 'system', external: false }), k('b', { role: 'system', external: false })]);
    expect(checkStandardDefinition(r, 'c4')).toEqual([]);
  });

  it('kinds with distinct matches get no notice', () => {
    const r = rules([
      k('person', { role: 'person' }),
      k('system', { role: 'system', external: false }),
      k('external_system', { role: 'system', external: true }),
    ]);
    expect(standardDefinitionNotices(r, 'c4')).toEqual([]);
  });

  it('a kind with external unset is shadowed for external elements by an earlier external kind', () => {
    const r = rules([k('ext', { role: 'system', external: true }, 'External'), k('any', { role: 'system' }, 'Any system')]);
    const notices = standardDefinitionNotices(r, 'c4');
    expect(notices).toHaveLength(1);
    expect(notices[0].path).toBe('elementKinds[1].match');
    expect(notices[0].message).toContain('"External"');
  });

  it('an earlier kind with external unset shadows later kinds of either kind', () => {
    const r = rules([k('any', { role: 'system' }, 'Any system'), k('ext', { role: 'system', external: true })]);
    expect(standardDefinitionNotices(r, 'c4').map((n) => n.path)).toEqual(['elementKinds[1].match']);
  });

  it('only applies to C4', () => {
    const r = rules([k('a', { role: 'system' }), k('b', { role: 'system' })]);
    expect(standardDefinitionNotices(r, 'flowchart')).toEqual([]);
  });
});
