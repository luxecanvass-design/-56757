/**
 * Вход по телефону через вашего Telegram-бота (бесплатно).
 *
 * Сценарий:
 *  1) сайт создаёт сессию по номеру → ссылка t.me/Bot?start=cXXXX
 *  2) пользователь жмёт Start в боте → chat привязывается к сессии
 *  3) на сайте «Отправить код» → бот шлёт 4 цифры
 *  4) ввод кода на сайте → регистрация / вход
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');
const { normalizePhone } = require('./sms');

const FILE = path.join(DATA_DIR, 'otp-codes.json');
const TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 40 * 1000;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || { byPhone: {}, bySession: {} }; }
  catch (_) { return { byPhone: {}, bySession: {} }; }
}
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function genCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
function genSession() {
  return crypto.randomBytes(4).toString('hex');
}

function botToken() {
  return String(
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.API_TOKEN ||
    ''
  ).trim();
}

async function resolveBotUsername() {
  const cached = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  if (cached) return cached;
  const token = botToken();
  if (!token) return '';
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = await r.json().catch(() => ({}));
    const u = (d.result && d.result.username) || '';
    if (u) process.env.TELEGRAM_BOT_USERNAME = u;
    return u;
  } catch (_) {
    return '';
  }
}

async function botDeepLink(session) {
  const u = await resolveBotUsername();
  if (!u) return '';
  return `https://t.me/${u}?start=c${session}`;
}

async function sendCodeToChat(chatId, code) {
  const token = botToken();
  if (!token || !chatId) return false;
  const text = [
    '<b>Код для входа в Luxe Canvas</b>',
    '',
    `<code>${code}</code>`,
    '',
    'Введите его на сайте. Никому не сообщайте код.'
  ].join('\n');
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      })
    });
    const data = await r.json().catch(() => ({}));
    return !!(data && data.ok);
  } catch (e) {
    console.error('OTP bot send:', e.message);
    return false;
  }
}

function findChatByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return '';
  try {
    const { findByPhone } = require('./auth');
    const { findLinkByUser } = require('./tg-users');
    const user = findByPhone(p);
    if (user) {
      const link = findLinkByUser(user.id, user.email);
      if (link && link.chatId) return String(link.chatId);
    }
  } catch (_) {}
  const data = load();
  const row = data.byPhone && data.byPhone[p];
  if (row && row.chatId) return String(row.chatId);
  return '';
}

function getRow(phone) {
  const data = load();
  return (data.byPhone && data.byPhone[phone]) || null;
}

/**
 * Шаг 1: создать сессию по номеру, отдать ссылку на бота.
 * Код ещё НЕ отправляем.
 */
async function startPhoneAuth(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw Object.assign(new Error('Введите номер +7…'), { status: 400 });
  if (!botToken()) {
    throw Object.assign(new Error('Бот не настроен (TELEGRAM_BOT_TOKEN)'), { status: 503 });
  }

  const data = load();
  if (!data.byPhone) data.byPhone = {};
  if (!data.bySession) data.bySession = {};

  const prev = data.byPhone[phone];
  if (prev && prev.session && data.bySession[prev.session]) {
    delete data.bySession[prev.session];
  }

  const code = genCode();
  const session = genSession();
  const knownChat = findChatByPhone(phone) || (prev && prev.chatId) || null;

  data.byPhone[phone] = {
    code,
    session,
    attempts: 0,
    sentAt: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    chatId: knownChat,
    linked: !!knownChat,
    delivered: false,
    via: null
  };
  data.bySession[session] = phone;
  save(data);

  const bot = await resolveBotUsername();
  const deepLink = await botDeepLink(session);

  return {
    ok: true,
    phone,
    session,
    ttl: Math.floor(TTL_MS / 1000),
    digits: 4,
    bot: bot || '',
    deepLink: deepLink || (bot ? `https://t.me/${bot}` : ''),
    linked: !!knownChat,
    needOpenBot: !knownChat,
    via: 'telegram-bot'
  };
}

/**
 * Бот: /start cSESSION — только привязать chat, код не слать.
 */
async function linkOtpSession(session, chatId) {
  const sid = String(session || '').replace(/^c/i, '').trim().toLowerCase();
  if (!sid) return { ok: false, error: 'Сессия не найдена' };

  const data = load();
  const phone = data.bySession && data.bySession[sid];
  if (!phone) return { ok: false, error: 'Код устарел — вернитесь на сайт и начните снова' };

  const row = data.byPhone[phone];
  if (!row || Date.now() > row.expiresAt) {
    return { ok: false, error: 'Сессия истекла — начните вход на сайте заново' };
  }

  row.chatId = String(chatId);
  row.linked = true;
  save(data);
  return { ok: true, phone, linked: true };
}

