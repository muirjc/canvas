-- Local email/password fallback credentials (research.md §7 — OIDC SSO is primary; this is a
-- fallback for the smallest deployments and is gated behind ALLOW_LOCAL_AUTH). Kept in its own
-- table so the core `users` table stays auth-method-agnostic.

CREATE TABLE local_credentials (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL
);
