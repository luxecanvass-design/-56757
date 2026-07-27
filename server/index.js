require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { seedIfEmpty, defaultCms } = require('./seed');
const { db } = require('./db');
const {
  register, login, signUser, publicUser,
  authOptional, authRequired, adminRequired,
  setAuthCookie, clearAuthCookie,
  redeemTgAdminToken, redeemTgPhoneToken, upsertUserByPhone, updateProfile,
  upsertGoogleUser
} = require('./auth');
const googleAuth = require('./google-auth');
const { requestPasswordReset, resetPassword, smtpConfigured } = require('./password-reset');
const {
  listProducts, getProduct, upsertProduct, deleteProduct
} = require('./products');
const {
  createCheckout, handleWebhook, syncPaymentStatus,
  listOrdersForUser, listAllOrders, getOrderByNum, updateOrderAdmin,
  claimOrdersForUser, getCms, saveCms, toPublicOrder, canAccessOrder
} = require('./orders');
const yookassa = require('./yookassa');
const { sanitizeCms, scrubCmsInput, tryonServerConfigured } = require('./cms-safe');
const { runTryon } = require('./tryon');
const telegramBot = require('./telegram-bot');
const { resolvePublicUrl, logPublicUrlDebug } = require('./public-url');

seedIfEmpty();

/* Убрать ключи из старых записей CMS в БД */
(() => {
  try {
    const cms = getCms();
    if (cms && cms.tryon && (cms.tryon.apiKey || cms.tryon.apiUrl)) {
      saveCms(scrubCmsInput(cms));
      console.log('Scrubbed tryon secrets from CMS store');
    }
  } catch (_) {}
})();

const app = express();
const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = resolvePublicUrl(PORT);
process.env.PUBLIC_URL = PUBLIC_URL;
logPublicUrlDebug(PUBLIC_URL);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(authOptional);

