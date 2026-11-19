'use strict';

const { db } = require('../db');
const { conflict } = require('../errors');
const { hashPassword } = require('../security');
const config = require('../config');

const ROLE_LABELS = Object.freeze({
  admin: 'Администратор',
  manager: 'Менеджер',
  user: 'Пользователь'
});

function serializeUser(row) {
  if (!row) return null;

  const lockedUntil = row.locked_until || null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] || row.role,
    isActive: Boolean(row.is_active),
    isLocked: lockedUntil ? Date.parse(lockedUntil) > Date.now() : false,
    lockedUntil,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getUserRowById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserById(id) {
  return serializeUser(getUserRowById(id));
}

function getUserRowByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function getUserByEmail(email) {
  return serializeUser(getUserRowByEmail(email));
}

function createUser({ email, name, password, role = 'user' }) {
  const normalizedEmail = String(email).trim().toLowerCase();

  if (getUserRowByEmail(normalizedEmail)) {
    throw conflict('Пользователь с таким email уже существует');
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(normalizedEmail, name, role, hashPassword(password), now, now);

  return serializeUser(getUserRowById(Number(info.lastInsertRowid)));
}

function listUsers({ search, role } = {}) {
  const clauses = [];
  const params = [];

  if (role) {
    clauses.push('role = ?');
    params.push(role);
  }

  if (search) {
    clauses.push('(email LIKE ? OR name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM users ${where} ORDER BY id ASC`)
    .all(...params)
    .map(serializeUser);
}

function updateUserRow(id, patch) {
  const current = getUserRowById(id);
  if (!current) return null;

  const next = {
    name: patch.name === undefined ? current.name : patch.name,
    role: patch.role === undefined ? current.role : patch.role,
    isActive:
      patch.isActive === undefined ? current.is_active : patch.isActive ? 1 : 0,
    passwordHash: patch.passwordHash || current.password_hash
  };

  db.prepare(
    `UPDATE users
        SET name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    next.name,
    next.role,
    next.isActive,
    next.passwordHash,
    new Date().toISOString(),
    id
  );

  return getUserRowById(id);
}

function deleteUserRow(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function countActiveAdmins() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1")
    .get().count;
}

function countTasksByOwner(userId) {
  return db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE owner_id = ?').get(userId)
    .count;
}

function clearLoginFailures(id) {
  db.prepare(
    `UPDATE users
        SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL
      WHERE id = ?`
  ).run(id);
}

/**
 * Возвращает остаток блокировки в мс. Если блокировка уже истекла — сбрасывает её.
 */
function lockRemainingMs(row) {
  if (!row || !row.locked_until) return 0;

  const until = Date.parse(row.locked_until);
  if (!Number.isFinite(until)) return 0;

  const remaining = until - Date.now();
  if (remaining <= 0) {
    clearLoginFailures(row.id);
    row.failed_attempts = 0;
    row.locked_until = null;
    return 0;
  }

  return remaining;
}

/**
 * Учитывает неудачную попытку входа. По достижении лимита блокирует учётную запись.
 */
function recordFailedLogin(row) {
  const now = Date.now();
  const lastFailed = row.last_failed_at ? Date.parse(row.last_failed_at) : 0;
  const withinWindow =
    Number.isFinite(lastFailed) &&
    lastFailed > 0 &&
    now - lastFailed <= config.auth.loginWindowMs;

  const attempts = withinWindow ? row.failed_attempts + 1 : 1;
  const lockedUntil =
    attempts >= config.auth.loginMaxAttempts
      ? new Date(now + config.auth.loginLockMs).toISOString()
      : null;

  db.prepare(
    `UPDATE users
        SET failed_attempts = ?, last_failed_at = ?, locked_until = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    attempts,
    new Date(now).toISOString(),
    lockedUntil,
    new Date(now).toISOString(),
    row.id
  );

  row.failed_attempts = attempts;
  row.locked_until = lockedUntil;

  return { attempts, lockedUntil };
}

function markLoginSuccess(id) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users
        SET failed_attempts = 0,
            last_failed_at = NULL,
            locked_until = NULL,
            last_login_at = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(now, now, id);
}

function updatePassword(id, passwordHash) {
  db.prepare(
    `UPDATE users
        SET password_hash = ?,
            failed_attempts = 0,
            last_failed_at = NULL,
            locked_until = NULL,
            updated_at = ?
      WHERE id = ?`
  ).run(passwordHash, new Date().toISOString(), id);
}

const DEMO_USERS = Object.freeze([
  {
    email: 'admin@example.com',
    name: 'Администратор',
    password: 'Admin123!',
    role: 'admin'
  },
  {
    email: 'manager@example.com',
    name: 'Менеджер',
    password: 'Manager123!',
    role: 'manager'
  },
  {
    email: 'user@example.com',
    name: 'Пользователь',
    password: 'User123!',
    role: 'user'
  },
  {
    email: 'user2@example.com',
    name: 'Анна Смирнова',
    password: 'User123!',
    role: 'user'
  }
]);

function seedDemoUsers() {
  if (!config.seedDemoUsers) return;

  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) return;

  for (const user of DEMO_USERS) {
    createUser(user);
  }

  const { logger } = require('../logger');
  logger.info('users.demo_seeded', {
    count: DEMO_USERS.length,
    emails: DEMO_USERS.map((user) => user.email)
  });
}

module.exports = {
  ROLE_LABELS,
  serializeUser,
  getUserRowById,
  getUserById,
  getUserRowByEmail,
  getUserByEmail,
  createUser,
  listUsers,
  updateUserRow,
  deleteUserRow,
  countActiveAdmins,
  countTasksByOwner,
  clearLoginFailures,
  lockRemainingMs,
  recordFailedLogin,
  markLoginSuccess,
  updatePassword,
  seedDemoUsers,
  DEMO_USERS
};
