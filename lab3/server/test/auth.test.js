'use strict';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  setupTestEnv,
  auth,
  login,
  refreshCookieFrom,
  resetDatabase
} = require('./helpers');

setupTestEnv();

const { createApp } = require('../src/app');
const { db } = require('../src/db');

let app;

before(() => {
  app = createApp();
});

beforeEach(() => {
  resetDatabase();
});

test('GET /api/health возвращает 200 и JSON', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.match(res.headers['content-type'], /application\/json/);
});

test('POST /api/health возвращает 405 и Allow', async () => {
  const res = await request(app).post('/api/health');
  assert.equal(res.status, 405);
  assert.match(res.headers.allow, /GET/);
});

test('защищённый маршрут без токена возвращает 401 и WWW-Authenticate', async () => {
  const res = await request(app).get('/api/tasks');
  assert.equal(res.status, 401);
  assert.match(res.headers['www-authenticate'], /Bearer/);
  assert.equal(res.body.title, 'Не авторизован');
  assert.ok(res.body.requestId);
});

test('вход с неверным паролем и неизвестным email не различаются', async () => {
  const badPassword = await login(app, 'user@example.com', 'Wrong123!');
  const unknown = await login(app, 'nobody@example.com', 'Wrong123!');

  assert.equal(badPassword.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(badPassword.body.detail, unknown.body.detail);
});

test('пять неудачных попыток блокируют учётную запись и возвращают 429', async () => {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await login(app, 'user2@example.com', 'Wrong123!');
  }

  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);

  const correctWhileLocked = await login(app, 'user2@example.com', 'User123!');
  assert.equal(correctWhileLocked.status, 429);

  const admin = await login(app, 'admin@example.com', 'Admin123!');
  assert.equal(admin.status, 200);

  const users = await request(app).get('/api/users?search=user2').set(auth(admin.body.accessToken));
  const target = users.body.find((user) => user.email === 'user2@example.com');
  assert.ok(target.isLocked);

  const unlock = await request(app)
    .post(`/api/users/${target.id}/unlock`)
    .set(auth(admin.body.accessToken));
  assert.equal(unlock.status, 200);
  assert.equal(unlock.body.isLocked, false);

  const afterUnlock = await login(app, 'user2@example.com', 'User123!');
  assert.equal(afterUnlock.status, 200);
});

test('успешный вход выдаёт временные ключи и refresh-cookie', async () => {
  const res = await login(app, 'user@example.com', 'User123!');

  assert.equal(res.status, 200);
  assert.equal(res.body.tokenType, 'Bearer');
  assert.ok(res.body.accessToken);
  assert.ok(res.body.expiresIn > 0);
  assert.equal(res.body.user.role, 'user');

  const cookie = refreshCookieFrom(res);
  assert.ok(cookie, 'refresh-cookie должен быть установлен');
  assert.match(res.headers['set-cookie'][0], /HttpOnly/);
  assert.match(res.headers['set-cookie'][0], /SameSite=Strict/);

  const me = await request(app).get('/api/auth/me').set(auth(res.body.accessToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'user@example.com');
});

test('регистрация создаёт пользователя с ролью user и открывает сессию', async () => {
  const res = await request(app).post('/api/auth/register').send({
    name: 'Новый Пользователь',
    email: 'new.user@example.com',
    password: 'NewUser123'
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'new.user@example.com');
  assert.equal(res.body.user.role, 'user');
  assert.ok(res.body.accessToken);
  assert.ok(refreshCookieFrom(res), 'refresh-cookie должен быть установлен');

  const me = await request(app).get('/api/auth/me').set(auth(res.body.accessToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'new.user@example.com');
});

test('регистрация отклоняет роль admin, дубликат email и слабый пароль', async () => {
  const escalation = await request(app).post('/api/auth/register').send({
    name: 'Взломщик',
    email: 'escalation@example.com',
    password: 'Hacker123',
    role: 'admin'
  });
  assert.equal(escalation.status, 422);

  const weak = await request(app).post('/api/auth/register').send({
    name: 'Слабый пароль',
    email: 'weak@example.com',
    password: '12345678'
  });
  assert.equal(weak.status, 422);

  const first = await request(app).post('/api/auth/register').send({
    name: 'Первый',
    email: 'duplicate@example.com',
    password: 'Duplicate123'
  });
  assert.equal(first.status, 201);

  const duplicate = await request(app).post('/api/auth/register').send({
    name: 'Второй',
    email: 'duplicate@example.com',
    password: 'Duplicate123'
  });
  assert.equal(duplicate.status, 409);
});

test('refresh ротирует ключи, повторное использование старого ключа отзывает сессии', async () => {
  const agent = request.agent(app);
  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'User123!' });

  const oldRefreshCookie = refreshCookieFrom(loginRes);
  assert.ok(oldRefreshCookie);

  const firstRefresh = await agent.post('/api/auth/refresh');
  assert.equal(firstRefresh.status, 200);
  const rotatedAccessToken = firstRefresh.body.accessToken;

  const reuse = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', oldRefreshCookie);

  assert.equal(reuse.status, 401);
  assert.match(reuse.body.detail, /повторное использование/i);

  const me = await request(app)
    .get('/api/auth/me')
    .set(auth(rotatedAccessToken));
  assert.equal(me.status, 401, 'при компрометации отзываются все сессии');
});

test('logout завершает сессию и очищает refresh-cookie', async () => {
  const agent = request.agent(app);
  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'User123!' });
  const token = loginRes.body.accessToken;

  const logout = await agent.post('/api/auth/logout');
  assert.equal(logout.status, 204);
  assert.match(logout.headers['set-cookie'][0], /refresh_token=;/);

  const me = await request(app).get('/api/auth/me').set(auth(token));
  assert.equal(me.status, 401);

  const refresh = await agent.post('/api/auth/refresh');
  assert.equal(refresh.status, 401);
});

