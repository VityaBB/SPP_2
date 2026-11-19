'use strict';

/**
 * Проверка входных данных задачи.
 *
 * Правила:
 *  - title   — строка 1..200 символов (обязательна при создании и PUT);
 *  - status  — одно из new | in_progress | done;
 *  - dueDate — null, пустая строка или реальная дата YYYY-MM-DD;
 *  - неизвестные поля запрещены.
 */

const STATUSES = Object.freeze(['new', 'in_progress', 'done']);
const STATUS_SET = new Set(STATUSES);
const TITLE_MAX = 200;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * @param {unknown} body тело запроса
 * @param {{partial?: boolean}} options partial=true — разрешено передать часть полей (PATCH)
 * @returns {{value: object|null, errors: Array<{field: string, message: string}>}}
 */
function validateTaskPayload(body, { partial = false } = {}) {
  const errors = [];

  if (!isPlainObject(body)) {
    return {
      value: null,
      errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом' }]
    };
  }

  const allowedFields = new Set(['title', 'status', 'dueDate']);
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) {
      errors.push({ field: key, message: `Неизвестное поле «${key}»` });
    }
  }

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
    if (typeof body.status !== 'string' || !STATUS_SET.has(body.status)) {
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

  if (partial && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: 'body',
      message: 'Нужно передать хотя бы одно поле: title, status или dueDate'
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
  TITLE_MAX,
  isPlainObject,
  isValidDate,
  validateTaskPayload,
  parseId
};
