'use strict';

const fs = require('node:fs');
const Database = require('better-sqlite3');

const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user'
                    CHECK (role IN ('admin', 'manager', 'user')),
    password_hash   TEXT NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    last_failed_at  TEXT,
    locked_until    TEXT,
    last_login_at   TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Сессии: временный ключ доступа (access) + ключ обновления (refresh).
  CREATE TABLE IF NOT EXISTS sessions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_hash        TEXT NOT NULL UNIQUE,
    user_agent         TEXT,
    ip                 TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    access_expires_at  TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    revoked_at         TEXT,
    revoked_reason     TEXT
  );

  -- История refresh-ключей нужна для обнаружения повторного использования.
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT NOT NULL,
    rotated_at  TEXT,
    revoked_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    requested_ip TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at   TEXT NOT NULL,
    used_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    event         TEXT NOT NULL,
    user_id       INTEGER,
    email         TEXT,
    ip            TEXT,
    user_agent    TEXT,
    request_id    TEXT,
    details       TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'in_progress', 'done')),
    due_date   TEXT
               CHECK (due_date IS NULL OR due_date GLOB
                      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL UNIQUE,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL CHECK (size >= 0),
    uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_access_hash ON sessions(access_hash);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);
  CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event);
  CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_files_task_id ON files(task_id);
`);

/**
 * Небольшая миграция для баз, созданных в лабораторной работе №2.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('tasks', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
ensureColumn('files', 'uploaded_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

function serializeFile(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    uploadedAt: row.uploaded_at
  };
}

function serializeTask(row, files = [], owner = null) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    dueDate: row.due_date,
    owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files
  };
}

function closeDb() {
  try {
    db.close();
  } catch {
    // База уже закрыта — ничего делать не нужно.
  }
}

module.exports = {
  db,
  dbFile: config.dbFile,
  dataDir: config.dataDir,
  serializeTask,
  serializeFile,
  closeDb
};
