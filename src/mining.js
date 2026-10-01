const logger = require('./logger');

let bot = null;

// Антиспам: логируем только при смене предмета в руке
let lastLoggedTool = null;

// Состояние после dig — нужно ли вернуть оружие
let digging = false;

const TIER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

// Инструмент не нужен — работаем кулаком
const CATEGORY_FIST = 'fist';

// ==================== КАТЕГОРИИ БЛОКОВ ====================

const PICKAXE_BLOCKS = new Set([
  'stone', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'bedrock',
  'obsidian', 'netherrack', 'bricks', 'stone_bricks', 'cracked_stone_bricks',
  'mossy_stone_bricks', 'chiseled_stone_bricks', 'smooth_stone', 'stone_slab',
  'smooth_stone_slab', 'stone_stairs', 'cobblestone_stairs', 'andesite',
  'diorite', 'granite', 'tuff', 'calcite', 'basalt', 'blackstone',
  'polished_blackstone', 'gilded_blackstone', 'nether_bricks', 'red_nether_bricks',
  'quartz_block', 'quartz_stairs', 'quartz_slab', 'end_stone', 'end_stone_bricks',
  'prismarine', 'purpur_block', 'purpur_pillar', 'sandstone', 'red_sandstone',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore',
  'emerald_ore', 'lapis_ore', 'diamond_ore', 'deepslate_coal_ore',
  'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore',
  'deepslate_redstone_ore', 'deepslate_emerald_ore', 'deepslate_lapis_ore',
  'deepslate_diamond_ore', 'nether_gold_ore', 'quartz_ore',
  'iron_block', 'gold_block', 'diamond_block', 'emerald_block',
  'lapis_block', 'redstone_block', 'coal_block', 'copper_block',
  'copper_ore_deepslate', 'amethyst_block', 'crying_obsidian'
]);

const SHOVEL_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path',
  'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'clay',
  'soul_sand', 'soul_soil', 'snow', 'snow_block', 'packed_ice',
  'blue_ice', 'mud', 'muddy_mangrove_roots', 'suspicious_sand',
  'suspicious_gravel', 'farmland', 'dirt_with_roots'
]);

// Меч и ножницы — только на мягкие/растительные блоки
const SOFT_BLOCKS = new Set([
  'cobweb', 'bamboo', 'leaves', 'azalea_leaves', 'vine', 'grass',
  'tall_grass', 'fern', 'large_fern', 'dead_bush', 'melon',
  'pumpkin', 'carrots', 'potatoes', 'beetroots', 'sugar_cane',
  'glow_lichen', 'short_grass', 'flower', 'poppy', 'dandelion'
]);

const AXE_SUFFIXES = [
  '_log', '_wood', '_planks', '_hyphae', '_stem', '_slab',
  '_stairs', '_fence', '_fence_gate', '_door', '_trapdoor', '_sign',
  '_pressure_plate', '_button', '_boat', '_chest', '_barrel', '_bookshelf'
];

const AXE_BLOCKS = new Set([
  'crafting_table', 'chest', 'trapped_chest', 'barrel', 'bookshelf',
  'ladder', 'torch', 'soul_torch', 'redstone_torch', 'scaffolding',
  'loom', 'cartography_table', 'fletching_table', 'smithing_table',
  'grindstone', 'stonecutter', 'composter', 'jukebox', 'note_block',
  'candle', 'cake', 'tnt', 'hay_block', 'target'
]);

const PICKAXE_SUFFIX = '_pickaxe';
const AXE_SUFFIX = '_axe';
const SHOVEL_SUFFIX = '_shovel';
const SWORD_SUFFIX = '_sword';
const SHEARS_NAME = 'shears';

/**
 * Определить категорию инструмента по имени блока.
 * Возвращает CATEGORY_FIST, если инструмент не нужен.
 */
function toolForBlock(blockName) {
  const name = String(blockName || '');

  // 1. Паутина, бамбук, листва — меч или ножницы
  if (SOFT_BLOCKS.has(name) || name.includes('leaves') || name === 'cobweb') {
    return 'soft';
  }

  // 2. Земля и сыпучие — лопата
  if (SHOVEL_BLOCKS.has(name)) {
    return 'shovel';
  }

  // 3. Камень, руда, обсидиан, кирпич, бетон — кирка
  if (PICKAXE_BLOCKS.has(name) || name.endsWith('_ore') || name.includes('concrete')) {
    return 'pickaxe';
  }

  // 4. Дерево, доски, верстак, сундук — топор
  if (AXE_BLOCKS.has(name) || AXE_SUFFIXES.some((s) => name.endsWith(s))) {
    return 'axe';
  }

  // 5. Всё остальное — кулак
  return CATEGORY_FIST;
}

/**
 * Оценка инструмента: тир материала. Без материала — 0.
 */
function toolScore(item) {
  const idx = TIER.findIndex((t) => item.name.startsWith(`${t}_`));
  return idx >= 0 ? TIER.length - idx : 0;
}

/**
 * Найти лучший инструмент нужной категории в инвентаре.
 */
