const logger = require('./logger');
const { goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;

let bot = null;

// Работа идёт в фоне — повторные вызовы не плодят дубли.
// Флаг двойной: защищает и от внешнего повторного вызова,
// и от вложенного setGoal, который ensureBuildingBlocks делает сам.
let ensuring = false;
let lastResultAt = 0;
const RESULT_LOG_INTERVAL = 5000;

// Блоки, из которых можно строить
const BUILDING_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium',
  'sand', 'red_sand', 'gravel', 'clay',
  'stone', 'cobblestone', 'cobbled_deepslate', 'deepslate',
  'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'calcite',
  'blackstone', 'basalt', 'end_stone', 'sandstone',
  'bricks', 'stone_bricks', 'mossy_stone_bricks', 'quartz_block',
  'glass', 'glowstone', 'oak_planks', 'spruce_planks', 'birch_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks'
]);

// Суффиксы древесины
const LOG_RE = /_(log|wood|hyphae|stem)$/;
const PLANKS_RE = /_planks$/;

function now() {
  return Date.now();
}

function items() {
  try {
    return bot?.inventory?.items?.() || [];
  } catch (e) {
    return [];
  }
}

/**
 * Есть ли в инвентаре блоки для строительства.
 */
function hasBuildingBlocks() {
  return items().some((i) => BUILDING_BLOCKS.has(i.name) || PLANKS_RE.test(i.name));
}

/**
 * Найти древесину в радиусе 32 блока.
 */
function findNearbyLog() {
  try {
    if (typeof bot.findBlock !== 'function') return null;
    return bot.findBlock({
      matching: (b) => LOG_RE.test(b?.name || ''),
      maxDistance: 32
    });
  } catch (e) {
    return null;
  }
}

/**
 * Есть ли верстак (в инвентаре или рядом).
 */
function findCraftingTable() {
  const inInv = items().find((i) => i.name === 'crafting_table');
  if (inInv) return inInv;
  try {
    const ref = bot.blockAt(bot.entity.position);
    return bot.findBlock({
      matching: 'crafting_table',
      maxDistance: 4,
      from: ref ? ref.position : undefined
    });
  } catch (e) {
    return null;
  }
}

/**
 * Крафт досок из одного бревна. 4 доски.
 */
async function craftPlanks(logName) {
  // Сопоставление породы: бревно → доски той же породы
  const type = (logName || '').split('_')[0];
  const plankId = `${type}_planks`;

  try {
    if (typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') {
      logger.info('[🏗] Крафт недоступен на этой версии');
      return false;
    }

    const table = findCraftingTable();
    const tableObj = table && table.name === 'crafting_table'
      ? (table.position ? table : items().find((i) => i.name === 'crafting_table'))
      : table;

    const recipes = bot.recipesFor(plankId, null, 1, tableObj || null);
    if (!recipes || !recipes.length) {
      logger.info(`[🏗] Крафт недоступен на этой версии (рецепт ${plankId} не найден)`);
      return false;
    }

    logger.info(`[🏗] Крафт 4 доски (${plankId})`);
    await bot.craft(recipes[0], 1);
    return true;
  } catch (e) {
    logger.info(`[🏗] Крафт недоступен на этой версии: ${e.message}`);
    return false;
  }
}

/**
 * Дойти до бревна и вырубить его.
 */
async function chopLog(logBlock) {
  const pos = logBlock.position;
  if (!pos) return false;

  try {
    if (bot.pathfinder) {
      bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 1), true);
    }
  } catch (e) {
    logger.info(`[🏗] не удалось поставить цель к дереву: ${e.message}`);
  }

  // Ждём, пока бот окажется вплотную к стволу
  const deadline = now() + 15000;
  while (now() < deadline) {
    if (!bot?.entity) return false;
    const d = bot.entity.position.distanceTo(pos);
    if (d <= 2.5) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const before = items().filter((i) => LOG_RE.test(i.name)).reduce((s, i) => s + i.count, 0);

  try {
    // Обёртка bot.dig из mining.js сама возьмёт топор
    await bot.dig(logBlock);
  } catch (e) {
    logger.info(`[🏗] не удалось срубить дерево: ${e.message}`);
    return false;
  }

  const after = items().filter((i) => LOG_RE.test(i.name)).reduce((s, i) => s + i.count, 0);
  const got = after - before;
  logger.info(`[🏗] Дерево срублено (+${got} ${logBlock.name})`);

  if (after <= 0) return false;
  return craftPlanks(logBlock.name);
}

