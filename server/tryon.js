const { tryonServerConfigured } = require('./cms-safe');

/**
 * Примерка только на сервере.
 * Ключи: OPENAI_API_KEY и/или TRYON_API_KEY + TRYON_API_URL — только .env
 */
async function runTryon({ personImage, garmentImage, productId, productName, brand }) {
  if (!personImage || !garmentImage) {
    const err = new Error('Нужны personImage и garmentImage');
    err.status = 400;
    throw err;
  }

  const customUrl = String(process.env.TRYON_API_URL || '').trim();
  const bearer = String(process.env.TRYON_API_KEY || process.env.OPENAI_API_KEY || '').trim();

  if (customUrl) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const res = await fetch(customUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        personImage,
        garmentImage,
        productId,
        productName,
        brand
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('Сервис примерки: ' + res.status));
      err.status = 502;
      throw err;
    }
    const out = data.image || data.imageUrl || data.result || data.url;
    if (!out) {
      const err = new Error('В ответе сервиса нет изображения');
      err.status = 502;
      throw err;
    }
    return { image: out };
  }

  const openaiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (openaiKey) {
    /* Генерация через OpenAI Images — без отдачи ключа клиенту */
    const prompt = [
      'Virtual try-on: show the person wearing the garment from the second reference.',
      'Keep the person identity, pose and background. Realistic e-commerce photo.',
      productName ? `Garment: ${productName}.` : '',
      brand ? `Brand: ${brand}.` : ''
    ].filter(Boolean).join(' ');

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + openaiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
        prompt,
        size: process.env.OPENAI_IMAGE_SIZE || '1024x1536',
        n: 1
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('OpenAI: ' + res.status);
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    const b64 = data.data && data.data[0] && (data.data[0].b64_json || data.data[0].url);
    if (!b64) {
      const err = new Error('OpenAI не вернул изображение');
      err.status = 502;
      throw err;
    }
    const image = String(b64).startsWith('http') || String(b64).startsWith('data:')
      ? b64
      : 'data:image/png;base64,' + b64;
    return { image };
  }

  const err = new Error('Примерка на сервере не настроена');
  err.status = 503;
  err.code = 'TRYON_NOT_CONFIGURED';
  throw err;
}

module.exports = { runTryon, tryonServerConfigured };
