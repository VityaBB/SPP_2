'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db, serializeTask, serializeFile } = require('../db');
const { STATUSES, validateTaskPayload, parseId } = require('../validation');

const router = express.Router();

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads')
);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);
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
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 5 },
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
  filesByTask: db.prepare('SELECT * FROM files WHERE task_id = ? ORDER BY id ASC'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  insertTask: db.prepare(
    'INSERT INTO tasks (title, status, due_date) VALUES (?, ?, ?)'
  ),
  updateTask: db.prepare(`
    UPDATE tasks
       SET title = @title,
           status = @status,
           due_date = @dueDate,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = @id
  `),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  insertFile: db.prepare(`
    INSERT INTO files (task_id, original_name, stored_name, mime_type, size)
    VALUES (?, ?, ?, ?, ?)
  `),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?')
};

function getTask(id) {
  const row = statements.taskById.get(id);
  if (!row) return null;

  const files = statements.filesByTask.all(id).map(serializeFile);
  return serializeTask(row, files);
}

function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    res.status(415).json({
      error: 'Ожидается Content-Type: application/json',
      details: [{ field: 'Content-Type', message: 'Тело запроса должно быть JSON' }]
    });
    return;
  }
  next();
}

function requireMultipart(req, res, next) {
  if (!req.is('multipart/form-data')) {
    res.status(415).json({
      error: 'Ожидается Content-Type: multipart/form-data',
      details: [
        {
          field: 'Content-Type',
          message: 'Файл нужно отправлять как multipart/form-data в поле file'
        }
      ]
    });
    return;
  }
  next();
}

function sendValidationError(res, errors) {
  res.status(400).json({ error: 'Некорректные данные задачи', details: errors });
}

function sendInvalidId(res, resource = 'задачи') {
  res.status(400).json({
    error: `Некорректный идентификатор ${resource}`,
    details: [{ field: 'id', message: 'Ожидается положительное целое число' }]
  });
}

function removeFileFromDisk(storedName) {
  const absolutePath = path.join(UPLOAD_DIR, path.basename(storedName));
  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[files] Не удалось удалить файл:', absolutePath, error.message);
    }
  }
}

function safeOriginalName(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);

  return base || 'file';
}

function safeExtension(originalName) {
  const extension = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,9}$/.test(extension) ? extension : '';
}

// GET /api/tasks?status=...&q=...
router.get('/', (req, res) => {
  const { status, q } = req.query;

  if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) {
    res.status(400).json({
      error: 'Некорректный фильтр по статусу',
      details: [{ field: 'status', message: `Допустимые значения: ${STATUSES.join(', ')}` }]
    });
    return;
  }

  if (q !== undefined && (typeof q !== 'string' || q.length > 100)) {
    res.status(400).json({
      error: 'Некорректный поисковый запрос',
      details: [{ field: 'q', message: 'q должен быть строкой до 100 символов' }]
    });
    return;
  }

  let rows = db
    .prepare(
      `SELECT * FROM tasks
       ORDER BY (due_date IS NULL), due_date ASC, id ASC`
    )
    .all();

  if (status) {
    rows = rows.filter((row) => row.status === status);
  }

  if (q) {
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((row) => row.title.toLowerCase().includes(needle));
    }
  }

  const filesStmt = statements.filesByTask;
  const tasks = rows.map((row) =>
    serializeTask(row, filesStmt.all(row.id).map(serializeFile))
  );

  res.json(tasks);
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    sendInvalidId(res);
    return;
  }

  const task = getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Задача не найдена' });
    return;
  }

  res.json(task);
});

// POST /api/tasks
router.post('/', requireJson, (req, res) => {
  const { value, errors } = validateTaskPayload(req.body, { partial: false });
  if (errors.length > 0) {
    sendValidationError(res, errors);
    return;
  }

  const info = statements.insertTask.run(
    value.title,
    value.status || 'new',
    value.dueDate === undefined ? null : value.dueDate
  );

  const created = getTask(Number(info.lastInsertRowid));
  res
    .status(201)
    .location(`/api/tasks/${created.id}`)
    .json(created);
});

