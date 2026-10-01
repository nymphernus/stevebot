const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;
const mcData = require('minecraft-data');

// ---- Импорты плагинов (raw) ----
const armorManagerRaw = require('mineflayer-armor-manager');
const autoEatRaw = require('mineflayer-auto-eat');

const config = require('./config.json');
const logger = require('./src/logger');
const { equipBestWeapon, equipShield, needsWeapon, setBot: setBotEquipment } = require('./src/equipment');
const { autoAttack, stopCombat, findHostileMob, attackEntity, checkWatchdog, countHostiles, setBot: setBotCombat } = require('./src/combat');
const { startGuard, stopGuard, isGuarding, getGuardInfo, setBot: setBotGuard } = require('./src/guard');
const { autoHeal, setupAutoEat, trackPreEatWeapon, returnWeaponAfterEat, setBot: setBotConsumables } = require('./src/consumables');
const { executeCommand } = require('./src/commands');

let bot;
let currentTarget = null;
let reconnectCount = 0;
let isShuttingDown = false;
let tickCounter = 0;
let combatEnabled = true;
// Антиспам autoHeal: не чаще раза в 5 секунд (100 тиков)
let lastAutoHealTick = -1000;

// Exponential backoff для reconnect: 5с → 10с → 30с → 60с → 120с (дальше кап)
const BACKOFF_SCHEDULE = [5000, 10000, 30000, 60000, 120000];
let backoffIndex = 0;

// Одноразовые таймеры, привязанные к текущему инстансу бота
let respawnTimer = null;
const collectTimers = [];

function clearPendingTimers() {
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  while (collectTimers.length) {
    clearTimeout(collectTimers.pop());
  }
}

// maxReconnectAttempts: -1 (или любое отрицательное) = бесконечные попытки
function canReconnect() {
  const max = config.maxReconnectAttempts ?? -1;
  if (max < 0) return true;
  return reconnectCount < max;
}

// ==================== HELPERS ====================
function safeLoadPlugin(bot, mod, name) {
  const fn =
    typeof mod === 'function' ? mod :
    typeof mod?.plugin === 'function' ? mod.plugin :
    typeof mod?.loader === 'function' ? mod.loader :
    typeof mod?.default === 'function' ? mod.default : null;

  if (!fn) {
    logger.error(`${name}: невалидный экспорт`, typeof mod, Object.keys(mod || {}));
    return false;
  }
  bot.loadPlugin(fn);
  logger.info(`${name} загружен`);
  return true;
}

// ==================== СОЗДАНИЕ ====================
function createBot() {
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth
  });

  bot.loadPlugin(pathfinder); // чистый плагин
  safeLoadPlugin(bot, armorManagerRaw, 'mineflayer-armor-manager');
  safeLoadPlugin(bot, autoEatRaw, 'mineflayer-auto-eat');

  // Передаём инстанс бота модулям
  setBotEquipment(bot);
  setBotCombat(bot);
  setBotGuard(bot);
  setBotConsumables(bot);

  // Связываем survival.js (выживание: вода, лава, падения)
  const survival = require('./src/survival');
  survival.setBot(bot);

  // Связываем инструменты, строительство, дальний бой, лут и спавн-точку
  require('./src/mining').setBot(bot);
  require('./src/building').setBot(bot);
  require('./src/ranged').setBot(bot);
  require('./src/looting').setBot(bot);
  require('./src/spawnpoint').setBot(bot);

  // Связываем commands.js
  const commands = require('./src/commands');
  commands.setBot(bot);
  commands.setConfig(config);
  commands.setCombatEnabled(true);

  // Связываем follow.js и safety.js
  const follow = require('./src/follow');
  const safety = require('./src/safety');
  follow.setBot(bot);
  safety.setBot(bot);

  // Устанавливаем базовые Movements один раз при спавне
  // Это инфраструктурная настройка — не привязана к sethome/follow/guard
  bot.once('spawn', () => {
    try {
      const defaultMovements = new Movements(bot);
      defaultMovements.canDig = false;
      defaultMovements.allow1by1towers = false;
      defaultMovements.canOpenDoors = true;
      defaultMovements.canSwim = true;
      bot.pathfinder.setMovements(defaultMovements);
      logger.info('[PATH] Movements установлены: canDig=false, allow1by1towers=false, canSwim=true');
    } catch (e) {
      logger.error(`[PATH] Не удалось установить Movements: ${e.message}`);
    }
  });

  bindEvents(bot);
}