/**
 * Копать землю под ногами, если древесины нет.
 */
async function digDirt() {
  try {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below) return false;

    const isDirt = below.name === 'dirt' || below.name === 'grass_block' ||
      below.name === 'coarse_dirt' || below.name === 'podzol';
    if (!isDirt) return false;

    await bot.dig(below);
    logger.info(`[🏗] Земля добыта (${below.name})`);
    return true;
  } catch (e) {
    logger.info(`[🏗] не удалось добыть землю: ${e.message}`);
    return false;
  }
}

/**
 * Гарантировать наличие блоков для строительства.
 * Возвращает true, если блоки уже есть или удалось их получить.
 */
async function ensureBuildingBlocks() {
  if (!bot || !bot.entity) return false;
  if (hasBuildingBlocks()) return true;
  // Уже выполняемся — вложенный вызов из обёртки setGoal должен просто выйти
  if (ensuring) return false;

  ensuring = true;
  try {
    // 1. Древесина уже в инвентаре — сразу крафтим доски
    const log = items().find((i) => LOG_RE.test(i.name));
    if (log) {
      if (now() - lastResultAt >= RESULT_LOG_INTERVAL) {
        lastResultAt = now();
        logger.info('[🏗] Нет блоков, крафтю доски из древесины');
      }
      const ok = await craftPlanks(log.name);
      if (ok) return true;
    }

    // 2. Ищем дерево рядом
    const logBlock = findNearbyLog();
    if (logBlock) {
      if (now() - lastResultAt >= RESULT_LOG_INTERVAL) {
        lastResultAt = now();
        logger.info('[🏗] Нет блоков, иду к дереву');
      }
      const ok = await chopLog(logBlock);
      if (ok) return true;
      if (hasBuildingBlocks()) return true;
    }

    // 3. Дерева нет — пробуем землю под ногами
    const dug = await digDirt();
    if (dug) return true;

    // 4. Ничего нет
    if (now() - lastResultAt >= RESULT_LOG_INTERVAL) {
      lastResultAt = now();
      logger.info('[🏗] Нет материалов для строительства');
    }
    return false;
  } catch (e) {
    logger.info(`[🏗] ошибка обеспечения блоками: ${e.message}`);
    return false;
  } finally {
    ensuring = false;
  }
}

/**
 * Нужны ли блоки для этой цели: цель выше бота на 2+ блока, блоков нет.
 */
function needsBlocks(goal) {
  if (!bot?.entity || !goal) return false;
  const targetY = typeof goal.y === 'number' ? goal.y : null;
  if (targetY === null) return false;

  const rise = targetY - bot.entity.position.y;
  return rise >= 2 && !hasBuildingBlocks();
}

function installGoalHook() {
  if (!bot?.pathfinder || bot.__buildingGoalHooked) return;
  bot.__buildingGoalHooked = true;

  const pf = bot.pathfinder;
  const originalSetGoal = pf.setGoal.bind(pf);
  pf.setGoal = function (goal, ...args) {
    // Ключевая защита от рекурсии: ensureBuildingBlocks сам вызывает
    // setGoal (идти к дереву) — второй заход не должен запускать проверку снова.
    if (!ensuring) {
      try {
        if (needsBlocks(goal)) {
          ensureBuildingBlocks();

          // Re-check: за время похода к дереву блоки могли появиться
          if (needsBlocks(goal)) {
            if (now() - lastResultAt >= RESULT_LOG_INTERVAL) {
              lastResultAt = now();
              logger.info('[🏗] Блоков нет, pathfinder попробует без строительства');
            }
          }
        }
      } catch (e) {
        logger.info(`[🏗] ошибка проверки цели: ${e.message}`);
      }
    }
    return originalSetGoal(goal, ...args);
  };
}

function setBot(instance) {
  bot = instance;
  ensuring = false;
  lastResultAt = 0;

  if (bot && typeof bot.once === 'function') {
    bot.once('spawn', () => {
      logger.info('[🏗] building активен');
      installGoalHook();
    });
  }
}

/**
 * Резерв: сброс состояния. Реальная логика работает по вызову ensureBuildingBlocks.
 */
function onTick() {
  if (!bot) return;
}

module.exports = {
  setBot,
  ensureBuildingBlocks,
  onTick
};
