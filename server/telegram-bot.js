/**
 * Telegram-бот Luxe Canvas
 * — одно живое сообщение на экран/заказ (edit; при провале — delete + send)
 * — сообщения пользователя всегда удаляются
 * — владелец: карточка заказа с треком / статусом / «На сайт» (авто-админ)
 * — покупатель: карточка заказа (edit), пуш только «Доставлен»
 */
const fs = require('fs');
const path = require('path');
const { resolvePublicUrl, isValidPublicHttps } = require('./public-url');
const { claimOwner, getOwnerChatId, getOwnerChatIds, isOwnerChat } = require('./tg-owner');
const { tryLink, relinkUser, findChatForOrder } = require('./tg-users');
const { DATA_DIR } = require('./db');

const TOKEN = () => String(
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.API_TOKEN ||
  ''
).trim();

const SHOP_URL = () => resolvePublicUrl(process.env.PORT || 3000);
const MSGS_FILE = path.join(DATA_DIR, 'tg-shop-msgs.json');
const ORDER_MSGS_FILE = path.join(DATA_DIR, 'tg-order-msgs.json');
const OWNER_ORDER_MSGS_FILE = path.join(DATA_DIR, 'tg-owner-order-msgs.json');
const DELIVERED_FILE = path.join(DATA_DIR, 'tg-delivered.json');
const OWNER_NOTIFIED_FILE = path.join(DATA_DIR, 'tg-owner-notified.json');
const AWAIT_FILE = path.join(DATA_DIR, 'tg-await.json');
const SUPPORT_FILE = path.join(DATA_DIR, 'tg-support.json');

/** Кому слать запросы оператора (только этот чат). */
const SUPPORT_OPERATOR_CHAT = () =>
  String(process.env.TELEGRAM_SUPPORT_CHAT_ID || '8133757512').trim();

const WEBHOOK_SECRET = () =>
  String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.JWT_SECRET || 'luxe-canvas-tg').slice(0, 64);

const STATUS_CODE = {
  p: 'Ожидает оплаты',
  w: 'В обработке',
  e: 'Едет',
  d: 'Доставлен',
  c: 'Отменён',
  r: 'Возврат'
};

let BOT_USERNAME = '';

function api(method, body) {
  const token = TOKEN();
  if (!token) return Promise.reject(new Error('TELEGRAM_BOT_TOKEN missing'));
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      throw Object.assign(new Error(data.description || `Telegram ${method} failed`), { tg: data });
    }
    return data.result;
  });
}

function shopHttps() {
  const shop = SHOP_URL();
  if (!isValidPublicHttps(shop)) return '';
  return shop.replace(/\/$/, '');
}

