/**
 * Telegram-админы магазина (пуш «Новый заказ» + кнопки в боте + авто-вход).
 * Не путать с ADMIN_EMAIL на сайте.
 *
 * Источники (объединяются):
 *   TELEGRAM_CHAT_ID / TELEGRAM_CHAT_IDS — через запятую
 *   data/tg-owner.json — chatId или chatIds[]
 *   первый /start — только если список ещё пуст
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const FILE = path.join(DATA_DIR, 'tg-owner.json');

function parseIds(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'Значение' && !/^change/i.test(s) && /^-?\d+$/.test(s));
}

function envChatIds() {
  const a = parseIds(process.env.TELEGRAM_CHAT_ID);
  const b = parseIds(process.env.TELEGRAM_CHAT_IDS);
  return [...new Set([...a, ...b])];
}

function readStored() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j) return null;
    const ids = [];
    if (Array.isArray(j.chatIds)) ids.push(...j.chatIds.map(String));
    if (j.chatId != null && String(j.chatId).trim() !== '') ids.push(String(j.chatId));
    const uniq = [...new Set(parseIds(ids.join(',')))];
    if (!uniq.length) return null;
    return {
      chatId: uniq[0],
      chatIds: uniq,
      username: j.username || '',
      name: j.name || '',
      at: j.at || ''
    };
  } catch (_) {}
  return null;
}

function writeStored(chatIds, from = {}) {
  const uniq = [...new Set(parseIds(chatIds.join(',')))];
  if (!uniq.length) return;
  const data = {
    chatId: uniq[0],
    chatIds: uniq,
    username: from.username || '',
    name: [from.first_name, from.last_name].filter(Boolean).join(' ').trim(),
    at: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/** Все chat_id админов бота. */
function getOwnerChatIds() {
  const fromEnv = envChatIds();
  if (fromEnv.length) return fromEnv;
  const stored = readStored();
  return (stored && stored.chatIds) || [];
}

/** Первый админ (совместимость). */
function getOwnerChatId() {
  return getOwnerChatIds()[0] || '';
}

function isOwnerChat(chatId) {
  const id = String(chatId || '');
  if (!id) return false;
  return getOwnerChatIds().includes(id);
}

function hasOwner() {
  return getOwnerChatIds().length > 0;
}

/**
 * Закрепить первого владельца при /start, если список ещё пуст.
 * Уже известные TELEGRAM_CHAT_ID не перезаписываются.
 */
function claimOwner(chatId, from = {}) {
  const id = String(chatId);
  if (isOwnerChat(id)) {
    return { claimed: false, already: true, chatId: id };
  }
  const existing = getOwnerChatIds();
  if (existing.length) {
    return { claimed: false, already: true, chatId: existing[0] };
  }
  writeStored([id], from);
  console.log('Telegram owner claimed:', id, from.username || '');
  return { claimed: true, already: false, chatId: id };
}

module.exports = {
  getOwnerChatId,
  getOwnerChatIds,
  isOwnerChat,
  hasOwner,
  claimOwner,
  FILE
};
