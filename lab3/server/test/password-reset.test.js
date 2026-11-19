'use strict';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  setupTestEnv,
  auth,
  login,
  uniqueEmail,
  resetDatabase
} = require('./helpers');

setupTestEnv();

const { createApp } = require('../src/app');
const { db } = require('../src/db');
const mailer = require('../src/services/mailer');

let app;
let admin;

before(() => {
  app = createApp();
});

beforeEach(async () => {
  resetDatabase();
  mailer.clearOutbox();
  admin = (await login(app, 'admin@example.com', 'Admin123!')).body;
});

async function createUser(email, password = 'UserPass123!') {
  const res = await request(app)
    .post('/api/users')
    .set(auth(admin.accessToken))
    .send({ email, name: 'Тестовый пользователь', password, role: 'user' });

  assert.equal(res.status, 201);
  return res.body;
}

async function requestReset(email) {
  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email });

  assert.equal(res.status, 202);
  assert.match(res.body.message, /Если учётная запись/i);

  const message = mailer
    .getOutbox()
    .filter((item) => item.to === email)
    .at(-1);
  assert.ok(message, 'письмо должно попасть в outbox');

  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert.ok(match, 'в письме должна быть ссылка с токеном');
  return match[1];
}

function resetPassword(token, newPassword) {
  return request(app).post('/api/auth/reset-password').send({ token, newPassword });
}

test('неизвестный email не раскрывает существование аккаунта', async () => {
  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: 'ghost@example.com' });

  assert.equal(res.status, 202);
  assert.match(res.body.message, /Если учётная запись/i);
  assert.equal(mailer.getOutbox().length, 0);
});

test('восстановление по email меняет пароль и отзывает сессии', async () => {
  const email = uniqueEmail('reset');
  await createUser(email);

  const session = await login(app, email, 'UserPass123!');
  assert.equal(session.status, 200);

  const token = await requestReset(email);
  const applied = await resetPassword(token, 'BrandNew123!');
  assert.equal(applied.status, 204);

  const oldSession = await request(app)
    .get('/api/auth/me')
    .set(auth(session.body.accessToken));
  assert.equal(oldSession.status, 401, 'после сброса все сессии отзываются');

  const oldPassword = await login(app, email, 'UserPass123!');
  assert.equal(oldPassword.status, 401);

  const newPassword = await login(app, email, 'BrandNew123!');
  assert.equal(newPassword.status, 200);

  const reuse = await resetPassword(token, 'AnotherPass123!');
  assert.equal(reuse.status, 400, 'одноразовый ключ нельзя использовать повторно');
});

test('новый запрос восстановления инвалидирует предыдущий ключ', async () => {
  const email = uniqueEmail('reset2');
  await createUser(email);

  const firstToken = await requestReset(email);
  const secondToken = await requestReset(email);
  assert.notEqual(firstToken, secondToken);

  const firstAttempt = await resetPassword(firstToken, 'FirstPass123!');
  assert.equal(firstAttempt.status, 400);

  const secondAttempt = await resetPassword(secondToken, 'SecondPass123!');
  assert.equal(secondAttempt.status, 204);
});

test('истёкший ключ восстановления отклоняется', async () => {
  const email = uniqueEmail('expired');
  await createUser(email);

  const token = await requestReset(email);
  db.prepare('UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL').run(
    new Date(Date.now() - 60_000).toISOString()
  );

  const res = await resetPassword(token, 'ExpiredPass123!');
  assert.equal(res.status, 400);
});

test('некорректный ключ и слабый пароль дают 400/422', async () => {
  const invalidToken = await resetPassword('x'.repeat(40), 'ValidPass123!');
  assert.equal(invalidToken.status, 400);

  const email = uniqueEmail('weak');
  await createUser(email);
  const token = await requestReset(email);

  const weak = await resetPassword(token, 'short');
  assert.equal(weak.status, 422);
  assert.equal(weak.body.errors[0].field, 'newPassword');
});

test('восстановление снимает блокировку после подбора пароля', async () => {
  const email = uniqueEmail('locked');
  await createUser(email);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await login(app, email, 'WrongPass123!');
  }

  const locked = await login(app, email, 'UserPass123!');
  assert.equal(locked.status, 429);

  const token = await requestReset(email);
  const applied = await resetPassword(token, 'Unlocked123!');
  assert.equal(applied.status, 204);

  const afterReset = await login(app, email, 'Unlocked123!');
  assert.equal(afterReset.status, 200);
});

test('восстановление защищено ограничением частоты запросов', async () => {
  const email = uniqueEmail('rate');
  await createUser(email);

  let response;
  for (let attempt = 0; attempt < 101; attempt += 1) {
    response = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email });
    if (response.status === 429) break;
  }

  assert.equal(response.status, 429);
  assert.ok(response.headers['retry-after']);
});