function money(n) {
  return `${Math.round(+n || 0).toLocaleString('ru-RU')} ₽`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function urlBtn(text, url, style) {
  const btn = { text, url };
  if (style) btn.style = style;
  return btn;
}

function cbBtn(text, data, style) {
  const btn = { text, callback_data: String(data).slice(0, 64) };
  if (style) btn.style = style;
  return btn;
}

function withStyleFallback(markup) {
  return async (fn) => {
    try {
      return await fn(markup);
    } catch (e) {
      if (!markup || !markup.inline_keyboard) throw e;
      const stripped = JSON.parse(JSON.stringify(markup));
      for (const row of stripped.inline_keyboard || []) {
        for (const b of row) delete b.style;
      }
      return await fn(stripped);
    }
  };
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; } catch (_) { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getMainMsgId(chatId) {
  const m = loadJson(MSGS_FILE, {});
  const v = m[String(chatId)];
  if (v == null) return null;
  if (typeof v === 'number') return v;
  return v.messageId || null;
}
function setMainMsgId(chatId, messageId) {
  const m = loadJson(MSGS_FILE, {});
  m[String(chatId)] = { messageId };
  saveJson(MSGS_FILE, m);
}
function clearMainMsgId(chatId) {
  const m = loadJson(MSGS_FILE, {});
  delete m[String(chatId)];
  saveJson(MSGS_FILE, m);
}

function getOrderMsgId(chatId, orderNum) {
  const m = loadJson(ORDER_MSGS_FILE, {});
  return (m[String(chatId)] || {})[String(orderNum)] || null;
}
function setOrderMsgId(chatId, orderNum, messageId) {
  const m = loadJson(ORDER_MSGS_FILE, {});
  const key = String(chatId);
  if (!m[key]) m[key] = {};
  m[key][String(orderNum)] = messageId;
  saveJson(ORDER_MSGS_FILE, m);
}

function getOwnerOrderMsgId(chatId, orderNum) {
  const m = loadJson(OWNER_ORDER_MSGS_FILE, {});
  const byChat = m[String(chatId)];
  if (byChat && typeof byChat === 'object') return byChat[String(orderNum)] || null;
  /* старый формат: { orderNum: messageId } */
  if (m[String(orderNum)] && typeof m[String(orderNum)] !== 'object') {
    return m[String(orderNum)] || null;
  }
  return null;
}
function setOwnerOrderMsgId(chatId, orderNum, messageId) {
  const m = loadJson(OWNER_ORDER_MSGS_FILE, {});
  const key = String(chatId);
  if (!m[key] || typeof m[key] !== 'object') m[key] = {};
  m[key][String(orderNum)] = messageId;
  saveJson(OWNER_ORDER_MSGS_FILE, m);
}

function wasDeliveredPushed(orderNum) {
  return !!loadJson(DELIVERED_FILE, {})[String(orderNum)];
}
function markDeliveredPushed(orderNum) {
  const m = loadJson(DELIVERED_FILE, {});
  m[String(orderNum)] = new Date().toISOString();
  saveJson(DELIVERED_FILE, m);
}

function wasOwnerNotified(orderNum) {
  return !!loadJson(OWNER_NOTIFIED_FILE, {})[String(orderNum)];
}
function markOwnerNotified(orderNum) {
  const m = loadJson(OWNER_NOTIFIED_FILE, {});
  m[String(orderNum)] = new Date().toISOString();
  saveJson(OWNER_NOTIFIED_FILE, m);
}

function getAwait(chatId) {
  return loadJson(AWAIT_FILE, {})[String(chatId)] || null;
}
function setAwait(chatId, data) {
  const m = loadJson(AWAIT_FILE, {});
  if (data) m[String(chatId)] = data;
  else delete m[String(chatId)];
  saveJson(AWAIT_FILE, m);
}

/* ===================== ПОДДЕРЖКА (оператор) ===================== */

function loadSupportMap() {
  return loadJson(SUPPORT_FILE, {});
}
function saveSupportMap(m) {
  saveJson(SUPPORT_FILE, m);
}
function getSupport(userChatId) {
  return loadSupportMap()[String(userChatId)] || null;
}
function setSupport(userChatId, data) {
  const m = loadSupportMap();
  if (data) m[String(userChatId)] = data;
  else delete m[String(userChatId)];
  saveSupportMap(m);
}
function findActiveSupportForOperator(opChatId) {
  const m = loadSupportMap();
  const id = String(opChatId);
  for (const s of Object.values(m)) {
    if (s && s.status === 'active' && String(s.operatorChatId) === id) return s;
  }
  return null;
}
function trackSupportMsg(session, side, messageId) {
  if (!session || !messageId) return;
  const key = side === 'op' ? 'opMsgs' : 'userMsgs';
  if (!Array.isArray(session[key])) session[key] = [];
  session[key].push(Number(messageId));
}

async function wipeSupportMessages(session) {
  if (!session) return;
  const userId = session.userChatId;
  const opId = session.operatorChatId;
  for (const mid of session.userMsgs || []) {
    await safeDelete(userId, mid);
  }
  if (opId) {
    for (const mid of session.opMsgs || []) {
      await safeDelete(opId, mid);
    }
  }
  for (const [cid, mid] of Object.entries(session.notifyMsgIds || {})) {
    await safeDelete(cid, mid);
  }
}

async function startSupportRequest(chatId, from = {}) {
  if (isOwnerChat(chatId) || String(chatId) === SUPPORT_OPERATOR_CHAT()) {
    await sendWithMarkupFallback(chatId, {
      text: 'Это чат админа. Запросы оператора приходят сюда автоматически.'
    });
    return;
  }

  const existing = getSupport(chatId);
  if (existing && (existing.status === 'waiting' || existing.status === 'active')) {
    await sendWithMarkupFallback(chatId, {
      text: existing.status === 'active'
        ? 'Диалог уже открыт — напишите ваш вопрос.'
        : 'Запрос уже отправлен. Оператор скоро ответит — напишите вопрос.',
      reply_markup: existing.status === 'waiting'
        ? { inline_keyboard: [[cbBtn('Отменить', 'sup:cancel')]] }
        : undefined
    });
    return;
  }

  const who = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || 'Покупатель';
  const uname = from.username ? '@' + from.username : '';

  const waitMsg = await sendWithMarkupFallback(chatId, {
    text: [
      '<b>Нужен оператор</b>',
      '',
      'В скором времени вам ответит оператор.',
      'Напишите ваш вопрос.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[cbBtn('Отменить', 'sup:cancel')]]
    }
  });

  const session = {
    status: 'waiting',
    userChatId: String(chatId),
    fromName: who,
    fromUsername: from.username || '',
    operatorChatId: null,
    userMsgs: waitMsg && waitMsg.message_id ? [waitMsg.message_id] : [],
    opMsgs: [],
    pendingTexts: [],
    notifyMsgIds: {},
    panelMsgId: null,
    createdAt: Date.now()
  };
  setSupport(chatId, session);

  const opId = SUPPORT_OPERATOR_CHAT();
  try {
    const n = await sendWithMarkupFallback(opId, {
      text: [
        '<b>Запрос оператора</b>',
        '',
        escHtml(who) + (uname ? ` · ${escHtml(uname)}` : ''),
        `Чат: <code>${chatId}</code>`,
        '',
        'Нажмите «Открыть», чтобы начать диалог.'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[cbBtn('Открыть', `sup:open:${chatId}`, 'success')]]
      }
    });
    if (n && n.message_id) {
      session.notifyMsgIds[String(opId)] = n.message_id;
      session.opMsgs.push(n.message_id);
      setSupport(chatId, session);
    }
  } catch (e) {
    console.error('TG support notify:', e.message);
    try {
      await sendWithMarkupFallback(chatId, {
        text: 'Не удалось связаться с оператором. Попробуйте позже.'
      });
    } catch (_) {}
  }
}

async function cancelSupportRequest(userChatId) {
  const session = getSupport(userChatId);
  if (!session) return false;
  if (session.status === 'active') return false;

  for (const [cid, mid] of Object.entries(session.notifyMsgIds || {})) {
    await safeDelete(cid, mid);
  }
  await wipeSupportMessages(session);
  setSupport(userChatId, null);

  try {
    await sendWithMarkupFallback(userChatId, {
      text: 'Запрос оператора отменён.'
    });
  } catch (_) {}
  return true;
}

async function openSupportDialog(opChatId, userChatId, notifyMsgId) {
  const session = getSupport(userChatId);
  if (!session || session.status !== 'waiting') {
    return { ok: false, error: 'Запрос уже закрыт или принят' };
  }

  for (const [cid, mid] of Object.entries(session.notifyMsgIds || {})) {
    await safeDelete(cid, mid);
  }
  if (notifyMsgId) await safeDelete(opChatId, notifyMsgId);
  session.notifyMsgIds = {};
  session.opMsgs = (session.opMsgs || []).filter((id) => id !== notifyMsgId);

  session.status = 'active';
  session.operatorChatId = String(opChatId);

  /* убрать кнопку «Отменить» у клиента */
  if (session.userMsgs && session.userMsgs[0]) {
    try {
      await api('editMessageReplyMarkup', {
        chat_id: userChatId,
        message_id: session.userMsgs[0],
        reply_markup: { inline_keyboard: [] }
      });
    } catch (_) {}
  }

  const hello = await sendWithMarkupFallback(userChatId, { text: 'Здравствуйте!' });
  trackSupportMsg(session, 'user', hello && hello.message_id);

  for (const t of session.pendingTexts || []) {
    const m = await sendWithMarkupFallback(opChatId, {
      text: `<b>Клиент:</b>\n${escHtml(t)}`
    });
    trackSupportMsg(session, 'op', m && m.message_id);
  }
  session.pendingTexts = [];

  const panel = await sendWithMarkupFallback(opChatId, {
    text: [
      '<b>Диалог открыт</b>',
      escHtml(session.fromName) + (session.fromUsername ? ` · @${escHtml(session.fromUsername)}` : ''),
      '',
      'Пишите сюда — сообщения уйдут клиенту.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[cbBtn('Закрыть диалог', `sup:close:${userChatId}`, 'danger')]]
    }
  });
  session.panelMsgId = panel && panel.message_id;
  trackSupportMsg(session, 'op', session.panelMsgId);
  setSupport(userChatId, session);
  return { ok: true };
}

async function closeSupportDialog(userChatId) {
  const session = getSupport(userChatId);
  if (!session) return false;

  session.status = 'closing';
  setSupport(userChatId, session);

  let closeMsgId = null;
  try {
    const note = await sendWithMarkupFallback(userChatId, {
      text: 'Оператор закрыл диалог.'
    });
    closeMsgId = note && note.message_id;
  } catch (_) {}

  const snapshot = { ...session, userMsgs: [...(session.userMsgs || [])], opMsgs: [...(session.opMsgs || [])] };
  if (closeMsgId) snapshot.userMsgs.push(closeMsgId);

  setTimeout(() => {
    wipeSupportMessages(snapshot).then(() => {
      setSupport(userChatId, null);
    }).catch(() => {
      setSupport(userChatId, null);
    });
  }, 5000);

  return true;
}

/** Сообщения клиента в режиме поддержки. */
async function handleSupportUserMessage(msg) {
  const chatId = msg.chat.id;
  const session = getSupport(chatId);
  if (!session || (session.status !== 'waiting' && session.status !== 'active')) return false;

  const text = String(msg.text || msg.caption || '').trim();
  if (!text || /^\/start\b/i.test(text)) return false;

  trackSupportMsg(session, 'user', msg.message_id);

  if (session.status === 'waiting') {
    session.pendingTexts = session.pendingTexts || [];
    session.pendingTexts.push(text.slice(0, 3500));
    setSupport(chatId, session);
    /* обновим карточку у оператора, если есть */
    const opId = SUPPORT_OPERATOR_CHAT();
    const notifyId = session.notifyMsgIds && session.notifyMsgIds[String(opId)];
    if (notifyId) {
      try {
        await api('editMessageText', {
          chat_id: opId,
          message_id: notifyId,
          text: [
            '<b>Запрос оператора</b>',
            '',
            escHtml(session.fromName) + (session.fromUsername ? ` · @${escHtml(session.fromUsername)}` : ''),
            `Чат: <code>${chatId}</code>`,
            '',
            `<b>Вопрос:</b> ${escHtml(text.slice(0, 500))}`,
            '',
            'Нажмите «Открыть», чтобы начать диалог.'
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Открыть', callback_data: `sup:open:${chatId}` }]]
          }
        });
      } catch (_) {}
    }
    return true;
  }

  /* active — пересылаем оператору */
  const opId = session.operatorChatId;
  if (!opId) return true;
  try {
    const m = await sendWithMarkupFallback(opId, {
      text: `<b>Клиент:</b>\n${escHtml(text)}`
    });
    trackSupportMsg(session, 'op', m && m.message_id);
    setSupport(chatId, session);
  } catch (e) {
    console.error('TG support relay→op:', e.message);
  }
  return true;
}

/** Сообщения оператора в активном диалоге. */
async function handleSupportOperatorMessage(msg) {
  const chatId = msg.chat.id;
  if (String(chatId) !== SUPPORT_OPERATOR_CHAT() && !isOwnerChat(chatId)) return false;

  const session = findActiveSupportForOperator(chatId);
  if (!session) return false;

  const text = String(msg.text || msg.caption || '').trim();
  if (!text || /^\/start\b/i.test(text)) return false;

  trackSupportMsg(session, 'op', msg.message_id);

  try {
    const m = await sendWithMarkupFallback(session.userChatId, {
      text: escHtml(text)
    });
    trackSupportMsg(session, 'user', m && m.message_id);
    setSupport(session.userChatId, session);
  } catch (e) {
    console.error('TG support relay→user:', e.message);
  }
  return true;
}

async function safeDelete(chatId, messageId) {
  if (!messageId) return;
  try {
    await api('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (_) {}
}

/** URL сайта: для владельца — авто-вход админа (короткий код, не огромный JWT в кнопке). */
function siteUrl(chatId, opts = {}) {
  const shop = shopHttps();
  if (!shop) return '';
  const q = new URLSearchParams();
  if (isOwnerChat(chatId)) {
    try {
      const { issueTgAdminToken } = require('./auth');
      /* короткий одноразовый код вместо длинного JWT в URL-кнопке Telegram */
      const full = issueTgAdminToken(chatId);
      const code = require('crypto').randomBytes(16).toString('hex');
      const { DATA_DIR } = require('./db');
      const fs = require('fs');
      const path = require('path');
      const file = path.join(DATA_DIR, 'tg-admin-codes.json');
      let map = {};
      try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
      map[code] = { token: full, at: Date.now(), exp: Date.now() + 10 * 60 * 1000 };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(map), 'utf8');
      q.set('tg_admin', code);
    } catch (_) {
      q.set('from', 'tg');
    }
  } else {
    q.set('from', 'tg');
  }
  if (opts.go) q.set('go', opts.go);
  const hash = opts.hash ? (opts.hash.startsWith('#') ? opts.hash : '#' + opts.hash) : '';
  return `${shop}/?${q.toString()}${hash}`;
}

function etaText() {
  try {
    const { getCms } = require('./orders');
    return String((getCms().shipping && getCms().shipping.pickupDays) || '2–5 дней');
  } catch (_) {
    return '2–5 дней';
  }
}

function welcomeText() {
  const shop = shopHttps();
  return [
    '<b>Добро пожаловать в Luxe Canvas</b>',
    '',
    'Одежда, в которой хочется жить каждый день.',
    '',
    'Чтобы войти или зарегистрироваться — нажмите «Поделиться контактом».',
    shop ? 'Или откройте сайт кнопкой ниже.' : 'Ссылка на сайт появится после настройки PUBLIC_URL (HTTPS).'
  ].join('\n');
}

function welcomeMarkup(chatId) {
  const url = siteUrl(chatId, isOwnerChat(chatId) ? { go: 'admin' } : {});
  if (!url) return undefined;
  return {
    inline_keyboard: [[urlBtn('сайт Luxe Canvas', url, 'success')]]
  };
}

function connectMarkup(chatId, extraRow) {
  const rows = [];
  if (extraRow) rows.push(extraRow);
  const url = siteUrl(chatId);
  if (url) rows.push([urlBtn('На сайт', url, 'primary')]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function alreadyLinkedText() {
  return [
    '<b>Уведомления уже подключены</b>',
    '',
    'Заказы и финальный пуш «Доставлен» приходят сюда.'
  ].join('\n');
}

function chatTakenText() {
  return [
    '<b>Этот Telegram уже привязан к другому аккаунту на сайте.</b>',
    '',
    'Выйдите из того аккаунта или напишите в поддержку.'
  ].join('\n');
}

function userTakenText() {
  return [
    '<b>Уведомления уже подключены к другому Telegram.</b>',
    '',
    'Если это вы — нажмите «Перепривязать к этому чату».'
  ].join('\n');
}

function connectedText() {
  return [
    '<b>Уведомления успешно подключены</b>',
    '',
    'После заказа здесь появится карточка со статусом.',
    'Отдельный пуш — только когда заказ доставлен.'
  ].join('\n');
}

function formatCustomerOrder(order) {
  const items = (order.items || []).map((i) =>
    `· <b>${escHtml(i.name || 'Товар')}</b>${i.size ? ' · ' + escHtml(i.size) : ''} × ${i.qty || 1}`
  );
  const track = String(order.tracking || '').trim();
  const status = order.status || 'Оформлен';
  return [
    '<b>Ваш заказ</b>',
    '',
    items.length ? items.join('\n') : '· Заказ',
    '',
    `Сумма: <b>${money(order.price)}</b>`,
    `Срок: ${escHtml(etaText())}`,
    `№${escHtml(order.num)}`,
    '',
    `Статус: <b>${escHtml(status)}</b>`,
    track ? `Трек: <code>${escHtml(track)}</code>` : ''
  ].filter((x) => x !== '').join('\n');
}

function customerOrderMarkup(order, chatId) {
  const status = order.status || '—';
  const rows = [[cbBtn(`Статус: ${status}`, `ost:${order.num}`)]];
  const url = siteUrl(chatId, { hash: 'orders' });
  if (url) rows.push([urlBtn('Открыть на сайте', url, 'primary')]);
  return { inline_keyboard: rows };
}

function formatOwnerOrder(order) {
  const items = order.items || [];
  const lines = items.slice(0, 12).map((i) =>
    `· ${escHtml(i.name || 'Товар')}${i.size ? ' · ' + escHtml(i.size) : ''} × ${i.qty || 1}`
  );
  if (items.length > 12) lines.push(`· …ещё ${items.length - 12}`);
  const guest = order.guest || {};
  const who = order.customerName || guest.name || '—';
  const phone = order.phone || guest.phone || '';
  const email = order.email || guest.email || '';
  const pvz = order.pvz || order.addr || '';
  const pvzStr = !pvz ? ''
    : (typeof pvz === 'string' ? pvz
      : [pvz.city, pvz.addr].filter(Boolean).join(', ') || pvz.addr || '');
  const track = String(order.tracking || '').trim();
  const status = order.status || '—';
  const title = /доставлен/i.test(status) ? 'Заказ доставлен'
    : wasOwnerNotified(order.num) ? 'Заказ' : 'Новый заказ';
  return [
    `<b>${title}</b>`,
    `№${escHtml(order.num)} · <b>${money(order.price)}</b>`,
    '',
    escHtml(who) + (phone ? ` · ${escHtml(phone)}` : ''),
    email ? escHtml(email) : '',
    pvzStr ? `ПВЗ СДЭК: ${escHtml(pvzStr)}` : '',
    lines.length ? '\n' + lines.join('\n') : '',
    '',
    `Статус: <b>${escHtml(status)}</b>`,
    track ? `Трек: <code>${escHtml(track)}</code>` : 'Трек: —'
  ].filter((x) => x !== '').join('\n');
}

function ownerOrderMarkup(order, chatId) {
  const num = order.num;
  const status = order.status || '';
  const delivered = /доставлен/i.test(status);
  const rows = [];

  if (delivered) {
    rows.push([cbBtn('Возврат', `oset:${num}:r`, 'danger')]);
    rows.push([cbBtn('Изменить трек', `otrk:${num}`)]);
  } else {
    rows.push([
      cbBtn('Добавить трек', `otrk:${num}`),
      cbBtn('Изменить статус', `osts:${num}`)
    ]);
  }

  const url = siteUrl(chatId, { go: 'admin' });
  if (url) rows.push([urlBtn('На сайт', url, 'primary')]);
  return { inline_keyboard: rows };
}

function ownerStatusPickMarkup(order) {
  const num = order.num;
  const delivered = /доставлен/i.test(String(order.status || ''));
  const rows = [];
  if (delivered) {
    rows.push([cbBtn('Возврат', `oset:${num}:r`, 'danger')]);
  } else {
    const opts = [
      ['В обработке', 'w'],
      ['Едет', 'e'],
      ['Доставлен', 'd'],
      ['Отменён', 'c'],
      ['Возврат', 'r']
    ];
    for (const [label, code] of opts) {
      rows.push([cbBtn(label, `oset:${num}:${code}`)]);
    }
  }
  rows.push([cbBtn('« Назад', `oback:${num}`)]);
  return { inline_keyboard: rows };
}

function formatDeliveredPush(order) {
  const items = (order.items || []).slice(0, 6).map((i) =>
    `· ${escHtml(i.name || 'Товар')}${i.size ? ' · ' + escHtml(i.size) : ''}`
  );
  return [
    '<b>Заказ доставлен</b> ✨',
    `№${escHtml(order.num)} · ${money(order.price)}`,
    items.length ? '' : null,
    items.join('\n'),
    '',
    'Спасибо, что выбрали Luxe Canvas.'
  ].filter((x) => x != null && x !== undefined).join('\n');
}

/* ---- edit helpers: сначала новое/edit, старое удаляем только после успеха ---- */
async function sendWithMarkupFallback(chatId, { text, reply_markup, silent }) {
  const run = withStyleFallback(reply_markup);
  try {
    return await run((markup) => api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: !!silent,
      reply_markup: markup
    }));
  } catch (e1) {
    /* URL-кнопка / style сломали отправку — шлём без клавиатуры */
    console.error('TG send markup fail:', e1.message);
    try {
      return await api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: !!silent
      });
    } catch (e2) {
      console.error('TG send plain fail:', e2.message);
      throw e2;
    }
  }
}

