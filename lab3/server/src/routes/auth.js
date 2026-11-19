'use strict';

const express = require('express');

const config = require('../config');
const { db } = require('../db');
const {
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  validationError,
  tooManyRequests
} = require('../errors');
const {
  validateLoginPayload,
  validateRegisterPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
  validateChangePasswordPayload,
  parseId
} = require('../validation');
const {
  getUserRowByEmail,
  getUserRowById,
  getUserById,
  serializeUser,
  createUser,
  lockRemainingMs,
  recordFailedLogin,
  markLoginSuccess,
  updatePassword
} = require('../services/users');
const {
  createSession,
  findSessionByRefreshToken,
  revokeSession,
  revokeAllSessions,
  revokeOtherSessions,
  rotateRefreshToken,
  listSessionsForUser,
  getSessionById,
  serializeSession
} = require('../services/sessions');
const {
  createResetToken,
  findResetByToken,
  markResetUsed
} = require('../services/password-resets');
const { audit } = require('../services/audit');
const { sendPasswordResetEmail } = require('../services/mailer');
const { authenticate } = require('../middleware/auth');
const { requireJson } = require('../middleware/content-type');
const { createRateLimiter } = require('../middleware/rate-limit');
const { methodNotAllowedHandler } = require('../middleware/method-not-allowed');
const {
  REFRESH_COOKIE,
  readCookie,
  setRefreshCookie,
  clearRefreshCookie
} = require('../utils/cookies');
const { hashPassword, verifyPassword, getDummyHash } = require('../security');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

const loginLimiter = createRateLimiter({
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMax,
  message: 'Слишком много попыток входа с этого IP-адреса. Попробуйте позже.'
});

const mailLimiter = createRateLimiter({
  windowMs: config.rateLimit.mailWindowMs,
  max: config.rateLimit.mailMax,
  message: 'Слишком много запросов на восстановление доступа. Попробуйте позже.'
});

const registerLimiter = createRateLimiter({
  windowMs: config.rateLimit.registerWindowMs,
  max: config.rateLimit.registerMax,
  message: 'Слишком много попыток регистрации с этого IP-адреса. Попробуйте позже.'
});

function tokenPayload(result, user) {
  const expiresIn = Math.max(
    1,
    Math.round((Date.parse(result.accessExpiresAt) - Date.now()) / 1000)
  );

  return {
    tokenType: 'Bearer',
    accessToken: result.accessToken,
    accessExpiresAt: result.accessExpiresAt,
    expiresIn,
    sessionId: result.sessionId,
    user
  };
}

function requestMeta(req) {
  return {
    ip: req.ip,
    userAgent: (req.get('user-agent') || '').slice(0, 200) || null
  };
}

// POST /api/auth/login — вход по email и паролю, выдача временных ключей.
router.post(
  '/login',
  loginLimiter,
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateLoginPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    const row = getUserRowByEmail(value.email);

    if (row) {
      const remaining = lockRemainingMs(row);
      if (remaining > 0) {
        const retryAfter = Math.ceil(remaining / 1000);
        audit(req, 'auth.login.locked', {
          userId: row.id,
          email: row.email,
          level: 'warn',
          details: { retryAfter }
        });
        throw tooManyRequests(
          'Учётная запись временно заблокирована из-за неудачных попыток входа',
          retryAfter
        );
      }
    }

    let passwordOk = false;
    if (row) {
      passwordOk = verifyPassword(value.password, row.password_hash);
    } else {
      // Тратим такое же время, как при проверке реального пароля.
      verifyPassword(value.password, getDummyHash());
    }

    if (!passwordOk) {
      let lockedUntil = null;
      if (row) {
        lockedUntil = recordFailedLogin(row).lockedUntil;
      }

      audit(req, 'auth.login.failure', {
        userId: row ? row.id : null,
        email: value.email,
        level: 'warn',
        details: {
          reason: row ? 'bad_password' : 'unknown_user',
          lockedUntil,
          ...requestMeta(req)
        }
      });

      if (lockedUntil) {
        throw tooManyRequests(
          'Слишком много неудачных попыток входа. Учётная запись временно заблокирована',
          Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1000)
        );
      }

      throw unauthorized('Неверный email или пароль', 'invalid_credentials');
    }

    if (!row.is_active) {
      audit(req, 'auth.login.denied', {
        userId: row.id,
        email: row.email,
        level: 'warn',
        details: { reason: 'inactive' }
      });
      throw forbidden('Учётная запись заблокирована администратором');
    }

    markLoginSuccess(row.id);
    const created = createSession(row, req);
    setRefreshCookie(res, created.refreshToken, config.auth.refreshTtlMs);

    audit(req, 'auth.login.success', {
      userId: row.id,
      email: row.email,
      details: { sessionId: created.sessionId, ...requestMeta(req) }
    });

    res.status(200).json({
      ...tokenPayload(created, serializeUser(getUserRowById(row.id)))
    });
  })
);

