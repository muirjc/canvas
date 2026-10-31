# Plan: an IP allow-list security model (like ADP)

> **Status:** done. Option **2b** (serve the web app from the API container) shipped as canvas-r3y:
> one origin, `SameSite=Lax`, no CORS preflight; the Storage static website only redirects the old
> address.

Status: **built** (2026-10-22). Option A shipped first (canvas-cng, PR #211: API ingress + Storage
firewall allow-list, live-verified). Option B followed as the canvas-ez1 epic (PRs #212–#216):
`AUTH_MODE=local`, admin-managed accounts, a bootstrapped first admin, lockout + rate limiting +
an audit log, and TOTP MFA for everyone — beyond this plan's phase 2, which predates the MFA
decision. How to operate it: RUNBOOK.md → "Local accounts". The rest of this document is the
original plan, kept as the decision record.

## What "like ADP" means

ADP's Azure deployment has two layers:

1. **Network — an IP allow-list on ingress.** `infra/azure/.secrets/allowed-ips` (gitignored) holds
   one `CIDR description` per line. `deploy.sh` validates it, passes it to the API container app
   as `ipSecurityRestrictions` (once one Allow rule exists, Container Apps denies everything else),
   recreates the file from the live rules if it's missing, and **refuses to deploy a public API**
   unless `ADP_ALLOW_PUBLIC=1`. ADP serves its web app *from the API container*, so that one rule
   covers the whole app.
2. **Sign-in — still on.** Keycloak login is enabled in Azure (`ADP_AUTH_ENABLED=true`). ADP can
   run with auth off (everyone is one default "architect" user), but only for tests and local dev.

So ADP's allow-list is **defence in depth**, not a replacement for sign-in.

## Canvas today

- **Sign-in:** Entra ID (OIDC) in Azure; local email/password accounts only in dev
  (`ALLOW_LOCAL_AUTH`, seeded with known passwords). Users are created on their first Entra
  sign-in; there is no API or screen to create users or set passwords. Sessions are stored in the
  database.
- **Identity matters everywhere:** project ownership and visibility (feature 007), diagram sharing
  (008), admin vs architect vs viewer roles, "shared by", rename/delete rights — all need to know
  *who* the user is.
- **Azure:** the API container app has external ingress with **no** IP restriction. The web app is
  a **public Storage static website** (a different origin from the API, which is why the session
  cookie is `SameSite=None`). Postgres is private (VNet); Key Vault holds the secrets.

## The decision: what sign-in looks like inside the allow-list

| Option | What users do | Effort | Notes |
|---|---|---|---|
| **A. Allow-list + Entra (ADP's model)** | Sign in with Entra as today, but only from allow-listed networks | Small | Pure network change. Identity, roles and sharing unchanged. |
| **B. Allow-list + local accounts** | Sign in with an email and password Canvas manages; no Entra needed | Medium–large | For environments without an Entra tenant. Needs user management that doesn't exist yet. |
| **C. Allow-list only, no sign-in** | Open the site from an allowed network; everyone is the same user | Small to build, large to live with | Breaks ownership, sharing, roles and audit. Only sensible for a single-user sandbox. **Not recommended.** |

**Recommendation:** build **A** first — it's what ADP actually does, it's small, and it stands on its
own. Add **B** only if there's a real need to run Canvas somewhere without Entra. A is also
phase 1 of B, so nothing is wasted.

## Work breakdown

### Phase 1 — the network allow-list (needed for A and B)

1. **API ingress.** `modules/apiapp.bicep`: an `allowedIpRanges` parameter rendered as
   `ipSecurityRestrictions` (copy ADP's block); threaded through `main.bicep`.
2. **The web app.** The Storage static website is public today, so restricting only the API would
   leave the app's front door open. Two ways:
   - **a. Storage firewall (recommended for now):** `modules/storage.bicep` sets `networkAcls`
     (`defaultAction: 'Deny'` plus the same `ipRules`). Small. Consequences: `deploy.sh`,
     `pause.sh` and `resume.sh` upload blobs from the deployer's machine, so its IP must be in the
     list (check and fail clearly if not); the Azure portal's blob browser stops working from other
     networks. To verify during implementation: the static website endpoint honours the storage
     firewall (it's documented to).
   - **b. Serve the web app from the API container, as ADP does:** one origin, one restriction,
     and the cross-site cookie (`SameSite=None`) and CORS go away. Larger: a Fastify static plugin,
     the Dockerfile builds the web app, `deploy.sh` stops publishing to Storage, and the paused
     page (canvas-vnh) needs a new home. Worth doing later on its own merits.
3. **`deploy.sh`.** Copy ADP's handling: read and validate `.secrets/allowed-ips` (`CIDR
   description` per line, `#` comments); recreate it from the live rules when missing; refuse to
   deploy with an empty list unless `CANVAS_ALLOW_PUBLIC=1`; print the list in the summary; warn
   when the deployer's current public IP isn't in it.
4. **Docs.** README (deploy prerequisites), RUNBOOK: adding an address, and the **fast fix when a
   home IP changes** (`az containerapp ingress access-restriction set …`, plus the storage
   equivalent) without a full redeploy.
5. **Verification (live).** From an allowed network: the site, sign-in and API work. From a
   non-allowed one (e.g. a phone on mobile data): the API and the web app both refuse (403).
   `deploy.sh`'s refusal path and the "file missing → rebuilt from live" path.

Estimate: about one working session, including the live check.

### Phase 2 — local accounts in Azure (only for option B)

1. **An explicit auth mode.** `AUTH_MODE=entra|local` replaces "is `ALLOW_LOCAL_AUTH` on?" as the
   switch; the sign-in page asks `/auth/config` which to show (SSO button or password form).
   `deploy.sh` refuses `local` without an allow-list.
2. **User management** (doesn't exist today): admin can create a user (email, name, role, a
   one-time password), reset a password, and deactivate (already exists). Users change their own
   password; a temporary password must be changed at first sign-in.
3. **No known passwords in Azure.** The seed's dev accounts must never be created there. The
   first admin is bootstrapped with a generated password stored in `.secrets/` (or a one-off job,
   like ADP's Keycloak user job).
4. **Hardening the password path:** rate limiting / lockout on `/auth/local/login` (likely a new
   dependency such as `@fastify/rate-limit`), a password policy, and audit entries for sign-in,
   password changes and admin user changes.
5. **Tests:** contract tests for the user-management API, rate limiting and the mode switch; e2e
   for creating a user, first sign-in and a password change. (Most e2e already uses local sign-in.)

Estimate: two to three more sessions.

## Risks and things to know

- **Changing home IPs** lock you out until the list is updated — the same trade-off ADP lives with.
  The RUNBOOK fix makes it a one-command recovery.
- **Shared networks:** allowing an office or VPN range lets *everyone* on it reach the site. With
  option A that's fine (they still need Entra); with option B the password becomes the only
  per-user control, hence phase 2's hardening.
- **Spoofing:** Container Apps and Storage check the real client address at their edge, not a
  header, so the allow-list can't be bypassed by setting `X-Forwarded-For`.
- **IPv6:** clients reaching the site over IPv6 need IPv6 ranges in the list.
- **Cost:** none — both restrictions are free features.

## Questions for the product owner

1. **A, B or C?** (Recommended: A now, B only if an Entra-less environment is a real need.)
2. Who and what goes on the list to start — your home IP, an office range, a VPN?
3. For the web app: storage firewall now (2a), or move the app into the API container (2b)?