async function editOrReplace(chatId, messageId, { text, reply_markup, silent }) {
  const run = withStyleFallback(reply_markup);

  if (messageId) {
    try {
      await run((markup) => api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: markup
      }));
      return messageId;
    } catch (e) {
      if (/not modified/i.test(String(e.message || ''))) return messageId;
      /* edit не вышел — НЕ удаляем сразу: сначала отправим новое */
    }
  }

  try {
    const sent = await sendWithMarkupFallback(chatId, { text, reply_markup, silent });
    const id = sent && sent.message_id;
    /* старое убираем только когда новое уже в чате */
    if (id && messageId && +id !== +messageId) {
      await safeDelete(chatId, messageId);
    }
    return id;
  } catch (e) {
    console.error('TG editOrReplace:', e.message);
    return messageId || null;
  }
}

async function upsertMain(chatId, { text, reply_markup }) {
  const id = await editOrReplace(chatId, getMainMsgId(chatId), { text, reply_markup });
  if (id) setMainMsgId(chatId, id);
  return id;
}

async function showWelcome(chatId, from = {}) {
  claimOwner(chatId, from);
  return upsertMain(chatId, {
    text: welcomeText(),
    reply_markup: welcomeMarkup(chatId)
  });
}

async function showConnectResult(chatId, kind, userId) {
  if (kind === 'already_same') {
    return upsertMain(chatId, {
      text: alreadyLinkedText(),
      reply_markup: connectMarkup(chatId)
    });
  }
  if (kind === 'chat_taken') {
    return upsertMain(chatId, {
      text: chatTakenText(),
      reply_markup: connectMarkup(chatId)
    });
  }
  if (kind === 'user_taken') {
    return upsertMain(chatId, {
      text: userTakenText(),
      reply_markup: connectMarkup(chatId, [
        cbBtn('Перепривязать к этому чату', `relink:${userId}`, 'danger')
      ])
    });
  }
  return upsertMain(chatId, {
    text: connectedText(),
    reply_markup: connectMarkup(chatId)
  });
}

