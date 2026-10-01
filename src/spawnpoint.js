const logger = require('./logger');
const { goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;

let bot = null;
let spawnPoint = null;

function fmt(p) {
  return `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;
}

function setBot(instance) {
  bot = instance;

  if (bot && typeof bot.on === 'function' && !bot.__spawnpointBound) {
    bot.__spawnpointBound = true;
    bot.on('death', () => {
      if (spawnPoint) {
        logger.info(`[🏠] Смерть. Дом: ${fmt(spawnPoint)}`);
      } else {
        logger.info('[🏠] Смерть. Дом: не задан');
      }
    });
  }
}

async function setHome() {
  if (!bot || !bot.entity) {
    logger.warn('[🏠] setHome: бот не подключён');
    return false;
  }

  const bedBlock = bot.findBlock({
    matching: (b) => b && b.name && b.name.endsWith('_bed'),
    maxDistance: 32
  });

  if (bedBlock) {
    const dist = bot.entity.position.distanceTo(bedBlock.position);
    logger.info(`[🏠] Найдена кровать на ${dist.toFixed(1)}м, иду к ней`);
    try {
      await bot.pathfinder.goto(new GoalBlock(
        bedBlock.position.x, bedBlock.position.y, bedBlock.position.z
      ));
      await bot.sleep(bedBlock);
      spawnPoint = bot.spawnPoint ? bot.spawnPoint.clone() : bot.entity.position.clone();
      logger.info(`[🏠] Дом установлен (кровать): ${fmt(spawnPoint)}`);
      return true;
    } catch (e) {
      logger.warn(`[🏠] Сон не удался (${e.message || 'не ночь или монстры рядом'}), сохраняю координаты`);
    }
  } else {
    logger.info('[🏠] Кровать не найдена, сохраняю координаты');
  }

  spawnPoint = bot.entity.position.clone();
  logger.info(`[🏠] Дом установлен (координаты): ${fmt(spawnPoint)}`);
  return true;
}

function setCurrent() {
  return setHome();
}

function goHome() {
  if (!bot || !bot.entity) {
    logger.warn('[🏠] goHome: бот не подключён');
    return false;
  }
  if (!spawnPoint) {
    logger.warn('[🏠] Дом не задан — используй !sethome');
    return false;
  }
  try {
    bot.pathfinder.setGoal(new GoalBlock(spawnPoint.x, spawnPoint.y, spawnPoint.z));
    logger.info(`[🏠] Иду к дому (${fmt(spawnPoint)})`);
    return true;
  } catch (e) {
    logger.info(`[🏠] Не удалось идти к дому: ${e.message}`);
    return false;
  }
}

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

module.exports = {
  setBot,
  setHome,
  setCurrent,
  goHome,
  goTo: goHome,
  get,
  reset
};
