-- canvas-2h2w.4: in-app notifications -- someone added you to a project, shared a diagram with you,
-- changed or removed your access, or made you a project's owner. subject_name is the name when it
-- happened (no foreign key: subject_type says which table; the purge removes a purged subject's rows).
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'level_changed', 'removed', 'ownership')),
  actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('project', 'diagram')),
  subject_id UUID NOT NULL,
  subject_name TEXT NOT NULL,
  access_level TEXT,
  previous_level TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  read_at TIMESTAMPTZ
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at);