/** Карточка покупателя — строго edit одного message_id на заказ. */
async function upsertCustomerOrderCard(order) {
  if (!order || !TOKEN()) return;
  const chatId = findChatForOrder(order);
  if (!chatId) return;
  /* тот же чат = владелец → только админ-карточка, без дубля */
  if (isOwnerChat(chatId)) return;

  const text = formatCustomerOrder(order);
  const markup = customerOrderMarkup(order, chatId);
  const prev = getOrderMsgId(chatId, order.num);
  const id = await editOrReplace(chatId, prev, { text, reply_markup: markup, silent: true });
  if (id) setOrderMsgId(chatId, order.num, id);
  return id;
}

/** Карточка владельца с кнопками управления (один чат). */
async function upsertOwnerOrderCardForChat(chatId, order, { replaceMain = false } = {}) {
  if (!order || !TOKEN() || !chatId) return;

  const text = formatOwnerOrder(order);
  const markup = ownerOrderMarkup(order, chatId);
  const prev = getOwnerOrderMsgId(chatId, order.num);
  const id = await editOrReplace(chatId, prev, {
    text,
    reply_markup: markup,
    silent: !!prev
  });
  if (id) setOwnerOrderMsgId(chatId, order.num, id);

  /* welcome/connect убираем только после успешной карточки заказа */
  if (replaceMain && id) {
    const mainId = getMainMsgId(chatId);
    if (mainId && +mainId !== +id) {
      await safeDelete(chatId, mainId);
      clearMainMsgId(chatId);
    }
  }
  return id;
}

