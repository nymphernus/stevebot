const logger = require('./logger');
const { goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;

let bot = null;
let enabled = true;

// Радиус поиска дропа
const PICKUP_RANGE = 8;
// Антиспам лога
const LOG_INTERVAL = 5000;
let lastLogAt = 0;

// id сущности, к которой уже идём — чтобы не переставлять цель каждый тик
let goalEntityId = null;
// Счётчик успешных подборов
let picked = 0;
// Бот следует за игроком — лутом не отвлекаемся
let following = false;

function now() {
  return Date.now();
}

/**
 * Понятное имя дропа: у item-сущности name всегда 'item',
 * поэтому берём displayName, а если его нет — id.
 */
function displayName(item) {
  if (item.displayName && item.displayName !== 'Item') return item.displayName;

  // Надёжный путь: mineflayer сам умеет разбирать item-сущность
  try {
    if (typeof item.getDroppedItem === 'function') {
      const dropped = item.getDroppedItem();
      if (dropped && dropped.name) return dropped.name;
    }
  } catch (e) { /* нет метода — идём к metadata */ }

  // Запасной путь: metadata[9].itemId. В minecraft-data объект items
  // индексирован ЧИСЛОВЫМ id (проверено: items[1114] = 'rotten_flesh'),
  // itemsById в этой версии отсутствует.
  const meta = item.metadata;
  if (Array.isArray(meta) && meta[9] && typeof meta[9] === 'object') {
    const id = meta[9].itemId;
    if (id != null) {
      try {
        const data = require('minecraft-data')(bot.version);
        const found = (data.items && data.items[id]) || (data.itemsById && data.itemsById[id]) || null;
        if (found && found.name) return found.name;
      } catch (e) { /* реестр может отсутствовать — не критично */ }
    }
  }
  return 'предмет';
}

/**
 * Является ли сущность выпавшим предметом.
 *
 * Проверено на сервере 1.21.11 через !dumpitems:
 *   type=other name=item displayName=Item entityType=71
 * То есть type у дропа — 'other', а не 'object'. Жёсткая проверка
 * type === 'object' отсекала весь лот.
 *
 * Устаревшее поле типа сущности НЕ читаем: prismarine-entity печатает
 * на него console.trace при каждом обращении — десятки строк в секунду.
 */
function isItemEntity(e) {
  if (!e || !e.position) return false;
  // mineflayer 4.x: предмет — это entity с name === 'item'
  if (e.name === 'item') return true;
  // displayName — актуальное поле вместо устаревшего
  if (typeof e.displayName === 'string' && e.displayName.toLowerCase() === 'item') return true;
  // fallback по entityType
  if (e.entityType === 'item') return true;
  return false;
}

/**
 * Ближайшие выпавшие предметы, отсортированные по расстоянию.
 */
function nearbyItems() {
  try {
    if (!bot || !bot.entity) return [];
    const list = Object.values(bot.entities || {}).filter(
      (e) => isItemEntity(e) && e.isValid !== false && e !== bot.entity
    );
    return list
      .map((e) => ({ e, d: e.position.distanceTo(bot.entity.position) }))
      .filter((x) => x.d < PICKUP_RANGE)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.e);
  } catch (e) {
    return [];
  }
}

/**
 * Тик автоподбора. Вызывается из bot.js раз в 20 тиков.
 * Во время боя не отвлекаемся — дроп соберём после.
 */
async function onTick() {
  if (!enabled || !bot || !bot.entity || !bot.pathfinder) return;
  if (require('./ranged').getTarget()) return;
  if (following) return;   // во время следования за игроком цель не перебиваем

  const list = nearbyItems();
  if (!list.length) {
    goalEntityId = null;
    return;
  }

  const item = list[0];

  // Уже идём к этому предмету — цель не переставляем
  if (goalEntityId === item.id) return;
  goalEntityId = item.id;

  const p = item.position;

  try {
    // Цель — блок ПОД предметом: дроп часто висит в воздухе,
    // и pathfinder не находит путь к координате без опоры
    bot.pathfinder.setGoal(
      new GoalNear(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), 1),
      true
    );
  } catch (e) {
    logger.info(`[💰] ошибка постановки цели: ${e.message}`);
    goalEntityId = null;
    return;
  }

  if (now() - lastLogAt >= LOG_INTERVAL) {
    lastLogAt = now();
    logger.info(`[💰] Подбираю предмет рядом: ${displayName(item)}`);
  }
}

/**
 * Диагностика: все сущности в радиусе 12 блоков с их полями.
 * Нужна, чтобы понять, как mineflayer на этой версии сервера
 * называет выпавшие предметы.
 */
function dumpNearbyItems() {
  if (!bot || !bot.entity) return 0;

  const all = Object.values(bot.entities || {});
  const withPos = all.filter((e) => e && e.position);

  // Сводка: сколько всего и по типам — чтобы понять, пуст ли entities вообще
  const byType = {};
  for (const e of all) {
    const t = (e && e.type) || 'null';
    byType[t] = (byType[t] || 0) + 1;
  }
  logger.info(
    `[🔍] всего в entities: ${all.length}, с позицией: ${withPos.length}, ` +
    `бот: ${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`
  );
  logger.info(`[🔍] по типам: ${JSON.stringify(byType)}`);

  let objs;
  try {
    objs = withPos.filter((e) =>
      e.position.distanceTo(bot.entity.position) < 12 &&
      e !== bot.entity
    );
  } catch (e) {
    logger.info(`[🔍] ошибка фильтрации: ${e.message}`);
    return 0;
  }

  logger.info(`[🔍] сущностей в радиусе 12м: ${objs.length}`);
  for (const e of objs) {
    const d = e.position.distanceTo(bot.entity.position);
    logger.info(
      `[🔍] entity: type=${e.type} name=${e.name} displayName=${e.displayName} ` +
      `entityType=${e.entityType} metadata=${JSON.stringify(e.metadata)} ` +
      `pos=${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)} dist=${d.toFixed(1)}`
    );
  }
  return objs.length;
}

function setBot(instance) {
  bot = instance;
  lastLogAt = 0;
  goalEntityId = null;
  picked = 0;

  // Счётчик успеха: предмет реально поднят, а не просто достигнут
  if (bot && typeof bot.on === 'function' && !bot.__lootingBound) {
    bot.__lootingBound = true;
    bot.on('playerCollect', (collector) => {
      if (!bot || collector !== bot.entity) return;
      picked++;
      logger.info(`[💰] Подобрал (всего ${picked})`);
    });
  }
}

/**
 * Флаг следования за игроком: во время follow лут не собираем,
 * чтобы не увести бота от цели.
 */
function setFollowing(value) {
  following = !!value;
}

function enable() {
  enabled = true;
}

function disable() {
  enabled = false;
}

function getStatus() {
  const list = enabled && bot?.entity ? nearbyItems() : [];
  return {
    enabled,
    nearby: list.length,
    picked,
    following
  };
}

module.exports = {
  setBot,
  onTick,
  enable,
  disable,
  getStatus,
  setFollowing,
  dumpNearbyItems
};
