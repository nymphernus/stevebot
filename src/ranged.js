const logger = require('./logger');

let bot = null;

const ARROW_NAMES = new Set(['arrow', 'spectral_arrow', 'tipped_arrow']);
const SWORD_SUFFIX = '_sword';
const AXE_SUFFIX = '_axe';

// Тир материала — приоритет при выборе ближнего оружия
const TIER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

// Минимальная дистанция — ниже неё работает ближний бой
const MIN_RANGE = 4;
// Ближний бой не дальше этого — стрелять смысла нет
const MAX_RANGE = 24;

// Натяжение лука: тики (20 тиков/сек → 1000 мс = 20 тиков)
const CHARGE_TICKS = 20;

let chargeTicks = 0;
let charging = false;
let shooting = false;
// ДИАГНОСТИКА: имя цели для лога выстрела
let lastTargetName = 'null';
// ДИАГНОСТИКА: время последнего лога attackedTarget
let lastAttackEventAt = 0;
let lastShotLog = 0;
const SHOT_LOG_INTERVAL = 1000;
let noBowWarned = false;
let noArrowsWarned = false;

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

function findBow() {
  return items().find((i) => i.name === 'bow') || null;
}

function countArrows() {
  return items()
    .filter((i) => ARROW_NAMES.has(i.name))
    // count может быть 0 — || 1 исказил бы количество
    .reduce((s, i) => s + (typeof i.count === 'number' ? i.count : 1), 0);
}

/**
 * Есть ли луч. Один раз логирует, если лука нет.
 */
function hasBow() {
  const bow = findBow();
  if (!bow && !noBowWarned) {
    noBowWarned = true;
    logger.info('[🏹] Лука нет — только ближний бой');
  }
  if (bow) noBowWarned = false;
  return !!bow;
}

/**
 * Есть ли стрелы. Один раз логирует, если стрелы кончились.
 */
function hasArrows() {
  const n = countArrows();
  if (n <= 0 && !noArrowsWarned) {
    noArrowsWarned = true;
    logger.info('[🏹] Стрелы кончились — переключаюсь на ближний бой');
  }
  if (n > 0) noArrowsWarned = false;
  return n > 0;
}

/**
 * Видна ли цель. Если canSeeEntity есть — доверяем ему,
 * иначе сравниваем высоту.
 */
function canSee(target) {
  if (!target) return false;
  if (typeof bot.canSeeEntity === 'function') {
    try {
      return bot.canSeeEntity(target);
    } catch (e) {
      /* используем запасную проверку */
    }
  }
  const dy = Math.abs(bot.entity.position.y - target.position.y);
  return dy < 4;
}

function distanceTo(target) {
  return bot.entity.position.distanceTo(target.position);
}

/**
 * Лучшее ближнее оружие: меч, при его отсутствии — топор.
 */
function findMelee() {
  const pool = items().filter(
    (i) => i.name.endsWith(SWORD_SUFFIX) || i.name.endsWith(AXE_SUFFIX)
  );
  if (!pool.length) return null;

  const score = (i) => {
    const idx = TIER.findIndex((t) => i.name.startsWith(`${t}_`));
    return idx >= 0 ? TIER.length - idx : 0;
  };
  return pool.reduce((best, cur) => (score(cur) > score(best) ? cur : best), pool[0]);
}

/**
 * Взять ближнее оружие в руку. Дистанция < 4 — только меч, лук убираем.
 */
