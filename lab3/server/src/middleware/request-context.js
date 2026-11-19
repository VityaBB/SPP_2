'use strict';

const crypto = require('node:crypto');

const { createLogger } = require('../logger');

const logger = createLogger();
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,100}$/;

/**
 * Присваивает каждому запросу идентификатор и пишет структурированный access-log.
 */
function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  req.log = logger.child({ requestId: req.id });

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields = {
      method: req.method,
      path: String(req.originalUrl || req.url).split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: req.ip,
      userId: req.user ? req.user.id : null
    };

    const userAgent = req.get('user-agent');
    if (userAgent) fields.userAgent = userAgent.slice(0, 200);

    if (req.originalUrl.startsWith('/api/health')) {
      req.log.debug('request', fields);
    } else if (res.statusCode >= 500) {
      req.log.error('request', fields);
    } else if (res.statusCode >= 400) {
      req.log.warn('request', fields);
    } else {
      req.log.info('request', fields);
    }
  });

  next();
}

module.exports = { requestContext };
