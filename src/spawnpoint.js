const logger = require('./logger');
const { goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;

let bot = null;
let spawnPoint = null;

function fmt(p) {
  return `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;
}

/**
 * Запомнить текущую точку как спавн-точку.
 */
function setCurrent() {
  if (!bot || !bot.entity) return null;
  try {
    spawnPoint = bot.entity.position.clone();
  } catch (e) {
    spawnPoint = bot.entity.position;
  }
  logger.info(`[🏠] Спавн-точка установлена: ${fmt(spawnPoint)}`);
  return spawnPoint;
}

/**
 * Пойти к спавн-точке.
 */
function goTo() {
  if (!spawnPoint) return false;
  if (!bot || !bot.entity || !bot.pathfinder) return false;
  try {
    bot.pathfinder.setGoal(new GoalBlock(spawnPoint.x, spawnPoint.y, spawnPoint.z), true);
    return true;
  } catch (e) {
    logger.info(`[🏠] не удалось идти к спавн-точке: ${e.message}`);
    return false;
  }
}

/**
 * Текущее состояние спавн-точки.
 */
function get() {
  if (!spawnPoint) return { set: false, pos: null };
  return {
    set: true,
    pos: {
      x: Math.round(spawnPoint.x),
      y: Math.round(spawnPoint.y),
      z: Math.round(spawnPoint.z)
    }
  };
}

function reset() {
  spawnPoint = null;
}

function setBot(instance) {
  bot = instance;

  // При смерти не возвращаемся сами — только подсказываем точку
  if (bot && typeof bot.on === 'function' && !bot.__spawnpointBound) {
    bot.__spawnpointBound = true;
    bot.on('death', () => {
      if (spawnPoint) {
        logger.info(`[🏠] Спавн-точка: ${fmt(spawnPoint)} (используй !gohome)`);
      }
    });
  }
}

module.exports = {
  setBot,
  setCurrent,
  goTo,
  get,
  reset
};