async function telegramWebhookHandler(req, res) {
  try {
    if (!telegramBot.configured()) return res.sendStatus(404);
    if (!telegramBot.verifyWebhookSecret(req)) return res.sendStatus(401);
    await telegramBot.handleUpdate(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error('telegram webhook:', e.message);
    res.sendStatus(200);
  }
}

/* Bothost ждёт /webhook и /health; оставляем и старые пути */
app.post('/webhook', telegramWebhookHandler);
app.post('/api/telegram/webhook', telegramWebhookHandler);

function healthPayload() {
  let telegramGateway = false;
  try { telegramGateway = require('./telegram-gateway').configured(); } catch (_) {}
  return {
    ok: true,
    brand: 'Luxe Canvas',
    publicUrl: PUBLIC_URL,
    yookassa: yookassa.configured(),
    telegram: telegramBot.configured(),
    telegramBot: telegramBot.botUsername() || '',
    telegramGateway,
    google: googleAuth.configured(),
    smtp: smtpConfigured(),
    tryon: tryonServerConfigured(),
    time: new Date().toISOString()
  };
}

app.get('/health', (_req, res) => {
  res.json(healthPayload());
});

app.get('/api/health', (_req, res) => {
  res.json(healthPayload());
});

/* -------- catalog -------- */
app.get('/api/catalog', (_req, res) => {
  res.json({ products: listProducts({ all: false }) });
});

app.get('/api/catalog/all', adminRequired, (_req, res) => {
  res.json({ products: listProducts({ all: true }) });
});

app.get('/api/catalog/:id', (req, res) => {
  const p = getProduct(+req.params.id);
  if (!p) return res.status(404).json({ error: 'Не найден' });
  res.json({ product: p });
});

app.post('/api/admin/products', adminRequired, (req, res) => {
  try {
    const product = upsertProduct(req.body || {});
    res.json({ product });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка' });
  }
});

app.put('/api/admin/products/:id', adminRequired, (req, res) => {
  try {
    const product = upsertProduct({ ...(req.body || {}), id: +req.params.id });
    res.json({ product });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка' });
  }
});

app.delete('/api/admin/products/:id', adminRequired, (req, res) => {
  deleteProduct(+req.params.id);
  res.json({ ok: true });
});

/* -------- cms (без секретов на клиент) -------- */
app.get('/api/cms', (_req, res) => {
  res.json({ cms: sanitizeCms(getCms() || defaultCms()) });
});

app.put('/api/cms', adminRequired, (req, res) => {
  const cur = getCms() || defaultCms();
  const body = scrubCmsInput(req.body || {});
  const next = Object.assign({}, cur, body);
  if (body.brand) next.brand = Object.assign({}, cur.brand, body.brand);
  if (body.contacts) next.contacts = Object.assign({}, cur.contacts, body.contacts);
  if (body.legal) next.legal = Object.assign({}, cur.legal, body.legal);
  if (body.texts) next.texts = Object.assign({}, cur.texts, body.texts);
  if (body.shipping) next.shipping = Object.assign({}, cur.shipping, body.shipping);
  if (body.tryon) next.tryon = Object.assign({}, cur.tryon || {}, body.tryon);
  /* на всякий случай ещё раз вычистить секреты */
  const clean = scrubCmsInput(next);
  saveCms(clean);
  res.json({ cms: sanitizeCms(clean) });
});

/* -------- try-on: ключи только на сервере -------- */
app.post('/api/tryon', async (req, res) => {
  try {
    const out = await runTryon({
      personImage: req.body && req.body.personImage,
      garmentImage: req.body && req.body.garmentImage,
      productId: req.body && req.body.productId,
      productName: req.body && req.body.productName,
      brand: req.body && req.body.brand
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

/* -------- auth -------- */
app.post('/api/auth/register', (req, res) => {
  try {
    const user = register(req.body || {});
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const user = login(req.body || {});
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
  }
});

app.post('/api/auth/forgot', async (req, res) => {
  try {
    const out = await requestPasswordReset(req.body && req.body.email);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({
      error: e.message,
      needTelegram: !!e.needTelegram,
      smtp: smtpConfigured()
    });
  }
});

app.post('/api/auth/reset', (req, res) => {
  try {
    const body = req.body || {};
    const user = resetPassword({
      email: body.email,
      code: body.code,
      password: body.password
    });
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/auth/google', (req, res) => {
  try {
    if (!googleAuth.configured()) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google не настроен: GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET'));
    }
    const state = require('crypto').randomBytes(12).toString('hex');
    res.redirect(googleAuth.authUrl(state));
  } catch (e) {
    res.redirect('/?auth_err=' + encodeURIComponent(e.message || 'Google ошибка'));
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google: нет кода'));
    }
    const tokens = await googleAuth.exchangeCode(code);
    const profile = await googleAuth.fetchProfile(tokens.access_token);
    if (!profile.email && !profile.googleId) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google не вернул email'));
    }
    const user = upsertGoogleUser(profile);
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    /* токен в hash — SPA подхватит на клиенте */
    res.redirect('/#google_token=' + encodeURIComponent(token));
  } catch (e) {
    console.error('Google callback:', e.message);
    res.redirect('/?auth_err=' + encodeURIComponent(e.message || 'Google ошибка'));
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/* ---- телефон + OTP через бота ---- */
app.post('/api/auth/phone/start', async (req, res) => {
  try {
    const { startPhoneAuth } = require('./otp');
    const out = await startPhoneAuth(req.body && req.body.phone);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/phone/send', async (req, res) => {
  try {
    const { sendPhoneCode } = require('./otp');
    const out = await sendPhoneCode(req.body && req.body.phone);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({
      error: e.message,
      needOpenBot: !!e.needOpenBot
    });
  }
});

app.get('/api/auth/phone/status', (req, res) => {
  try {
    const { phoneAuthStatus } = require('./otp');
    res.json(phoneAuthStatus(req.query && req.query.phone));
  } catch (e) {
    res.status(400).json({ error: e.message, linked: false });
  }
});

/* совместимость со старым клиентом */
app.post('/api/auth/phone/send-legacy-start', async (req, res) => {
  try {
    const { startPhoneAuth } = require('./otp');
    const out = await startPhoneAuth(req.body && req.body.phone);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/phone/verify', (req, res) => {
  try {
    const { verifyOtp } = require('./otp');
    const body = req.body || {};
    const { phone, chatId } = verifyOtp(body.phone, body.code);
    const user = upsertUserByPhone({
      phone,
      name: body.name,
      last: body.last,
      via: 'telegram-otp'
    });
    claimOrdersForUser(user);
    if (chatId) {
      try {
        const { tryLink } = require('./tg-users');
        tryLink(chatId, {}, user.id);
      } catch (_) {}
    }
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, wrong: !!e.wrong });
  }
});

/** Вход по ссылке после регистрации через Telegram (контакт). */
app.post('/api/auth/telegram-phone', (req, res) => {
  try {
    const tokenIn = String((req.body && req.body.token) || '').trim();
    const user = redeemTgPhoneToken(tokenIn);
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

app.put('/api/auth/profile', authRequired, (req, res) => {
  try {
    const body = req.body || {};
    const user = updateProfile(req.user.id, {
      name: body.name,
      last: body.last,
      middle: body.middle,
      email: body.email
    });
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/auth/telegram', (req, res) => {
  const bot = telegramBot.botUsername() || '';
  if (!req.user) return res.json({ linked: false, conflict: false, bot });
  const { telegramStatusForUser } = require('./tg-users');
  const st = telegramStatusForUser(req.user);
  res.json({
    linked: st.linked,
    conflict: !!st.conflict,
    bot,
    at: st.at || null
  });
});

/** Авто-вход в ADMIN_EMAIL по одноразовой ссылке из бота (только владелец TELEGRAM_CHAT_ID). */
app.post('/api/auth/telegram-admin', (req, res) => {
  try {
    const token = String((req.body && req.body.token) || req.query.t || '').trim();
    const user = redeemTgAdminToken(token);
    const jwt = signUser(user);
    setAuthCookie(res, jwt);
    res.json({ user: publicUser(user), token: jwt });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/* -------- checkout / orders -------- */
app.post('/api/checkout', async (req, res) => {
  try {
    const result = await createCheckout({
      items: req.body.items,
      guest: req.body.guest,
      pvz: req.body.pvz,
      promoCode: req.body.promoCode,
      user: req.user,
      publicUrl: PUBLIC_URL
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

app.post('/api/yookassa/webhook', async (req, res) => {
  try {
    const out = await handleWebhook(req.body);
    res.json(out);
  } catch (e) {
    console.error('webhook', e);
    res.status(500).json({ error: 'webhook failed' });
  }
});

app.get('/api/orders/mine', authRequired, (req, res) => {
  res.json({ orders: listOrdersForUser(req.user) });
});

app.get('/api/orders/:num', authOptional, async (req, res) => {
  const num = String(req.params.num || '');
  let order = getOrderByNum(num);
  if (!order) return res.status(404).json({ error: 'Не найден' });

  const accessToken = String(req.query.t || req.headers['x-order-token'] || '');
  if (!canAccessOrder(order, req.user, accessToken)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const isAdmin = !!(req.user && req.user.role === 'admin');
  if (req.query.sync === '1' || order.payStatus === 'pending') {
    order = (await syncPaymentStatus(order.num)) || order;
  }
  res.json({ order: toPublicOrder(order, { admin: isAdmin }) });
});

app.get('/api/admin/orders', adminRequired, (_req, res) => {
  res.json({ orders: listAllOrders() });
});

app.patch('/api/admin/orders/:num', adminRequired, (req, res) => {
  const order = updateOrderAdmin(req.params.num, req.body || {});
  if (!order) return res.status(404).json({ error: 'Не найден' });
  res.json({ order });
});

app.get('/api/admin/customers', adminRequired, (_req, res) => {
  const orders = listAllOrders();
  const map = {};
  for (const o of orders) {
    const key = (o.email || o.phone || o.customerName || 'guest').toLowerCase();
    if (!map[key]) {
      map[key] = { name: o.customerName, email: o.email, phone: o.phone, orders: 0, sum: 0 };
    }
    map[key].orders += 1;
    map[key].sum += o.price || 0;
  }
  res.json({ customers: Object.values(map) });
});

/* static */
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Серверная ошибка' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Luxe Canvas → ${PUBLIC_URL}`);
  console.log(`Listening 0.0.0.0:${PORT}`);
  console.log(`DB ready · ЮKassa: ${yookassa.configured() ? 'ON' : 'OFF (keys missing)'}`);
  telegramBot.boot(PUBLIC_URL).catch((e) => console.error(e));
});
