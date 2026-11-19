'use strict';

/**
 * Проверка всех входящих данных.
 * Функции возвращают { value, errors }, где errors — массив { field, message }.
 */

const config = require('./config');

const STATUSES = Object.freeze(['new', 'in_progress', 'done']);
const ROLES = Object.freeze(['admin', 'manager', 'user']);
const TITLE_MAX = 200;
const NAME_MAX = 100;
const EMAIL_MAX = 254;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkUnknownFields(body, allowed) {
  const allowedSet = new Set(allowed);
  const errors = [];

  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) {
      errors.push({ field: key, message: `Неизвестное поле «${key}»` });
    }
  }
  return errors;
}

function isValidDate(value) {
  const match = DATE_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * @returns {{ value: object|null, errors: Array<{field: string, message: string}> }}
 */
function validateTaskPayload(body, { partial = false } = {}) {
  const errors = [];

  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  errors.push(...checkUnknownFields(body, ['title', 'status', 'dueDate', 'ownerId']));

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const value = {};

  if (!partial || has('title')) {
    if (!has('title')) {
      errors.push({ field: 'title', message: 'Поле title обязательно' });
    } else if (typeof body.title !== 'string') {
      errors.push({ field: 'title', message: 'title должен быть строкой' });
    } else {
      const title = body.title.trim();
      if (title.length === 0) {
        errors.push({ field: 'title', message: 'title не может быть пустым' });
      } else if (title.length > TITLE_MAX) {
        errors.push({
          field: 'title',
          message: `title не должен превышать ${TITLE_MAX} символов`
        });
      } else {
        value.title = title;
      }
    }
  }

  if (has('status')) {
    if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
      errors.push({
        field: 'status',
        message: `status должен быть одним из: ${STATUSES.join(', ')}`
      });
    } else {
      value.status = body.status;
    }
  }

  if (has('dueDate')) {
    if (body.dueDate === null || body.dueDate === '') {
      value.dueDate = null;
    } else if (typeof body.dueDate !== 'string' || !isValidDate(body.dueDate)) {
      errors.push({
        field: 'dueDate',
        message: 'dueDate должен быть реальной датой в формате YYYY-MM-DD или null'
      });
    } else {
      value.dueDate = body.dueDate;
    }
  }

  if (has('ownerId')) {
    if (body.ownerId === null) {
      errors.push({ field: 'ownerId', message: 'ownerId не может быть null' });
    } else if (!Number.isSafeInteger(body.ownerId) || body.ownerId <= 0) {
      errors.push({
        field: 'ownerId',
        message: 'ownerId должен быть положительным целым числом'
      });
    } else {
      value.ownerId = body.ownerId;
    }
  }

  if (partial && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: 'body',
      message: 'Нужно передать хотя бы одно поле: title, status, dueDate или ownerId'
    });
  }

  return { value: errors.length === 0 ? value : null, errors };
}

function validateEmail(raw) {
  if (typeof raw !== 'string') {
    return { value: null, error: 'Email должен быть строкой' };
  }

  const value = raw.trim().toLowerCase();
  if (value.length === 0) return { value: null, error: 'Email не может быть пустым' };
  if (value.length > EMAIL_MAX) {
    return { value: null, error: `Email не должен превышать ${EMAIL_MAX} символов` };
  }
  if (!EMAIL_RE.test(value)) return { value: null, error: 'Некорректный email' };

  return { value, error: null };
}

function validateLoginPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['email', 'password']);
  const email = validateEmail(body.email);
  if (email.error) errors.push({ field: 'email', message: email.error });

  if (typeof body.password !== 'string' || body.password.length === 0) {
    errors.push({ field: 'password', message: 'Пароль обязателен' });
  } else if (body.password.length > config.auth.passwordMax) {
    errors.push({
      field: 'password',
      message: `Пароль не должен превышать ${config.auth.passwordMax} символов`
    });
  }

  return {
    value:
      errors.length === 0
        ? { email: email.value, password: body.password }
        : null,
    errors
  };
}

function passwordError(password) {
  if (typeof password !== 'string') return 'Пароль должен быть строкой';
  if (password.length < config.auth.passwordMin) {
    return `Пароль должен содержать не менее ${config.auth.passwordMin} символов`;
  }
  if (password.length > config.auth.passwordMax) {
    return `Пароль не должен превышать ${config.auth.passwordMax} символов`;
  }
  if (!/[A-Za-zА-Яа-яЁё]/.test(password) || !/\d/.test(password)) {
    return 'Пароль должен содержать хотя бы одну букву и одну цифру';
  }
  return null;
}

function validateForgotPasswordPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['email']);
  const email = validateEmail(body.email);
  if (email.error) errors.push({ field: 'email', message: email.error });

  return { value: errors.length === 0 ? { email: email.value } : null, errors };
}

function validateResetPasswordPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['token', 'newPassword']);

  if (typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 200) {
    errors.push({ field: 'token', message: 'Некорректный токен восстановления' });
  }

  const problem = passwordError(body.newPassword);
  if (problem) errors.push({ field: 'newPassword', message: problem });

  return {
    value:
      errors.length === 0
        ? { token: body.token, newPassword: body.newPassword }
        : null,
    errors
  };
}

function validateChangePasswordPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['currentPassword', 'newPassword']);

  if (typeof body.currentPassword !== 'string' || body.currentPassword.length === 0) {
    errors.push({ field: 'currentPassword', message: 'Текущий пароль обязателен' });
  }

  const problem = passwordError(body.newPassword);
  if (problem) errors.push({ field: 'newPassword', message: problem });

  return {
    value:
      errors.length === 0
        ? { currentPassword: body.currentPassword, newPassword: body.newPassword }
        : null,
    errors
  };
}

/**
 * Публичная регистрация: роль не принимается от клиента и всегда равна `user`.
 */
function validateRegisterPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['email', 'name', 'password']);
  const value = {};

  const email = validateEmail(body.email);
  if (email.error) errors.push({ field: 'email', message: email.error });
  else value.email = email.value;

  if (typeof body.name !== 'string') {
    errors.push({ field: 'name', message: 'Имя должно быть строкой' });
  } else {
    const name = body.name.trim();
    if (name.length === 0) {
      errors.push({ field: 'name', message: 'Имя не может быть пустым' });
    } else if (name.length > NAME_MAX) {
      errors.push({ field: 'name', message: `Имя не должно превышать ${NAME_MAX} символов` });
    } else {
      value.name = name;
    }
  }

  const problem = passwordError(body.password);
  if (problem) errors.push({ field: 'password', message: problem });
  else value.password = body.password;

  return { value: errors.length === 0 ? value : null, errors };
}

function validateCreateUserPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['email', 'name', 'password', 'role']);
  const value = {};

  const email = validateEmail(body.email);
  if (email.error) errors.push({ field: 'email', message: email.error });
  else value.email = email.value;

  if (typeof body.name !== 'string') {
    errors.push({ field: 'name', message: 'Имя должно быть строкой' });
  } else {
    const name = body.name.trim();
    if (name.length === 0) {
      errors.push({ field: 'name', message: 'Имя не может быть пустым' });
    } else if (name.length > NAME_MAX) {
      errors.push({ field: 'name', message: `Имя не должно превышать ${NAME_MAX} символов` });
    } else {
      value.name = name;
    }
  }

  const problem = passwordError(body.password);
  if (problem) errors.push({ field: 'password', message: problem });
  else value.password = body.password;

  if (body.role === undefined) {
    value.role = 'user';
  } else if (typeof body.role !== 'string' || !ROLES.includes(body.role)) {
    errors.push({ field: 'role', message: `role должен быть одним из: ${ROLES.join(', ')}` });
  } else {
    value.role = body.role;
  }

  return { value: errors.length === 0 ? value : null, errors };
}

function validateUpdateUserPayload(body) {
  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const errors = checkUnknownFields(body, ['name', 'role', 'isActive', 'password']);
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const value = {};

  if (has('name')) {
    if (typeof body.name !== 'string') {
      errors.push({ field: 'name', message: 'Имя должно быть строкой' });
    } else {
      const name = body.name.trim();
      if (name.length === 0) {
        errors.push({ field: 'name', message: 'Имя не может быть пустым' });
      } else if (name.length > NAME_MAX) {
        errors.push({
          field: 'name',
          message: `Имя не должно превышать ${NAME_MAX} символов`
        });
      } else {
        value.name = name;
      }
    }
  }

  if (has('role')) {
    if (typeof body.role !== 'string' || !ROLES.includes(body.role)) {
      errors.push({
        field: 'role',
        message: `role должен быть одним из: ${ROLES.join(', ')}`
      });
    } else {
      value.role = body.role;
    }
  }

  if (has('isActive')) {
    if (typeof body.isActive !== 'boolean') {
      errors.push({ field: 'isActive', message: 'isActive должен быть boolean' });
    } else {
      value.isActive = body.isActive;
    }
  }

  if (has('password')) {
    const problem = passwordError(body.password);
    if (problem) errors.push({ field: 'password', message: problem });
    else value.password = body.password;
  }

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: 'body',
      message: 'Нужно передать хотя бы одно поле: name, role, isActive или password'
    });
  }

  return { value: errors.length === 0 ? value : null, errors };
}

/**
 * Строгий разбор положительного целочисленного идентификатора.
 * @returns {number|null}
 */
function parseId(raw) {
  const value = String(raw);
  if (!/^\d+$/.test(value)) return null;

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = {
  STATUSES,
  ROLES,
  TITLE_MAX,
  NAME_MAX,
  EMAIL_MAX,
  isPlainObject,
  isValidDate,
  validateTaskPayload,
  validateLoginPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
  validateChangePasswordPayload,
  validateRegisterPayload,
  validateCreateUserPayload,
  validateUpdateUserPayload,
  parseId
};