/** Обновить карточки у всех Telegram-админов. */
async function upsertOwnerOrderCard(order, { replaceMain = false, chatId = null } = {}) {
  if (!order || !TOKEN()) return;
  if (chatId) {
    return upsertOwnerOrderCardForChat(chatId, order, { replaceMain });
  }
  const ids = getOwnerChatIds();
  for (const id of ids) {
    try {
      await upsertOwnerOrderCardForChat(id, order, { replaceMain });
    } catch (e) {
      console.error('TG owner card', id, e.message);
    }
  }
}

async function notifyCustomerOrder(order) {
  if (!order) return;
  await upsertCustomerOrderCard(order);
  await upsertOwnerOrderCard(order);

  const delivered = /доставлен/i.test(String(order.status || ''));
  if (!delivered || wasDeliveredPushed(order.num)) return;

  const chatId = findChatForOrder(order);
  if (!chatId || !TOKEN() || isOwnerChat(chatId)) {
    markDeliveredPushed(order.num);
    return;
  }

  const url = siteUrl(chatId, { hash: 'orders' });
  const markup = url
    ? { inline_keyboard: [[urlBtn('На сайт', url, 'primary')]] }
    : undefined;
  try {
    await withStyleFallback(markup)((m) => api('sendMessage', {
      chat_id: chatId,
      text: formatDeliveredPush(order),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: m
    }));
    markDeliveredPushed(order.num);
  } catch (e) {
    console.error('TG delivered push:', e.message);
  }
}

