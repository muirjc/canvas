#!/usr/bin/env node
// Create/refresh real Keycloak users via the admin REST API (canvas-ycu.1's decided
// user-provisioning approach -- mirrors ADP's src/adp/ops/keycloak_create_users.py).
//
// `start --import-realm` is IGNORE_EXISTING -- it never adds users to an already-imported
// realm, and CanvasRealm-realm.json's own two seeded users (sso-admin@example.com,
// sso-architect@example.com) are documented as local-iteration fixtures only, not real
// accounts for a deployed environment. This script is the real path: run it against a
// deployed realm (reachable only from inside the VNet, since Keycloak has internal-only
// ingress -- see infra/azure/README.md for how to reach it, e.g. `az containerapp exec`
// into canvas-api, which shares the same Container Apps environment) to create/update real
// named accounts.
//
// MFA gotcha (carried over verbatim from ADP's own script, re-verified for canvas's realm):
// a realm's `requiredActions[].defaultAction` (CanvasRealm-realm.json's own CONFIGURE_TOTP
// entry) only gets assigned to users created through Keycloak's own self-registration/
// first-login flow -- users created via this admin-API POST do NOT inherit it automatically.
// New users are therefore given `requiredActions: ["CONFIGURE_TOTP"]` explicitly below so MFA
// enrollment is actually enforced on first login, not just nominally configured at the realm
// level. Existing users are left alone on re-run (no forced re-enrollment of an already-set-up
// user).
//
// canvas maps ROLES, not groups (apps/api/src/auth/oidc.ts's mapRealmRolesToUserRole reads
// `realm_access.roles` from the ID token) -- unlike ADP's group-based script, this assigns
// realm ROLES (admin/architect/viewer, CanvasRealm-realm.json's own `roles.realm` list).
//
// Required env vars:
//   KEYCLOAK_URL              Base URL INCLUDING /idp, e.g. https://canvas-keycloak.internal.../idp
//   KEYCLOAK_REALM            Realm name, e.g. CanvasRealm
//   KEYCLOAK_ADMIN_USERNAME   Master-realm admin username (KEYCLOAK_ADMIN in keycloak.bicep)
//   KEYCLOAK_ADMIN_PASSWORD   Master-realm admin password (keycloak-admin-password Key Vault secret)
//   KC_USERS                  JSON array of objects, each:
//                               {"username": "...", "email": "...", "password": "...",
//                                "role": "admin" | "architect" | "viewer"}
//                             Re-running resets the password and re-asserts the realm role
//                             (idempotent) -- it does NOT re-trigger MFA enrollment for an
//                             already-existing user.
//
// Usage: KEYCLOAK_URL=... KEYCLOAK_REALM=CanvasRealm KEYCLOAK_ADMIN_USERNAME=admin \
//   KEYCLOAK_ADMIN_PASSWORD=... KC_USERS='[{"username":"jane","email":"jane@example.com",
//   "password":"...","role":"architect"}]' node infra/keycloak/create-users.mjs

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: required env var ${name} is not set`);
    process.exit(1);
  }
  return value;
}

async function checkedFetch(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${response.status}: ${body}`);
  }
  return response;
}

async function adminToken(base, username, password) {
  const response = await checkedFetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username,
      password,
    }),
  });
  const body = await response.json();
  return body.access_token;
}

async function findUserId(base, realm, headers, username) {
  const response = await checkedFetch(
    `${base}/admin/realms/${realm}/users?${new URLSearchParams({ username, exact: 'true' })}`,
    { headers },
  );
  const hits = await response.json();
  return hits.length > 0 ? hits[0].id : null;
}

async function main() {
  const base = requireEnv('KEYCLOAK_URL').replace(/\/$/, '');
  const realm = requireEnv('KEYCLOAK_REALM');
  const adminUsername = requireEnv('KEYCLOAK_ADMIN_USERNAME');
  const adminPassword = requireEnv('KEYCLOAK_ADMIN_PASSWORD');
  const users = JSON.parse(requireEnv('KC_USERS'));

  const token = await adminToken(base, adminUsername, adminPassword);
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  for (const u of users) {
    if (!['admin', 'architect', 'viewer'].includes(u.role)) {
      throw new Error(`user ${u.username}: role must be admin/architect/viewer, got ${u.role}`);
    }

    let userId = await findUserId(base, realm, headers, u.username);
    let action;
    if (userId === null) {
      await checkedFetch(`${base}/admin/realms/${realm}/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          username: u.username,
          email: u.email ?? '',
          emailVerified: true,
          enabled: true,
          // Explicit per-user requiredAction -- see the MFA gotcha in the header comment.
          requiredActions: ['CONFIGURE_TOTP'],
        }),
      });
      userId = await findUserId(base, realm, headers, u.username);
      action = 'created';
    } else {
      action = 'updated';
    }

    // (Re)set a permanent password -- idempotent on re-run.
    await checkedFetch(`${base}/admin/realms/${realm}/users/${userId}/reset-password`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ type: 'password', value: u.password, temporary: false }),
    });

    // Assert realm role membership -- Keycloak's role-mappings endpoint needs the role's own
    // id/name pair, not just its name, to add it.
    const roleResp = await checkedFetch(`${base}/admin/realms/${realm}/roles/${u.role}`, { headers });
    const role = await roleResp.json();
    await checkedFetch(`${base}/admin/realms/${realm}/users/${userId}/role-mappings/realm`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ id: role.id, name: role.name }]),
    });

    console.log(`OK: ${action} user ${u.username} (id=${userId}) role=${u.role}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
