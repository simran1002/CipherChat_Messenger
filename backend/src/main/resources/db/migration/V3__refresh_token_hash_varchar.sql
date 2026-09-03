-- Hibernate (ddl-auto=validate) maps the entity's String to VARCHAR and rejects CHAR(64) ("bpchar").
-- The value is always exactly 64 hex characters, so the type change is semantically neutral;
-- it is a new migration rather than an edit of V1 so applied databases evolve the same way.
ALTER TABLE refresh_tokens ALTER COLUMN token_hash TYPE VARCHAR(64);
