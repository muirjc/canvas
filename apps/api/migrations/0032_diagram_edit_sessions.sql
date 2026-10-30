-- canvas-obp0: who has a diagram open in the editor right now. Each open editor tab sends a
-- heartbeat; a row whose last_seen_at is older than the expiry window no longer counts. Advisory
-- only (a banner) -- stale saves are stopped separately, by the save's base version check.
CREATE TABLE diagram_edit_sessions (
  diagram_id UUID NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (diagram_id, user_id, session_id)
);
CREATE INDEX diagram_edit_sessions_seen_idx ON diagram_edit_sessions (diagram_id, last_seen_at);