async function notifyCustomerNewOrder(order) {
  return upsertCustomerOrderCard(order);
}

async function notifyOwnerNewOrder(order) {
  if (!order || !TOKEN()) return;
  const chats = getOwnerChatIds();
  if (!chats.length) return;
  const firstTime = !wasOwnerNotified(order.num);
  for (const chat of chats) {
    try {
      await upsertOwnerOrderCardForChat(chat, order, { replaceMain: firstTime });
    } catch (e) {
      console.error('TG owner notify', chat, e.message);
    }
  }
  if (firstTime) markOwnerNotified(order.num);
}

function parseStartPayload(text) {
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const raw = String(m[1] || '').trim();
  if (!raw) return { kind: 'start' };
  const uid = /^u(\d+)$/i.exec(raw);
  if (uid) return { kind: 'link', userId: +uid[1] };
  if (/^reg$/i.test(raw)) return { kind: 'reg' };
  if (/^log(?:in)?$/i.test(raw)) return { kind: 'login' };
  if (/^(support|op|help|operator)$/i.test(raw)) return { kind: 'support' };
  const otp = /^c([a-f0-9]{6,16})$/i.exec(raw);
  if (otp) return { kind: 'otp', session: otp[1] };
  return { kind: 'start', payload: raw };
}

async function showRegAskPhone(chatId, from = {}, mode = 'reg') {
  claimOwner(chatId, from);
  setAwait(chatId, { type: 'reg_phone', mode: mode === 'log' ? 'log' : 'reg' });
  const isLogin = mode === 'log';
  const text = [
    isLogin ? '<b>Вход в Luxe Canvas</b>' : '<b>Регистрация в Luxe Canvas</b>',
    '',
    'Нажмите кнопку ниже и поделитесь номером — этого достаточно.'
  ].join('\n');
  try {
    await api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [[{ text: 'Поделиться контактом', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  } catch (e) {
    console.error('TG reg ask:', e.message);
  }
}

async function handleContactReg(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const c = msg.contact;
  if (!c || !c.phone_number) return false;

  /* только свой контакт */
  if (c.user_id && from.id && +c.user_id !== +from.id) {
    await sendWithMarkupFallback(chatId, {
      text: 'Нужен ваш собственный номер — нажмите «Поделиться контактом» ещё раз.'
    });
    return true;
  }

  try {
    const { upsertUserByPhone, issueTgPhoneToken, findByPhone } = require('./auth');
    const { normalizePhone } = require('./sms');
    const { tryLink } = require('./tg-users');
    const phoneNorm = normalizePhone(c.phone_number);
    const existed = !!(phoneNorm && findByPhone(phoneNorm));
    const user = upsertUserByPhone({
      phone: c.phone_number,
      name: '',
      last: '',
      via: 'telegram'
    });
    try {
      const link = tryLink(chatId, from, user.id);
      if (link && (link.status === 'chat_taken' || link.status === 'user_taken')) {
        console.warn('TG contact link skipped:', link.status);
      }
    } catch (e) {
      console.warn('TG contact link:', e.message);
    }

    const code = issueTgPhoneToken(c.phone_number, chatId);
    const shop = shopHttps();
    const url = shop ? `${shop}/?tg_phone=${encodeURIComponent(code)}` : '';

    setAwait(chatId, null);

    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: '✅ Номер получен',
        reply_markup: { remove_keyboard: true }
      });
    } catch (_) {}

    const text = [
      existed ? '<b>С возвращением</b>' : '<b>Вы зарегистрированы</b>',
      '',
      existed
        ? 'Вход выполнен по номеру Telegram.'
        : 'Аккаунт в Luxe Canvas создан.',
      url
        ? 'Нажмите кнопку — вернётесь на сайт уже под своим аккаунтом.'
        : 'Откройте сайт магазина — вы сможете войти через этого бота.'
    ].join('\n');

    const markup = url
      ? { inline_keyboard: [[urlBtn(existed ? 'Вернуться на сайт' : 'Перейти на сайт', url, 'success')]] }
      : undefined;

    const sent = await sendWithMarkupFallback(chatId, { text, reply_markup: markup });
    if (sent && sent.message_id) setMainMsgId(chatId, sent.message_id);

    console.log('TG phone reg', user.id, c.phone_number, existed ? 'login' : 'reg');
  } catch (e) {
    console.error('TG contact reg:', e.message);
    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: 'Не удалось войти: ' + (e.message || 'ошибка'),
        reply_markup: { remove_keyboard: true }
      });
    } catch (_) {}
  }
  return true;
}

