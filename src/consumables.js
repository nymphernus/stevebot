const logger = require('./logger');
const config = require('../config.json');
const equipment = require('./equipment');

let bot = null;

let lastHealAt = 0;
const HEAL_COOLDOWN_MS = 10000;

let lastFoodAt = 0;
const FOOD_COOLDOWN_MS = 5000;

let healingInProgress = false;

function isHealing() {
  return healingInProgress;
}

// Реестр зелий и эффектов — заполняется при spawn
let potionsRegistry = null;
let effectsRegistry = null;

const HEALING_POTIONS = new Set([
  'minecraft:healing',
  'minecraft:strong_healing',
  'minecraft:regeneration',
  'minecraft:long_regeneration',
  'minecraft:strong_regeneration'
]);

const HEALTH_EFFECTS = new Set(['minecraft:instant_health', 'minecraft:regeneration']);

// potionId, которые уже попробовали и эффекта не дали
const blacklistedPotionIds = new Set();

// Счётчики расходов — независимы от логов
let stats = {
  potionsTried: 0, potionsEffective: 0,
  applesTried: 0, applesEffective: 0,
  foodTried: 0, foodEffective: 0
};

function getStats() {
  return { ...stats, blacklisted: [...blacklistedPotionIds] };
}

// Сигнатура последнего предупреждения «все зелья в чёрном списке»
let lastAllBlacklistedSig = null;

// Один раз на неизменный инвентарь: подсказать про !clearpotions
function logAllBlacklistedIfAny() {
  if (!bot || !bot.entity) return;
  const pots = bot.inventory.items().filter(isPotionItem);
  if (!pots.length) return;

  const ids = pots.map(getPotionId);
  const allBlack = ids.every(id => id != null && blacklistedPotionIds.has(id));
  if (!allBlack) return;

  const sig = ids.join(',');
  if (sig === lastAllBlacklistedSig) return;
  lastAllBlacklistedSig = sig;
  logger.warn(`[🍖] все зелья в инвентаре в чёрном списке (${pots.length} шт), пропускаю — используй !clearpotions для сброса`);
}

function clearPotionBlacklist() {
  logger.info(`[🍖] clearPotionBlacklist() вызван из:\n${new Error().stack}`);
  blacklistedPotionIds.clear();
  lastAllBlacklistedSig = null;
  logger.info('[🍖] Чёрный список зелий: очищен');
}

const POTION_ITEM_NAMES = ['potion', 'splash_potion', 'lingering_potion'];

// Имя без пространства имён и без не-буквенных символов:
// 'minecraft:strong_healing' -> 'stronghealing', 'InstantHealth' -> 'instanthealth'
function normName(value) {
  return String(value).toLowerCase().replace(/^minecraft[:.]/, '').replace(/[^a-z]/g, '');
}

function setBot(instance) {
  bot = instance;
  if (!bot || bot.__potionsHooked) return;
  bot.__potionsHooked = true;
  bot.once('spawn', () => {
    // Чёрный список живёт только до реконнекта
    blacklistedPotionIds.clear();
    lastAllBlacklistedSig = null;

    const reg = bot.registry || {};
    potionsRegistry = reg.potions || null;
    effectsRegistry = reg.effects || null;

    logger.info(`[🍖] potions registry: ${potionsRegistry ? 'OK' : 'MISSING'}`);
    logger.info(`[🍖] effects registry: ${effectsRegistry ? 'OK' : 'MISSING'}`);
  });
}

function getPotionId(item) {
  if (!item || !Array.isArray(item.components)) return null;
  for (const c of item.components) {
    if (c && c.type === 'potion_contents' && c.data &&
        typeof c.data.potionId === 'number') {
      return c.data.potionId;
    }
  }
  return null;
}

function isPotionItem(item) {
  if (!item || !item.name) return false;
  return POTION_ITEM_NAMES.includes(item.name.split(':').pop());
}

// Уровень 1: имя зелья из реестра
function getRegistryPotionName(item) {
  const id = getPotionId(item);
  if (id == null) return null;

  let reg = potionsRegistry;
  if (!reg && bot && bot.version) {
    try { reg = require('minecraft-data')(bot.version).potions || null; } catch (e) { reg = null; }
  }
  if (!reg) return null;

  const entry = Array.isArray(reg) ? reg[id] : reg[id];
  if (!entry) return null;
  const name = typeof entry === 'string' ? entry : (entry.name || entry.displayName);
  return name || null;
}

