-- Initial schema for Stupid Upload.

-- Upload reservations and files. IDs are random 128-bit base64url strings.
-- Bearer tokens are never stored raw; only their HMAC snapshots are persisted.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  retention TEXT NOT NULL CHECK (retention IN ('temporary', 'permanent')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'deleted', 'expired')),
  source_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  upload_token_hash TEXT NOT NULL,
  delete_token_hash TEXT NOT NULL,
  upload_expires_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER,
  price_atomic INTEGER,
  payment_network TEXT,
  payment_receipt TEXT,
  UNIQUE (source_hash, idempotency_key)
);
-- Index expiration + status for scheduled cleanup scans.
CREATE INDEX uploads_status_expiry ON uploads (status, expires_at);
CREATE INDEX uploads_created_at ON uploads (created_at);

-- Daily usage counters for quota reservation. One conditional UPSERT reserves
-- quota without a read-then-write race. scope separates source and global budgets.
CREATE TABLE daily_usage (
  scope         TEXT NOT NULL CHECK (scope IN ('source', 'global')),
  subject_hash  TEXT NOT NULL,
  utc_day       TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  upload_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject_hash, utc_day)
);
CREATE INDEX IF NOT EXISTS daily_usage_utc_day ON daily_usage (utc_day);

-- Private feedback. messages stay in D1; no public read endpoint.
CREATE TABLE feedback (
  id               TEXT NOT NULL PRIMARY KEY,
  category         TEXT NOT NULL CHECK (category IN ('bug', 'feature_request', 'usability', 'pricing', 'other')),
  message          TEXT NOT NULL,
  rating           INTEGER,
  related_upload_id TEXT,
  request_id       TEXT,
  client_name      TEXT,
  client_version   TEXT,
  source_hash      TEXT NOT NULL,
  daily_usage_key  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'closed')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_triage ON feedback (status, created_at);
CREATE INDEX IF NOT EXISTS feedback_daily ON feedback (daily_usage_key);