function findTool(category) {
  let suffix = null;
  if (category === 'pickaxe') suffix = PICKAXE_SUFFIX;
  if (category === 'axe') suffix = AXE_SUFFIX;
  if (category === 'shovel') suffix = SHOVEL_SUFFIX;
  if (category === 'soft') suffix = SWORD_SUFFIX;

  const items = bot.inventory?.items?.() || [];
  const pool = items.filter((i) => {
    if (category === 'soft') {
      // Меч или ножницы
      return i.name.endsWith(SWORD_SUFFIX) || i.name === SHEARS_NAME;
    }
    return suffix && i.name.endsWith(suffix);
  });

  if (!pool.length) return null;

  // Приоритет материала: netherite → ... → wooden
  return pool.reduce((best, cur) => (toolScore(cur) > toolScore(best) ? cur : best), pool[0]);
}

/**
 * Снять предмет с руки — чтобы копать кулаком, а не мечом.
 */
async function freeHand() {
  try {
    if (typeof bot.unequip === 'function') {
      await bot.unequip('hand');
    } else {
      await bot.equip(null, 'hand');
    }
    return true;
  } catch (e) {
    // Запасной путь — экипировать любой не-меч предмет
    try {
      const items = bot.inventory?.items?.() || [];
      const alt = items.find((i) => !i.name.endsWith(SWORD_SUFFIX));
      if (alt) await bot.equip(alt, 'hand');
    } catch (e2) { /* не ломать dig */ }
    return false;
  }
}

/**
 * Взять подходящий инструмент под блок. Экспортируется для тестов.
 */
async function equipToolFor(block) {
  if (!bot || !bot.entity) return null;

  const blockName = typeof block === 'string' ? block : block?.name;
  const category = toolForBlock(blockName);

  // Категория 'fist' — инструмент не нужен
  if (category === CATEGORY_FIST) {
    const held = bot.heldItem?.name || null;
    if (held) {
      await freeHand();
      if (lastLoggedTool !== 'empty') {
        lastLoggedTool = 'empty';
        logger.info('[⛏] Инструмент: кулак');
      }
    }
    return null;
  }

  const tool = findTool(category);
  if (!tool) {
    // Инструмента нет — кулак. Меч для камня/дерева не берём никогда.
    const held = bot.heldItem?.name || null;
    if (held) await freeHand();
    if (lastLoggedTool !== 'нет') {
      lastLoggedTool = 'нет';
      logger.info(`[⛏] Инструмент: нет (${category}) — копаю кулаком`);
    }
    return null;
  }

  const heldName = bot.heldItem?.name || null;
  if (heldName === tool.name) {
    // Уже правильный инструмент — ничего не делаем и не логируем
    lastLoggedTool = tool.name;
    return tool;
  }

  try {
    await bot.equip(tool, 'hand');
    if (lastLoggedTool !== tool.name) {
      lastLoggedTool = tool.name;
      logger.info(`[⛏] Инструмент: ${tool.name}`);
    }
    digging = true;
    return tool;
  } catch (e) {
    logger.info(`[⛏] не удалось взять ${tool.name}: ${e.message}`);
    return null;
  }
}

/**
 * Оружие ли в руке. Локальная функция, чтобы не тянуть
 * циклическую зависимость с equipment.js.
 */
function isWeaponItem(item) {
  if (!item || !item.name) return false;
  return item.name.endsWith(SWORD_SUFFIX) || item.name.endsWith(AXE_SUFFIX);
}

/**
 * Вернуть оружие в руку после копания.
 * Если раньше в руке было оружие — equipToolFor мог его снять
 * (например, для кулака при отсутствии кирки), боту без оружия нельзя.
 */
async function restoreWeapon() {
  try {
    const mod = require('./equipment');
    if (typeof mod.equipBestWeapon !== 'function') {
      logger.info('[⛏] возврат оружия недоступен: equipment.js не экспортирует equipBestWeapon');
      return false;
    }
    await mod.equipBestWeapon();
    return true;
  } catch (e) {
    logger.info(`[⛏] не удалось вернуть оружие: ${e.message}`);
    return false;
  }
}

/**
 * Обёртка bot.dig: перед копанием всегда ставит подходящий инструмент,
 * после — возвращает оружие, если оно было в руке.
 */
function installDigWrapper() {
  if (!bot || typeof bot.dig !== 'function') return;
  if (bot.__miningWrapped) return;
  bot.__miningWrapped = true;

  const originalDig = bot.dig.bind(bot);
  bot.dig = async function (block, forceLook) {
    // Защита кровати — не копаем никогда
    if (block && block.name && block.name.endsWith('_bed')) {
      return false;
    }

    const hadWeapon = isWeaponItem(bot.heldItem);

    try {
      await equipToolFor(block);
    } catch (e) {
      logger.info(`[⛏] ошибка подбора инструмента: ${e.message}`);
    }

    let result;
    try {
      result = await originalDig(block, forceLook);
    } finally {
      // Возврат оружия — даже если dig упал, иначе бот останется с кулаком
      if (hadWeapon) {
        await restoreWeapon();
      }
    }
    return result;
  };
}

function setBot(instance) {
  bot = instance;
  lastLoggedTool = null;
  digging = false;
  installDigWrapper();

  if (bot && typeof bot.once === 'function') {
    bot.once('spawn', () => {
      logger.info('[⛏] mining активен — dig обёрнут подбором инструмента');
    });
  }
}

/**
 * Раз в 20 тиков: сброс флага копания, чтобы не держать состояние вечно.
 */
function onTick() {
  digging = false;
}

module.exports = {
  setBot,
  equipToolFor,
  onTick
};
