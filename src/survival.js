const logger = require('./logger');
const { goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;

let bot = null;
let enabled = true;
let swimming = false;
let lastWaterLog = 0;   // антиспам, раз в 5 сек
let lastSurfacedLog = 0; // антиспам для «Вынырнул», раз в 5 сек
let lastLavaLog = 0;

// Текущее состояние среды — для getStatus()
let inWater = false;
let inLava = false;

// Опорные точки
let lastWaterPos = null;  // где был в воде (для выныривания)
let lastSafePos = null;   // последняя позиция на земле (для выхода из лавы)
let lastFallY = null;     // откуда началось падение

// Лава
let lavaSince = 0;        // момент входа в лаву
let lavaEscapeIssued = false;

// Антиспам падения
let lastFallLogAt = 0;
const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const WATER_LOG_INTERVAL = 5000;
const LAVA_LOG_INTERVAL = 1000;
const FALL_LOG_INTERVAL = 3000;

function now() {
  return Date.now();
}

/**
 * Привязка инстанса бота. Подписка на physicsTick здесь намеренно
 * не делается — onTick() вызывается из bot.js, чтобы не плодить подписки.
 */
function setBot(instance) {
  bot = instance;
  if (!bot || typeof bot.once !== 'function') return;

  bot.once('spawn', () => {
    logger.info('[🛟] survival активен');
    logPathfinderParams();
  });

  bot.on('death', () => {
    // После смерти опорные точки недействительны
    swimming = false;
    inWater = false;
    inLava = false;
    lastSafePos = null;
    lastFallY = null;
    lavaSince = 0;
    lavaEscapeIssued = false;
  });
}

/**
 * Диагностика: какие параметры движения реально применяет pathfinder.
 * Не меняет их — только показывает фактические значения.
 */
function logPathfinderParams() {
  try {
    const mv = bot?.pathfinder?.movements;
    if (!mv) {
      logger.info('[🛟] pathfinder.movements ещё не задан (появится при follow/guard)');
      return;
    }
    logger.info(
      `[🛟] pathfinder: liquidCost=${mv.liquidCost}, ` +
      `canSwim=${mv.canSwim}, allow1by1towers=${mv.allow1by1towers}, ` +
      `allowParkour=${mv.allowParkour}, canDig=${mv.canDig}`
    );
  } catch (e) {
    logger.info(`[🛟] не удалось прочитать параметры pathfinder: ${e.message}`);
  }
}

function blockNameAt(pos) {
  try {
    return bot?.blockAt(pos)?.name || null;
  } catch (e) {
    return null;
  }
}

function setControl(name, value) {
  try {
    bot.setControlState(name, value);
  } catch (e) { /* не ломать physicsTick */ }
}

/**
 * Основной тик выживания. Вызывается из bot.js (physicsTick) каждый тик.
 */
function onTick() {
  if (!bot || !bot.entity) return;
  if (!enabled) return;

  const pos = bot.entity.position;
  const blockName = blockNameAt(pos);

  // ---------- Вода ----------
  const isWater = bot.entity.isInWater === true ||
    blockName === 'water' || blockName === 'flowing_water';
  inWater = isWater;

  if (isWater) {
    setControl('jump', true);            // грести вверх
    swimming = true;
    lastWaterPos = pos.clone();
    if (now() - lastWaterLog >= WATER_LOG_INTERVAL) {
      lastWaterLog = now();
      logger.info('[🛟] В воде — гребу вверх');
    }
  } else if (swimming) {
    // ---------- Вынырнул ----------
    setControl('jump', false);
    swimming = false;
    // На границе воды isWater мигает по тикам — без антиспама строка
    // печаталась бы каждый тик, а не по факту выхода
    if (now() - lastSurfacedLog >= WATER_LOG_INTERVAL) {
      lastSurfacedLog = now();
      logger.info('[🛟] Вынырнул');
    }
  }

  // ---------- Лава ----------
  const isLava = blockName === 'lava' || blockName === 'flowing_lava';
  inLava = isLava;

  if (isLava) {
    setControl('jump', true);            // всплыть
    setControl('forward', true);         // грести вперёд
    if (now() - lastLavaLog >= LAVA_LOG_INTERVAL) {
      lastLavaLog = now();
      logger.info('[🛟] В ЛАВЕ — пытаюсь выбраться');
    }
    if (!lavaSince) {
      lavaSince = now();
      lavaEscapeIssued = false;
    }
    // Через 2 секунды в лаве — попытка выйти к последней безопасной точке
    if (!lavaEscapeIssued && now() - lavaSince >= 2000) {
      lavaEscapeIssued = true;
      tryEscapeLava();
    }
  } else if (lavaSince) {
    lavaSince = 0;
    lavaEscapeIssued = false;
  }

  // ---------- Опорная точка на земле ----------
  // Опора обновляется, только когда под ногами твёрдый блок (не вода и не лава)
  const belowName = blockNameAt(pos.offset(0, -1, 0));
  const solidBelow = !!belowName && !LIQUIDS.has(belowName);
  if (bot.entity.onGround && solidBelow && !isWater && !isLava) {
    lastSafePos = pos.clone();
  }

  // ---------- Защита от падения (только фиксация) ----------
  // Опорная высота — последняя точка на земле (lastSafePos), она же
  // используется как «старт» падения: пока бот не касался земли,
  // lastFallY держит Y, с которого начался свободный полёт.
  const velY = bot.entity.velocity?.y ?? 0;

  if (velY < -0.7 && pos.y > 10) {
    if (lastFallY === null) {
      lastFallY = pos.y;
    }
    const fallen = lastFallY - pos.y;
    if (fallen > 5 && now() - lastFallLogAt >= FALL_LOG_INTERVAL) {
      lastFallLogAt = now();
      logger.info(`[🛟] Падение ${Math.round(fallen)} блоков`);
    }
  } else {
    lastFallY = null;
  }
}

/**
 * Попытка выбраться из лавы: GoalNear к последней точке на земле.
 */
function tryEscapeLava() {
  if (!bot?.pathfinder) {
    logger.info('[🛟] выход из лавы невозможен: pathfinder не загружен');
    return;
  }
  if (!lastSafePos) {
    logger.info('[🛟] выход из лавы невозможен: нет сохранённой безопасной точки');
    return;
  }
  try {
    bot.pathfinder.setGoal(
      new GoalNear(lastSafePos.x, lastSafePos.y, lastSafePos.z, 1),
      true
    );
    logger.info(
      `[🛟] Цель выхода из лавы: ` +
      `${lastSafePos.x.toFixed(0)}, ${lastSafePos.y.toFixed(0)}, ${lastSafePos.z.toFixed(0)}`
    );
  } catch (e) {
    logger.info(`[🛟] не удалось поставить цель выхода из лавы: ${e.message}`);
  }
}

function enable() {
  enabled = true;
  logger.info('[🛟] survival включён');
}

function disable() {
  enabled = false;
  // Не оставляем залипшие клавиши
  setControl('jump', false);
  inWater = false;
  inLava = false;
  swimming = false;
  lavaSince = 0;
  lavaEscapeIssued = false;
  logger.info('[🛟] survival выключен');
}

function getStatus() {
  return { enabled, swimming, inWater, inLava };
}

module.exports = {
  setBot,
  onTick,
  enable,
  disable,
  getStatus
};
