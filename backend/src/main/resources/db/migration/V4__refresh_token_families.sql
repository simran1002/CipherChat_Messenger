-- Refresh-token families: reuse detection that actually revokes.
--
-- Rotation used to DELETE the presented row, so a replayed (stolen) token looked exactly like an
-- unknown one: nothing could be revoked and the audit event had no actor. Rows are now kept after use
-- (used_at) and every token minted from the same sign-in shares a family_id. Presenting a used token
-- outside a short race window revokes the whole family — the thief's live token included.
ALTER TABLE refresh_tokens
    ADD COLUMN family_id UUID        NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN used_at   TIMESTAMPTZ;

CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
