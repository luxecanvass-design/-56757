/** Публичное CMS без секретов. Ключи AI только в process.env. */

function tryonServerConfigured() {
  return !!(
    process.env.TRYON_API_URL ||
    process.env.TRYON_API_KEY ||
    process.env.OPENAI_API_KEY
  );
}

function sanitizeTryon(tryon) {
  const t = tryon && typeof tryon === 'object' ? tryon : {};
  return {
    enabled: t.enabled === true,
    maxSide: +t.maxSide || 1280,
    serverConfigured: tryonServerConfigured()
  };
}

function sanitizeCms(cms) {
  if (!cms || typeof cms !== 'object') return cms;
  const out = JSON.parse(JSON.stringify(cms));
  out.tryon = sanitizeTryon(out.tryon);
  return out;
}

/** Перед сохранением CMS с клиента — выкинуть любые секреты. */
function scrubCmsInput(cms) {
  if (!cms || typeof cms !== 'object') return cms;
  const out = JSON.parse(JSON.stringify(cms));
  if (out.tryon && typeof out.tryon === 'object') {
    out.tryon = {
      enabled: out.tryon.enabled === true,
      maxSide: +out.tryon.maxSide || 1280
    };
  }
  return out;
}

module.exports = {
  sanitizeCms,
  scrubCmsInput,
  sanitizeTryon,
  tryonServerConfigured
};
