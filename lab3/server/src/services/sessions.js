'use strict';

const { db } = require('../db');
const config = require('../config');
const { randomToken, hashToken } = require('../security');

const SESSION_JOIN = `
  SELECT s.id AS session_id,
         s.user_id AS session_user_id,
         s.user_agent,
         s.ip,
         s.created_at AS session_created_at,
         s.last_seen_at,
         s.access_expires_at,
         s.refresh_expires_at,
         s.revoked_at,
         s.revoked_reason,
         u.id AS user_id,
         u.email,
         u.name,
         u.role,
         u.is_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
`;

function mapJoined(row) {
  if (!row) return null;

  return {
    session: {
      id: row.session_id,
      userId: row.session_user_id,
      userAgent: row.user_agent,
      ip: row.ip,
      createdAt: row.session_created_at,
      lastSeenAt: row.last_seen_at,
      accessExpiresAt: row.access_expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason
    },
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      isActive: Boolean(row.is_active)
    }
  };
}

function truncate(value, max = 300) {
  if (!value) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function createSession(user, req) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(48);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const accessExpiresAt = new Date(now + config.auth.accessTtlMs).toISOString();
  const refreshExpiresAt = new Date(now + config.auth.refreshTtlMs).toISOString();

  const info = db
    .prepare(
      `INSERT INTO sessions
         (user_id, access_hash, user_agent, ip, created_at, last_seen_at,
          access_expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      hashToken(accessToken),
      truncate(req.get('user-agent')),
      req.ip || null,
      nowIso,
      nowIso,
      accessExpiresAt,
      refreshExpiresAt
    );

  const sessionId = Number(info.lastInsertRowid);

  db.prepare(
    `INSERT INTO refresh_tokens (session_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(sessionId, hashToken(refreshToken), nowIso, refreshExpiresAt);

  return {
    sessionId,
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt
  };
}

const getJoinedByAccessHash = db.prepare(
  `${SESSION_JOIN} WHERE s.access_hash = ? AND s.revoked_at IS NULL`
);
const getJoinedById = db.prepare(`${SESSION_JOIN} WHERE s.id = ?`);
const getRefreshToken = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?');

function findSessionByAccessToken(token) {
  if (!token) return null;

  const row = getJoinedByAccessHash.get(hashToken(token));
  if (!row) return null;

  const accessExpires = Date.parse(row.access_expires_at);
  if (!Number.isFinite(accessExpires) || accessExpires <= Date.now()) return null;

  const mapped = mapJoined(row);
  if (!mapped.user.isActive) return null;

  // Не пишем в БД на каждый запрос — обновляем отметку не чаще раза в минуту.
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60 * 1000) {
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(
      nowIso,
      mapped.session.id
    );
    mapped.session.lastSeenAt = nowIso;
  }

  return mapped;
}

function findSessionByRefreshToken(token) {
  if (!token) return null;

  const row = getRefreshToken.get(hashToken(token));
  if (!row) return null;

  const joined = getJoinedById.get(row.session_id);
  return mapJoined(joined);
}

function revokeSession(sessionId, reason = 'logout') {
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, ?),
            revoked_reason = COALESCE(revoked_reason, ?)
      WHERE id = ?`
  ).run(nowIso, reason, sessionId);

  db.prepare(
    `UPDATE refresh_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE session_id = ?`
  ).run(nowIso, sessionId);
}

function revokeAllSessions(userId, reason = 'logout_all') {
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, ?),
            revoked_reason = COALESCE(revoked_reason, ?)
      WHERE user_id = ?`
  ).run(nowIso, reason, userId);

  db.prepare(
    `UPDATE refresh_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)`
  ).run(nowIso, userId);
}