async function handleTrackInput(chatId, text) {
  const awaitState = getAwait(chatId);
  if (!awaitState || awaitState.type !== 'track' || !awaitState.orderNum) return false;
  if (!isOwnerChat(chatId)) {
    setAwait(chatId, null);
    return false;
  }
  setAwait(chatId, null);
  const track = String(text || '').trim().slice(0, 200);
  try {
    const { updateOrderAdmin, getOrderByNum } = require('./orders');
    const updated = updateOrderAdmin(awaitState.orderNum, { tracking: track });
    const o = updated || getOrderByNum(awaitState.orderNum);
    if (o) await upsertOwnerOrderCard(o);
  } catch (e) {
    console.error('TG track set:', e.message);
  }
  return true;
}

async function handleMessage(msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = String(msg.text || msg.caption || '').trim();
  const start = parseStartPayload(text);
  const isStart = !!(start || /^\/start\b/i.test(text));

  try {
    if (msg.contact) {
      await handleContactReg(msg);
      await safeDelete(chatId, msg.message_id);
      return;
    }

    /* поддержка: оператор ↔ клиент (не удаляем сообщения — сотрём при закрытии) */
    if (text && !isStart && (await handleSupportOperatorMessage(msg))) {
      return;
    }
    if (text && !isStart && (await handleSupportUserMessage(msg))) {
      return;
    }

    /* /start НЕ удаляем сразу — иначе Telegram на телефоне «закрывает» бота. */
    if (text && !isStart && (await handleTrackInput(chatId, text))) {
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (!text) {
      await showWelcome(chatId, from);
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'support') {
      await startSupportRequest(chatId, from);
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'otp' && start.session) {
      claimOwner(chatId, from);
      try {
        const { linkOtpSession } = require('./otp');
        const r = await linkOtpSession(start.session, chatId);
        if (!r.ok) {
          await upsertMain(chatId, {
            text: `<b>${escHtml(r.error || 'Сессия не найдена')}</b>\n\nВернитесь на сайт, укажите номер и откройте бота снова.`,
            reply_markup: welcomeMarkup(chatId)
          });
        } else {
          await upsertMain(chatId, {
            text: [
              '<b>Бот подключён</b> ✅',
              '',
              'Вернитесь на сайт Luxe Canvas и нажмите «Отправить код».',
              'Код придёт сюда сообщением.'
            ].join('\n'),
            reply_markup: connectMarkup(chatId)
          });
        }
      } catch (e) {
        console.error('TG otp start:', e.message);
      }
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'reg') {
      claimOwner(chatId, from);
      await showRegAskPhone(chatId, from, 'reg');
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'login') {
      claimOwner(chatId, from);
      await showRegAskPhone(chatId, from, 'log');
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'link' && start.userId) {
      claimOwner(chatId, from);
      const result = tryLink(chatId, from, start.userId);
      console.log('TG link', start.userId, '→', chatId, result.status);
      await showConnectResult(chatId, result.status, start.userId);
      await safeDelete(chatId, msg.message_id);
      return;
    }

    /* обычный /start или любой вход в бота без спец-payload — сразу контакт */
    if (isStart) {
      await showRegAskPhone(chatId, from, 'reg');
      await safeDelete(chatId, msg.message_id);
      return;
    }

    await showWelcome(chatId, from);
    await safeDelete(chatId, msg.message_id);
  } catch (e) {
    console.error('TG handleMessage:', e.message);
    try {
      await showWelcome(chatId, from);
    } catch (e2) {
      console.error('TG recovery welcome:', e2.message);
    }
  }
}

async function handleCallback(cq) {
  if (!cq || !cq.message || !cq.message.chat) return;
  const chatId = cq.message.chat.id;
  const from = cq.from || {};
  const data = String(cq.data || '');
  const msgId = cq.message.message_id;

  const answer = async (text, alert) => {
    try {
      await api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text,
        show_alert: !!alert
      });
    } catch (_) {}
  };

  if (/^relink:(\d+)$/.test(data)) {
    await answer();
    const userId = +data.split(':')[1];
    const result = relinkUser(chatId, from, userId);
    await showConnectResult(
      chatId,
      result.status === 'ok' ? 'ok' : result.status === 'chat_taken' ? 'chat_taken' : 'user_taken',
      userId
    );
    return;
  }

  if (data === 'sup:cancel') {
    await answer();
    await cancelSupportRequest(chatId);
    return;
  }

  if (/^sup:open:(-?\d+)$/.test(data)) {
    const userChatId = data.split(':')[2];
    if (String(chatId) !== SUPPORT_OPERATOR_CHAT() && !isOwnerChat(chatId)) {
      await answer('Нет доступа', true);
      return;
    }
    const r = await openSupportDialog(chatId, userChatId, msgId);
    await answer(r.ok ? 'Диалог открыт' : (r.error || 'Не удалось'), !r.ok);
    return;
  }

  if (/^sup:close:(-?\d+)$/.test(data)) {
    const userChatId = data.split(':')[2];
    if (String(chatId) !== SUPPORT_OPERATOR_CHAT() && !isOwnerChat(chatId)) {
      await answer('Нет доступа', true);
      return;
    }
    const session = getSupport(userChatId);
    if (!session || String(session.operatorChatId) !== String(chatId)) {
      await answer('Диалог не найден', true);
      return;
    }
    await answer('Диалог закрыт');
    await closeSupportDialog(userChatId);
    return;
  }

  if (/^ost:/.test(data)) {
    await answer('Статус актуален');
    const num = data.slice(4);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (o) await upsertCustomerOrderCard(o);
    } catch (_) {}
    return;
  }

  /* --- владелец --- */
  if (!isOwnerChat(chatId)) {
    await answer('Нет доступа', true);
    return;
  }

  if (/^otrk:/.test(data)) {
    const num = data.slice(5);
    setAwait(chatId, { type: 'track', orderNum: num });
    await answer('Пришлите трек или ссылку следующим сообщением');
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (o) {
        await editOrReplace(chatId, msgId, {
          text: formatOwnerOrder(o) + '\n\n<i>Пришлите трек-номер или ссылку одним сообщением.</i>',
          reply_markup: {
            inline_keyboard: [[cbBtn('Отмена', `oback:${num}`)]]
          }
        });
        setOwnerOrderMsgId(chatId, num, msgId);
      }
    } catch (_) {}
    return;
  }

  if (/^osts:/.test(data)) {
    await answer();
    const num = data.slice(5);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (!o) return;
      await editOrReplace(chatId, msgId, {
        text: formatOwnerOrder(o) + '\n\n<b>Выберите статус:</b>',
        reply_markup: ownerStatusPickMarkup(o)
      });
      setOwnerOrderMsgId(chatId, num, msgId);
    } catch (_) {}
    return;
  }

  if (/^oback:/.test(data)) {
    await answer();
    setAwait(chatId, null);
    const num = data.slice(6);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (o) await upsertOwnerOrderCardForChat(chatId, o);
    } catch (_) {}
    return;
  }

  if (/^oset:/.test(data)) {
    const parts = data.split(':');
    const num = parts[1];
    const code = parts[2];
    const status = STATUS_CODE[code];
    if (!status) {
      await answer('Неизвестный статус', true);
      return;
    }
    try {
      const { updateOrderAdmin } = require('./orders');
      const updated = updateOrderAdmin(num, { status });
      await answer(status === 'Доставлен' ? 'Доставлен' : `Статус: ${status}`);
      if (updated) await upsertOwnerOrderCard(updated);
    } catch (e) {
      await answer(e.message || 'Ошибка', true);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  if (msg.from && msg.from.is_bot) return;
  console.log('TG update:', msg.chat.id, msg.text || msg.caption || '(media)');
  await handleMessage(msg);
}

async function setupWebhook(publicUrl) {
  const base = String(publicUrl || '').replace(/\/$/, '');
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) {
    return { mode: 'skip', reason: 'local PUBLIC_URL' };
  }
  const url = String(process.env.WEBHOOK_URL || `${base}/webhook`).replace(/\/$/, '');
  await api('setWebhook', {
    url,
    secret_token: WEBHOOK_SECRET(),
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query']
  });
  return { mode: 'webhook', url };
}

