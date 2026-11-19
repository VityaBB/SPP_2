'use strict';

const path = require('node:path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const ENV = process.env.NODE_ENV || 'development';

function readInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Переменная окружения ${name} должна быть целым числом от ${min} до ${max}`
    );
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function readList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  env: ENV,
  isProduction: ENV === 'production',
  isTest: ENV === 'test',
  serverRoot: SERVER_ROOT,

  host: process.env.HOST || '0.0.0.0',
  port: readInt('PORT', 3000, { min: 1, max: 65535 }),
  trustProxy: readInt('TRUST_PROXY', 1, { min: 0, max: 10 }),
  appOrigin: (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/+$/, ''),
  corsOrigins: readList('CORS_ORIGIN'),
  logLevel: process.env.LOG_LEVEL || (ENV === 'test' ? 'error' : 'info'),
  seedDemoUsers: readBool('SEED_DEMO_USERS', true),

  dataDir: path.resolve(process.env.DATA_DIR || path.join(SERVER_ROOT, 'data')),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(SERVER_ROOT, 'uploads')),
  maxFileSize: readInt('MAX_FILE_SIZE', 10 * 1024 * 1024, { min: 1 }),
  maxJsonBody: process.env.MAX_JSON_BODY || '100kb',

  auth: {
    // Время жизни временных ключей доступа и обновления.
    accessTtlMs: readInt('ACCESS_TOKEN_TTL_MS', 15 * 60 * 1000, { min: 1000 }),
    refreshTtlMs: readInt('REFRESH_TOKEN_TTL_MS', 7 * 24 * 60 * 60 * 1000, {
      min: 1000
    }),
    resetTtlMs: readInt('RESET_TOKEN_TTL_MS', 30 * 60 * 1000, { min: 1000 }),
    // Защита от подбора учётных данных.
    loginMaxAttempts: readInt('LOGIN_MAX_ATTEMPTS', 5, { min: 1, max: 100 }),
    loginLockMs: readInt('LOGIN_LOCK_MS', 15 * 60 * 1000, { min: 1000 }),
    loginWindowMs: readInt('LOGIN_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
    passwordMin: readInt('PASSWORD_MIN_LENGTH', 8, { min: 8, max: 64 }),
    passwordMax: 128
  },

  rateLimit: {
    windowMs: readInt('RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
    max: readInt('RATE_LIMIT_MAX', 300, { min: 10 }),
    loginWindowMs: readInt('LOGIN_RATE_WINDOW_MS', 10 * 60 * 1000, { min: 1000 }),
    loginMax: readInt('LOGIN_RATE_MAX', 10, { min: 1 }),
    mailWindowMs: readInt('MAIL_RATE_WINDOW_MS', 60 * 60 * 1000, { min: 1000 }),
    mailMax: readInt('MAIL_RATE_MAX', 10, { min: 1 }),
    registerWindowMs: readInt('REGISTER_RATE_WINDOW_MS', 60 * 60 * 1000, { min: 1000 }),
    registerMax: readInt('REGISTER_RATE_MAX', 5, { min: 1 })
  },

  cookie: {
    secure: readBool('COOKIE_SECURE', ENV === 'production'),
    refreshPath: '/api/auth'
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: readInt('SMTP_PORT', 1025, { min: 1, max: 65535 }),
    secure: readBool('SMTP_SECURE', false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Список задач <no-reply@lab3.local>'
  }
};

config.dbFile = path.join(config.dataDir, 'lab3.sqlite');

module.exports = config;