function revokeOtherSessions(userId, currentSessionId, reason = 'password_change') {
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, ?),
            revoked_reason = COALESCE(revoked_reason, ?)
      WHERE user_id = ? AND id <> ?`
  ).run(nowIso, reason, userId, currentSessionId);

  db.prepare(
    `UPDATE refresh_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
      WHERE session_id IN (
        SELECT id FROM sessions WHERE user_id = ? AND id <> ?
      )`
  ).run(nowIso, userId, currentSessionId);
}

/**
 * Ротация refresh-ключа. Повторное использование уже ротированного ключа
 * трактуется как компрометация: отзываются все сессии пользователя.
 */
function rotateRefreshToken(token, req) {
  if (!token) return { ok: false, reason: 'unknown' };

  const tokenRow = getRefreshToken.get(hashToken(token));
  if (!tokenRow) return { ok: false, reason: 'unknown' };

  const joined = mapJoined(getJoinedById.get(tokenRow.session_id));
  if (!joined) return { ok: false, reason: 'unknown' };

  if (tokenRow.rotated_at) {
    revokeAllSessions(joined.user.id, 'refresh_reuse');
    return {
      ok: false,
      reason: 'reuse',
      userId: joined.user.id,
      sessionId: joined.session.id
    };
  }

  if (tokenRow.revoked_at) return { ok: false, reason: 'revoked' };
  if (joined.session.revokedAt) return { ok: false, reason: 'revoked' };
  if (!joined.user.isActive) {
    return { ok: false, reason: 'inactive', userId: joined.user.id };
  }

  const now = Date.now();
  if (Date.parse(tokenRow.expires_at) <= now) return { ok: false, reason: 'expired' };
  if (Date.parse(joined.session.refreshExpiresAt) <= now) {
    return { ok: false, reason: 'expired' };
  }

  const accessToken = randomToken(32);
  const refreshToken = randomToken(48);
  const nowIso = new Date(now).toISOString();
  const accessExpiresAt = new Date(now + config.auth.accessTtlMs).toISOString();
  const refreshExpiresAt = new Date(now + config.auth.refreshTtlMs).toISOString();

  const rotate = db.transaction(() => {
    db.prepare('UPDATE refresh_tokens SET rotated_at = ? WHERE id = ?').run(
      nowIso,
      tokenRow.id
    );

    db.prepare(
      `INSERT INTO refresh_tokens (session_id, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(joined.session.id, hashToken(refreshToken), nowIso, refreshExpiresAt);

    db.prepare(
      `UPDATE sessions
          SET access_hash = ?,
              access_expires_at = ?,
              refresh_expires_at = ?,
              last_seen_at = ?,
              user_agent = ?,
              ip = ?
        WHERE id = ?`
    ).run(
      hashToken(accessToken),
      accessExpiresAt,
      refreshExpiresAt,
      nowIso,
      truncate(req.get('user-agent')),
      req.ip || null,
      joined.session.id
    );
  });

  rotate();

  return {
    ok: true,
    sessionId: joined.session.id,
    userId: joined.user.id,
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt
  };
}

function serializeSession(session) {
  return {
    id: session.id,
    userId: session.userId,
    userAgent: session.userAgent,
    ip: session.ip,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
    revokedAt: session.revokedAt,
    revokedReason: session.revokedReason
  };
}

function listSessionsForUser(userId) {
  const rows = db
    .prepare(
      `${SESSION_JOIN}
        WHERE s.user_id = ? AND s.revoked_at IS NULL
        ORDER BY s.last_seen_at DESC, s.id DESC`
    )
    .all(userId);

  return rows.map((row) => {
    const item = mapJoined(row);
    return { ...serializeSession(item.session), user: item.user };
  });
}

function listAllSessions({ userId } = {}) {
  const rows = userId
    ? db
        .prepare(
          `${SESSION_JOIN}
            WHERE s.revoked_at IS NULL AND s.user_id = ?
            ORDER BY s.last_seen_at DESC, s.id DESC`
        )
        .all(userId)
    : db
        .prepare(
          `${SESSION_JOIN}
            WHERE s.revoked_at IS NULL
            ORDER BY s.last_seen_at DESC, s.id DESC`
        )
        .all();

  return rows.map((row) => {
    const item = mapJoined(row);
    return { ...serializeSession(item.session), user: item.user };
  });
}

function getSessionById(sessionId) {
  return mapJoined(getJoinedById.get(sessionId));
}

function cleanupExpiredTokens() {
  const nowIso = new Date().toISOString();
  db.prepare(
    `DELETE FROM refresh_tokens
      WHERE expires_at < ? AND (rotated_at IS NOT NULL OR revoked_at IS NOT NULL)`
  ).run(nowIso);
}

module.exports = {
  createSession,
  findSessionByAccessToken,
  findSessionByRefreshToken,
  revokeSession,
  revokeAllSessions,
  revokeOtherSessions,
  rotateRefreshToken,
  serializeSession,
  listSessionsForUser,
  listAllSessions,
  getSessionById,
  cleanupExpiredTokens
};
