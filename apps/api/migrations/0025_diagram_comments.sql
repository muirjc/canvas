-- canvas-bw4: comments on diagrams -- the "comment" share level finally means something.
-- A thread is a root comment (thread_root_id null) plus its replies. A thread may be pinned to a
-- shape or connector (anchor_type/anchor_id; it reads as general if that element is gone) and
-- resolved. Deleting a comment keeps its row (deleted_at) so the thread still reads. Reads hold
-- when each person last looked at a diagram's comments, for the unread count.
CREATE TABLE diagram_comments (
  id UUID PRIMARY KEY,
  diagram_id UUID NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  thread_root_id UUID REFERENCES diagram_comments (id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users (id),
  body TEXT NOT NULL,
  anchor_type TEXT,
  anchor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users (id)
);
CREATE INDEX diagram_comments_diagram_idx ON diagram_comments (diagram_id, created_at);
CREATE INDEX diagram_comments_thread_idx ON diagram_comments (thread_root_id);

CREATE TABLE diagram_comment_reads (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  diagram_id UUID NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, diagram_id)
);