async function equipMelee() {
  const w = findMelee();
  if (!w) return false;
  if (bot.heldItem?.name === w.name) return true;
  try {
    await bot.equip(w, 'hand');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Прервать натяжение лука.
 */
function releaseCharge() {
  if (!charging) return;
  charging = false;
  // ДИАГНОСТИКА: временный лог, снимается после разбора
  logger.info(`[🏹 DBG] ВЫСТРЕЛ chargeTicks=${chargeTicks} target=${lastTargetName}`);
  chargeTicks = 0;
  shooting = false;
  lastTargetName = 'null';
  safe(() => bot.deactivateItem());
}

function safe(fn, ...args) {
  try {
    return fn(...args);
  } catch (e) {
    logger.info(`[🏹] ошибка: ${e.message}`);
    return null;
  }
}

/**
 * Запрет бить луком врукопашную.
 * mineflayer-pvp бьёт тем, что в руке, поэтому:
 *  - pvp.attack при дистанции >= 4 и наличии лука со стрелами: melee не нужен,
 *    но цель всё равно отдаётся pvp — иначе она не появится в bot.pvp.target,
 *    ranged.js её не увидит, а autoAttack будет долбить attack() каждые 10 тиков.
 *  - при дистанции < 4 в руку сначала идёт ближнее оружие, и только потом удар.
 */
function installPvpGuard() {
  const pvp = bot?.pvp;
  if (!pvp || bot.__rangedPvpWrapped) return;
  bot.__rangedPvpWrapped = true;

  const originalAttack = pvp.attack.bind(pvp);
  pvp.attack = async function (entity) {
    if (!entity || !bot?.entity) return;

    let dist = null;
    try {
      dist = bot.entity.position.distanceTo(entity.position);
    } catch (e) {
      dist = null;
    }

    const canShoot = !!findBow() && countArrows() > 0;
    // ДИАГНОСТИКА: временный лог, снимается после разбора
    const heldName = bot.heldItem?.name || 'none';
    const weapon = findMelee();

    if (dist != null && dist >= MIN_RANGE && canShoot) {
      logger.info(`[🏹 DBG] pvp.attack → ranged (dist=${dist.toFixed(1)}, hasBow=${!!findBow()}, hasArrows=${countArrows()}, held=${heldName})`);
      // Дальний бой: цель ведёт pvp, удары мечом не наносятся
      return originalAttack(entity);
    }

    // Ближний бой: оружие в руку ДО удара
    logger.info(`[🏹 DBG] pvp.attack → melee (dist=${dist == null ? 'n/a' : dist.toFixed(1)}, weapon=${weapon?.name || 'none'}, held=${heldName}, canShoot=${canShoot})`);

    // Нет оружия вообще — бить нечем, погоня бесполезна
    if (!weapon) {
      logger.warn('[⚔] Нет оружия — бой остановлен');
      try {
        await bot.pvp.stop();
      } catch (e) {
        /* бой и так не ведётся */
      }
      return;
    }

    if (bot.heldItem?.name !== weapon.name) {
      try {
        await bot.equip(weapon, 'hand');
      } catch (e) {
        /* остаётся то, что в руке */
      }
    }

    // Цель уже назначена — повторный вызов перезапускает погоню
    // и обнуляет кулдаун удара в mineflayer-pvp
    if (bot.pvp.target === entity) return;

    return originalAttack(entity);
  };

  // ДИАГНОСТИКА: mineflayer-pvp эмитит это событие сразу после bot.attack().
  // Значит событие есть — удар отправлен; нет — пакет не ушёл.
  bot.on('attackedTarget', () => {
    if (now() - lastAttackEventAt < 1000) return;
    lastAttackEventAt = now();
    const t = bot?.pvp?.target;
    const d = t && bot.entity ? bot.entity.position.distanceTo(t.position).toFixed(1) : 'n/a';
    logger.info(`[⚔ DBG] attackedTarget: dist=${d} held=${bot?.heldItem?.name || 'empty'}`);
  });
}

/**
 * Если идёт бой, а в руке лук — вернуть ближнее оружие.
 * Правило «не бить луком врукопашную» обеспечивается здесь,
 * без обёртки bot.pvp.attemptAttack: пакет удара mineflayer-pvp не трогаем.
 * Вызывается из physicsTick до autoAttack.
 */
function enforceMeleeWeapon() {
  if (!bot || !bot.entity || !bot.pvp?.target) return false;
  const held = bot.heldItem?.name;
  if (!held || !held.endsWith('_bow')) return false;
  const weapon = findMelee();
  if (!weapon) return false;
  try {
    const p = bot.equip(weapon, 'hand');
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    return false;
  }
  return true;
}

/**
 * Тик дальнего боя. Вызывается из bot.js каждый тик,
 * внутри считает тики натяжения (без setTimeout).
 */
async function onTick() {
  if (!bot || !bot.entity) return;

  // ДИАГНОСТИКА: снимок состояния раз в 500 мс. Снимается после разбора бага.
  if (!global._rangedDbgLast || Date.now() - global._rangedDbgLast > 500) {
    global._rangedDbgLast = Date.now();
    const tgt = bot.pvp?.target;
    const dist = tgt ? bot.entity.position.distanceTo(tgt.position).toFixed(1) : 'n/a';
    const bowCount = items().filter((i) => i.name.endsWith('_bow') || i.name === 'bow').length;
    const arrowCount = countArrows();
    logger.info(
      `[🏹 DBG] dist=${dist} bow=${bowCount} arrows=${arrowCount} shooting=${shooting} ` +
      `charging=${charging} chargeTicks=${chargeTicks} held=${bot.heldItem?.name || 'empty'} ` +
      `pvpTarget=${tgt?.name || 'null'} tgtHP=${tgt ? (tgt.health != null ? tgt.health.toFixed(1) : 'n/a') : 'n/a'} ` +
      `botHP=${bot.health != null ? bot.health.toFixed(1) : 'n/a'} canSee=${tgt ? canSee(tgt) : 'n/a'} ` +
      `pvpInRange=${bot.pvp?.wasInRange} pvpNext=${bot.pvp?.timeToNextAttack} pvpRange=${bot.pvp?.attackRange}`
    );
  }

  const target = bot.pvp?.target;
  if (!target) {
    // Цели нет — натяжение сбрасываем, лук остаётся в руке до решения equipment.js
    releaseCharge();
    shooting = false;
    return;
  }

  let dist;
  try {
    dist = distanceTo(target);
  } catch (e) {
    return;
  }

  // Дистанция < 4 — только ближний бой, лук из руки убираем
  if (dist < MIN_RANGE) {
    releaseCharge();
    shooting = false;
    await equipMelee();
    return;
  }

  // Дотягиваем натяжение — тик вызывается каждый physicsTick.
  // Тик активации — первый из CHARGE_TICKS, поэтому счёт стартует с 1.
  if (charging) {
    chargeTicks++;
    if (chargeTicks >= CHARGE_TICKS) {
      releaseCharge();
    }
    return;
  }

  // Слишком далеко — ни лук, ни меч: цель ещё не в рабочей зоне
  if (dist > MAX_RANGE) {
    shooting = false;
    return;
  }

  if (!hasBow() || !hasArrows()) {
    shooting = false;
    await equipMelee();
    return;
  }
  if (!canSee(target)) {
    shooting = false;
    return;
  }

  // Лук должен быть в руке — иначе pvp ударит мечом по не-HP-цели
  const held = bot.heldItem?.name;
  if (held !== 'bow') {
    const bow = findBow();
    if (!bow) return;
    safe(() => bot.equip(bow, 'hand'));
  }

  // Целимся чуть выше центра
  try {
    const aim = target.position.offset(0, 1.5, 0);
    const look = bot.lookAt(aim, true);
    if (look && typeof look.then === 'function') await look;
  } catch (e) {
    /* цель не обязана попасть — логируем выстрел */
  }

  charging = true;
  shooting = true;
  chargeTicks = 1;   // тик активации входит в счёт
  lastTargetName = target.name || 'null';
  safe(() => bot.activateItem());

  if (now() - lastShotLog >= SHOT_LOG_INTERVAL) {
    lastShotLog = now();
    logger.info(`[🏹] Выстрел в ${target.name} (${dist.toFixed(1)}м)`);
  }
}

function setBot(instance) {
  bot = instance;
  chargeTicks = 0;
  charging = false;
  shooting = false;
  noBowWarned = false;
  noArrowsWarned = false;

  if (bot && typeof bot.once === 'function') {
    bot.once('spawn', () => {
      logger.info('[🏹] ranged активен');
      installPvpGuard();
    });
  }
}

function getStatus() {
  return {
    shooting,
    arrowsLeft: countArrows(),
    bowEquipped: (bot?.heldItem?.name === 'bow')
  };
}

module.exports = {
  setBot,
  onTick,
  enforceMeleeWeapon,
  getStatus
};