function updateTask(req, res, { partial }) {
  const id = parseId(req.params.id);
  if (!id) {
    sendInvalidId(res);
    return;
  }

  const current = statements.taskById.get(id);
  if (!current) {
    res.status(404).json({ error: 'Задача не найдена' });
    return;
  }

  const { value, errors } = validateTaskPayload(req.body, { partial });
  if (errors.length > 0) {
    sendValidationError(res, errors);
    return;
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(value, key);

  statements.updateTask.run({
    id,
    title: has('title') ? value.title : current.title,
    status: has('status') ? value.status : current.status,
    dueDate: has('dueDate') ? value.dueDate : current.due_date
  });

  res.json(getTask(id));
}

// PUT /api/tasks/:id — обновление (title обязательно)
router.put('/:id', requireJson, (req, res) => {
  updateTask(req, res, { partial: false });
});

// PATCH /api/tasks/:id — частичное обновление (например, только статус)
router.patch('/:id', requireJson, (req, res) => {
  updateTask(req, res, { partial: true });
});

// DELETE /api/tasks/:id
router.delete('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    sendInvalidId(res);
    return;
  }

  if (!statements.taskById.get(id)) {
    res.status(404).json({ error: 'Задача не найдена' });
    return;
  }

  const files = statements.filesByTask.all(id);
  // files удаляются каскадно на уровне БД
  statements.deleteTask.run(id);
  files.forEach((file) => removeFileFromDisk(file.stored_name));

  res.status(204).end();
});

// GET /api/tasks/:id/files
router.get('/:id/files', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    sendInvalidId(res);
    return;
  }

  if (!statements.taskById.get(id)) {
    res.status(404).json({ error: 'Задача не найдена' });
    return;
  }

  res.json(statements.filesByTask.all(id).map(serializeFile));
});

// POST /api/tasks/:id/files (multipart/form-data, поле file)
router.post(
  '/:id/files',
  (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) {
      sendInvalidId(res);
      return;
    }

    if (!statements.taskById.get(id)) {
      res.status(404).json({ error: 'Задача не найдена' });
      return;
    }

    req.taskId = id;
    next();
  },
  requireMultipart,
  upload.single('file'),
  (req, res, next) => {
    if (!req.file) {
      res.status(400).json({
        error: 'Файл не передан',
        details: [{ field: 'file', message: 'Добавьте файл в поле file' }]
      });
      return;
    }

    if (req.file.size === 0) {
      res.status(400).json({ error: 'Пустой файл загружать нельзя' });
      return;
    }

    const originalName = safeOriginalName(req.file.originalname);
    const storedName = `${crypto.randomUUID()}${safeExtension(originalName)}`;
    const absolutePath = path.join(UPLOAD_DIR, storedName);

    try {
      fs.writeFileSync(absolutePath, req.file.buffer, { flag: 'wx' });
    } catch (error) {
      next(error);
      return;
    }

    try {
      const info = statements.insertFile.run(
        req.taskId,
        originalName,
        storedName,
        req.file.mimetype,
        req.file.size
      );

      const file = statements.fileById.get(Number(info.lastInsertRowid));
      res
        .status(201)
        .location(`/api/tasks/${req.taskId}/files/${file.id}`)
        .json(serializeFile(file));
    } catch (error) {
      removeFileFromDisk(storedName);
      next(error);
    }
  }
);

function findTaskFile(taskId, fileId) {
  const file = statements.fileById.get(fileId);
  if (!file || file.task_id !== taskId) return null;
  return file;
}

// GET /api/tasks/:taskId/files/:fileId
router.get('/:taskId/files/:fileId', (req, res) => {
  const taskId = parseId(req.params.taskId);
  const fileId = parseId(req.params.fileId);

  if (!taskId || !fileId) {
    sendInvalidId(res, 'файла');
    return;
  }

  const file = findTaskFile(taskId, fileId);
  if (!file) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }

  res.json(serializeFile(file));
});

// GET /api/tasks/:taskId/files/:fileId/download
router.get('/:taskId/files/:fileId/download', (req, res) => {
  const taskId = parseId(req.params.taskId);
  const fileId = parseId(req.params.fileId);

  if (!taskId || !fileId) {
    sendInvalidId(res, 'файла');
    return;
  }

  const file = findTaskFile(taskId, fileId);
  if (!file) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }

  const absolutePath = path.join(UPLOAD_DIR, path.basename(file.stored_name));
  if (!fs.existsSync(absolutePath)) {
    res.status(404).json({ error: 'Файл отсутствует на сервере' });
    return;
  }

  res.download(absolutePath, file.original_name, (error) => {
    if (error && !res.headersSent) {
      res.status(500).json({ error: 'Не удалось отдать файл' });
    }
  });
});

// DELETE /api/tasks/:taskId/files/:fileId
router.delete('/:taskId/files/:fileId', (req, res) => {
  const taskId = parseId(req.params.taskId);
  const fileId = parseId(req.params.fileId);

  if (!taskId || !fileId) {
    sendInvalidId(res, 'файла');
    return;
  }

  const file = findTaskFile(taskId, fileId);
  if (!file) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }

  statements.deleteFile.run(fileId);
  removeFileFromDisk(file.stored_name);
  res.status(204).end();
});

module.exports = router;
