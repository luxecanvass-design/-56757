const crypto = require('crypto');
const { db } = require('./db');
const { getProduct, checkStock, deductStock, restoreStock } = require('./products');
const { createPayment, configured, getPayment } = require('./yookassa');

function nextOrderNum() {
  const row = db.prepare(`SELECT num FROM orders ORDER BY id DESC LIMIT 1`).get();
  if (!row) return '10001';
  const n = parseInt(row.num, 10);
  return String((Number.isFinite(n) ? n : 10000) + 1);
}

function newAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokensEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function rowToOrder(row) {
  if (!row) return null;
  let items = [], steps = [], pvz = null;
  try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
  try { steps = JSON.parse(row.steps_json || '[]'); } catch (_) {}
  try { pvz = row.pvz_json ? JSON.parse(row.pvz_json) : null; } catch (_) {}
  return {
    id: row.id,
    num: row.num,
    date: (row.created_at || '').slice(0, 16).replace('T', ' '),
    status: row.status,
    payStatus: row.pay_status,
    yookassaId: row.yookassa_id,
    confirmationUrl: row.confirmation_url,
    price: row.price,
    goods: row.goods,
    discount: row.discount,
    ship: row.ship,
    shipMode: row.ship_mode,
    promoCode: row.promo_code,
    payName: row.pay_name,
    customerName: row.customer_name,
    email: row.email,
    phone: row.phone,
    addr: row.addr,
    pvz,
    items,
    steps,
    now: row.step_now,
    tracking: row.tracking || '',
    note: row.note || '',
    guest: !!row.guest,
    userId: row.user_id,
    accessToken: row.access_token || ''
  };
}

/** Ответ клиенту: без accessToken / внутренних полей. */
function toPublicOrder(order, { admin = false } = {}) {
  if (!order) return null;
  const o = Object.assign({}, order);
  delete o.accessToken;
  if (!admin) {
    delete o.note;
    delete o.yookassaId;
    delete o.confirmationUrl;
  }
  return o;
}

/** Владелец / админ / одноразовый токен из return URL после оплаты. */
function canAccessOrder(order, user, accessToken) {
  if (!order) return false;
  if (user && user.role === 'admin') return true;
  if (user) {
    if (order.userId && +order.userId === +user.id) return true;
    if (order.email && String(order.email).toLowerCase() === String(user.email || '').toLowerCase()) {
      return true;
    }
  }
  if (accessToken && order.accessToken && tokensEqual(accessToken, order.accessToken)) return true;
  return false;
}

function getCms() {
  const row = db.prepare('SELECT data_json FROM cms WHERE id = 1').get();
  if (!row) return { promos: [], shipping: { pickup: 190, freeFrom: 15000 } };
  try { return JSON.parse(row.data_json); } catch (_) { return { promos: [], shipping: {} }; }
}

function saveCms(cms) {
  db.prepare(`UPDATE cms SET data_json = ? WHERE id = 1`).run(JSON.stringify(cms));
}

function calcPromo(code, goodsSum) {
  const cms = getCms();
  const promo = (cms.promos || []).find(
    (p) => p.on && String(p.code || '').toUpperCase() === String(code || '').toUpperCase()
  );
  if (!promo) return { discount: 0, promo: null, error: code ? 'Промокод не найден' : null };
  if (promo.minSum && goodsSum < promo.minSum) {
    return { discount: 0, promo: null, error: `Минимальная сумма ${promo.minSum} ₽` };
  }
  if (promo.limit != null && (promo.used || 0) >= promo.limit) {
    return { discount: 0, promo: null, error: 'Промокод исчерпан' };
  }
  let discount = 0;
  if (promo.type === 'percent') discount = Math.round((goodsSum * (+promo.value || 0)) / 100);
  else discount = Math.min(goodsSum, Math.round(+promo.value || 0));
  return { discount, promo, error: null };
}

function shipCost(goodsAfterDiscount) {
  const s = getCms().shipping || {};
  const pickup = +s.pickup || 190;
  const freeFrom = +s.freeFrom || 0;
  if (freeFrom > 0 && goodsAfterDiscount >= freeFrom) return 0;
  return pickup;
}

async function pushNewOrder(order) {
  try {
    const { notifyOwnerNewOrder, notifyCustomerNewOrder } = require('./telegram-bot');
    await notifyOwnerNewOrder(order);
    await notifyCustomerNewOrder(order);
  } catch (_) {}
}

/** Привязать гостевые заказы с тем же email к аккаунту. */
function claimOrdersForUser(user) {
  if (!user || !user.id || !user.email) return 0;
  const info = db.prepare(`
    UPDATE orders
    SET user_id = ?, guest = 0, updated_at = datetime('now')
    WHERE user_id IS NULL AND lower(email) = lower(?)
  `).run(user.id, String(user.email).trim());
  return info.changes || 0;
}

