const { goals: { GoalBlock } } = require('mineflayer-pathfinder');
const { Movements } = require('mineflayer-pathfinder');
const mcData = require('minecraft-data');
const logger = require('./logger');

let bot = null;
let guardPosition = null;    // { x, y, z }
let guardRadius = 8;         // макс. удаление от точки
let guardActive = false;
let guardInterval = null;

function setBot(instance) {
  bot = instance;
}

/**
 * Начать охрану текущей позиции бота.
 */
function startGuard(radius = 8) {
  if (!bot) return;

  stopGuard();

  guardPosition = bot.entity.position.clone();
  guardRadius = radius;
  guardActive = true;

  logger.info(`[🏰] Охраняю точку (${guardPosition.x.toFixed(0)}, ${guardPosition.y.toFixed(0)}, ${guardPosition.z.toFixed(0)}), радиус ${radius}`);

  // Каждые 20 тиков (~1 сек) проверяем, не ушёл ли бот далеко
  guardInterval = setInterval(() => {
    if (!guardActive || !guardPosition || !bot) return;

    // Не трогаем, если бот в бою — mineflayer-pvp сам управляет движением
    if (bot.pvp?.target) return;

    const dist = bot.entity.position.distanceTo(guardPosition);
    if (dist > 1.5) {
      // Возвращаемся к точке через GoalBlock
      const { x, y, z } = guardPosition;
      const data = mcData(bot.version);
      const mv = new Movements(bot, data);
      mv.canDig = false;
      bot.pathfinder.setMovements(mv);
      bot.pathfinder.setGoal(new GoalBlock(x, y, z));
      logger.info(`[🏰] Возвращаюсь к точке (${dist.toFixed(1)} > 1.5)`);
    }
  }, 1000);
}

/**
 * Остановить охрану.
 */
function stopGuard() {
  if (guardInterval) {
    clearInterval(guardInterval);
    guardInterval = null;
  }
  guardActive = false;
  guardPosition = null;
  if (bot && bot.pathfinder) bot.pathfinder.setGoal(null);
  logger.info('[🏰] Охрана остановлена');
}

/**
 * Проверить, активна ли охрана.
 */
function isGuarding() {
  return guardActive;
}

/**
 * Получить текущую позицию охраны.
 */
function getGuardPosition() {
  return guardPosition;
}

/**
 * Получить информацию о хранении для !status.
 */
function getGuardInfo() {
  return {
    active: guardActive,
    radius: guardRadius,
    position: guardPosition ? {
      x: guardPosition.x.toFixed(0),
      y: guardPosition.y.toFixed(0),
      z: guardPosition.z.toFixed(0)
    } : null
  };
}

module.exports = {
  setBot,
  startGuard,
  stopGuard,
  isGuarding,
  getGuardPosition,
  getGuardInfo
};
