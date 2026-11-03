-- canvas-3s5.2: SQLite mirror of Postgres 0027_submission_withdrawn.sql.
ALTER TABLE diagram_submissions ADD COLUMN withdrawn_at TEXT;
ALTER TABLE diagram_submissions ADD COLUMN withdrawn_by_user_id TEXT REFERENCES users (id);
