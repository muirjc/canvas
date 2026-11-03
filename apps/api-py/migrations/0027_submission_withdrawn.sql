-- canvas-3s5.2: a submission withdrawn from Canvas (its pull request closed by the submitter)
-- is told apart from one rejected on GitHub.
ALTER TABLE diagram_submissions ADD COLUMN withdrawn_at TIMESTAMPTZ;
ALTER TABLE diagram_submissions ADD COLUMN withdrawn_by_user_id UUID REFERENCES users (id);
