import { afterEach, describe, expect, it } from 'vitest';
import {
  isBareAddress,
  locationToSearch,
  parseLocation,
  readLastBrowseHref,
  readLastProjectId,
  resolveLanding,
  sameLocation,
  writeLastBrowse,
  writeLastProjectId,
} from '../../src/app/navigation';

/** canvas-t3b.2: the address <-> location mapping and landing rules (docs/browse-screen-design.md). */

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const D1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('parseLocation / locationToSearch', () => {
  it('maps each screen to its address and back', () => {
    for (const location of [{ screen: 'projects' }, { screen: 'project', projectId: P1 }, { screen: 'diagram', diagramId: D1 }] as const) {
      expect(parseLocation(locationToSearch(location))).toEqual(location);
    }
    expect(locationToSearch({ screen: 'projects' })).toBe('?');
    expect(locationToSearch({ screen: 'project', projectId: P1 })).toBe(`?projectId=${P1}`);
  });

  it('an old ?projectId= link still names that project', () => {
    expect(parseLocation(`?projectId=${P1}`)).toEqual({ screen: 'project', projectId: P1 });
  });

  it('diagramId wins over projectId, and malformed ids read as the top level', () => {
    expect(parseLocation(`?projectId=${P1}&diagramId=${D1}`)).toEqual({ screen: 'diagram', diagramId: D1 });
    expect(parseLocation('?projectId=not-a-uuid')).toEqual({ screen: 'projects' });
    expect(parseLocation('?diagramId=../x')).toEqual({ screen: 'projects' });
    expect(parseLocation('')).toEqual({ screen: 'projects' });
  });

  it('isBareAddress is false for any screen or admin page', () => {
    expect(isBareAddress('')).toBe(true);
    expect(isBareAddress('?')).toBe(true);
    expect(isBareAddress(`?projectId=${P1}`)).toBe(false);
    expect(isBareAddress(`?diagramId=${D1}`)).toBe(false);
    expect(isBareAddress('?admin=users')).toBe(false);
  });

  it('sameLocation compares screen and id', () => {
    expect(sameLocation({ screen: 'project', projectId: P1 }, { screen: 'project', projectId: P1 })).toBe(true);
    expect(sameLocation({ screen: 'project', projectId: P1 }, { screen: 'project', projectId: P2 })).toBe(false);
    expect(sameLocation({ screen: 'projects' }, { screen: 'project', projectId: P1 })).toBe(false);
  });
});

describe('resolveLanding', () => {
  it('opens the only project when nothing is shared', () => {
    expect(resolveLanding([P1], 0, null)).toEqual({ screen: 'project', projectId: P1 });
  });

  it('stays on the top level for one project when something is shared, so it is visible', () => {
    expect(resolveLanding([P1], 2, null)).toEqual({ screen: 'projects' });
  });

  it('resumes the last project with two or more, only if it is still theirs', () => {
    expect(resolveLanding([P1, P2], 0, P2)).toEqual({ screen: 'project', projectId: P2 });
    expect(resolveLanding([P1, P2], 3, P2)).toEqual({ screen: 'project', projectId: P2 });
    expect(resolveLanding([P1, P2], 0, 'gone')).toEqual({ screen: 'projects' });
    expect(resolveLanding([P1, P2], 0, null)).toEqual({ screen: 'projects' });
  });

  it('no projects lands on the top level', () => {
    expect(resolveLanding([], 0, null)).toEqual({ screen: 'projects' });
  });
});

describe('last project hint', () => {
  afterEach(() => window.localStorage.clear());

  it('round-trips through localStorage and can be cleared', () => {
    expect(readLastProjectId()).toBeNull();
    writeLastProjectId(P1);
    expect(readLastProjectId()).toBe(P1);
    writeLastProjectId(null);
    expect(readLastProjectId()).toBeNull();
  });
});

describe('last Browse location (canvas-t3b.4)', () => {
  afterEach(() => window.sessionStorage.clear());

  it('records the project list and projects, never the editor', () => {
    expect(readLastBrowseHref()).toBeNull();
    writeLastBrowse({ screen: 'project', projectId: P1 });
    expect(readLastBrowseHref()).toBe(`/?projectId=${P1}`);
    writeLastBrowse({ screen: 'diagram', diagramId: D1 });
    expect(readLastBrowseHref()).toBe(`/?projectId=${P1}`);
    writeLastBrowse({ screen: 'projects' });
    expect(readLastBrowseHref()).toBe('/');
  });
});
