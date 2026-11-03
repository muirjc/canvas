-- canvas-3s5.1: SQLite mirror of Postgres 0026_github_integration.sql.
CREATE TABLE github_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  base_branch TEXT NOT NULL,
  folder TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TEXT,
  last_check_error TEXT,
  UNIQUE (repo_id, folder)
);

CREATE TABLE diagram_submissions (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  github_link_id TEXT REFERENCES github_links (id) ON DELETE SET NULL,
  -- Copied from the link, so status sync keeps working if the link is edited or removed.
  repo_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  base_branch TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  submitted_version_sequence INTEGER,
  submitted_fingerprint TEXT,
  last_pushed_commit_sha TEXT,
  head_sha TEXT,
  submitted_by_user_id TEXT REFERENCES users (id),
  first_submitted_at TEXT NOT NULL,
  last_submitted_at TEXT NOT NULL,
  submitting_since TEXT,
  review_state TEXT NOT NULL DEFAULT 'none',
  checks_state TEXT NOT NULL DEFAULT 'none',
  status_detail TEXT,
  last_synced_at TEXT,
  last_sync_error TEXT,
  merged_at TEXT,
  merged_by_login TEXT,
  merge_commit_sha TEXT,
  merged_head_matches INTEGER,
  closed_at TEXT
);
-- One open pull request per diagram.
CREATE UNIQUE INDEX diagram_submissions_one_open ON diagram_submissions (diagram_id) WHERE state = 'open';
CREATE INDEX diagram_submissions_state_sync_idx ON diagram_submissions (state, last_synced_at);
CREATE INDEX diagram_submissions_diagram_idx ON diagram_submissions (diagram_id);

CREATE TABLE diagram_submission_pushes (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES diagram_submissions (id) ON DELETE CASCADE,
  version_sequence INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  pushed_by_user_id TEXT REFERENCES users (id),
  pushed_at TEXT NOT NULL,
  warning_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX diagram_submission_pushes_submission_idx ON diagram_submission_pushes (submission_id);
