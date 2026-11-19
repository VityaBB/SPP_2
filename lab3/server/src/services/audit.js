'use strict';

const { db } = require('../db');
const { logger } = require('../logger');

function truncate(value, max = 300) {
  if (!value) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Записывает событие безопасности в журнал аудита и в структурированный лог.
 */
function audit(req, event, options = {}) {
  const entry = {
    event,
    userId: options.userId === undefined ? req?.user?.id ?? null : options.userId,
    email: options.email === undefined ? req?.user?.email ?? null : options.email,
    ip: req?.ip || null,
    userAgent: req?.get ? truncate(req.get('user-agent')) : null,
    requestId: req?.id || null,
    details: options.details || null
  };

  try {
    db.prepare(
      `INSERT INTO audit_log (at, event, user_id, email, ip, user_agent, request_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(),
      entry.event,
      entry.userId,
      entry.email,
      entry.ip,
      entry.userAgent,
      entry.requestId,
      entry.details ? JSON.stringify(entry.details) : null
    );
  } catch (error) {
    logger.error('audit.write_failed', { event, error });
  }

  const write =
    options.level === 'error'
      ? logger.error
      : options.level === 'warn'
        ? logger.warn
        : logger.info;

  write(`audit.${event}`, entry);
  return entry;
}

function serializeAuditRow(row) {
  let details = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details);
    } catch {
      details = row.details;
    }
  }

  return {
    id: row.id,
    at: row.at,
    event: row.event,
    userId: row.user_id,
    email: row.email,
    ip: row.ip,
    userAgent: row.user_agent,
    requestId: row.request_id,
    details
  };
}

function listAudit({ limit = 50, event, userId } = {}) {
  const clauses = [];
  const params = [];

  if (event) {
    clauses.push('event = ?');
    params.push(event);
  }

  if (userId) {
    clauses.push('user_id = ?');
    params.push(userId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  return db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params)
    .map(serializeAuditRow);
}

module.exports = { audit, listAudit };
