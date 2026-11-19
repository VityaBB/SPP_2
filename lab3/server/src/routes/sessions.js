'use strict';

const express = require('express');

const { HttpError, notFound } = require('../errors');
const { parseId } = require('../validation');
const {
  listAllSessions,
  getSessionById,
  revokeSession
} = require('../services/sessions');
const { audit } = require('../services/audit');
const { authenticate, requireRole } = require('../middleware/auth');
const { methodNotAllowedHandler } = require('../middleware/method-not-allowed');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

router.use(authenticate, requireRole('admin'));

// GET /api/sessions?userId=... — все активные подключения.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const raw = req.query.userId;
    let userId;

    if (raw !== undefined) {
      userId = parseId(raw);
      if (!userId) {
        throw new HttpError(400, 'Некорректный запрос', {
          detail: 'Некорректный идентификатор пользователя',
          errors: [{ field: 'userId', message: 'Ожидается положительное целое число' }]
        });
      }
    }

    res.json(listAllSessions({ userId }));
  })
);

// DELETE /api/sessions/:id — принудительное завершение подключения.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор сессии',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    const found = getSessionById(id);
    if (!found || found.session.revokedAt) throw notFound('Сессия не найдена');

    revokeSession(id, 'admin_revoked');

    audit(req, 'session.revoked', {
      userId: req.user.id,
      email: req.user.email,
      details: {
        sessionId: id,
        targetUserId: found.user.id,
        targetEmail: found.user.email
      }
    });

    res.status(204).end();
  })
);

router.all('/', methodNotAllowedHandler(['GET']));
router.all('/:id', methodNotAllowedHandler(['DELETE']));

module.exports = router;