test('пользователь видит и отзывает свои подключения', async () => {
  const first = await login(app, 'user@example.com', 'User123!');
  const second = await login(app, 'user@example.com', 'User123!');

  const sessions = await request(app)
    .get('/api/auth/sessions')
    .set(auth(second.body.accessToken));

  assert.equal(sessions.status, 200);
  assert.ok(sessions.body.length >= 2);

  const other = sessions.body.find((session) => session.id !== second.body.sessionId);
  const revoke = await request(app)
    .delete(`/api/auth/sessions/${other.id}`)
    .set(auth(second.body.accessToken));
  assert.equal(revoke.status, 204);

  const revoked = await request(app).get('/api/auth/me').set(auth(first.body.accessToken));
  assert.equal(revoked.status, 401);

  const current = await request(app).get('/api/auth/me').set(auth(second.body.accessToken));
  assert.equal(current.status, 200);
});

test('смена пароля отзывает другие сессии', async () => {
  const first = await login(app, 'user@example.com', 'User123!');
  const second = await login(app, 'user@example.com', 'User123!');

  const change = await request(app)
    .post('/api/auth/change-password')
    .set(auth(second.body.accessToken))
    .send({ currentPassword: 'User123!', newPassword: 'NewPass123!' });

  assert.equal(change.status, 204);

  const oldSession = await request(app).get('/api/auth/me').set(auth(first.body.accessToken));
  assert.equal(oldSession.status, 401);

  const oldLogin = await login(app, 'user@example.com', 'User123!');
  assert.equal(oldLogin.status, 401);

  const newLogin = await login(app, 'user@example.com', 'NewPass123!');
  assert.equal(newLogin.status, 200);
});

test('некорректный JSON возвращает 400, неверный Content-Type — 415', async () => {
  const badJson = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"email": ');

  assert.equal(badJson.status, 400);
  assert.match(badJson.body.detail, /JSON/);

  const wrongType = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'text/plain')
    .send('email=user@example.com');

  assert.equal(wrongType.status, 415);
});

test('неизвестный маршрут API возвращает 404 в формате problem+json', async () => {
  const res = await request(app).get('/api/unknown');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/problem\+json/);
});

test('запрос с недоверенного Origin отклоняется с 403', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', 'https://evil.example')
    .send({ email: 'user@example.com', password: 'User123!' });

  assert.equal(res.status, 403);
});

test('учётные данные не попадают в журнал аудита', async () => {
  await login(app, 'user@example.com', 'User123!');

  const rows = db.prepare('SELECT details FROM audit_log').all();
  for (const row of rows) {
    assert.ok(!String(row.details || '').includes('User123!'));
  }
});
