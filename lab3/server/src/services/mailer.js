'use strict';

const nodemailer = require('nodemailer');

const config = require('../config');
const { logger } = require('./../logger');
const { HttpError } = require('../errors');

let transporter = null;
const outbox = [];

function createTransport() {
  if (config.smtp.host) {
    return nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    });
  }

  // Без SMTP письма не теряются: они попадают в структурированный лог.
  return nodemailer.createTransport({ jsonTransport: true });
}

function getTransporter() {
  if (!transporter) transporter = createTransport();
  return transporter;
}

function resetTransport() {
  transporter = null;
}

async function sendMail({ to, subject, text }) {
  const message = {
    from: config.smtp.from,
    to,
    subject,
    text
  };

  const info = await getTransporter().sendMail(message);

  outbox.push({
    to,
    subject,
    text,
    messageId: info.messageId,
    at: new Date().toISOString()
  });

  if (config.smtp.host) {
    logger.info('mail.sent', { to, subject, messageId: info.messageId });
  } else {
    logger.info('mail.dev_outbox', { to, subject, text });
  }

  return info;
}

function resetPasswordEmail({ email, name, token }) {
  const link = `${config.appOrigin}/#/reset-password?token=${encodeURIComponent(token)}`;

  return {
    to: email,
    subject: 'Восстановление доступа к «Списку задач»',
    text: [
      `Здравствуйте, ${name}!`,
      '',
      'Для восстановления доступа к приложению перейдите по ссылке:',
      link,
      '',
      `Ссылка действует ${Math.round(config.auth.resetTtlMs / 60000)} мин и может быть использована один раз.`,
      'Если вы не запрашивали восстановление, просто проигнорируйте письмо.'
    ].join('\n')
  };
}

async function sendPasswordResetEmail(options) {
  try {
    await sendMail(resetPasswordEmail(options));
  } catch (error) {
    logger.error('mail.send_failed', { to: options.email, error });
    throw new HttpError(502, 'Не удалось отправить письмо', {
      detail: 'Почтовый сервис временно недоступен, попробуйте позже',
      expose: true
    });
  }
}

function getOutbox() {
  return outbox.slice();
}

function clearOutbox() {
  outbox.length = 0;
}

module.exports = {
  sendMail,
  sendPasswordResetEmail,
  getOutbox,
  clearOutbox,
  resetTransport
};