// POST /api/auth/register — публичная регистрация. Роль всегда `user`.
router.post(
  '/register',
  registerLimiter,
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateRegisterPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    let user;
    try {
      user = createUser({
        email: value.email,
        name: value.name,
        password: value.password,
        role: 'user'
      });
    } catch (error) {
      if (error.status === 409) {
        audit(req, 'auth.register.failed', {
          email: value.email,
          level: 'warn',
          details: { reason: 'email_taken' }
        });
      }
      throw error;
    }

    markLoginSuccess(user.id);
    const created = createSession(getUserRowById(user.id), req);
    setRefreshCookie(res, created.refreshToken, config.auth.refreshTtlMs);

    audit(req, 'auth.register', {
      userId: user.id,
      email: user.email,
      details: { role: user.role, sessionId: created.sessionId }
    });

    res
      .status(201)
      .location(`/api/users/${user.id}`)
      .json(tokenPayload(created, serializeUser(getUserRowById(user.id))));
  })
);

// POST /api/auth/refresh — обновление временного ключа доступа.
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = readCookie(req, REFRESH_COOKIE);
    if (!token) {
      throw unauthorized('Ключ обновления не передан', 'invalid_grant');
    }

    const result = rotateRefreshToken(token, req);

    if (!result.ok) {
      clearRefreshCookie(res);

      if (result.reason === 'reuse') {
        audit(req, 'auth.refresh.reuse', {
          userId: result.userId,
          level: 'warn',
          details: { sessionId: result.sessionId, ...requestMeta(req) }
        });
        throw unauthorized(
          'Обнаружено повторное использование ключа. Все сессии отозваны',
          'invalid_grant'
        );
      }

      if (result.reason === 'inactive') {
        audit(req, 'auth.refresh.denied', {
          userId: result.userId,
          level: 'warn',
          details: { reason: 'inactive' }
        });
        throw forbidden('Учётная запись заблокирована администратором');
      }

      audit(req, 'auth.refresh.failure', {
        userId: result.userId || null,
        level: 'warn',
        details: { reason: result.reason }
      });
      throw unauthorized('Ключ обновления недействителен или истёк', 'invalid_grant');
    }

    setRefreshCookie(res, result.refreshToken, config.auth.refreshTtlMs);
    audit(req, 'auth.refresh.success', {
      userId: result.userId,
      details: { sessionId: result.sessionId }
    });

    res.status(200).json(
      tokenPayload(result, serializeUser(getUserRowById(result.userId)))
    );
  })
);

// POST /api/auth/logout — завершение текущего подключения.
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    const found = refreshToken ? findSessionByRefreshToken(refreshToken) : null;

    if (found && !found.session.revokedAt) {
      revokeSession(found.session.id, 'logout');
      audit(req, 'auth.logout', {
        userId: found.user.id,
        email: found.user.email,
        details: { sessionId: found.session.id }
      });
    }

    clearRefreshCookie(res);
    res.status(204).end();
  })
);

// GET /api/auth/me — текущий пользователь и его временный ключ.
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({
      user: getUserById(req.user.id),
      session: serializeSession(req.session)
    });
  })
);

// GET /api/auth/sessions — активные подключения текущего пользователя.
router.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = listSessionsForUser(req.user.id).map((session) => ({
      ...session,
      current: session.id === req.session.id
    }));

    res.json(sessions);
  })
);

// DELETE /api/auth/sessions — завершить все подключения, кроме текущего.
router.delete(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    revokeOtherSessions(req.user.id, req.session.id, 'logout_others');
    audit(req, 'auth.sessions.revoked_others', {
      userId: req.user.id,
      email: req.user.email
    });
    res.status(204).end();
  })
);

