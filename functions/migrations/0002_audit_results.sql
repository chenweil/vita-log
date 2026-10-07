-- Preserve existing rows and IDs while expanding audit-only result semantics.
CREATE TABLE audit_event_v2 (
  id INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('save', 'migrate', 'backup', 'restore')),
  result TEXT NOT NULL CHECK (result IN ('success', 'version-conflict', 'database-unavailable', 'not-initialized', 'unknown')),
  version INTEGER NOT NULL CHECK (version >= 0)
);
INSERT INTO audit_event_v2 SELECT id, time, operation, result, version FROM audit_event;
DROP TABLE audit_event;
ALTER TABLE audit_event_v2 RENAME TO audit_event;
