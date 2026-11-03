-- canvas-ez1.4: account lockout and an audit log. Three failed sign-ins lock a Canvas-password
-- account until an admin unlocks it (no time-based unlock). audit_events records sign-ins, failed
-- sign-ins, lockouts, password changes/resets and admin changes to users.
ALTER TABLE local_credentials ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_credentials ADD COLUMN locked_at TIMESTAMPTZ;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event TEXT NOT NULL,
  -- UUID like users.id (no FK: an audit row outlives the user it mentions).
  actor_user_id UUID,
  target_user_id UUID,
  ip TEXT,
  detail TEXT
);
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
