-- Health content and authentication material never belong in audit rows.
CREATE TABLE IF NOT EXISTS audit_event (
  id INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('save', 'migrate', 'backup', 'restore')),
  result TEXT NOT NULL CHECK (result IN ('success', 'version-conflict', 'database-unavailable')),
  version INTEGER NOT NULL CHECK (version >= 0)
);
