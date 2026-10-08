# Entra ID Authentication & Authorization Specification

Oct 1, 2026 · @john

## 1. Purpose & Scope

This specification defines authentication and authorization requirements for any application component that must verify user or service identity and enforce access control using Microsoft Entra ID as the identity provider.

It is written to be **implementation-agnostic**: no requirement below assumes a specific programming language, framework, or SDK. Implementers select tooling appropriate to their stack (e.g. MSAL, a framework-native OIDC middleware, or direct OAuth2/OIDC HTTP calls) as long as the behavioral requirements in this document are met.

The spec covers:

- Authentication of users and/or services against Entra ID using standard OAuth 2.0 / OpenID Connect flows
- Authorization decisions based on claims issued by Entra ID (roles, groups, scopes)
- Configuration and secret-handling requirements that keep the system portable between a personal/free Azure tenant (development) and an enterprise-managed tenant (production)

It does not cover UI/UX of login screens, Entra ID tenant provisioning steps, or network-level infrastructure (reverse proxies, API gateways) beyond what is needed to pass and validate tokens.

## 2. Goals & Non-Goals

**Goals**

- Authenticate users and/or services via Entra ID using standards-compliant OIDC/OAuth2 flows
- Enforce authorization using claims issued directly by Entra ID (App Roles, group claims, scopes) rather than a parallel, custom permission system
- Keep every tenant-specific value (tenant ID, client ID, secrets, authority URL) outside of application logic, in configuration
- Support moving the application from a personal/free Azure tenant to an enterprise-managed Entra tenant by changing configuration only — no code changes to authentication or authorization logic

**Non-Goals**

- Building a custom user store, password system, or credential database (Entra ID is the system of record for identity)
- Supporting identity providers other than Entra ID at this time (the design should not actively prevent this, but multi-IdP support is out of scope)
- Defining the enterprise tenant's governance process (Conditional Access policy authorship, PIM, consent workflows) — this spec assumes the application is a *consumer* of whatever policies the tenant enforces

## 3. Identity Provider Overview

Entra ID is an OpenID Connect (OIDC) / OAuth 2.0 identity provider. The concepts below are referenced throughout this spec and should be understood as tenant-independent — they behave identically on a free/personal tenant and an enterprise tenant.

- **Tenant**: an isolated Entra ID directory. Each has a unique Tenant ID (GUID). A free Azure subscription provisions its own tenant automatically.
- **App Registration**: the record of an application within a tenant. Produces a Client ID (GUID) and, optionally, client secrets or certificate credentials.
- **Authority**: the tenant-specific issuer URL, of the form `https://login.microsoftonline.com/{tenant-id}`. All token requests and validation are scoped to this authority.
- **Token**: a signed JWT issued by Entra ID. Three types matter here — an **ID token** (proves user identity, used by the client), an **access token** (presented to an API to authorize a request), and a **refresh token** (used to silently obtain new access tokens).
- **Scope**: a permission an application requests (e.g. `api://{client-id}/user_impersonation`, or Microsoft Graph scopes like `User.Read`).
- **App Role**: an application-defined role (e.g. `Admin`, `Reader`) declared on the app registration and assigned to users, groups, or service principals. Appears in the validated token as a `roles` claim. This is the preferred mechanism for authorization in this spec, in place of a custom role table.
- **JWKS (JSON Web Key Set)**: the tenant's published signing keys, fetched from a well-known endpoint and used to cryptographically verify token signatures without a round trip to Entra ID on every request.

## 4. Authentication Requirements

**AUTH-1. Flow selection is interaction-dependent.**

- Any component with an interactive user login MUST use the **Authorization Code flow with PKCE** (Proof Key for Code Exchange). Implicit flow MUST NOT be used.
- Any component acting as a service with no signed-in user (service-to-service, background job) MUST use the **Client Credentials flow**.

**AUTH-2. Authorization Code + PKCE sequence** (interactive login):

1. Application generates a PKCE code verifier/challenge pair and redirects the user to Entra ID's `/authorize` endpoint with the challenge, requested scopes, and redirect URI.
2. User authenticates with Entra ID (credentials, MFA, Conditional Access as configured on the tenant).
3. Entra ID redirects back to the application with an authorization code.
4. Application exchanges the code, plus the original PKCE verifier, for an ID token, access token, and refresh token at the `/token` endpoint.
5. Application validates the ID token (see AUTH-4) and establishes a session.
6. Application uses the access token on subsequent calls to protected APIs; uses the refresh token to obtain new access tokens silently when they expire.

**AUTH-3. Client Credentials sequence** (service-to-service):

1. Service authenticates directly to the `/token` endpoint using its client ID and credential (secret or certificate) — no user is involved.
2. Entra ID returns an access token scoped to the requested resource.
3. Service presents this token on calls to the target API.

**AUTH-4. Token validation.** Every component that receives a token MUST independently validate it before trusting any claim inside it. At minimum:

- Signature verified against the tenant's current JWKS (fetched from the authority's well-known endpoint, cached, and refreshed on key rotation)
- `iss` (issuer) matches the expected tenant authority
- `aud` (audience) matches this application's expected audience (its own client ID or exposed API identifier)
- `exp`/`nbf` (expiry/not-before) checked against current time
- Token has not been tampered with or truncated

