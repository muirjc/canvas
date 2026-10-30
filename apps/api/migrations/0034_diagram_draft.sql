-- canvas-j6v: a diagram drawn by Create with AI starts as a draft -- nothing saved yet. Only its
-- creator can open it, it's in no list, and the first Save makes it a normal diagram. Discarding a
-- draft deletes it outright; an abandoned one is removed by the purge script after a day.
ALTER TABLE diagrams ADD COLUMN draft BOOLEAN NOT NULL DEFAULT FALSE;
