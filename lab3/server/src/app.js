'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { db, dbFile, closeDb } = require('./db');
const { logger } = require('./logger');
const {
  HttpError,
  conflict,
  notFound,
  badRequest,
  unsupportedMediaType,
  payloadTooLarge,
  sendProblem
} = require('./errors');
const { requestContext } = require('./middleware/request-context');
const { createRateLimiter } = require('./middleware/rate-limit');
const { methodNotAllowedHandler } = require('./middleware/method-not-allowed');
const { seedDemoUsers } = require('./services/users');
const { cleanupExpiredTokens } = require('./services/sessions');
const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const sessionRoutes = require('./routes/sessions');
const auditRoutes = require('./routes/audit');

const packageJson = require('../package.json');

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

/**
 * Защита от CSRF: состояние изменяется только запросами с доверенного origin.
 * Дополнительно refresh-ключ хранится в cookie с SameSite=Strict.
 */
function verifyOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    next(new HttpError(403, 'Доступ запрещён', { detail: 'Некорректный заголовок Origin' }));
    return;
  }

  const trusted = new Set();
  try {
    trusted.add(new URL(config.appOrigin).host);
  } catch {
    // Некорректный APP_ORIGIN не должен ломать проверку Host.
  }
  trusted.add(req.get('x-forwarded-host') || req.get('host'));

  if (!trusted.has(originHost)) {
    next(
      new HttpError(403, 'Доступ запрещён', {
        detail: 'Запросы с изменением данных разрешены только с доверенного origin'
      })
    );
    return;
  }

  next();
}

function mapMulterError(error) {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return payloadTooLarge(
        `Размер файла превышает ${Math.round(config.maxFileSize / 1024 / 1024)} МБ`
      );
    case 'LIMIT_FILE_COUNT':
      return badRequest('Можно загрузить только один файл');
    case 'LIMIT_UNEXPECTED_FILE':
      return badRequest('Неожиданное поле с файлом. Используйте поле «file»');
    case 'LIMIT_FIELD_COUNT':
      return badRequest('Слишком много полей формы');
    default:
      return badRequest(`Ошибка загрузки файла: ${error.message}`);
  }
}

function normalizeError(error) {
  if (error instanceof HttpError) return error;

  if (error instanceof multer.MulterError) return mapMulterError(error);

  if (error.code === 'INVALID_FILE_TYPE') {
    return unsupportedMediaType(error.message);
  }

  if (
    typeof error.message === 'string' &&
    (error.message.startsWith('Multipart:') ||
      error.message === 'Unexpected end of form')
  ) {
    return badRequest('Некорректные данные multipart/form-data');
  }

  if (error.type === 'entity.parse.failed') {
    return badRequest('Некорректный JSON в теле запроса');
  }

  if (error.type === 'entity.too.large') {
    return payloadTooLarge('Слишком большое тело запроса');
  }

  if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
    return unsupportedMediaType('Неподдерживаемая кодировка тела запроса');
  }

  if (
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return conflict('Нарушено ограничение целостности данных');
  }

  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return new HttpError(error.status, 'Некорректный запрос', {
      detail: 'Не удалось обработать тело запроса'
    });
  }

  return new HttpError(500, 'Внутренняя ошибка сервера', {
    detail: 'Повторите попытку позже. Если ошибка повторяется — обратитесь к администратору',
    expose: false
  });
}

function createApp() {
  seedDemoUsers();
  cleanupExpiredTokens();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext);
  app.use(applySecurityHeaders);
  app.use(verifyOrigin);

  if (config.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: config.corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
        exposedHeaders: [
          'Location',
          'X-Request-ID',
          'WWW-Authenticate',
          'Retry-After',
          'RateLimit-Limit',
          'RateLimit-Remaining',
          'RateLimit-Reset'
        ],
        maxAge: 600
      })
    );
  }

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(
    '/api',
    createRateLimiter({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      message: 'Превышен общий лимит запросов к API. Попробуйте позже.'
    })
  );

  app.use(
    express.json({
      limit: config.maxJsonBody,
      type: ['application/json', 'application/*+json']
    })
  );

  // ---------- REST API ----------
  app.get('/api/health', (req, res) => {
    const row = db.prepare('SELECT 1 AS ok').get();
    res.json({
      status: row && row.ok === 1 ? 'ok' : 'error',
      database: path.basename(dbFile),
      uptime: Math.round(process.uptime()),
      version: packageJson.version,
      time: new Date().toISOString()
    });
  });

  app.all('/api/health', methodNotAllowedHandler(['GET']));

  app.use('/api/auth', authRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/audit', auditRoutes);

  // Неизвестный маршрут API — JSON 404, а не HTML.
  app.use('/api', (req, res, next) => {
    next(notFound('Маршрут API не найден'));
  });

  // ---------- SPA (локальный запуск без Docker) ----------
  const clientDir = path.join(__dirname, '..', '..', 'client', 'public');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir));
    app.get('*', (req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  // ---------- Единая обработка ошибок ----------
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const normalized = normalizeError(error);
    const requestLogger = req.log || logger;

    if (normalized.status >= 500) {
      requestLogger.error('request.failed', {
        status: normalized.status,
        title: normalized.title,
        error
      });
    } else {
      requestLogger.warn('request.rejected', {
        status: normalized.status,
        title: normalized.title,
        detail: normalized.detail
      });
    }

    sendProblem(req, res, normalized);
  });

  return app;
}

function startServer() {
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info('server.started', {
      host: config.host,
      port: config.port,
      env: config.env,
      database: dbFile,
      uploadDir: config.uploadDir,
      accessTokenTtlMs: config.auth.accessTtlMs,
      refreshTokenTtlMs: config.auth.refreshTtlMs,
      structuredLogging: true
    });

    if (fs.existsSync(path.join(__dirname, '..', '..', 'client', 'public', 'index.html'))) {
      logger.info('spa.available', { url: `http://localhost:${config.port}` });
    }
  });

  server.on('error', (error) => {
    logger.error('server.listen_failed', { error });
    process.exit(1);
  });

  const cleanupTimer = setInterval(cleanupExpiredTokens, 60 * 60 * 1000);
  cleanupTimer.unref();

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown', { signal });

    server.close(() => {
      closeDb();
      logger.info('server.stopped');
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