// Уровень 2: customEffects внутри potion_contents
function hasHealingCustomEffect(item) {
  if (!item || !Array.isArray(item.components)) return false;
  let reg = effectsRegistry;
  if (!reg && bot && bot.version) {
    try { reg = require('minecraft-data')(bot.version).effects || null; } catch (e) { reg = null; }
  }
  if (!reg) return false;

  for (const c of item.components) {
    if (!c || c.type !== 'potion_contents' || !c.data) continue;
    const effects = Array.isArray(c.data.customEffects) ? c.data.customEffects : [];
    for (const eff of effects) {
      if (!eff || typeof eff.effectId !== 'number') continue;
      const entry = Array.isArray(reg) ? reg[eff.effectId] : reg[eff.effectId];
      if (!entry) continue;
      const name = typeof entry === 'string' ? entry : (entry.name || entry.displayName);
      if (!name) continue;
      const short = name.replace(/^minecraft[:.]/, '');
      for (const want of HEALTH_EFFECTS) {
        if (normName(want) === normName(short)) return true;
      }
    }
  }
  return false;
}

function isWeapon(item) {
  if (!item || !item.name) return false;
  const n = item.name.split(':').pop();
  return n.endsWith('_sword') || n.endsWith('_axe');
}

function needsWeapon() {
  if (!bot || !bot.entity) return false;
  return !isWeapon(bot.heldItem);
}

function findHealingPotion() {
  if (!bot || !bot.entity) return null;
  const items = bot.inventory.items().filter(isPotionItem);

  // Уровень 1: имя зелья из реестра
  for (const item of items) {
    const name = getRegistryPotionName(item);
    if (!name) continue;
    const short = name.replace(/^minecraft[:.]/, '');
    for (const want of HEALING_POTIONS) {
      if (normName(want) === normName(short)) return item;
    }
  }

  // Уровень 2: customEffects внутри potion_contents
  for (const item of items) {
    if (hasHealingCustomEffect(item)) return item;
  }

  // Уровень 3: чёрный список — пробуем то, что ещё не пробовали
  for (const item of items) {
    const id = getPotionId(item);
    if (id != null && blacklistedPotionIds.has(id)) continue;
    return item;
  }

  return null;
}

// Отчёт по всем зельям в инвентаре — для команды !potions
function describePotions() {
  if (!bot || !bot.entity) return ['Бот не подключён'];

  const reg = potionsRegistry ||
    (bot.registry && bot.registry.potions) || null;
  const regEffects = effectsRegistry ||
    (bot.registry && bot.registry.effects) || null;

  const lines = [];
  lines.push(
    `[POTIONS] registry=${reg ? 'OK' : 'MISSING'} ` +
    `typeof=${typeof (bot.registry && bot.registry.potions)}`
  );
  lines.push(
    `[POTIONS] effectsRegistry=${regEffects ? 'OK' : 'MISSING'} ` +
    `blacklist=[${Array.from(blacklistedPotionIds).join(',')}]`
  );

  const pots = bot.inventory.items().filter(isPotionItem);
  lines.push(`[POTIONS] всего=${pots.length}`);

  for (const item of pots) {
    const id = getPotionId(item);
    const registryName = (() => {
      const n = getRegistryPotionName(item);
      return n === null ? 'undefined' : n;
    })();
    lines.push(
      `id=${id} name=${item.name} displayName=${item.displayName} ` +
      `components=${JSON.stringify(item.components)} registryName=${registryName}`
    );
  }

  return lines;
}

function findGoldenApple() {
  if (!bot || !bot.entity) return null;
  return bot.inventory.items().find(item => {
    const n = item.name.split(':').pop();
    return n === 'golden_apple' || n === 'enchanted_golden_apple';
  }) || null;
}

function findFood() {
  if (!bot || !bot.entity) return null;
  const foodNames = [
    'golden_carrot', 'cooked_beef', 'cooked_porkchop',
    'cooked_chicken', 'cooked_mutton', 'bread',
    'baked_potato', 'cooked_salmon', 'cooked_cod'
  ];
  return bot.inventory.items().find(item => {
    const n = item.name.split(':').pop();
    return foodNames.includes(n);
  }) || null;
}

function setupAutoEat() {
  if (!bot || !bot.autoEat) return;
  bot.autoEat.options = {
    priority: 'foodPoints',
    startAt: config.autoEatStartAt ?? 14,
    bannedFood: ['golden_apple', 'enchanted_golden_apple', 'potion'],
    equipOldItem: true
  };
}

async function consumeItem(item, label) {
  if (!bot || !bot.entity || !item) return false;
  try {
    await bot.equip(item, 'hand');
    await bot.consume();
    return true;
  } catch (e) {
    logger.error(`[🍖] Ошибка (${label}): ${e.message}`);
    return false;
  }
}

