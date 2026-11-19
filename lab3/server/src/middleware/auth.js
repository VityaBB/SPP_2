'use strict';

const { findSessionByAccessToken } = require('../services/sessions');
const { unauthorized, forbidden } = require('../errors');

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{20,300})$/;

function parseBearer(req) {
  const header = req.get('authorization');
  if (!header) return null;

  const match = BEARER_RE.exec(String(header).trim());
  return match ? match[1] : null;
}

/**
 * Проверяет временный ключ доступа (access token) и подгружает сессию/пользователя.
 */
function authenticate(req, res, next) {
  try {
    const token = parseBearer(req);
    if (!token) {
      throw unauthorized('Не передан Bearer-токен доступа');
    }

    const found = findSessionByAccessToken(token);
    if (!found) {
      throw unauthorized('Временный ключ доступа недействителен или истёк');
    }

    req.accessToken = token;
    req.user = found.user;
    req.session = found.session;
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      next(unauthorized());
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(forbidden(`Операция доступна только ролям: ${roles.join(', ')}`));
      return;
    }

    next();
  };
}

module.exports = { authenticate, requireRole, parseBearer };
