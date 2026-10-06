-- D1 online source of truth for the Cloudflare deployment.
--
-- Apply once with:
--   wrangler d1 execute vita-log --file=functions/schema.sql
--
-- 06.1-02a added the owner session table and the versioned write below. The
-- one-time import of the local SQLite snapshot is 06.1-03, which additionally
-- owns the "database must be empty before first import" guard. That guard is
-- part of its INSERT statement (`... WHERE NOT EXISTS (SELECT 1 FROM
-- health_state)`), not a check that runs before it, so two concurrent first
-- imports cannot both report success. No row in health_state is ever created
-- through the daily-save route.
--
-- No PRAGMA here on purpose. D1 only supports table_list, table_info and
-- foreign_keys; every other PRAGMA is rejected, so the local SQLite schema's
-- `PRAGMA user_version` convention does not port. Nothing in the read or write
-- path reads a schema version, and 06.1-03 owns any future schema change,
-- which should go through `wrangler d1 migrations` rather than an ad-hoc
-- execute.
--
-- Credentials and sessions: the owner account is never created by a request.
-- The password digest is provisioned from a Cloudflare Secret or a one-off ops
-- command (06.1-02b); this table holds only the *session* rows that a successful
-- login creates, so that expiry and logout revocation are visible to every
-- Pages Function isolate at once.
--
-- `token_hash` is the SHA-256 of the cookie value, never the cookie value
-- itself: a row lifted out of D1 does not become a usable session.
CREATE TABLE IF NOT EXISTS owner_session (
  token_hash TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  payload   TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  saved_at  TEXT    NOT NULL
);

-- 06.1-03: the first import stages its candidate row here, reconciles it, and
-- only then promotes it into health_state above.
--
-- The staging table is what makes "public read stays closed until reconciliation
-- and backup are done" (ADR-0002) enforceable rather than aspirational. A read
-- path that confirmed a row which was already being served would be confirming
-- live data, and a mismatch found afterwards could not be undone without deleting
-- the owner's only copy of their health data. No route in this deployment ever
-- SELECTs from this table; it is scratch space for one in-flight import.
--
-- Its columns deliberately mirror health_state so the promotion carries the
-- bytes across unchanged, which is what lets the same byte-for-byte comparison
-- run against both the staged and the promoted row.
CREATE TABLE IF NOT EXISTS health_state_import (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  payload   TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  saved_at  TEXT    NOT NULL
);
