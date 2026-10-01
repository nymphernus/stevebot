const logger = require('./logger');

const TIER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

let bot = null;

function setBot(instance) {
  bot = instance;
}

/**
 * Оценка оружия: тир + бонус за зачарование sharpness.
 * Защита от NaN при отсутствии зачарований.
 */
function weaponScore(item) {
  const tierIdx = TIER.findIndex(t => item.name.startsWith(t));
  const tierScore = tierIdx >= 0 ? (TIER.length - tierIdx) * 1000 : 0;
  const sharp = item.enchants?.find(e => e.name === 'sharpness');
  const sharpBonus = sharp ? sharp.lvl * 50 : 0;
  return tierScore + sharpBonus;
}

/**
 * Проверить, является ли предмет оружием (меч или топор).
 */
function isWeapon(item) {
  if (!item) return false;
  return item.name.endsWith('_sword') || item.name.endsWith('_axe');
}

/**
 * Экипировать лучшее оружие: сначала меч, потом топор.
 */
async function equipBestWeapon() {
  if (!bot || !bot.entity) return false;

  const items = bot.inventory.items();
  const swords = items.filter(i => i.name.endsWith('_sword'));
  const axes = items.filter(i => i.name.endsWith('_axe'));

  const pool = swords.length ? swords : axes;
  if (!pool.length) return false;

  pool.sort((a, b) => weaponScore(b) - weaponScore(a));
  const best = pool[0];

  // Не переэкипировываем, если уже в руке
  const held = bot.heldItem;
  if (held && held.name === best.name) return true;

  try {
    await bot.equip(best, 'hand');
    logger.info(`[🗡] В руке: ${best.name}`);
    return true;
  } catch (e) {
    logger.error(`[🗡] Не удалось экипировать ${best.name}: ${e.message}`);
    return false;
  }
}

/**
 * Проверить, нужно ли экипировать оружие.
 * Возвращает true, если в руке нет оружия и бот не ест.
 */
function needsWeapon() {
  if (!bot) return false;

  const held = bot.heldItem;
  if (held && isWeapon(held)) return false; // уже оружие в руке

  // Не трогаем, если бот ест
  if (bot.autoEat?.isEating) return false;

  return true;
}

/**
 * Экипировать щит в левую руку (если есть).
 */
async function equipShield() {
  if (!bot) return false;

  const shield = bot.inventory.items().find(i => i.name === 'shield');
  if (!shield) return false;

  // Уже в off-hand
  if (bot.inventory.slots[45]?.name === 'shield') return true;

  await bot.equip(shield, 'off-hand');
  logger.info('[🛡] Щит в левой руке');
  return true;
}

module.exports = {
  setBot,
  equipBestWeapon,
  equipShield,
  weaponScore,
  isWeapon,
  needsWeapon
};
