'use strict';

/**
 * Ошибки API в формате RFC 9457 «Problem Details for HTTP APIs».
 */

class HttpError extends Error {
  constructor(status, title, options = {}) {
    super(options.detail || title);
    this.name = 'HttpError';
    this.status = status;
    this.title = title;
    this.detail = options.detail;
    this.type = options.type || 'about:blank';
    this.headers = options.headers || {};
    this.errors = options.errors;
    this.retryAfter = options.retryAfter;
    this.expose = options.expose !== undefined ? options.expose : status < 500;
  }
}

function unauthorized(detail = 'Требуется аутентификация', errorCode = 'invalid_token') {
  return new HttpError(401, 'Не авторизован', {
    detail,
    headers: {
      'WWW-Authenticate': `Bearer realm="lab3-api", error="${errorCode}"`
    }
  });
}

function forbidden(detail = 'Недостаточно прав для выполнения операции') {
  return new HttpError(403, 'Доступ запрещён', { detail });
}

function notFound(detail = 'Ресурс не найден') {
  return new HttpError(404, 'Не найдено', { detail });
}

function conflict(detail) {
  return new HttpError(409, 'Конфликт', { detail });
}

function validationError(errors, detail = 'Данные не прошли проверку') {
  return new HttpError(422, 'Ошибка валидации', { detail, errors });
}

function badRequest(detail = 'Некорректный запрос') {
  return new HttpError(400, 'Некорректный запрос', { detail });
}

function unsupportedMediaType(detail) {
  return new HttpError(415, 'Неподдерживаемый тип данных', { detail });
}

function payloadTooLarge(detail) {
  return new HttpError(413, 'Слишком большой запрос', { detail });
}

function tooManyRequests(detail, retryAfterSeconds) {
  return new HttpError(429, 'Слишком много запросов', {
    detail,
    headers: retryAfterSeconds
      ? { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) }
      : {},
    retryAfter: retryAfterSeconds
  });
}

function methodNotAllowed(allowedMethods) {
  const allow = [...new Set([...allowedMethods, 'OPTIONS'])].join(', ');
  return new HttpError(405, 'Метод не разрешён', {
    detail: 'Этот HTTP-метод не поддерживается для указанного ресурса',
    headers: { Allow: allow }
  });
}

/**
 * Отправляет ошибку в формате application/problem+json.
 */
function sendProblem(req, res, error) {
  for (const [name, value] of Object.entries(error.headers || {})) {
    res.setHeader(name, value);
  }

  const body = {
    type: error.type || 'about:blank',
    title: error.title,
    status: error.status,
    detail: error.detail,
    instance: req.originalUrl,
    requestId: req.id
  };

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    body.errors = error.errors;
  }

  res.status(error.status).type('application/problem+json').json(body);
}

module.exports = {
  HttpError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  validationError,
  badRequest,
  unsupportedMediaType,
  payloadTooLarge,
  tooManyRequests,
  methodNotAllowed,
  sendProblem
};
