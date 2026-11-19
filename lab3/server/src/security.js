'use strict';

const crypto = require('node:crypto');

// Параметры scrypt подобраны так, чтобы одна проверка занимала десятки миллисекунд,
// но при этом не блокировала сервер на секунды.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

function deriveKey(password, salt, { N = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P } = {}) {
  return crypto.scryptSync(String(password), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEM
  });
}

/**
 * Формат хранения: scrypt$N$r$p$salt$hash (base64url).
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = deriveKey(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url')
  ].join('$');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 2 || r < 1 || p < 1) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }

  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEM
    });
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash = null;

/**
 * Хэш-заглушка: позволяет тратить одинаковое время на проверку пароля
 * даже для несуществующего пользователя (защита от перечисления аккаунтов).
 */
function getDummyHash() {
  if (!dummyHash) {
    dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
  }
  return dummyHash;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  getDummyHash,
  randomToken,
  hashToken
};
