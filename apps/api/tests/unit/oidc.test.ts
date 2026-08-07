import { describe, expect, it } from 'vitest';
import { extractRealmRoles, mapRealmRolesToUserRole } from '../../src/auth/oidc.js';

describe('extractRealmRoles()', () => {
  it('reads roles from a well-formed realm_access.roles claim', () => {
    expect(extractRealmRoles({ realm_access: { roles: ['admin', 'offline_access'] } })).toEqual([
      'admin',
      'offline_access',
    ]);
  });

  it('returns an empty array when realm_access is absent', () => {
    expect(extractRealmRoles({})).toEqual([]);
  });

  it('returns an empty array when realm_access.roles is absent', () => {
    expect(extractRealmRoles({ realm_access: {} })).toEqual([]);
  });

  it('returns an empty array when realm_access is not an object', () => {
    expect(extractRealmRoles({ realm_access: 'not-an-object' })).toEqual([]);
  });

  it('returns an empty array when realm_access.roles is not an array', () => {
    expect(extractRealmRoles({ realm_access: { roles: 'admin' } })).toEqual([]);
  });

  it('filters out non-string entries rather than throwing -- an untyped claims bag from the IdP', () => {
    expect(extractRealmRoles({ realm_access: { roles: ['admin', 42, null, 'viewer'] } })).toEqual([
      'admin',
      'viewer',
    ]);
  });
});

/**
 * canvas-mi9: highest-privilege realm role wins; no recognised role defaults to the
 * lowest-privilege 'viewer' rather than failing closed (no access) or open (silently admin).
 */
describe('mapRealmRolesToUserRole()', () => {
  it('maps a single recognised role directly', () => {
    expect(mapRealmRolesToUserRole(['admin'])).toBe('admin');
    expect(mapRealmRolesToUserRole(['architect'])).toBe('architect');
    expect(mapRealmRolesToUserRole(['viewer'])).toBe('viewer');
  });

  it('picks the highest-privilege role when a token carries more than one', () => {
    expect(mapRealmRolesToUserRole(['viewer', 'admin'])).toBe('admin');
    expect(mapRealmRolesToUserRole(['viewer', 'architect'])).toBe('architect');
    expect(mapRealmRolesToUserRole(['architect', 'admin'])).toBe('admin');
  });

  it('ignores unrecognised Keycloak built-in roles (e.g. offline_access) when picking', () => {
    expect(mapRealmRolesToUserRole(['offline_access', 'architect'])).toBe('architect');
  });

  it('defaults to viewer when no recognised role is present', () => {
    expect(mapRealmRolesToUserRole([])).toBe('viewer');
    expect(mapRealmRolesToUserRole(['offline_access', 'default-roles-canvasrealm'])).toBe('viewer');
  });
});
