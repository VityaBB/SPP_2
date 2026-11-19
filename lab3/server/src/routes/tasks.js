'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');
const { db, serializeTask, serializeFile } = require('../db');
const { STATUSES, validateTaskPayload, parseId } = require('../validation');
const { HttpError, forbidden, notFound, validationError } = require('../errors');
const { logger } = require('../logger');
const { getUserRowById } = require('../services/users');
const { audit } = require('../services/audit');
const { authenticate } = require('../middleware/auth');
const { requireJson, requireMultipart } = require('../middleware/content-type');
const { methodNotAllowedHandler } = require('../middleware/method-not-allowed');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.txt',
  '.csv',
  '.zip',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  // Браузеры передают имя файла в UTF-8, busboy по умолчанию читает latin1.
  defParamCharset: 'utf8',
  limits: { fileSize: config.maxFileSize, files: 1, fields: 5 },
  fileFilter(req, file, cb) {
    const extension = path.extname(file.originalname || '').toLowerCase();

    if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXTENSIONS.has(extension)) {
      cb(null, true);
      return;
    }

    const error = new Error(
      'Недопустимый тип файла. Разрешены изображения, PDF, TXT, CSV, ZIP, DOC/DOCX, XLS/XLSX'
    );
    error.status = 415;
    error.code = 'INVALID_FILE_TYPE';
    cb(error);
  }
});

