'use strict';

const express = require('express');

const { HttpError } = require('../errors');
const { parseId } = require('../validation');
const { listAudit } = require('../services/audit');
const { authenticate, requireRole } = require('../middleware/auth');
const { methodNotAllowedHandler } = require('../middleware/method-not-allowed');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

router.use(authenticate, requireRole('admin'));

// GET /api/audit?limit=50&event=...&userId=...
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { event, userId, limit } = req.query;

    let parsedLimit = 50;
    if (limit !== undefined) {
      const value = Number(limit);
      if (!Number.isInteger(value) || value < 1 || value > 200) {
        throw new HttpError(400, 'Некорректный запрос', {
          detail: 'Некорректное ограничение выборки',
          errors: [{ field: 'limit', message: 'limit должен быть целым числом от 1 до 200' }]
        });
      }
      parsedLimit = value;
    }

    if (event !== undefined && (typeof event !== 'string' || event.length > 100)) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный фильтр по событию',
        errors: [{ field: 'event', message: 'event должен быть строкой до 100 символов' }]
      });
    }

    let parsedUserId;
    if (userId !== undefined) {
      parsedUserId = parseId(userId);
      if (!parsedUserId) {
        throw new HttpError(400, 'Некорректный запрос', {
          detail: 'Некорректный идентификатор пользователя',
          errors: [{ field: 'userId', message: 'Ожидается положительное целое число' }]
        });
      }
    }

    res.json(
      listAudit({
        limit: parsedLimit,
        event: event || undefined,
        userId: parsedUserId
      })
    );
  })
);

router.all('/', methodNotAllowedHandler(['GET']));

module.exports = router;
