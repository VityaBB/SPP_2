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

let app;
let admin;
let manager;
let user;

before(async () => {
  app = createApp();
  admin = (await login(app, 'admin@example.com', 'Admin123!')).body;
  manager = (await login(app, 'manager@example.com', 'Manager123!')).body;
  user = (await login(app, 'user@example.com', 'User123!')).body;
});

beforeEach(async () => {
  resetDatabase();

  const freshAdmin = await login(app, 'admin@example.com', 'Admin123!');
  const freshManager = await login(app, 'manager@example.com', 'Manager123!');
  const freshUser = await login(app, 'user@example.com', 'User123!');

  admin = freshAdmin.body;
  manager = freshManager.body;
  user = freshUser.body;
});

async function createTask(token, body) {
  return request(app).post('/api/tasks').set(auth(token)).send(body);
}

test('роли: пользователь видит только свои задачи, менеджер — все', async () => {
  const userTask = await createTask(user.accessToken, { title: 'Задача пользователя' });
  const managerTask = await createTask(manager.accessToken, { title: 'Задача менеджера' });

  assert.equal(userTask.status, 201);
  assert.equal(managerTask.status, 201);

  const userList = await request(app).get('/api/tasks').set(auth(user.accessToken));
  assert.equal(userList.status, 200);
  assert.deepEqual(
    userList.body.map((task) => task.title),
    ['Задача пользователя']
  );

  const managerList = await request(app).get('/api/tasks').set(auth(manager.accessToken));
  assert.equal(managerList.status, 200);
  assert.equal(managerList.body.length, 2);

  const foreignGet = await request(app)
    .get(`/api/tasks/${managerTask.body.id}`)
    .set(auth(user.accessToken));
  assert.equal(foreignGet.status, 403);

  const allowedGet = await request(app)
    .get(`/api/tasks/${userTask.body.id}`)
    .set(auth(manager.accessToken));
  assert.equal(allowedGet.status, 200);

  const foreignDelete = await request(app)
    .delete(`/api/tasks/${managerTask.body.id}`)
    .set(auth(user.accessToken));
  assert.equal(foreignDelete.status, 403);

  const adminDelete = await request(app)
    .delete(`/api/tasks/${managerTask.body.id}`)
    .set(auth(admin.accessToken));
  assert.equal(adminDelete.status, 204);
});

test('назначение владельца задачи ограничено ролью', async () => {
  const foreignAssign = await createTask(user.accessToken, {
    title: 'Чужая задача',
    ownerId: manager.user.id
  });
  assert.equal(foreignAssign.status, 403);

  const managerAssign = await createTask(manager.accessToken, {
    title: 'Назначено пользователю',
    ownerId: user.user.id
  });
  assert.equal(managerAssign.status, 201);
  assert.equal(managerAssign.body.owner.email, 'user@example.com');

  const missingOwner = await createTask(admin.accessToken, {
    title: 'Несуществующий владелец',
    ownerId: 999999
  });
  assert.equal(missingOwner.status, 422);
  assert.equal(missingOwner.body.errors[0].field, 'ownerId');
});

test('административные маршруты защищены ролевой моделью', async () => {
  const asUser = await request(app).get('/api/users').set(auth(user.accessToken));
  assert.equal(asUser.status, 403);

  const asManager = await request(app).get('/api/users').set(auth(manager.accessToken));
  assert.equal(asManager.status, 403);

  const asAdmin = await request(app).get('/api/users').set(auth(admin.accessToken));
  assert.equal(asAdmin.status, 200);
});

test('администратор создаёт пользователей, блокирует и удаляет их', async () => {
  const email = uniqueEmail('created');
  const created = await request(app)
    .post('/api/users')
    .set(auth(admin.accessToken))
    .send({ email, name: 'Новый сотрудник', password: 'Pass1234!', role: 'user' });

  assert.equal(created.status, 201);
  assert.match(created.headers.location, /^\/api\/users\/\d+$/);
  assert.equal(created.body.role, 'user');

  const duplicate = await request(app)
    .post('/api/users')
    .set(auth(admin.accessToken))
    .send({ email, name: 'Дубликат', password: 'Pass1234!', role: 'user' });
  assert.equal(duplicate.status, 409);

  const weakPassword = await request(app)
    .post('/api/users')
    .set(auth(admin.accessToken))
    .send({ email: uniqueEmail('weak'), name: 'Слабый', password: '123', role: 'user' });
  assert.equal(weakPassword.status, 422);

  const badRole = await request(app)
    .post('/api/users')
    .set(auth(admin.accessToken))
    .send({ email: uniqueEmail('role'), name: 'Роль', password: 'Pass1234!', role: 'root' });
  assert.equal(badRole.status, 422);

  const blocked = await request(app)
    .patch(`/api/users/${created.body.id}`)
    .set(auth(admin.accessToken))
    .send({ isActive: false });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.isActive, false);

  const blockedLogin = await login(app, email, 'Pass1234!');
  assert.equal(blockedLogin.status, 403);

  const unblocked = await request(app)
    .patch(`/api/users/${created.body.id}`)
    .set(auth(admin.accessToken))
    .send({ isActive: true });
  assert.equal(unblocked.status, 200);

  const task = await createTask(admin.accessToken, {
    title: 'Задача нового сотрудника',
    ownerId: created.body.id
  });
  assert.equal(task.status, 201);

  const deleteWithTasks = await request(app)
    .delete(`/api/users/${created.body.id}`)
    .set(auth(admin.accessToken));
  assert.equal(deleteWithTasks.status, 409);

  await request(app)
    .delete(`/api/tasks/${task.body.id}`)
    .set(auth(admin.accessToken));

  const deleted = await request(app)
    .delete(`/api/users/${created.body.id}`)
    .set(auth(admin.accessToken));
  assert.equal(deleted.status, 204);

  const deleteSelf = await request(app)
    .delete(`/api/users/${admin.user.id}`)
    .set(auth(admin.accessToken));
  assert.equal(deleteSelf.status, 409);
});