let polling = false;
async function startPolling() {
  if (polling) return { mode: 'polling' };
  polling = true;
  try { await api('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
  let offset = 0;
  const tick = async () => {
    if (!polling || !TOKEN()) return;
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      for (const u of updates || []) {
        offset = u.update_id + 1;
        try { await handleUpdate(u); } catch (e) { console.error('TG handle:', e.message); }
      }
    } catch (e) {
      console.error('TG poll:', e.message);
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (polling) setImmediate(tick);
  };
  tick();
  return { mode: 'polling' };
}

function stopPolling() { polling = false; }

function verifyWebhookSecret(req) {
  const expected = WEBHOOK_SECRET();
  const got = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!got) return true;
  return got === expected;
}

async function boot(publicUrl) {
  if (!TOKEN()) {
    console.log('Telegram bot: OFF (нет TELEGRAM_BOT_TOKEN)');
    return { mode: 'off' };
  }
  try {
    const me = await api('getMe');
    BOT_USERNAME = me.username || '';
    if (BOT_USERNAME) process.env.TELEGRAM_BOT_USERNAME = BOT_USERNAME;
    const shop = shopHttps() || SHOP_URL();
    const owners = getOwnerChatIds();
    console.log(`Telegram bot: @${BOT_USERNAME} · shop → ${shop || '(нет валидного HTTPS)'} · admins → ${owners.join(', ') || '(первый /start)'}`);

    const forcePoll =
      process.env.TELEGRAM_POLLING === '1' ||
      process.env.TELEGRAM_POLLING === 'true' ||
      !!process.env.BOT_ID ||
      !!process.env.DOMAIN ||
      /bothost\.(tech|ru)/i.test(shop);

    if (forcePoll || process.env.TELEGRAM_WEBHOOK !== '1') {
      await startPolling();
      console.log('Telegram bot: polling ON');
      return { mode: 'polling', username: BOT_USERNAME, shop };
    }

    const wh = await setupWebhook(publicUrl);
    if (wh.mode === 'webhook') {
      console.log(`Telegram webhook: ${wh.url}`);
      return { mode: 'webhook', username: BOT_USERNAME, url: wh.url, shop };
    }
    await startPolling();
    console.log('Telegram bot: polling ON');
    return { mode: 'polling', username: BOT_USERNAME, shop };
  } catch (e) {
    console.error('Telegram bot start failed:', e.message);
    return { mode: 'error', error: e.message };
  }
}

function configured() {
  return !!TOKEN();
}

function botUsername() {
  return BOT_USERNAME;
}

/** Простое HTML-сообщение (сброс пароля и т.п.). */
async function sendText(chatId, text, reply_markup) {
  if (!TOKEN() || !chatId) throw new Error('no bot');
  return sendWithMarkupFallback(chatId, { text, reply_markup });
}

module.exports = {
  boot,
  handleUpdate,
  verifyWebhookSecret,
  configured,
  stopPolling,
  notifyCustomerOrder,
  notifyCustomerNewOrder,
  notifyOwnerNewOrder,
  upsertCustomerOrderCard,
  upsertOwnerOrderCard,
  botUsername,
  shopHttps,
  sendText
};
