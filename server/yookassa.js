const { randomUUID } = require('crypto');

function configured() {
  return !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET);
}

async function createPayment({ amount, description, orderNum, returnUrl, metadata }) {
  if (!configured()) {
    const err = new Error('ЮKassa не настроена: укажите YOOKASSA_SHOP_ID и YOOKASSA_SECRET в .env');
    err.status = 503;
    err.code = 'YOOKASSA_NOT_CONFIGURED';
    throw err;
  }

  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET;
  const auth = Buffer.from(`${shopId}:${secret}`).toString('base64');

  const body = {
    amount: {
      value: (Math.round(amount) / 1).toFixed(2),
      currency: 'RUB'
    },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: returnUrl
    },
    description: description || `Заказ №${orderNum}`,
    metadata: Object.assign({ orderNum: String(orderNum) }, metadata || {})
  };

  const res = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Idempotence-Key': randomUUID()
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.description) || (data && data.message) || 'Ошибка ЮKassa';
    const err = new Error(msg);
    err.status = 502;
    err.details = data;
    throw err;
  }
  return data;
}

async function getPayment(paymentId) {
  if (!configured()) return null;
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET;
  const auth = Buffer.from(`${shopId}:${secret}`).toString('base64');
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = { configured, createPayment, getPayment };
