'use strict';

const express = require('express');

const {
  HttpError,
  conflict,
  notFound,
  validationError
} = require('../errors');
const {
  ROLES,
  validateCreateUserPayload,
  validateUpdateUserPayload,
  parseId
} = require('../validation');
const {
  getUserRowById,
  getUserById,
  createUser,
  listUsers,
  updateUserRow,
  deleteUserRow,
  countActiveAdmins,
  countTasksByOwner,
  clearLoginFailures,
  serializeUser
} = require('../services/users');
const { revokeAllSessions } = require('../services/sessions');
const { audit } = require('../services/audit');
const { hashPassword } = require('../security');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireJson } = require('../middleware/content-type');
const { methodNotAllowedHandler } = require('../middleware/method-not-allowed');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

router.use(authenticate, requireRole('admin'));

function parseUserId(req) {
  const id = parseId(req.params.id);
  if (!id) {
    throw new HttpError(400, 'Некорректный запрос', {
      detail: 'Некорректный идентификатор пользователя',
      errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
    });
  }
  return id;
}

function getTargetRow(id) {
  const row = getUserRowById(id);
  if (!row) throw notFound('Пользователь не найден');
  return row;
}

// GET /api/users?role=...&search=...
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { role, search } = req.query;

    if (role !== undefined && (typeof role !== 'string' || !ROLES.includes(role))) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный фильтр по роли',
        errors: [{ field: 'role', message: `Допустимые значения: ${ROLES.join(', ')}` }]
      });
    }

    if (search !== undefined && (typeof search !== 'string' || search.length > 100)) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный поисковый запрос',
        errors: [{ field: 'search', message: 'search должен быть строкой до 100 символов' }]
      });
    }

    res.json(listUsers({ role, search: search ? search.trim() : undefined }));
  })
);

// POST /api/users
router.post(
  '/',
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateCreateUserPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    const user = createUser(value);

    audit(req, 'user.created', {
      userId: req.user.id,
      email: req.user.email,
      details: { targetUserId: user.id, targetEmail: user.email, role: user.role }
    });

    res.status(201).location(`/api/users/${user.id}`).json(user);
  })
);

// GET /api/users/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseUserId(req);
    const user = getUserById(id);
    if (!user) throw notFound('Пользователь не найден');
    res.json(user);
  })
);

// PATCH /api/users/:id — роль, имя, блокировка, сброс пароля.
router.patch(
  '/:id',
  requireJson,
  asyncHandler(async (req, res) => {
    const id = parseUserId(req);
    const target = getTargetRow(id);

    const { value, errors } = validateUpdateUserPayload(req.body);
    if (errors.length > 0) throw validationError(errors);

    const nextRole = value.role === undefined ? target.role : value.role;
    const nextActive =
      value.isActive === undefined ? Boolean(target.is_active) : value.isActive;

    if (target.role === 'admin' && (nextRole !== 'admin' || !nextActive)) {
      if (countActiveAdmins() <= 1) {
        throw conflict('Нельзя лишить прав последнего активного администратора');
      }
    }

    if (value.isActive === false && id === req.user.id) {
      throw conflict('Нельзя заблокировать собственную учётную запись');
    }

    const patch = {
      name: value.name,
      role: value.role,
      isActive: value.isActive
    };

    if (value.password) {
      patch.passwordHash = hashPassword(value.password);
    }

    const updated = updateUserRow(id, patch);

    if (value.isActive === false) {
      revokeAllSessions(id, 'user_blocked');
    }

    if (value.password) {
      revokeAllSessions(id, 'password_admin_reset');
    }

    audit(req, 'user.updated', {
      userId: req.user.id,
      email: req.user.email,
      details: {
        targetUserId: id,
        targetEmail: target.email,
        changed: Object.keys(value).filter((key) => key !== 'password'),
        passwordChanged: Boolean(value.password)
      }
    });

    res.json(serializeUser(updated));
  })
);

// DELETE /api/users/:id — удаление (только если у пользователя нет задач).
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseUserId(req);
    const target = getTargetRow(id);

    if (id === req.user.id) {
      throw conflict('Нельзя удалить собственную учётную запись');
    }

    if (target.role === 'admin' && target.is_active && countActiveAdmins() <= 1) {
      throw conflict('Нельзя удалить последнего активного администратора');
    }

    const tasks = countTasksByOwner(id);
    if (tasks > 0) {
      throw conflict(
        `У пользователя ${tasks} задач(и). Сначала переназначьте или удалите их`
      );
    }

    deleteUserRow(id);
    revokeAllSessions(id, 'user_deleted');

    audit(req, 'user.deleted', {
      userId: req.user.id,
      email: req.user.email,
      details: { targetUserId: id, targetEmail: target.email }
    });

    res.status(204).end();
  })
);

// POST /api/users/:id/unlock — снять блокировку после подбора пароля.
router.post(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const id = parseUserId(req);
    const target = getTargetRow(id);

    clearLoginFailures(id);

    audit(req, 'user.unlocked', {
      userId: req.user.id,
      email: req.user.email,
      details: { targetUserId: id, targetEmail: target.email }
    });

    res.json(getUserById(id));
  })
);

// DELETE /api/users/:id/sessions — принудительно завершить все подключения.
router.delete(
  '/:id/sessions',
  asyncHandler(async (req, res) => {
    const id = parseUserId(req);
    const target = getTargetRow(id);

    revokeAllSessions(id, 'admin_revoked');

    audit(req, 'user.sessions_revoked', {
      userId: req.user.id,
      email: req.user.email,
      details: { targetUserId: id, targetEmail: target.email }
    });

    res.status(204).end();
  })
);

for (const [path, methods] of Object.entries({
  '/': ['GET', 'POST'],
  '/:id': ['GET', 'PATCH', 'DELETE'],
  '/:id/unlock': ['POST'],
  '/:id/sessions': ['DELETE']
})) {
  router.all(path, methodNotAllowedHandler(methods));
}

module.exports = router;
