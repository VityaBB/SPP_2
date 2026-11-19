'use strict';

const { unsupportedMediaType } = require('../errors');

function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    next(
      unsupportedMediaType(
        'Ожидается Content-Type: application/json. Тело запроса должно быть JSON-объектом'
      )
    );
    return;
  }
  next();
}

function requireMultipart(req, res, next) {
  if (!req.is('multipart/form-data')) {
    next(
      unsupportedMediaType(
        'Ожидается Content-Type: multipart/form-data. Файл передаётся в поле «file»'
      )
    );
    return;
  }
  next();
}

module.exports = { requireJson, requireMultipart };
