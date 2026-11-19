'use strict';

const { tooManyRequests } = require('../errors');

/**
 * Простой ограничитель частоты запросов (sliding window в памяти процесса).
 * Дополняет блокировку учётной записи после серии неверных паролей.
 */
function createRateLimiter({ windowMs, max, message, keyGenerator }) {
  const buckets = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 30_000));
  timer.unref();

  return function rateLimiter(req, res, next) {
    const key = keyGenerator ? keyGenerator(req) : req.ip;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const resetInSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(resetInSeconds));

    if (bucket.count > max) {
      next(
        tooManyRequests(
          message || 'Слишком много запросов. Попробуйте позже.',
          resetInSeconds
        )
      );
      return;
    }

    next();
  };
}

module.exports = { createRateLimiter };
