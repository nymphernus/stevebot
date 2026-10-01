const { Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow } = goals;
const mcData = require('minecraft-data');
const logger = require('./logger');

let bot = null;
let currentTarget = null;

function setBot(instance) {
  bot = instance;
}

function startFollowing(name, followDistance) {
  stopFollowing();

  const player = bot.players[name];
  if (!player || !player.entity) {
    logger.warn(`Игрок ${name} не найден или не имеет entity`);
    return false;
  }

  const data = mcData(bot.version);
  const movements = new Movements(bot, data);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);

  // dynamic = true — путь пересчитывается при движении игрока
  bot.pathfinder.setGoal(new GoalFollow(player.entity, followDistance), true);
  currentTarget = name;
  logger.info(`Следую за ${name}`);
  return true;
}

function stopFollowing() {
  if (bot && bot.pathfinder) {
    bot.pathfinder.setGoal(null);
  }
  currentTarget = null;
}

function getCurrentTarget() {
  return currentTarget;
}

module.exports = {
  setBot,
  startFollowing,
  stopFollowing,
  getCurrentTarget
};
