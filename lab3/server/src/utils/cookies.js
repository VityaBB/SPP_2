'use strict';

const config = require('../config');

const REFRESH_COOKIE = 'refresh_token';

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};

  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (!name) continue;

    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

function readCookie(req, name) {
  return parseCookies(req)[name] || null;
}

function refreshCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookie.secure,
    path: config.cookie.refreshPath,
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs })
  };
}

function setRefreshCookie(res, token, maxAgeMs) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(maxAgeMs));
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

module.exports = {
  REFRESH_COOKIE,
  parseCookies,
  readCookie,
  setRefreshCookie,
  clearRefreshCookie
};
