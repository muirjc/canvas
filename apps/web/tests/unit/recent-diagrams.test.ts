import { afterEach, describe, expect, it } from 'vitest';
import { readRecentDiagrams, recordRecentDiagram, RECENT_LIMIT } from '../../src/projects/recent-diagrams';

/** canvas-93n: recently opened diagrams, per user, on this browser. */
describe('recent diagrams', () => {
  afterEach(() => window.localStorage.clear());

  it('keeps the newest first, moves a reopened one to the top, and keeps five', () => {
    for (let i = 1; i <= 7; i += 1) recordRecentDiagram('u1', { id: `d${i}`, name: `D${i}` });
    recordRecentDiagram('u1', { id: 'd4', name: 'D4 renamed' });
    const list = readRecentDiagrams('u1');
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list.map((d) => d.id)).toEqual(['d4', 'd7', 'd6', 'd5', 'd3']);
    expect(list[0].name).toBe('D4 renamed');
  });

  it('is per user, and survives bad stored data', () => {
    recordRecentDiagram('u1', { id: 'd1', name: 'D1' });
    expect(readRecentDiagrams('u2')).toEqual([]);
    window.localStorage.setItem('canvas.recentDiagrams.u3', '{not json');
    expect(readRecentDiagrams('u3')).toEqual([]);
  });
});
