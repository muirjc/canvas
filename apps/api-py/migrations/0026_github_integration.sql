-- canvas-3s5.1: submitting diagrams to GitHub for approval (docs/github-approval-design.md).
-- An admin links a project to a repository + folder; each pull request Canvas opens for a diagram
-- is a submission (one open at a time per diagram); every push to it is recorded.
CREATE TABLE github_links (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  repo_id BIGINT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
  base_branch TEXT NOT NULL,
  folder TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TIMESTAMPTZ,
  last_check_error TEXT,
  UNIQUE (repo_id, folder)
);

CREATE TABLE diagram_submissions (
  id UUID PRIMARY KEY,
  diagram_id UUID NOT NULL REFERENCES diagrams (id) ON DELETE CASCADE,
  github_link_id UUID REFERENCES github_links (id) ON DELETE SET NULL,
  -- Copied from the link, so status sync keeps working if the link is edited or removed.
  repo_id BIGINT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
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
  submitted_by_user_id UUID REFERENCES users (id),
  first_submitted_at TIMESTAMPTZ NOT NULL,
  last_submitted_at TIMESTAMPTZ NOT NULL,
  submitting_since TIMESTAMPTZ,
  review_state TEXT NOT NULL DEFAULT 'none',
  checks_state TEXT NOT NULL DEFAULT 'none',
  status_detail TEXT,
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  merged_at TIMESTAMPTZ,
  merged_by_login TEXT,
  merge_commit_sha TEXT,
  merged_head_matches BOOLEAN,
  closed_at TIMESTAMPTZ
);
-- One open pull request per diagram.
CREATE UNIQUE INDEX diagram_submissions_one_open ON diagram_submissions (diagram_id) WHERE state = 'open';
CREATE INDEX diagram_submissions_state_sync_idx ON diagram_submissions (state, last_synced_at);
CREATE INDEX diagram_submissions_diagram_idx ON diagram_submissions (diagram_id);

CREATE TABLE diagram_submission_pushes (
  id UUID PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES diagram_submissions (id) ON DELETE CASCADE,
  version_sequence INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  pushed_by_user_id UUID REFERENCES users (id),
  pushed_at TIMESTAMPTZ NOT NULL,
  warning_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX diagram_submission_pushes_submission_idx ON diagram_submission_pushes (submission_id);