// ==================== СОБЫТИЯ ====================
function bindEvents(bot) {
  if (bot.__eventsBound) {
    logger.warn('[BOT] bindEvents уже вызывался для этого инстанса — повторная привязка пропущена');
    return;
  }
  bot.__eventsBound = true;
  logger.info('[BOT] bindEvents вызван');

  bot.once('login', () => {
    logger.info(`${bot.username} вошёл`);
    reconnectCount = 0;
    backoffIndex = 0; // сброс backoff после успешного подключения
    // Запускаем heartbeat
    try { logger.startHeartbeat(getBot, getTickCounter); } catch (e) { /* ignore */ }
    // Уведомляем CLI, что бот готов
    try { require('./src/cli').notifyReady(); } catch (e) { /* ignore */ }
  });

  // bot.on('spawn') — не once, чтобы после респавна экипировка работала
  bot.on('spawn', async () => {
    // Авто-броня
    bot.armorManager?.equipAll();

    // Авто-оружие
    await equipBestWeapon().catch(() => {});
    await equipShield().catch(() => {});

    // Настройка авто-еды
    setupAutoEat();

    // Восстановление следования после респавна
    if (currentTarget && bot.players[currentTarget]) {
      startFollowing(currentTarget);
    }
  });

  bot.on('playerCollect', () => {
    collectTimers.push(setTimeout(() => {
      if (bot && bot.entity) bot.armorManager?.equipAll();
    }, 500));
    collectTimers.push(setTimeout(() => {
      if (bot && bot.entity) equipBestWeapon().catch(() => {});
    }, 500));
  });

  // ---- Единый physicsTick: авто-атака + экипировка + охрана + зелья ----
  bot.on('physicsTick', () => {
    if (!bot || !bot.entity) return;
    tickCounter++;

    // Ближний бой через ranged.js (цель ставит combat.js)
    if (tickCounter % 5 === 0) {
      try { require('./src/ranged').onTick(tickCounter); } catch (e) { /* ignore */ }
    }

    // Выживание: вода, лава, фиксация падений — в самом начале тика
    try { require('./src/survival').onTick(); } catch (e) { /* не ломать physicsTick */ }

    if (tickCounter % 20 === 0) {
      try { require('./src/mining').onTick(); } catch (e) { /* не ломать tick */ }
      try { require('./src/building').onTick(); } catch (e) { /* не ломать tick */ }
    }

    if (tickCounter % 10 === 0 && combatEnabled) {
      const r = isGuarding()
        ? Math.max(config.guardRadius ?? 8, 12) + 4
        : Math.max(config.combatRadius ?? 10, 24);
      autoAttack(r);
      checkWatchdog(tickCounter);
    }

    if (tickCounter % 20 === 0) {
      // Автоподбор дропа — после боя, когда цель не выбрана
      try { require('./src/looting').onTick(); } catch (e) { /* не ломать tick */ }

      const healing = require('./src/consumables').isHealing();
      const eating = bot.autoEat && bot.autoEat.isEating;
      if (!healing && !eating && needsWeapon()) {
        equipBestWeapon().catch(() => {});
      }
      // autoHeal не чаще раза в 5 секунд: при HP ниже порога проверка идёт каждый
      // тик, а лечение может завершиться быстро — повторы уйдут в пустоту
      if (bot.health < 14 && !healing && tickCounter - lastAutoHealTick > 100) {
        lastAutoHealTick = tickCounter;
        autoHeal().catch(() => {});
      }
    }

    // Диагностика каждые 100 тиков (~5 сек) — только при debug: true
    if (tickCounter % 100 === 0 && config.debug) {
      const combatRadius = Math.max(config.combatRadius ?? 10, 24);
      const hostiles = countHostiles(combatRadius);
      const combatTarget = require('./src/ranged').getTarget()?.name || 'null';
      logger.info(`[DBG] tick=${tickCounter}, hostiles=${hostiles}, radius=${combatRadius}, target=${combatTarget}`);
    }
  });

  // ---- Чат-команды ----
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    try { require('./src/web').broadcastChat(username, message); } catch (e) { /* ignore */ }
    executeCommand('game', username, message);
  });

  // ---- Смерть ----
  bot.on('death', () => {
    logger.warn('Смерть. Возрождаюсь...');
    clearPendingTimers();
    stopFollowing();
    stopGuard();
    stopCombat();
    bot.clearControlStates();
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      try { bot.respawn(); } catch (e) { /* ignore */ }
    }, 1000);
  });

  // ---- Ошибки ----
  bot.on('error', (e) => logger.error(e.message));
  bot.on('kicked', (r) => logger.warn(`Kicked: ${r}`));

  bot.on('end', (reason) => {
    logger.warn(`End: ${reason}`);
    clearPendingTimers();
    stopFollowing();
    stopGuard();
    if (!isShuttingDown && canReconnect()) {
      reconnectCount++;
      const idx = BACKOFF_SCHEDULE.length
        ? Math.min(backoffIndex, BACKOFF_SCHEDULE.length - 1)
        : 0;
      const delay = BACKOFF_SCHEDULE.length
        ? BACKOFF_SCHEDULE[idx]
        : (config.reconnectDelay ?? 5000); // fallback, если расписание пустое
      logger.warn(`Reconnect #${reconnectCount} через ${delay / 1000}с (backoff[${idx}])`);
      backoffIndex++;
      setTimeout(createBot, delay);
    }
  });
}