Validation MUST NOT be skipped for tokens received from a trusted network segment or internal caller — validate on every hop that makes an authorization decision.

**AUTH-5. No flow-specific logic outside the auth layer.** Business logic components MUST receive a validated identity/claims object, not a raw token or flow-specific detail, so swapping a flow (e.g. adding a CLI device-code flow later) touches only the auth layer.

## 5. Authorization Requirements

**AUTHZ-1. Roles are defined in Entra ID, not in application code.** App Roles MUST be declared on the app registration's manifest (e.g. `Admin`, `Operator`, `Reader`). Assignment of users/groups/service principals to roles happens in Entra ID (or the tenant's identity governance process), not in an application database.

**AUTHZ-2. Authorization decisions are claims-based.** After token validation (AUTH-4), the application extracts the `roles` claim (and, if used, `groups` or custom claims) and makes access-control decisions from it. No custom role/permission table should duplicate what Entra ID already asserts.

**AUTHZ-3. Fail closed.** If a required role/claim is absent, missing, or the token fails validation, the request MUST be denied by default. Authorization checks are deny-by-default, not allow-by-default.

**AUTHZ-4. Least privilege at the role level.** Define the minimum number of roles needed to express real access distinctions. Avoid a single all-powerful role where narrower roles would do.

**AUTHZ-5. Authorization logic is reusable across entry points.** Whether a request arrives via an HTTP API, a CLI, or a background job triggered by a service principal, the same claims-based authorization check MUST apply — implemented once, called from every entry point, not reimplemented per surface.

## 6. Configuration Contract

**CFG-1.** No tenant ID, client ID, authority URL, scope, or secret reference may be hardcoded anywhere in application logic. All of the following MUST be externalized to configuration (environment variables, a config file, or a secrets manager — see Section 7):

| Setting | Required | Example (dev) | Notes |
| --- | --- | --- | --- |
| Tenant ID | Yes | `9f8a...` (free tenant GUID) | Changes on every tenant move |
| Client ID | Yes | `3c21...` | Per app registration, per tenant |
| Client credential type | Yes | `secret` | `secret` in dev; enterprise may require `certificate` |
| Client secret / cert reference | Conditional | value or Key Vault reference | Never the literal secret value in source control |
| Authority URL | Derived | `https://login.microsoftonline.com/{tenant_id}` | Computed from Tenant ID, not set independently |
| Expected audience | Yes | `api://{client_id}` or a custom App ID URI | Used in AUTH-4 validation |
| Requested scopes | Yes | `api://{client_id}/user_impersonation` | Flow-dependent |
| Redirect URI(s) | Conditional | `http://localhost:8000/callback` | Only for interactive flows |

**CFG-2.** Configuration MUST be loaded once at startup and validated (required fields present, authority URL well-formed) before the application begins accepting requests. Fail fast on missing configuration rather than failing per-request.

**CFG-3.** A single named configuration object/module should be the sole source of these values throughout the codebase — no component reads tenant ID or client ID from a second location.

## 7. Secret & Credential Management

**SEC-1. Secrets are never committed to source control.** Client secrets, certificates, and connection strings for secret stores MUST be excluded from version control (e.g. via `.gitignore`) in every environment.

**SEC-2. Secret retrieval is abstracted behind one interface.** The application MUST obtain its client credential through a single function/module boundary (e.g. `get_client_credential()`), never by reading the raw value inline in multiple places. This is what makes SEC-3 a configuration swap rather than a code change.

**SEC-3. Environment-specific backing store:**

- **Development (free/personal tenant):** a local `.env` file or equivalent, excluded from source control, is acceptable.
- **Enterprise tenant:** secrets MUST be retrieved from a managed secret store (e.g. Azure Key Vault) or, preferably, avoided entirely via a platform-managed identity (e.g. Managed Identity) that removes the need for a stored secret.

**SEC-4. Certificate credentials preferred where supported.** Where the hosting environment and tenant policy allow it, prefer certificate-based client credentials over client secrets, since certificates are harder to leak and easier to rotate without downtime. The configuration contract (Section 6) MUST support both credential types without a code change — only the `Client credential type` setting changes.

**SEC-5. Rotation does not require a deployment.** Secret/certificate rotation MUST be achievable by updating the secret store or environment configuration, without requiring an application code change or rebuild.

## 8. Portability Requirements (Dev Tenant → Enterprise Tenant)

**PORT-1.** Moving the application from the free/personal tenant to an enterprise tenant MUST require only a configuration change (Section 6) plus, where applicable, a secret-store swap (Section 7). No change to authentication logic (Section 4) or authorization logic (Section 5) is acceptable as part of a tenant move.

**PORT-2.** What changes vs. what does not:

