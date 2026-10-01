const logger = require('./logger');
const follow = require('./follow');
const safety = require('./safety');
const combat = require('./combat');
const equipment = require('./equipment');
const guard = require('./guard');

let bot = null;
let config = null;
let combatEnabled = true;

function setBot(instance) {
  bot = instance;
}

function setConfig(cfg) {
  config = cfg;
}

function setCombatEnabled(value) {
  combatEnabled = value;
}

function getCombatEnabled() {
  return combatEnabled;
}

/**
 * Единая функция выполнения команд.
 * @param {string} source - 'game' | 'cli' | 'web'
 * @param {string} playerName - имя игрока или 'console'/'web'
 * @param {string} rawMessage - текст команды
 */
async function executeCommand(source, playerName, rawMessage) {
  if (!bot || !config) return;
  if (!bot.entity) {
    sendReply(source, 'Бот не подключён');
    return;
  }

  const p = config.prefix || '!';
  const args = rawMessage.trim().split(/\s+/);
  let cmd = args[0].toLowerCase();

  // Префикс ! обязателен только для game
  if (source === 'game' && !cmd.startsWith(p)) return;
  if (cmd.startsWith(p)) cmd = cmd.slice(p.length);

  const arg = args[1];

  // ---- follow <ник> ----
  if (cmd === 'follow' && arg) {
    const target = bot.players[arg];
    if (!target || !target.entity) {
      sendReply(source, `Не вижу игрока ${arg}`);
      return;
    }
    guard.stopGuard();
    follow.startFollowing(arg, config.followDistance);
    sendReply(source, `Следую за ${arg}`);
  }

  // ---- stop ----
  if (cmd === 'stop') {
    follow.stopFollowing();
    guard.stopGuard();
    combat.stopCombat();
    sendReply(source, 'Остановился');
  }

  // ---- guard [радиус] ----
  if (cmd === 'guard') {
    const r = parseInt(arg) || config.guardRadius || 8;
    guard.startGuard(r);
    sendReply(source, `Охрана включена (радиус ${r})`);
  }

  // ---- unguard ----
  if (cmd === 'unguard') {
    guard.stopGuard();
    sendReply(source, 'Охрана снята');
  }

  // ---- attack ----
  if (cmd === 'attack') {
    if (bot.pvp.target) {
      sendReply(source, 'Уже в бою');
      return;
    }
    combatEnabled = true;
    const combatRadius = config.combatRadius ?? 10;
    const mob = combat.findHostileMob(combatRadius);
    if (mob) {
      combat.attackEntity(mob);
      sendReply(source, `Атакую ${mob.name}`);
    } else {
      sendReply(source, 'Врагов рядом нет');
    }
  }

  // ---- peace ----
  if (cmd === 'peace') {
    combatEnabled = false;
    combat.stopCombat();
    sendReply(source, 'Мир');
  }

  // ---- armor ----
  if (cmd === 'armor') {
    bot.armorManager?.equipAll();
    sendReply(source, 'Броня надета');
  }

  // ---- sword ----
  if (cmd === 'sword') {
    const ok = await equipment.equipBestWeapon().catch(() => false);
    sendReply(source, ok ? 'Оружие в руке' : 'Нет оружия');
  }

  // ---- status ----
  if (cmd === 'status') {
    const pos = bot.entity.position;
    const guardInfo = guard.getGuardInfo();
    const guardStatus = guardInfo.active
      ? `ON(r=${guardInfo.radius})`
      : 'OFF';
    const combatStatus = combatEnabled ? 'ON' : 'OFF';
    const targetName = bot.pvp?.target?.name || 'null';
    const s = require('./survival').getStatus();
    const survStatus = `Surv:${s.enabled ? 'ON' : 'OFF'}` +
      `${s.inWater ? ' WATER' : ''}${s.inLava ? ' LAVA' : ''}`;
    const toolName = bot.heldItem?.name || 'empty';
    const meleeInfo = require('./ranged').getStatus();
    const home = require('./spawnpoint').get();
    const homeText = home.set
      ? `${home.pos.x},${home.pos.y},${home.pos.z}`
      : 'none';
    const loot = require('./looting').getStatus();
    sendReply(source,
      `HP:${bot.health.toFixed(0)} Food:${bot.food} ` +
      `Pos:${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)} ` +
      `Guard:${guardStatus} Combat:${combatStatus} Target:${targetName} ${survStatus} ` +
      `Tool:${toolName} Melee:${meleeInfo.meleeWeapon || 'empty'} Home:${homeText} Loot:${loot.enabled ? 'ON' : 'OFF'}`
    );
  }

  // ---- dumpitems (диагностика выпавших предметов) ----
  if (cmd === 'dumpitems') {
    const n = require('./looting').dumpNearbyItems();
    sendReply(source, `[🔍] Сущностей рядом: ${n}`);
    return;
  }

  // ---- setspawn (запомнить точку возврата) ----
  if (cmd === 'sethome' || cmd === 'setspawn') {
    const p = require('./spawnpoint');
    try {
      const ok = await p.setHome();
      if (ok) {
        const sp = p.get();
        if (sp && sp.set) {
          sendReply(source,
            `Дом установлен (${sp.pos.x}, ${sp.pos.y}, ${sp.pos.z})`
          );
        } else {
          sendReply(source, 'Дом установлен');
        }
      } else {
        sendReply(source, 'Не удалось установить дом');
      }
    } catch (e) {
      sendReply(source, `Ошибка установки дома: ${e.message || e}`);
    }
    return;
  }

  // ---- gohome (идти к точке возврата) ----
  if (cmd === 'gohome') {
    const sp = require('./spawnpoint');
    if (!sp.get().set) {
      sendReply(source, 'Дом не задан');
      return;
    }
    const ok = sp.goTo();
    sendReply(source, ok ? 'Иду к дому' : 'Не удалось поставить цель');
    return;
  }

  // ---- ranged (лук удалён) ----
  if (cmd === 'ranged') {
    sendReply(source, 'Лук больше не используется. Ближний бой: меч → топор → рука.');
    return;
  }

  // ---- survival [on|off] ----
  if (cmd === 'survival') {
    const s = require('./survival');
    const st = s.getStatus();
    if (arg === 'toggle') {
      if (st.enabled) {
        s.disable();
        sendReply(source, 'Survival: OFF');
      } else {
        s.enable();
        sendReply(source, 'Survival: ON');
      }
    } else if (arg === 'off') {
      s.disable();
      sendReply(source, 'Survival: OFF');
    } else if (arg === 'on') {
      s.enable();
      sendReply(source, 'Survival: ON');
    } else {
      sendReply(source, `Survival: ${st.enabled ? 'ON' : 'OFF'}`);
    }
    return;
  }

  // ---- clearpotions (сброс чёрного списка зелий) ----
  if (cmd === 'clearpotions') {
    const { clearPotionBlacklist } = require('./consumables');
    if (clearPotionBlacklist) clearPotionBlacklist();
    sendReply(source, 'Чёрный список зелий очищен');
    return;
  }

  // ---- stats (счётчики расходов) ----
  if (cmd === 'stats') {
    const { getStats } = require('./consumables');
    const s = getStats ? getStats() : {};
    const line = `🍖 potions ${s.potionsEffective || 0}/${s.potionsTried || 0}, ` +
      `apples ${s.applesEffective || 0}/${s.applesTried || 0}, ` +
      `food ${s.foodEffective || 0}/${s.foodTried || 0}, ` +
      `blacklist=[${(s.blacklisted || []).join(',')}]`;
    sendReply(source, line);
    return;
  }

  // ---- potions (отладка зелий) ----
  if (cmd === 'potions') {
    const lines = require('./consumables').describePotions();
    for (const line of lines) {
      // Ограничение чата — 256 символов, режем по 240
      if (line.length <= 240) {
        sendReply(source, line);
      } else {
        for (let i = 0; i < line.length; i += 240) {
          sendReply(source, line.slice(i, i + 240));
        }
      }
    }
  }

  // ---- help ----
  if (cmd === 'help') {
    const helpText = [
      'Доступные команды:',
      '  follow <ник> — следовать за игроком',
      '  stop — остановить всё',
      '  guard [радиус] — охранять точку',
      '  unguard — снять охрану',
      '  attack — атаковать ближайшего врага',
      '  peace — прекрать бой',
      '  armor — надеть броню',
      '  sword — взять оружие',
      '  status — показать статус',
      '  potions — отчёт по зельям в инвентаре',
      '  clearpotions — очистить чёрный список зелий',
      '  stats — счётчики расходов (зелья/яблоки/еда)',
      '  survival [on|off|toggle] — управление выживанием',
      '  sethome / setspawn — установить дом (через кровать или координаты)',
      '  gohome — идти к дому',
      '  help — список команд',
      '  quit — выйти'
    ].join('\n');
    sendReply(source, helpText);
  }

  // ---- quit ----
  if (cmd === 'quit') {
    const { gracefulShutdown } = require('./safety');
    gracefulShutdown(`Команда из ${source}`);
  }
}

/**
 * Отправка ответа в зависимости от источника.
 */
function sendReply(source, message) {
  if (source === 'game') {
    bot.chat(message);
  }
  if (source === 'web') {
    try { require('./web').broadcast('chat', { user: 'bot', message }); } catch (e) { /* ignore */ }
  }
  // Ответ в Web GUI уже ушёл клиенту кадром — в лог INFO это дублирование
  if (source === 'web') {
    logger.debug(`[WEB] ${message}`);
  } else {
    logger.info(`[${source.toUpperCase()}] ${message}`);
  }
}

module.exports = {
  setBot,
  setConfig,
  setCombatEnabled,
  getCombatEnabled,
  executeCommand
};