// ==================== СЛЕДОВАНИЕ ====================
function startFollowing(name) {
  stopFollowing();
  const p = bot.players[name];
  if (!p?.entity) return;

  const data = mcData(bot.version);
  const mv = new Movements(bot, data);
  mv.canDig = false;
  bot.pathfinder.setMovements(mv);
  bot.pathfinder.setGoal(new GoalFollow(p.entity, config.followDistance), true);
  currentTarget = name;
  // Во время следования лут не собираем — иначе бот уйдёт от игрока
  try { require('./src/looting').setFollowing(true); } catch (e) { /* ignore */ }
}

function stopFollowing() {
  if (bot?.pathfinder) bot.pathfinder.setGoal(null);
  currentTarget = null;
  try { require('./src/looting').setFollowing(false); } catch (e) { /* ignore */ }
}

// ==================== ЗАВЕРШЕНИЕ ====================
function gracefulShutdown(reason) {
  logger.warn(`Завершение: ${reason}`);
  isShuttingDown = true;
  stopFollowing();
  stopGuard();
  stopCombat();
  try { bot?.quit('graceful'); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (e) => logger.error(`Uncaught: ${e.message}`));
process.on('unhandledRejection', (r) => logger.error(`Rejection: ${r}`));

// ==================== ЭКСПОРТ ДЛЯ CLI/WEB ====================
function getBot() {
  return bot;
}

function getCombatEnabled() {
  return combatEnabled;
}

function setCombatEnabled(value) {
  combatEnabled = value;
}

function getTickCounter() {
  return tickCounter;
}

// ==================== ЗАПУСК ====================
logger.info(`[LOG] TTY=${process.stdout.isTTY === true}, file=./logs/bot-${new Date().toISOString().split('T')[0]}.log`);
createBot();

// Инициализация CLI и Web GUI
try {
  require('./src/cli').init({ getBot, getCombatEnabled, setCombatEnabled, getTickCounter, gracefulShutdown });
} catch (e) {
  logger.error(`CLI init error: ${e.message}`);
}

try {
  require('./src/web').init({ getBot, getCombatEnabled, setCombatEnabled, getTickCounter, gracefulShutdown });
} catch (e) {
  logger.error(`[WEB] Не удалось инициализировать Web GUI: ${e.message}`);
}

try {
  const web = require('./src/web');
  bot.once('spawn', () => web.broadcastStatus());
  bot.on('death', () => web.broadcastStatus());
  bot.on('health', () => web.broadcastStatus());
  bot.on('end', () => web.broadcastStatus());
} catch (e) { /* ignore */ }