// DELETE /api/auth/sessions/:id — завершить конкретное подключение.
router.delete(
  '/sessions/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      throw badRequest('Идентификатор сессии должен быть положительным целым числом');
    }

    const found = getSessionById(id);
    if (!found || found.session.userId !== req.user.id || found.session.revokedAt) {
      throw notFound('Сессия не найдена');
    }

    revokeSession(id, 'logout_session');
    if (id === req.session.id) clearRefreshCookie(res);

    audit(req, 'auth.session.revoked', {
      userId: req.user.id,
      email: req.user.email,
      details: { sessionId: id }
    });

    res.status(204).end();
  })
);

// POST /api/auth/change-password — смена пароля с проверкой текущего.
router.post(
  '/change-password',
  authenticate,
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateChangePasswordPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    const row = getUserRowById(req.user.id);
    if (!row || !verifyPassword(value.currentPassword, row.password_hash)) {
      throw validationError(
        [{ field: 'currentPassword', message: 'Неверный текущий пароль' }],
        'Текущий пароль указан неверно'
      );
    }

    updatePassword(row.id, hashPassword(value.newPassword));
    revokeOtherSessions(row.id, req.session.id, 'password_change');

    audit(req, 'auth.password.changed', {
      userId: row.id,
      email: row.email,
      details: { otherSessionsRevoked: true }
    });

    res.status(204).end();
  })
);

// POST /api/auth/forgot-password — запрос восстановления через email.
router.post(
  '/forgot-password',
  mailLimiter,
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateForgotPasswordPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    const row = getUserRowByEmail(value.email);
    const genericMessage =
      'Если учётная запись с таким email существует, письмо с инструкцией отправлено';

    if (!row || !row.is_active) {
      audit(req, 'auth.password.reset_requested', {
        userId: row ? row.id : null,
        email: value.email,
        details: { delivered: false, reason: row ? 'inactive' : 'unknown_user' }
      });
      res.status(202).json({ message: genericMessage });
      return;
    }

    const reset = createResetToken(row.id, req.ip);

    audit(req, 'auth.password.reset_requested', {
      userId: row.id,
      email: row.email,
      details: { expiresAt: reset.expiresAt, delivered: false }
    });

    try {
      await sendPasswordResetEmail({
        email: row.email,
        name: row.name,
        token: reset.token
      });
    } catch (error) {
      req.log.error('password_reset.mail_failed', { error });
    }

    res.status(202).json({ message: genericMessage });
  })
);

// POST /api/auth/reset-password — установка нового пароля по одноразовому ключу.
router.post(
  '/reset-password',
  mailLimiter,
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateResetPasswordPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    const reset = findResetByToken(value.token);
    if (!reset || reset.invalid) {
      audit(req, 'auth.password.reset_failed', {
        level: 'warn',
        details: { reason: reset?.reason || 'unknown' }
      });
      throw badRequest('Ссылка восстановления недействительна или истекла');
    }

    const row = getUserRowById(reset.userId);
    if (!row) throw badRequest('Ссылка восстановления недействительна или истекла');
    if (!row.is_active) throw forbidden('Учётная запись заблокирована администратором');

    const applyReset = db.transaction(() => {
      updatePassword(row.id, hashPassword(value.newPassword));
      markResetUsed(reset.id);
    });
    applyReset();

    revokeAllSessions(row.id, 'password_reset');
    clearRefreshCookie(res);

    audit(req, 'auth.password.reset', {
      userId: row.id,
      email: row.email,
      details: { allSessionsRevoked: true }
    });

    res.status(204).end();
  })
);

for (const [path, methods] of Object.entries({
  '/login': ['POST'],
  '/register': ['POST'],
  '/refresh': ['POST'],
  '/logout': ['POST'],
  '/me': ['GET'],
  '/sessions': ['GET', 'DELETE'],
  '/sessions/:id': ['DELETE'],
  '/change-password': ['POST'],
  '/forgot-password': ['POST'],
  '/reset-password': ['POST']
})) {
  router.all(path, methodNotAllowedHandler(methods));
}

module.exports = router;
