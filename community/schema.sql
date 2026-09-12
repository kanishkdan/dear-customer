-- One row per (anonymous install, business). count = how many runs reported it.
CREATE TABLE IF NOT EXISTS reports (
  install_id TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  name       TEXT NOT NULL,
  is_api     INTEGER NOT NULL DEFAULT 0,
  cc         TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  category   TEXT,            -- what the business was to the reporter: promo | guess | txn | api | smb
  PRIMARY KEY (install_id, name_key)
);
CREATE INDEX IF NOT EXISTS idx_reports_key ON reports(name_key);

-- SHA-256 of the digits of each number a business used, per install. Never the number itself.
CREATE TABLE IF NOT EXISTS numbers (
  name_key    TEXT NOT NULL,
  number_hash TEXT NOT NULL,
  install_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (name_key, number_hash, install_id)
);
CREATE INDEX IF NOT EXISTS idx_numbers_key ON numbers(name_key);
