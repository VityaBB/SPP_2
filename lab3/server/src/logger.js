'use strict';

/**
 * Структурированное логирование: одна JSON-строка на событие.
 * Формат: {"time":"...","level":"info","msg":"request","requestId":"...","...":...}
 */

const config = require('./config');

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

const SENSITIVE_KEY = /^(password|currentPassword|newPassword|token|accessToken|refreshToken|authorization|cookie|secret|passwordHash)$/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack
  };
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return sanitize(serializeError(value), depth + 1);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[MaxDepth]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(item, depth + 1);
  }
  return result;
}

function normalizeLevel(level) {
  const value = String(level || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : 'info';
}

function createLogger(bindings = {}, level = config.logLevel) {
  const threshold = LEVELS[normalizeLevel(level)];

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;

    const record = {
      time: new Date().toISOString(),
      level: lvl,
      msg,
      ...sanitize(bindings)
    };

    if (fields && typeof fields === 'object') {
      Object.assign(record, sanitize(fields));
    }

    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        time: record.time,
        level: lvl,
        msg,
        logError: 'Не удалось сериализовать запись лога'
      });
    }

    process.stdout.write(`${line}\n`);
  }

  return {
    level: normalizeLevel(level),
    child(extra = {}) {
      return createLogger({ ...bindings, ...extra }, level);
    },
    debug(msg, fields) {
      write('debug', msg, fields);
    },
    info(msg, fields) {
      write('info', msg, fields);
    },
    warn(msg, fields) {
      write('warn', msg, fields);
    },
    error(msg, fields) {
      write('error', msg, fields);
    }
  };
}

const logger = createLogger();

module.exports = { createLogger, logger, sanitize, LEVELS };