const statements = {
  taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  taskWithOwnerById: db.prepare(`
    SELECT t.*, u.email AS owner_email, u.name AS owner_name
      FROM tasks t
      LEFT JOIN users u ON u.id = t.owner_id
     WHERE t.id = ?
  `),
  allTasks: db.prepare(`
    SELECT t.*, u.email AS owner_email, u.name AS owner_name
      FROM tasks t
      LEFT JOIN users u ON u.id = t.owner_id
     ORDER BY (t.due_date IS NULL), t.due_date ASC, t.id ASC
  `),
  tasksByOwner: db.prepare(`
    SELECT t.*, u.email AS owner_email, u.name AS owner_name
      FROM tasks t
      LEFT JOIN users u ON u.id = t.owner_id
     WHERE t.owner_id = ?
     ORDER BY (t.due_date IS NULL), t.due_date ASC, t.id ASC
  `),
  filesByTask: db.prepare('SELECT * FROM files WHERE task_id = ? ORDER BY id ASC'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  insertTask: db.prepare(
    'INSERT INTO tasks (owner_id, title, status, due_date) VALUES (?, ?, ?, ?)'
  ),
  updateTask: db.prepare(`
    UPDATE tasks
       SET owner_id = @ownerId,
           title = @title,
           status = @status,
           due_date = @dueDate,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = @id
  `),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  insertFile: db.prepare(`
    INSERT INTO files (task_id, uploaded_by, original_name, stored_name, mime_type, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?')
};

function ownerOf(row) {
  if (!row.owner_email) return null;
  return { id: row.owner_id, email: row.owner_email, name: row.owner_name };
}

function serializeTaskRow(row) {
  return serializeTask(
    row,
    statements.filesByTask.all(row.id).map(serializeFile),
    ownerOf(row)
  );
}

function requireTaskAccess(req, row) {
  if (!row) throw notFound('Задача не найдена');
  if (req.user.role === 'user' && row.owner_id !== req.user.id) {
    throw forbidden('Задача принадлежит другому пользователю');
  }
}

function getTaskRow(id) {
  return statements.taskById.get(id) || null;
}

function resolveOwnerId(req, requested) {
  if (requested === undefined) return req.user.id;

  if (req.user.role === 'user' && requested !== req.user.id) {
    throw forbidden('Пользователь может назначать задачи только себе');
  }

  const owner = getUserRowById(requested);
  if (!owner || !owner.is_active) {
    throw validationError(
      [{ field: 'ownerId', message: 'Пользователь-владелец не найден или заблокирован' }],
      'Некорректный владелец задачи'
    );
  }

  return requested;
}

function taskList(row) {
  return serializeTaskRow(row);
}

function removeFileFromDisk(storedName) {
  const absolutePath = path.join(config.uploadDir, path.basename(storedName));
  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('files.unlink_failed', { storedName, error });
    }
  }
}

function safeOriginalName(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    // eslint-disable-next-line no-control-regex -- удаляем управляющие символы из имени файла
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);

  return base || 'file';
}

function safeExtension(originalName) {
  const extension = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,9}$/.test(extension) ? extension : '';
}

function findTaskFile(taskId, fileId) {
  const file = statements.fileById.get(fileId);
  if (!file || file.task_id !== taskId) return null;
  return file;
}

router.use(authenticate);

// GET /api/tasks?status=...&q=...
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, q } = req.query;

    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный фильтр по статусу',
        errors: [
          { field: 'status', message: `Допустимые значения: ${STATUSES.join(', ')}` }
        ]
      });
    }

    if (q !== undefined && (typeof q !== 'string' || q.length > 100)) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный поисковый запрос',
        errors: [{ field: 'q', message: 'q должен быть строкой до 100 символов' }]
      });
    }

    let rows =
      req.user.role === 'user'
        ? statements.tasksByOwner.all(req.user.id)
        : statements.allTasks.all();

    if (status) {
      rows = rows.filter((row) => row.status === status);
    }

    if (q) {
      const needle = q.trim().toLowerCase();
      if (needle) {
        rows = rows.filter((row) => row.title.toLowerCase().includes(needle));
      }
    }

    res.json(rows.map(taskList));
  })
);

// POST /api/tasks
router.post(
  '/',
  requireJson,
  asyncHandler(async (req, res) => {
    const { value, errors } = validateTaskPayload(req.body, { partial: false });
    if (errors.length > 0) throw validationError(errors);

    const ownerId = resolveOwnerId(req, value.ownerId);

    const info = statements.insertTask.run(
      ownerId,
      value.title,
      value.status || 'new',
      value.dueDate === undefined ? null : value.dueDate
    );

    const created = serializeTaskRow(statements.taskWithOwnerById.get(Number(info.lastInsertRowid)));

    audit(req, 'task.created', {
      userId: req.user.id,
      email: req.user.email,
      details: { taskId: created.id, ownerId }
    });

    res.status(201).location(`/api/tasks/${created.id}`).json(created);
  })
);

function updateTask(req, res, { partial }) {
  const id = parseId(req.params.id);
  if (!id) {
    throw new HttpError(400, 'Некорректный запрос', {
      detail: 'Некорректный идентификатор задачи',
      errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
    });
  }

  const current = getTaskRow(id);
  requireTaskAccess(req, current);

  const { value, errors } = validateTaskPayload(req.body, { partial });
  if (errors.length > 0) throw validationError(errors);

  const has = (key) => Object.prototype.hasOwnProperty.call(value, key);
  const ownerId = has('ownerId')
    ? resolveOwnerId(req, value.ownerId)
    : current.owner_id;

  statements.updateTask.run({
    id,
    ownerId,
    title: has('title') ? value.title : current.title,
    status: has('status') ? value.status : current.status,
    dueDate: has('dueDate') ? value.dueDate : current.due_date
  });

  const updated = serializeTaskRow(statements.taskWithOwnerById.get(id));

  audit(req, 'task.updated', {
    userId: req.user.id,
    email: req.user.email,
    details: { taskId: id, ownerId }
  });

  res.json(updated);
}

// PUT /api/tasks/:id — полное обновление (title обязательно).
router.put(
  '/:id',
  requireJson,
  asyncHandler(async (req, res) => {
    updateTask(req, res, { partial: false });
  })
);

// PATCH /api/tasks/:id — частичное обновление.
router.patch(
  '/:id',
  requireJson,
  asyncHandler(async (req, res) => {
    updateTask(req, res, { partial: true });
  })
);

// GET /api/tasks/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор задачи',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    const row = statements.taskWithOwnerById.get(id);
    requireTaskAccess(req, row);
    res.json(serializeTaskRow(row));
  })
);

// DELETE /api/tasks/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор задачи',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    const row = getTaskRow(id);
    requireTaskAccess(req, row);

    const files = statements.filesByTask.all(id);
    statements.deleteTask.run(id);
    files.forEach((file) => removeFileFromDisk(file.stored_name));

    audit(req, 'task.deleted', {
      userId: req.user.id,
      email: req.user.email,
      details: { taskId: id, ownerId: row.owner_id }
    });

    res.status(204).end();
  })
);

// GET /api/tasks/:id/files
router.get(
  '/:id/files',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор задачи',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    const row = getTaskRow(id);
    requireTaskAccess(req, row);

    res.json(statements.filesByTask.all(id).map(serializeFile));
  })
);

// POST /api/tasks/:id/files (multipart/form-data, поле file)
router.post(
  '/:id/files',
  (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) {
        throw new HttpError(400, 'Некорректный запрос', {
          detail: 'Некорректный идентификатор задачи',
          errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
        });
      }

      const row = getTaskRow(id);
      requireTaskAccess(req, row);
      req.taskId = id;
      next();
    } catch (error) {
      next(error);
    }
  },
  requireMultipart,
  upload.single('file'),
  (req, res, next) => {
    try {
      if (!req.file) {
        throw validationError(
          [{ field: 'file', message: 'Добавьте файл в поле file' }],
          'Файл не передан'
        );
      }

      if (req.file.size === 0) {
        throw new HttpError(400, 'Некорректный запрос', {
          detail: 'Пустой файл загружать нельзя'
        });
      }

      const originalName = safeOriginalName(req.file.originalname);
      const storedName = `${crypto.randomUUID()}${safeExtension(originalName)}`;
      const absolutePath = path.join(config.uploadDir, storedName);

      fs.writeFileSync(absolutePath, req.file.buffer, { flag: 'wx' });

      let info;
      try {
        info = statements.insertFile.run(
          req.taskId,
          req.user.id,
          originalName,
          storedName,
          req.file.mimetype,
          req.file.size
        );
      } catch (error) {
        removeFileFromDisk(storedName);
        throw error;
      }

      const file = statements.fileById.get(Number(info.lastInsertRowid));

      audit(req, 'file.uploaded', {
        userId: req.user.id,
        email: req.user.email,
        details: {
          taskId: req.taskId,
          fileId: file.id,
          size: file.size,
          mimeType: file.mime_type
        }
      });

      res
        .status(201)
        .location(`/api/tasks/${req.taskId}/files/${file.id}`)
        .json(serializeFile(file));
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/tasks/:taskId/files/:fileId
router.get(
  '/:taskId/files/:fileId',
  asyncHandler(async (req, res) => {
    const taskId = parseId(req.params.taskId);
    const fileId = parseId(req.params.fileId);

    if (!taskId || !fileId) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор файла',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    requireTaskAccess(req, getTaskRow(taskId));

    const file = findTaskFile(taskId, fileId);
    if (!file) throw notFound('Файл не найден');

    res.json(serializeFile(file));
  })
);

// GET /api/tasks/:taskId/files/:fileId/download
router.get(
  '/:taskId/files/:fileId/download',
  asyncHandler(async (req, res, next) => {
    const taskId = parseId(req.params.taskId);
    const fileId = parseId(req.params.fileId);

    if (!taskId || !fileId) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор файла',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    requireTaskAccess(req, getTaskRow(taskId));

    const file = findTaskFile(taskId, fileId);
    if (!file) throw notFound('Файл не найден');

    const absolutePath = path.join(config.uploadDir, path.basename(file.stored_name));
    if (!fs.existsSync(absolutePath)) {
      throw notFound('Файл отсутствует на сервере');
    }

    res.download(absolutePath, file.original_name, (error) => {
      if (error && !res.headersSent) next(error);
    });

    audit(req, 'file.downloaded', {
      userId: req.user.id,
      email: req.user.email,
      details: { taskId, fileId }
    });
  })
);

// DELETE /api/tasks/:taskId/files/:fileId
router.delete(
  '/:taskId/files/:fileId',
  asyncHandler(async (req, res) => {
    const taskId = parseId(req.params.taskId);
    const fileId = parseId(req.params.fileId);

    if (!taskId || !fileId) {
      throw new HttpError(400, 'Некорректный запрос', {
        detail: 'Некорректный идентификатор файла',
        errors: [{ field: 'id', message: 'Ожидается положительное целое число' }]
      });
    }

    requireTaskAccess(req, getTaskRow(taskId));

    const file = findTaskFile(taskId, fileId);
    if (!file) throw notFound('Файл не найден');

    statements.deleteFile.run(fileId);
    removeFileFromDisk(file.stored_name);

    audit(req, 'file.deleted', {
      userId: req.user.id,
      email: req.user.email,
      details: { taskId, fileId }
    });

    res.status(204).end();
  })
);

for (const [path, methods] of Object.entries({
  '/': ['GET', 'POST'],
  '/:id': ['GET', 'PUT', 'PATCH', 'DELETE'],
  '/:id/files': ['GET', 'POST'],
  '/:taskId/files/:fileId': ['GET', 'DELETE'],
  '/:taskId/files/:fileId/download': ['GET']
})) {
  router.all(path, methodNotAllowedHandler(methods));
}

module.exports = router;