| Aspect | Dev / free tenant | Enterprise tenant | Code impact |
| --- | --- | --- | --- |
| Tenant ID / Client ID | Personal values | New, enterprise-issued values | Config only |
| Client credential | Secret in `.env` | Certificate or Managed Identity | Config only (SEC-4) |
| Secret storage | Local file | Key Vault / managed store | Swap behind SEC-2's interface |
| Conditional Access / MFA policy | Minimal or none | Enforced by tenant admins | None — enforced upstream by Entra ID, transparent to the app |
| App Role assignment | Self-assigned | Managed by enterprise identity governance | None — app reads the same `roles` claim either way |
| Token validation logic | Same | Same | No change |
| Authorization logic | Same | Same | No change |

**PORT-3. Single-tenant vs. multi-tenant app registration.** Decide and document explicitly whether the app registration is single-tenant (restricted to one Entra tenant) or multi-tenant. A dev-tenant app registration is typically single-tenant; confirm the enterprise tenant's requirement before migration, since this affects how the authority/issuer is validated (AUTH-4).

**PORT-4. Verify, don't assume.** Before declaring a migration complete, re-run the full authentication and authorization test suite (Section 10) against the enterprise tenant with its real policies in effect — Conditional Access or consent requirements not present in the free tenant can surface only at this point.

## 9. Non-Functional Requirements

**NFR-1. Security**

- Tokens MUST be transmitted only over TLS.
- Access tokens MUST NOT be logged, including in debug logs. Log claims needed for audit (e.g. subject ID, roles) selectively, never the raw token.
- Token lifetimes follow Entra ID defaults unless a documented reason requires otherwise; do not extend lifetimes to work around refresh-flow issues.

**NFR-2. Testability**

- Authentication and authorization logic MUST be testable without a live Entra ID tenant — e.g. by validating against recorded/mocked JWKS and sample tokens for unit tests, reserving live-tenant tests for integration/acceptance level.
- The claims-extraction and authorization-decision logic (AUTHZ-2, AUTHZ-3) MUST be isolated from transport/framework code so it can be unit tested directly.

**NFR-3. Observability**

- Authentication failures and authorization denials MUST be logged with enough context to diagnose (which claim was missing, which role was required) without logging sensitive token contents.
- A clear distinction MUST be observable in logs/metrics between "authentication failed" (401-class) and "authorized but insufficient permission" (403-class) outcomes.

**NFR-4. Performance**

- JWKS keys MUST be cached locally and refreshed on a schedule or on signature-validation failure (indicating possible key rotation), not fetched on every request.
- Token validation MUST be local (signature + claims check) rather than requiring a network round-trip to Entra ID per request, except where the flow specifically requires it (e.g. initial code exchange).

## 10. Acceptance Criteria / Quality Gates

A component claiming conformance to this spec MUST satisfy all of the following before being considered complete:

- [ ] Interactive login uses Authorization Code + PKCE; Implicit flow is not present anywhere (AUTH-1, AUTH-2)
- [ ] Service-to-service auth uses Client Credentials flow with no interactive user involved (AUTH-1, AUTH-3)
- [ ] Every token-accepting component independently validates signature, issuer, audience, and expiry before trusting any claim (AUTH-4)
- [ ] A deliberately tampered or expired token is rejected in a test, not merely assumed to be rejected (AUTH-4)
- [ ] Authorization decisions read only from Entra ID-issued claims (App Roles/groups); no parallel custom permission table exists (AUTHZ-1, AUTHZ-2)
- [ ] A request with a missing/insufficient role is denied by default, verified by test (AUTHZ-3)
- [ ] No tenant ID, client ID, authority URL, or secret value appears hardcoded in source (CFG-1) — verified by a source scan
- [ ] Application fails fast at startup on missing required configuration (CFG-2)
- [ ] Client credential retrieval goes through a single abstraction point, not inlined in multiple places (SEC-2)
- [ ] No secret value is present in version control history (SEC-1) — verified by a repository scan
- [ ] Switching the credential type setting (secret → certificate) requires no code change (SEC-4, CFG-1)
- [ ] Full auth/authz test suite passes against both the dev tenant and, before production sign-off, a test run against the target enterprise tenant (PORT-4)
- [ ] Access tokens are absent from all log output, including debug-level logs (NFR-1)
- [ ] Authentication and authorization logic has unit test coverage that does not require a live Entra ID tenant (NFR-2)

## 11. Glossary

| Term | Definition |
| --- | --- |
| Entra ID | Microsoft's cloud identity platform (formerly Azure Active Directory) |
| Tenant | An isolated Entra ID directory; identified by a Tenant ID |
| App Registration | The record of an application within a tenant; produces a Client ID |
| OIDC | OpenID Connect — an identity layer on top of OAuth 2.0 |
| PKCE | Proof Key for Code Exchange — a security extension to the Authorization Code flow |
| JWT | JSON Web Token — the signed token format used for ID and access tokens |
| JWKS | JSON Web Key Set — the public keys used to verify token signatures |
| App Role | An application-defined role, assignable to users/groups/service principals, surfaced in tokens as a `roles` claim |
| Claim | A piece of information asserted about the subject inside a validated token |
| Client Credentials flow | OAuth2 flow for service-to-service auth with no interactive user |
| Managed Identity | An Azure-managed credential that removes the need to store a secret for a service's own identity |