async function createCheckout({ items, guest, pvz, promoCode, user, publicUrl }) {
  if (!items || !items.length) {
    throw Object.assign(new Error('Корзина пуста'), { status: 400 });
  }

  const normalized = items.map((i) => {
    const p = getProduct(i.id);
    if (!p) throw Object.assign(new Error('Товар не найден'), { status: 400 });
    return {
      id: p.id,
      name: p.name,
      img: p.img,
      size: String(i.size || ''),
      qty: Math.max(1, Math.round(+i.qty || 1)),
      price: p.price
    };
  });

  const stockErr = checkStock(normalized);
  if (stockErr) throw Object.assign(new Error(stockErr), { status: 409 });

  const g = guest || {};
  const name = String(g.name || '').trim();
  const phone = String(g.phone || '').trim();
  const email = String(g.email || (user && user.email) || '').trim().toLowerCase();
  if (!name) throw Object.assign(new Error('Укажите имя'), { status: 400 });
  if (!phone) throw Object.assign(new Error('Укажите телефон'), { status: 400 });
  if (!email.includes('@')) throw Object.assign(new Error('Укажите email'), { status: 400 });
  if (!pvz || !String(pvz.addr || '').trim() || String(pvz.addr).trim().length < 8) {
    throw Object.assign(new Error('Укажите адрес пункта выдачи СДЭК'), { status: 400 });
  }

  /* Привязка к аккаунту: JWT-user или существующий email (гость с тем же email). */
  let userId = user && user.id ? +user.id : null;
  let asGuest = userId ? 0 : 1;
  if (!userId) {
    try {
      const { findByEmail } = require('./auth');
      const existing = findByEmail(email);
      if (existing) {
        userId = existing.id;
        asGuest = 0;
      }
    } catch (_) {}
  }

  const goods = normalized.reduce((s, i) => s + i.price * i.qty, 0);
  const { discount, promo, error: promoErr } = calcPromo(promoCode, goods);
  if (promoErr && promoCode) throw Object.assign(new Error(promoErr), { status: 400 });
  const after = Math.max(0, goods - discount);
  const ship = shipCost(after);
  const price = after + ship;
  const num = nextOrderNum();
  const dd = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const steps = [
    ['Оформлен', dd.slice(5, 10)],
    ['Оплата', ''],
    ['Обработка', ''],
    ['Едет', ''],
    ['Доставлен', '']
  ];

  const accessToken = newAccessToken();
  const ykOn = configured();
  const initialStatus = ykOn ? 'Ожидает оплаты' : 'В обработке';
  const initialPay = ykOn ? 'pending' : 'manual';
  const initialStep = ykOn ? 0 : 2;
  if (!ykOn && steps[1]) steps[1][1] = dd.slice(5, 10);
  if (!ykOn && steps[2]) steps[2][1] = dd.slice(5, 10);

  const info = db.prepare(`
    INSERT INTO orders (
      num, user_id, status, pay_status, price, goods, discount, ship, ship_mode,
      promo_code, customer_name, email, phone, addr, pvz_json, items_json, steps_json, step_now, guest, access_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pickup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    num,
    userId,
    initialStatus,
    initialPay,
    price,
    goods,
    discount,
    ship,
    promo ? promo.code : '',
    name,
    email,
    phone,
    [pvz.city, pvz.addr].filter(Boolean).join(', ') || String(pvz.addr || ''),
    JSON.stringify(pvz),
    JSON.stringify(normalized),
    JSON.stringify(steps),
    initialStep,
    asGuest,
    accessToken
  );

  const orderId = info.lastInsertRowid;
  const returnUrl = `${publicUrl.replace(/\/$/, '')}/?paid=${encodeURIComponent(num)}&t=${encodeURIComponent(accessToken)}`;

  if (!ykOn) {
    const order = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
    await pushNewOrder(order);
    return {
      order: toPublicOrder(order, { admin: false }),
      orderAccessToken: accessToken,
      paymentConfigured: false,
      message: 'ЮKassa не настроена — заказ принят в обработку'
    };
  }

  const payment = await createPayment({
    amount: price,
    description: `Luxe Canvas · заказ №${num}`,
    orderNum: num,
    returnUrl,
    metadata: { orderId: String(orderId) }
  });

  const confUrl = payment.confirmation && payment.confirmation.confirmation_url;
  db.prepare(`
    UPDATE orders SET yookassa_id = ?, confirmation_url = ?, updated_at = datetime('now') WHERE id = ?
  `).run(payment.id, confUrl || '', orderId);

  const orderDraft = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  await pushNewOrder(orderDraft);

  const order = orderDraft;
  return {
    order: toPublicOrder(order, { admin: false }),
    orderAccessToken: accessToken,
    paymentConfigured: true,
    confirmationUrl: confUrl,
    paymentId: payment.id
  };
}

function markPaid(order, paymentId) {
  if (!order || order.pay_status === 'paid') return order;
  let items = [];
  try { items = JSON.parse(order.items_json || '[]'); } catch (_) {}
  deductStock(items);

  if (order.promo_code) {
    const cms = getCms();
    const pr = (cms.promos || []).find((x) => String(x.code).toUpperCase() === String(order.promo_code).toUpperCase());
    if (pr) {
      pr.used = (pr.used || 0) + 1;
      saveCms(cms);
    }
  }

  let steps = [];
  try { steps = JSON.parse(order.steps_json || '[]'); } catch (_) {}
  const dd = new Date().toISOString().slice(5, 10);
  if (steps[1]) steps[1][1] = dd;

  db.prepare(`
    UPDATE orders SET
      pay_status = 'paid',
      status = 'В обработке',
      yookassa_id = COALESCE(?, yookassa_id),
      steps_json = ?,
      step_now = 2,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(paymentId || null, JSON.stringify(steps), order.id);

  const paid = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
  /* Владельцу статусы не шлём. Покупателю — silent edit карточки. */
  try {
    const { notifyCustomerNewOrder } = require('./telegram-bot');
    notifyCustomerNewOrder(paid).catch(() => {});
  } catch (_) {}
  return paid;
}

async function handleWebhook(event) {
  if (!event || !event.object) return { ok: true };
  const obj = event.object;
  const paymentId = obj.id;
  let order = db.prepare('SELECT * FROM orders WHERE yookassa_id = ?').get(paymentId);
  if (!order && obj.metadata && obj.metadata.orderNum) {
    order = db.prepare('SELECT * FROM orders WHERE num = ?').get(String(obj.metadata.orderNum));
  }
  if (!order) return { ok: true, skipped: true };

  if (event.event === 'payment.succeeded' || obj.status === 'succeeded') {
    markPaid(order, paymentId);
  } else if (event.event === 'payment.canceled' || obj.status === 'canceled') {
    db.prepare(`
      UPDATE orders SET pay_status = 'canceled', status = 'Отменён', updated_at = datetime('now') WHERE id = ?
    `).run(order.id);
  }
  return { ok: true };
}

async function syncPaymentStatus(num) {
  const order = db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
  if (!order) return null;
  if (order.pay_status === 'paid') return rowToOrder(order);
  if (!order.yookassa_id) return rowToOrder(order);
  const payment = await getPayment(order.yookassa_id);
  if (payment && payment.status === 'succeeded') {
    return markPaid(order, payment.id);
  }
  return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
}

function listOrdersForUser(user) {
  if (!user) return [];
  claimOrdersForUser(user);
  const rows = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? OR lower(email) = lower(?) ORDER BY id DESC
  `).all(user.id, user.email);
  return rows.map((r) => toPublicOrder(rowToOrder(r), { admin: user.role === 'admin' }));
}

function listAllOrders() {
  return db.prepare('SELECT * FROM orders ORDER BY id DESC').all()
    .map((r) => toPublicOrder(rowToOrder(r), { admin: true }));
}

function getOrderByNum(num) {
  return rowToOrder(db.prepare('SELECT * FROM orders WHERE num = ?').get(num));
}

function getOrderRow(num) {
  return db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
}

function updateOrderAdmin(num, patch) {
  const order = db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
  if (!order) return null;
  const prevStatus = order.status;
  const prevTrack = order.tracking || '';
  const status = patch.status != null ? patch.status : order.status;
  const tracking = patch.tracking != null ? patch.tracking : order.tracking;
  const note = patch.note != null ? patch.note : order.note;
  let step_now = order.step_now;
  if (status === 'В обработке') step_now = 2;
  if (status === 'Едет') step_now = 3;
  if (status === 'Доставлен') step_now = 4;
  if (status === 'Отменён' || status === 'Возврат') {
    if (order.pay_status === 'paid' && order.status !== 'Отменён' && order.status !== 'Возврат') {
      let items = [];
      try { items = JSON.parse(order.items_json || '[]'); } catch (_) {}
      restoreStock(items);
    }
  }
  db.prepare(`
    UPDATE orders SET status = ?, tracking = ?, note = ?, step_now = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, tracking || '', note || '', step_now, order.id);
  const updated = toPublicOrder(getOrderByNum(num), { admin: true });
  if (
    updated &&
    (String(prevStatus) !== String(status) || String(prevTrack) !== String(tracking || ''))
  ) {
    try {
      const { notifyCustomerOrder } = require('./telegram-bot');
      notifyCustomerOrder(updated).catch(() => {});
    } catch (_) {}
  }
  return updated;
}

module.exports = {
  createCheckout,
  handleWebhook,
  syncPaymentStatus,
  listOrdersForUser,
  listAllOrders,
  getOrderByNum,
  updateOrderAdmin,
  claimOrdersForUser,
  getCms,
  saveCms,
  rowToOrder,
  toPublicOrder,
  canAccessOrder,
  configured
};
