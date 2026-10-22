-- canvas-ez1.5: two-step verification (TOTP) for Canvas-password accounts. secret_encrypted is
-- AES-256-GCM (MFA_ENCRYPTION_KEY); enabled_at is null while set-up is started but not confirmed.
-- last_used_step stops a code being replayed. Recovery codes are stored hashed, single use.
CREATE TABLE user_mfa (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  last_used_step BIGINT
);

CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);
