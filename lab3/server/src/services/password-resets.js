'use strict';

const { db } = require('../db');
const config = require('../config');
const { randomToken, hashToken } = require('../security');

function invalidateUserResets(userId) {
  db.prepare(
    'UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND used_at IS NULL'
  ).run(new Date().toISOString(), userId);
}

/**
 * Создаёт одноразовый временный ключ восстановления. В БД хранится только хэш.
 */
function createResetToken(userId, ip) {
  invalidateUserResets(userId);

  const token = randomToken(32);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + config.auth.resetTtlMs).toISOString();

  db.prepare(
    `INSERT INTO password_resets (user_id, token_hash, requested_ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, hashToken(token), ip || null, nowIso, expiresAt);

  return { token, expiresAt };
}

function findResetByToken(token) {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT pr.*, u.id AS u_id, u.email, u.name, u.role, u.is_active
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash = ?`
    )
    .get(hashToken(token));

  if (!row) return null;
  if (row.used_at) return { invalid: true, reason: 'used' };
  if (Date.parse(row.expires_at) <= Date.now()) return { invalid: true, reason: 'expired' };

  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    expiresAt: row.expires_at
  };
}

function markResetUsed(id) {
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
}

module.exports = {
  createResetToken,
  findResetByToken,
  markResetUsed,
  invalidateUserResets
};