async function autoHeal() {
  if (!bot || !bot.entity) return;
  if (healingInProgress) return;
  if (require('./ranged').getTarget()) return;
  if (bot.health <= 0) return;
  if (bot.autoEat && bot.autoEat.isEating) return;

  // Еда не блокируется кулдауном зелья — это разные ресурсы.
  const foodReady = (bot.food ?? 20) < 14 && (Date.now() - lastFoodAt >= FOOD_COOLDOWN_MS);
  if (Date.now() - lastHealAt < HEAL_COOLDOWN_MS && !foodReady) return;

  healingInProgress = true;
  try {
    await autoHealInner();
  } finally {
    healingInProgress = false;
  }
}

async function autoHealInner() {
  const hp = bot.health ?? 20;
  const food = bot.food ?? 20;
  const healThreshold = config.autoHealThreshold ?? 10;
  const criticalThreshold = config.autoHealCriticalThreshold ?? 6;

  if (hp < healThreshold) {
    const potion = findHealingPotion();
    if (potion) {
      // Защита от повторной попытки: не пить то, что уже не сработало
      const pid = getPotionId(potion);
      if (pid != null && blacklistedPotionIds.has(pid)) return;

      const hpBefore = bot.health;
      const label = `Пью ${potion.displayName || potion.name}`;
      const ok = await consumeItem(potion, label);
      if (ok) stats.potionsTried++;
      if (ok && bot.health > hpBefore) {
        stats.potionsEffective++;
        lastHealAt = Date.now();
        logger.info(`[🍖] ${label}`);
        await equipment.equipBestWeapon().catch(() => {});
        return;
      }
      if (ok) {
        const pidAfter = getPotionId(potion);
        if (pidAfter != null) blacklistedPotionIds.add(pidAfter);
        logger.warn(`[🍖] ${potion.name} использован, эффекта нет — id=${pidAfter} в чёрный список (hp=${Math.round(bot.health)}, food=${Math.round(bot.food)})`);
      }
    } else {
      logAllBlacklistedIfAny();
    }
  }

  if (hp < criticalThreshold) {
    const apple = findGoldenApple();
    if (apple) {
      const hpBefore = bot.health;
      const label = `Съел ${apple.name}`;
      const ok = await consumeItem(apple, label);
      if (ok) stats.applesTried++;
      if (ok && bot.health > hpBefore) {
        stats.applesEffective++;
        lastHealAt = Date.now();
        logger.info(`[🍖] ${label}`);
        await equipment.equipBestWeapon().catch(() => {});
        return;
      }
      if (ok) {
        logger.warn(`[🍖] ${apple.name} использован, но эффекта нет (hp=${Math.round(bot.health)}, food=${Math.round(bot.food)})`);
      }
    }
  }

  if (food < 14) {
    const foodItem = findFood();
    if (foodItem) {
      const foodBefore = bot.food;
      const label = `Съел ${foodItem.name}`;
      const ok = await consumeItem(foodItem, label);
      if (ok) stats.foodTried++;
      if (ok && bot.food > foodBefore) {
        stats.foodEffective++;
        lastFoodAt = Date.now();
        logger.info(`[🍖] ${label}`);
        await equipment.equipBestWeapon().catch(() => {});
      } else if (ok) {
        logger.warn(`[🍖] ${foodItem.name} использован, но эффекта нет (hp=${Math.round(bot.health)}, food=${Math.round(bot.food)})`);
      }
    }
  }
}

async function drinkPotion() {
  const potion = findHealingPotion();
  if (!potion) return false;
  const hpBefore = bot ? bot.health : 0;
  const label = `Пью ${potion.displayName || potion.name}`;
  const ok = await consumeItem(potion, label);
  if (ok) stats.potionsTried++;
  if (ok && bot && bot.health > hpBefore) {
    stats.potionsEffective++;
    lastHealAt = Date.now();
    logger.info(`[🍖] ${label}`);
    await equipment.equipBestWeapon().catch(() => {});
    return true;
  }
  return false;
}

function trackPreEatWeapon() {
  // Не требуется: autoHeal сам вызывает equipBestWeapon после еды.
}

function returnWeaponAfterEat() {
  // Не требуется: autoHeal сам вызывает equipBestWeapon после еды.
}

module.exports = {
  setBot,
  setupAutoEat,
  isHealing,
  autoHeal,
  drinkPotion,
  describePotions,
  getStats,
  clearPotionBlacklist,
  trackPreEatWeapon,
  returnWeaponAfterEat
};