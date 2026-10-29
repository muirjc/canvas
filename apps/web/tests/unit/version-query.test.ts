import { describe, expect, it } from 'vitest';
import { parseVersionQuery } from '../../src/projects/version-query';

// canvas-zfe. Expectations use local-time constructors, like the parser, so they hold in any TZ.
const NOW = new Date(2026, 9, 29, 15, 30); // 29 Oct 2026, 3:30 PM local
const day = (y: number, m: number, d: number) => ({
  from: new Date(y, m, d).toISOString(),
  to: new Date(y, m, d + 1).toISOString(),
});

describe('parseVersionQuery', () => {
  it('passes version numbers through as q', () => {
    for (const text of ['3', 'v3', 'V3', '#3', ' v 12 ']) {
      expect(parseVersionQuery(text, NOW, 'en-US')).toEqual({ q: text.trim() });
    }
  });

  it('turns today and yesterday into that local day', () => {
    expect(parseVersionQuery('today', NOW, 'en-US')).toEqual(day(2026, 9, 29));
    expect(parseVersionQuery('Yesterday', NOW, 'en-US')).toEqual(day(2026, 9, 28));
    expect(parseVersionQuery('yesterday', new Date(2026, 10, 1, 9), 'en-US')).toEqual(day(2026, 9, 31));
  });

  it('reads ISO dates', () => {
    expect(parseVersionQuery('2026-10-26', NOW, 'en-US')).toEqual(day(2026, 9, 26));
  });

  it('reads numeric dates in the locale order the list shows them', () => {
    expect(parseVersionQuery('10/26/2026', NOW, 'en-US')).toEqual(day(2026, 9, 26));
    expect(parseVersionQuery('10/26/2026, 4:12:33 PM', NOW, 'en-US')).toEqual(day(2026, 9, 26));
    expect(parseVersionQuery('26/10/2026', NOW, 'en-GB')).toEqual(day(2026, 9, 26));
    expect(parseVersionQuery('26/10/2026, 16:12:33', NOW, 'en-GB')).toEqual(day(2026, 9, 26));
  });

  it('gives a date without a year the most recent such day', () => {
    expect(parseVersionQuery('10/26', NOW, 'en-US')).toEqual(day(2026, 9, 26));
    // 12/25 hasn't happened yet this year, so it means last Christmas.
    expect(parseVersionQuery('12/25', NOW, 'en-US')).toEqual(day(2025, 11, 25));
  });

  it('reads month names in either order, abbreviated or not', () => {
    for (const text of ['Oct 26', 'oct 26', 'October 26', '26 Oct', '26 October', 'Oct. 26', 'Oct 26, 2026', 'October 26 2026']) {
      expect(parseVersionQuery(text, NOW, 'en-US'), text).toEqual(day(2026, 9, 26));
    }
  });

  it('reads a month and year as the whole month', () => {
    expect(parseVersionQuery('October 2026', NOW, 'en-US')).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 10, 1).toISOString(),
    });
  });

  it('treats anything else as an author search', () => {
    for (const text of ['jane', 'Jane Smith', 'architect@example.com', 'Marvin 3', 'May']) {
      expect(parseVersionQuery(text, NOW, 'en-US'), text).toEqual({ q: text });
    }
  });

  it('does not invent impossible dates', () => {
    expect(parseVersionQuery('2/31/2026', NOW, 'en-US')).toEqual({ q: '2/31/2026' });
    expect(parseVersionQuery('2026-13-01', NOW, 'en-US')).toEqual({ q: '2026-13-01' });
  });

  it('is empty for an empty box', () => {
    expect(parseVersionQuery('   ', NOW, 'en-US')).toEqual({});
  });
});
