-- Spring Modulith event publication registry = the transactional outbox.
-- Owned by Flyway like every other table (Hibernate runs with ddl-auto=validate, and the JPA
-- persistence unit includes Modulith's JpaEventPublication entity, so the table must exist
-- before the EntityManagerFactory is built — a framework-side initializer would run too late).
-- Column names follow Spring's CamelCaseToUnderscores naming of the entity fields.
CREATE TABLE event_publication (
    id                     UUID        NOT NULL PRIMARY KEY,
    listener_id            TEXT        NOT NULL,
    event_type             TEXT        NOT NULL,
    serialized_event       TEXT        NOT NULL,
    publication_date       TIMESTAMPTZ NOT NULL,
    completion_date        TIMESTAMPTZ,
    status                 TEXT,
    completion_attempts    INTEGER     NOT NULL DEFAULT 0,
    last_resubmission_date TIMESTAMPTZ
);
-- Incomplete publications are what "republish on restart" scans; completed rows are deleted
-- (completion-mode: delete), so the partial index stays small.
CREATE INDEX event_publication_incomplete_idx ON event_publication (publication_date) WHERE completion_date IS NULL;
CREATE INDEX event_publication_serialized_event_hash_idx ON event_publication USING hash (serialized_event);

-- Mapped by the same module (completion-mode: archive would move rows here). Kept so schema
-- validation passes; unused with completion-mode: delete.
CREATE TABLE event_publication_archive (
    id                     UUID        NOT NULL PRIMARY KEY,
    listener_id            TEXT        NOT NULL,
    event_type             TEXT        NOT NULL,
    serialized_event       TEXT        NOT NULL,
    publication_date       TIMESTAMPTZ NOT NULL,
    completion_date        TIMESTAMPTZ,
    status                 TEXT,
    completion_attempts    INTEGER     NOT NULL DEFAULT 0,
    last_resubmission_date TIMESTAMPTZ
);
