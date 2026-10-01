const logger = require('./logger');

let bot = null;

const SWORD_SUFFIX = '_sword';
const AXE_SUFFIX = '_axe';

const TIER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

function items() {
  try {
    return bot?.inventory?.items?.() || [];
  } catch (e) {
    return [];
  }
}

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

function setBot(instance) {
  bot = instance;

  if (!bot?.pvp || bot.__rangedPvpWrapped) return;
  bot.__rangedPvpWrapped = true;

  const originalAttack = bot.pvp.attack.bind(bot.pvp);

  bot.pvp.attack = async function (entity) {
    if (!entity || !bot?.entity) return;

    // Уже на этой цели — не перезапускаем погоню (mineflayer-pvp state)
    if (bot.pvp.target === entity) return;

    const weapon = findMelee();

    if (weapon) {
      if (!bot.heldItem || bot.heldItem.name !== weapon.name) {
        try {
          await bot.equip(weapon, 'hand');
        } catch (e) {
          // остаётся то, что в руке
        }
      }
    } else {
      // Нет оружия — бить рукой (освободить руку, если там что-то лишнее)
      if (bot.heldItem) {
        try {
          await bot.unequip('hand');
        } catch (e) {
          /* ничего не делаем */
        }
      }
    }

    return originalAttack(entity);
  };
}

function getStatus() {
  const weapon = findMelee();
  return {
    meleeWeapon: weapon ? weapon.name : null
  };
}

module.exports = {
  setBot,
  getStatus
};
