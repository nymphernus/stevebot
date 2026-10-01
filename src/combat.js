const logger = require('./logger');

const HOSTILE_RANGE = 10;
const WATCHDOG_TIMEOUT = 600; // 30 секунд (20 тиков/сек * 30)

let bot = null;
let pvpStartTime = 0;
let lastTargetPos = null;

function setBot(instance) {
  bot = instance;
}

/**
 * Мобы, которых сервер отдаёт не как hostile — летающие и ночные.
 * Без них бот их не видит: filter по type их отсекает.
 */
const ATTACKABLE_NAMES = new Set([
  'phantom', 'ghast', 'magma_cube', 'slime',
  'hoglin', 'zoglin', 'blaze', 'vex'
]);

/**
 * Найти ближайшего враждебного моба в радиусе.
 * Используем фильтр hostile, а не mob — слизни, големы и аллеи не враждебны.
 */
function findHostileMob(range = HOSTILE_RANGE) {
  if (!bot) return null;

  const r = range ?? HOSTILE_RANGE;

  return bot.nearestEntity(e => {
    if (!e.isValid) return false;
    if (e.position.distanceTo(bot.entity.position) >= r) return false;
    if (e.type === 'hostile') return true;
    const name = (e.name || '').toLowerCase();
    return ATTACKABLE_NAMES.has(name);
  });
}

/**
 * Сторожевой таймер: если бой длится > 30 секунд и цель не двигается — сбрасываем.
 */
function checkWatchdog(tickCounter) {
  const target = require('./ranged').getTarget();
  if (!bot || !target) {
    pvpStartTime = 0;
    lastTargetPos = null;
    return;
  }

  // Начинаем отсчёт
  if (pvpStartTime === 0) {
    pvpStartTime = tickCounter;
    lastTargetPos = target.position.clone();
    return;
  }

  // Проверяем, двигается ли цель
  const moved = lastTargetPos && target.position.distanceTo(lastTargetPos) > 0.5;
  if (moved) {
    pvpStartTime = tickCounter;
    lastTargetPos = target.position.clone();
    return;
  }

  // Если цель не двигается > 30 секунд — сбрасываем бой
  if (tickCounter - pvpStartTime > WATCHDOG_TIMEOUT) {
    logger.warn(`[⚔] Сторожевой таймер: бой длится >30с, цель не двигается. Сбрасываем.`);
    require('./ranged').clearTarget();
    pvpStartTime = 0;
    lastTargetPos = null;
  }
}

/**
 * Атаковать моба, если бот ещё не в бою.
 */
function autoAttack(range = HOSTILE_RANGE) {
  const ranged = require('./ranged');
  if (!bot || ranged.getTarget()) return; // уже сражается

  const r = range ?? HOSTILE_RANGE;
  const mob = findHostileMob(r);

  if (!mob) return;

  ranged.setTarget(mob);
  pvpStartTime = 0; // сбрасываем сторожевой таймер
  lastTargetPos = null;
  logger.info(`[⚔] Цель: ${mob.name || mob.displayName} @ ${mob.position.distanceTo(bot.entity.position).toFixed(1)}м`);
}

/**
 * Остановить бой.
 */
function stopCombat() {
  try { require('./ranged').clearTarget(); } catch {}
  logger.info('[⚔] Бой остановлен');
}

/**
 * Атаковать конкретного моба.
 */
function attackEntity(entity) {
  if (!bot || !entity || !entity.isValid) return false;
  const ranged = require('./ranged');
  ranged.setTarget(entity);
  pvpStartTime = 0;
  lastTargetPos = null;
  return true;
}

/**
 * Получить количество враждебных мобов в радиусе (для диагностики).
 */
function countHostiles(range = HOSTILE_RANGE) {
  if (!bot) return 0;

  const r = range ?? HOSTILE_RANGE;

  return Object.values(bot.entities).filter(e =>
    e.type === 'hostile' &&
    e.isValid &&
    e.position.distanceTo(bot.entity.position) < r
  ).length;
}

module.exports = {
  setBot,
  findHostileMob,
  autoAttack,
  attackEntity,
  stopCombat,
  checkWatchdog,
  countHostiles,
  HOSTILE_RANGE
};
