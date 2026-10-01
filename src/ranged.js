const logger = require('./logger');
const { goals } = require('mineflayer-pathfinder');

let bot = null;
let currentTarget = null;
let lastAttackAt = 0;
let lastLogAt = 0;

const ATTACK_COOLDOWN_MS = 600;
const CHASE_DISTANCE = 2.5;
const LOSE_DISTANCE = 32;

function setBot(instance) {
  bot = instance;
  if (!bot) return;
  logger.info('[⚔] ranged: собственная логика боя активна');
}

function setTarget(entity) {
  if (!entity || !entity.isValid) return;
  if (currentTarget === entity) return;
  currentTarget = entity;
  logger.info(`[⚔] Цель: ${entity.name} @ ${bot.entity.position.distanceTo(entity.position).toFixed(1)}м`);
}

function clearTarget() {
  if (!currentTarget) return;
  logger.info('[⚔] Цель сброшена');
  currentTarget = null;
}

function getTarget() {
  return currentTarget;
}

async function equipMelee() {
  if (!bot || !bot.entity) return;
  const weapon = bot.inventory.items().find(i =>
    i.name.endsWith('_sword') || i.name.endsWith('_axe'));
  if (weapon) {
    if (!bot.heldItem || bot.heldItem.name !== weapon.name) {
      try { await bot.equip(weapon, 'hand'); } catch {}
    }
  } else {
    if (bot.heldItem) {
      try { await bot.unequip('hand'); } catch {}
    }
  }
}

async function onTick(tickCounter) {
  if (!bot || !bot.entity) return;

  // Валидация цели
  if (currentTarget && (!currentTarget.isValid || !currentTarget.position)) {
    clearTarget();
    return;
  }
  if (currentTarget) {
    const dist = bot.entity.position.distanceTo(currentTarget.position);
    if (dist > LOSE_DISTANCE) {
      logger.info(`[⚔] Цель потеряна (dist=${dist.toFixed(1)})`);
      clearTarget();
      return;
    }
  }

  if (!currentTarget) return;

  const dist = bot.entity.position.distanceTo(currentTarget.position);

  // Оружие в руку или рука пустая
  await equipMelee();

  if (dist > CHASE_DISTANCE) {
    // Погоня: обновлять goal раз в 10 тиков
    if (tickCounter % 10 === 0) {
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(currentTarget, CHASE_DISTANCE), true);
      } catch (e) {
        logger.error(`[⚔] setGoal ошибка: ${e.message}`);
      }
      // Раз в секунду — расстояние, чтобы видеть, сходится ли бот
      if (Date.now() - lastLogAt > 1000) {
        lastLogAt = Date.now();
        logger.info(`[⚔] Погоня: ${currentTarget.name} @ ${dist.toFixed(1)}м`);
      }
    }
    return;
  }

  // Ближний бой
  if (Date.now() - lastAttackAt < ATTACK_COOLDOWN_MS) return;
  lastAttackAt = Date.now();
  try {
    await bot.lookAt(currentTarget.position.offset(0, 1, 0));
    bot.attack(currentTarget);
  } catch (e) { /* ignore */ }
}

module.exports = { setBot, setTarget, clearTarget, getTarget, onTick };