test('валидация задачи возвращает 422 с перечнем полей', async () => {
  const emptyTitle = await createTask(user.accessToken, { title: '   ' });
  assert.equal(emptyTitle.status, 422);
  assert.equal(emptyTitle.body.errors[0].field, 'title');

  const badStatus = await createTask(user.accessToken, {
    title: 'Задача',
    status: 'unknown'
  });
  assert.equal(badStatus.status, 422);

  const badDate = await createTask(user.accessToken, {
    title: 'Задача',
    dueDate: '2026-02-31'
  });
  assert.equal(badDate.status, 422);

  const unknownField = await createTask(user.accessToken, {
    title: 'Задача',
    priority: 'high'
  });
  assert.equal(unknownField.status, 422);

  const task = await createTask(user.accessToken, { title: 'Задача для PATCH' });
  const patchEmpty = await request(app)
    .patch(`/api/tasks/${task.body.id}`)
    .set(auth(user.accessToken))
    .send({});
  assert.equal(patchEmpty.status, 422);
});

test('коды 400/404/405 для задач', async () => {
  const malformed = await request(app)
    .get('/api/tasks/not-a-number')
    .set(auth(user.accessToken));
  assert.equal(malformed.status, 400);

  const missing = await request(app).get('/api/tasks/999999').set(auth(user.accessToken));
  assert.equal(missing.status, 404);

  const wrongMethod = await request(app).delete('/api/tasks').set(auth(user.accessToken));
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.allow, /GET/);

  const wrongUserMethod = await request(app).patch('/api/users').set(auth(admin.accessToken));
  assert.equal(wrongUserMethod.status, 405);
});

test('файлы: загрузка, права доступа, типы и размеры', async () => {
  const task = await createTask(user.accessToken, { title: 'Задача с файлом' });
  const taskId = task.body.id;

  const uploaded = await request(app)
    .post(`/api/tasks/${taskId}/files`)
    .set(auth(user.accessToken))
    .attach('file', Buffer.from('hello world'), {
      filename: 'note.txt',
      contentType: 'text/plain'
    });

  assert.equal(uploaded.status, 201);
  assert.match(uploaded.headers.location, /^\/api\/tasks\/\d+\/files\/\d+$/);
  assert.equal(uploaded.body.originalName, 'note.txt');

  const download = await request(app)
    .get(`/api/tasks/${taskId}/files/${uploaded.body.id}/download`)
    .set(auth(admin.accessToken));
  assert.equal(download.status, 200);
  assert.match(download.headers['content-disposition'], /note\.txt/);

  const foreign = await request(app)
    .get(`/api/tasks/${taskId}/files`)
    .set(auth(manager.accessToken));
  assert.equal(foreign.status, 200, 'менеджер имеет доступ к любой задаче');

  const managerLogin = await login(app, 'user2@example.com', 'User123!');
  const forbidden = await request(app)
    .get(`/api/tasks/${taskId}/files`)
    .set(auth(managerLogin.body.accessToken));
  assert.equal(forbidden.status, 403);

  const badType = await request(app)
    .post(`/api/tasks/${taskId}/files`)
    .set(auth(user.accessToken))
    .attach('file', Buffer.from('MZ'), {
      filename: 'virus.exe',
      contentType: 'application/octet-stream'
    });
  assert.equal(badType.status, 415);

  const tooLarge = await request(app)
    .post(`/api/tasks/${taskId}/files`)
    .set(auth(user.accessToken))
    .attach('file', Buffer.alloc(5000), {
      filename: 'big.txt',
      contentType: 'text/plain'
    });
  assert.equal(tooLarge.status, 413);

  const noFile = await request(app)
    .post(`/api/tasks/${taskId}/files`)
    .set(auth(user.accessToken))
    .field('comment', 'без файла');
  assert.equal(noFile.status, 422);

  const notFoundTask = await request(app)
    .post('/api/tasks/999999/files')
    .set(auth(user.accessToken))
    .attach('file', Buffer.from('x'), {
      filename: 'x.txt',
      contentType: 'text/plain'
    });
  assert.equal(notFoundTask.status, 404);
});

test('администратор видит и отзывает активные подключения', async () => {
  const target = await login(app, 'user@example.com', 'User123!');

  const sessions = await request(app)
    .get('/api/sessions')
    .set(auth(admin.accessToken));
  assert.equal(sessions.status, 200);

  const targetSession = sessions.body.find(
    (session) => session.user.email === 'user@example.com'
  );
  assert.ok(targetSession);

  const revoked = await request(app)
    .delete(`/api/sessions/${targetSession.id}`)
    .set(auth(admin.accessToken));
  assert.equal(revoked.status, 204);

  const me = await request(app)
    .get('/api/auth/me')
    .set(auth(target.body.accessToken));
  assert.equal(me.status, 401);
});

test('журнал аудита доступен только администратору', async () => {
  const adminAudit = await request(app)
    .get('/api/audit?limit=10')
    .set(auth(admin.accessToken));
  assert.equal(adminAudit.status, 200);
  assert.ok(Array.isArray(adminAudit.body));
  assert.ok(adminAudit.body.some((item) => item.event === 'auth.login.success'));

  const managerAudit = await request(app)
    .get('/api/audit')
    .set(auth(manager.accessToken));
  assert.equal(managerAudit.status, 403);

  const badLimit = await request(app)
    .get('/api/audit?limit=1000')
    .set(auth(admin.accessToken));
  assert.equal(badLimit.status, 400);
});
