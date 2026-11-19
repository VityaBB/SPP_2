'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');

const { db, DB_FILE } = require('./db');
const taskRoutes = require('./routes/tasks');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024);
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')
);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS нужен только при запуске клиента на отдельном origin (например, dev-сервер).
if (process.env.CORS_ORIGIN) {
  const origins = process.env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: origins.length > 0 ? origins : false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      exposedHeaders: ['Location']
    })
  );
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '100kb' }));

// ---------- REST API ----------
app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({
    status: 'ok',
    database: path.basename(DB_FILE),
    uptime: Math.round(process.uptime())
  });
});

app.use('/api/tasks', taskRoutes);

// Неизвестный маршрут API — JSON 404, а не HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Маршрут API не найден' });
});

// ---------- SPA (удобно при локальном запуске без Docker) ----------
const CLIENT_DIR = path.join(__dirname, '..', '..', 'client', 'public');
if (fs.existsSync(path.join(CLIENT_DIR, 'index.html'))) {
  app.use(express.static(CLIENT_DIR));
  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });
}

// ---------- Обработка ошибок ----------
function multerMessage(error) {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return `Размер файла превышает ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} МБ`;
    case 'LIMIT_FILE_COUNT':
      return 'Можно загрузить только один файл';
    case 'LIMIT_UNEXPECTED_FILE':
      return 'Неожиданное поле с файлом. Используйте поле «file»';
    case 'LIMIT_FIELD_COUNT':
      return 'Слишком много полей формы';
    default:
      return `Ошибка загрузки файла: ${error.message}`;
  }
}

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: multerMessage(error) });
    return;
  }

  if (error.code === 'INVALID_FILE_TYPE') {
    res.status(415).json({ error: error.message });
    return;
  }

  if (
    typeof error.message === 'string' &&
    (error.message.startsWith('Multipart:') ||
      error.message === 'Unexpected end of form')
  ) {
    res.status(400).json({ error: 'Некорректные данные multipart/form-data' });
    return;
  }

  if (error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
    return;
  }

  if (error.type === 'entity.too.large') {
    res.status(413).json({ error: 'Слишком большое тело запроса' });
    return;
  }

  if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
    res.status(415).json({ error: 'Неподдерживаемая кодировка тела запроса' });
    return;
  }

  // Прочие ошибки разбора/чтения тела запроса с корректным HTTP-статусом.
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({ error: 'Некорректное тело запроса' });
    return;
  }

  console.error('[error]', error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ---------- Запуск ----------
const server = app.listen(PORT, HOST, () => {
  console.log(`REST API: http://localhost:${PORT}/api`);
  console.log(`База данных: ${DB_FILE}`);
  console.log(`Каталог файлов: ${UPLOAD_DIR}`);
  if (fs.existsSync(path.join(CLIENT_DIR, 'index.html'))) {
    console.log(`SPA (локальный режим): http://localhost:${PORT}`);
  }
});

server.on('error', (error) => {
  console.error('Не удалось запустить сервер:', error.message);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}, завершение работы...`);

  server.close(() => {
    try {
      db.close();
    } catch (error) {
      console.error('Не удалось закрыть БД:', error.message);
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
