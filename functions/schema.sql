-- D1 online source of truth for the Cloudflare deployment.
--
-- Apply once with:
--   wrangler d1 execute vita-log --file=functions/schema.sql
--
-- This ticket only reads this table. The owner write path (versioned save and
-- the one-time import of the local SQLite snapshot) lands in 06.1-02a/06.1-03;
-- 06.1-03 additionally owns the "database must be empty before first import"
-- guard. Nothing here may be created through the public API.
--
-- Credentials and sessions are deliberately absent from this file: the owner
-- account is provisioned from a deployment secret or a one-off ops command
-- (06.1-02b), never from a request a visitor can make.
--
-- No PRAGMA here on purpose. D1 only supports table_list, table_info and
-- foreign_keys; every other PRAGMA is rejected, so the local SQLite schema's
-- `PRAGMA user_version` convention does not port. Nothing in the read path
-- reads a schema version, and 06.1-03 owns any future schema change, which
-- should go through `wrangler d1 migrations` rather than an ad-hoc execute.

CREATE TABLE IF NOT EXISTS health_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  payload   TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  saved_at  TEXT    NOT NULL
);
