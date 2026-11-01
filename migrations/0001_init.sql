-- Song Rider Suite core schema.
-- These tables already exist in production (they were created by hand before this file existed).
-- Every statement is idempotent, so it is safe to run against the live database:
--   npx wrangler d1 execute song-rider-suite-prod-db --remote --file=migrations/0001_init.sql
-- The worker also creates srp_projects, user_preferences, project_tombstones and login_attempts
-- lazily on first use; they are listed here so a fresh database matches production.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Chord Rider Pro projects. updated_at is the server clock and doubles as the sync revision.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC);

-- Song Rider Pro projects. updated_at is the client's content time; rev is the server revision.
CREATE TABLE IF NOT EXISTS srp_projects (
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  legacy_user_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT,
  last_synced_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_srp_projects_owner_updated ON srp_projects(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  skin TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- Deleted CRP projects, so other devices drop them instead of re-uploading.
CREATE TABLE IF NOT EXISTS project_tombstones (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

-- Failed login counters for throttling.
CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0
);
