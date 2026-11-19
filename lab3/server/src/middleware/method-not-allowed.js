'use strict';

const { methodNotAllowed } = require('../errors');

/**
 * Возвращает 405 с заголовком Allow для методов, не описанных в маршруте.
 * OPTIONS обрабатывается автоматически.
 */
function methodNotAllowedHandler(methods) {
  const allow = [...new Set([...methods, 'OPTIONS'])].join(', ');

  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', allow);
      res.status(204).end();
      return;
    }

    next(methodNotAllowed(methods));
  };
}

module.exports = { methodNotAllowedHandler };
