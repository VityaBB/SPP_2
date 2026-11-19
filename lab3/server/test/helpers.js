'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

/**
 * Готовит изолированную БД и настройки ДО подключения приложения.
 */
function setupTestEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab3-test-'));

  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = dir;
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.SEED_DEMO_USERS = 'true';
  process.env.LOG_LEVEL = 'error';
  process.env.COOKIE_SECURE = 'false';
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.ACCESS_TOKEN_TTL_MS = '900000';
  process.env.REFRESH_TOKEN_TTL_MS = '604800000';
  process.env.RESET_TOKEN_TTL_MS = '1800000';
  process.env.LOGIN_MAX_ATTEMPTS = '5';
  process.env.LOGIN_LOCK_MS = '600000';
  process.env.RATE_LIMIT_MAX = '1000';
  process.env.LOGIN_RATE_MAX = '100';
  process.env.MAIL_RATE_MAX = '100';
  process.env.REGISTER_RATE_MAX = '100';
  process.env.MAX_FILE_SIZE = '4096';

  return dir;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function login(app, email, password) {
  return request(app).post('/api/auth/login').send({ email, password });
}

function refreshCookieFrom(response) {
  const cookies = response.headers['set-cookie'] || [];
  const cookie = cookies.find((item) => item.startsWith('refresh_token='));
  return cookie ? cookie.split(';')[0] : null;
}

let userCounter = 0;

function uniqueEmail(prefix = 'test') {
  userCounter += 1;
  return `${prefix}${userCounter}.${Date.now()}@example.com`;
}

function resetDatabase() {
  const { db } = require('../src/db');
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM files');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM refresh_tokens');
  db.exec('DELETE FROM password_resets');
  db.exec('DELETE FROM audit_log');
  db.prepare(
    `UPDATE users
        SET failed_attempts = 0, locked_until = NULL, last_failed_at = NULL
      WHERE 1 = 1`
  ).run();
}

module.exports = {
  setupTestEnv,
  auth,
  login,
  refreshCookieFrom,
  uniqueEmail,
  resetDatabase
};