/** Совместимость со старым именем в боте */
async function deliverOtpBySession(session, chatId) {
  return linkOtpSession(session, chatId);
}

/**
 * Шаг 3: отправить код в уже привязанный чат.
 */
async function sendPhoneCode(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw Object.assign(new Error('Введите номер +7…'), { status: 400 });

  const data = load();
  const row = data.byPhone && data.byPhone[phone];
  if (!row) {
    throw Object.assign(new Error('Сначала укажите номер на сайте'), { status: 400 });
  }
  if (Date.now() > row.expiresAt) {
    throw Object.assign(new Error('Сессия истекла — начните снова'), { status: 400 });
  }
  if (row.sentAt && Date.now() - row.sentAt < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - row.sentAt)) / 1000);
    throw Object.assign(new Error(`Подождите ${wait} с`), { status: 429 });
  }

  let chatId = row.chatId || findChatByPhone(phone);
  if (!chatId) {
    throw Object.assign(
      new Error('Сначала откройте бота по кнопке и нажмите Start'),
      { status: 409, needOpenBot: true }
    );
  }

  /* новый код на каждую отправку */
  row.code = genCode();
  row.attempts = 0;
  const sent = await sendCodeToChat(chatId, row.code);
  if (!sent) {
    throw Object.assign(new Error('Не удалось отправить код в Telegram'), { status: 502 });
  }

  row.chatId = String(chatId);
  row.linked = true;
  row.delivered = true;
  row.sentAt = Date.now();
  row.via = 'telegram-bot';
  row.expiresAt = Date.now() + TTL_MS;
  save(data);

  const out = {
    ok: true,
    phone,
    delivered: true,
    linked: true,
    via: 'telegram-bot',
    ttl: Math.floor(TTL_MS / 1000)
  };
  if (process.env.SMS_DEV === '1' || process.env.SMS_DEV === 'true') {
    out.devCode = row.code;
    console.log(`[OTP DEV] +${phone} → ${row.code}`);
  }
  return out;
}

/** Статус: открыл ли пользователь бота */
function phoneAuthStatus(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, linked: false };
  const row = getRow(phone);
  if (!row || Date.now() > row.expiresAt) {
    return { ok: false, linked: false, expired: true };
  }
  return {
    ok: true,
    linked: !!(row.linked && row.chatId),
    delivered: !!row.delivered,
    phone
  };
}

function verifyOtp(rawPhone, rawCode) {
  const phone = normalizePhone(rawPhone);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!phone) throw Object.assign(new Error('Некорректный номер'), { status: 400 });
  if (code.length !== 4) throw Object.assign(new Error('Введите 4 цифры кода'), { status: 400 });

  const data = load();
  const row = data.byPhone && data.byPhone[phone];
  if (!row) throw Object.assign(new Error('Сначала запросите код'), { status: 400 });
  if (Date.now() > row.expiresAt) {
    if (row.session && data.bySession) delete data.bySession[row.session];
    delete data.byPhone[phone];
    save(data);
    throw Object.assign(new Error('Код истёк — запросите новый'), { status: 400 });
  }
  if (!row.delivered) {
    throw Object.assign(new Error('Сначала нажмите «Отправить код»'), { status: 400 });
  }
  row.attempts = (row.attempts || 0) + 1;
  if (row.attempts > 5) {
    if (row.session && data.bySession) delete data.bySession[row.session];
    delete data.byPhone[phone];
    save(data);
    throw Object.assign(new Error('Слишком много попыток — запросите новый код'), { status: 429 });
  }
  if (row.code !== code) {
    save(data);
    throw Object.assign(new Error('Неверный код'), { status: 400, wrong: true });
  }

  const chatId = row.chatId || null;
  if (row.session && data.bySession) delete data.bySession[row.session];
  delete data.byPhone[phone];
  save(data);

  return { phone, ok: true, chatId };
}

/** @deprecated старое имя — теперь start + send */
async function requestOtp(rawPhone) {
  return startPhoneAuth(rawPhone);
}

module.exports = {
  startPhoneAuth,
  sendPhoneCode,
  phoneAuthStatus,
  linkOtpSession,
  deliverOtpBySession,
  verifyOtp,
  requestOtp,
  FILE
};
