-- canvas-bj7: ending a session marks it revoked instead of deleting the row. Sessions are saved at
-- the end of every response (rolling), so a request still in flight when a session was ended
-- (sign-out, an admin's password reset/deactivation/lockout/MFA reset) used to re-create the
-- deleted row and bring the session back. A revoked row is never written over and reads as no
-- session; it is pruned once it expires like any other.
ALTER TABLE sessions ADD COLUMN revoked BOOLEAN NOT NULL DEFAULT false;
