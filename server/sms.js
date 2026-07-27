/**
 * SMS OTP. Провайдер: SMS.ru (SMS_RU_API_ID).
 * Без ключа — DEV-режим: код в лог сервера (и в ответе если SMS_DEV=1).
 * Полностью бесплатной SMS-рассылки по РФ в проде нет.
 */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (!/^7\d{10}$/.test(d)) return '';
  return d;
}

function formatPhoneDisplay(digits) {
  const d = normalizePhone(digits);
  if (!d) return String(digits || '');
  return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

function smsConfigured() {
  const id = String(process.env.SMS_RU_API_ID || '').trim();
  return !!(id && id !== 'change-me' && !/^change/i.test(id));
}

function isDevSms() {
  return process.env.SMS_DEV === '1' || process.env.SMS_DEV === 'true' || !smsConfigured();
}

async function sendSms(phone, text) {
  const to = normalizePhone(phone);
  if (!to) throw Object.assign(new Error('Некорректный номер'), { status: 400 });

  if (!smsConfigured()) {
    console.log(`[SMS DEV] → +${to}: ${text}`);
    return { ok: true, provider: 'dev', phone: to };
  }

  const apiId = String(process.env.SMS_RU_API_ID).trim();
  const url = new URL('https://sms.ru/sms/send');
  url.searchParams.set('api_id', apiId);
  url.searchParams.set('to', to);
  url.searchParams.set('msg', text);
  url.searchParams.set('json', '1');

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => ({}));
  if (data.status !== 'OK' && data.status_code !== 100) {
    const msg = data.status_text || data.status || 'SMS не отправлено';
    throw Object.assign(new Error(String(msg)), { status: 502, sms: data });
  }
  return { ok: true, provider: 'sms.ru', phone: to, raw: data };
}

module.exports = {
  normalizePhone,
  formatPhoneDisplay,
  smsConfigured,
  isDevSms,
  sendSms
};
