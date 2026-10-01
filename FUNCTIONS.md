# FUNCTIONS.md — примеры и разбор

Дополнение к [`README.md`](README.md): по каждой команде — ввод, ожидаемый ответ, что происходит в игре; по каждой авто-функции — реальная последовательность строк лога; плюс диаграмма состояний и карта ответственности модулей.

Все фрагменты логов в этом документе сняты с живого прогона `2026-10-01T11:13:53Z … 11:14:43Z` (окно 50 секунд), сервер 1.21.11, `offline`.

---

## 1. Команды

Три источника, один обработчик — `executeCommand(source, playerName, rawMessage)` в `src/commands.js`:

| Источник | `source` | Префикс `!` | Ответ уходит |
|----------|----------|--------------|--------------|
| Чат Minecraft | `game` | обязателен (`config.prefix`) | в чат игрока |
| CLI | `cli` | не нужен | в промпт `bot> ` + лог |
| Web GUI | `web` | не нужен | WS-кадр `chat` + лог |

Каждый ответ пишется в лог строкой `[<SOURCE>] <текст ответа>`, где `<SOURCE>` = `GAME`, `CLI` или `WEB`.

### `follow <ник>`

- Ввод: `follow Buddy`
- Ответ: `Следую за Buddy`
- В игре: `pathfinder.setGoal(new GoalFollow(player.entity, config.followDistance), true)` — путь пересчитывается при движении игрока. Охрана снимается.
- Лог:

```
[2026-10-01T11:13:59.491Z] [INFO] [🏰] Охрана остановлена
[2026-10-01T11:13:59.495Z] [INFO] Следую за Buddy
[2026-10-01T11:13:59.496Z] [INFO] [WEB] Следую за Buddy
```

- Ошибка: если игрока нет в зоне видимости — `Не вижу игрока <ник>`, цель не меняется.
- Повторный `follow` после респавна: цель восстанавливается автоматически в хендлере `spawn` (`bot.js`).

### `stop`

- Ввод: `stop`
- Ответ: `Остановился`
- В игре: снимаются следование, охрана и бой. Авто-атака при этом остаётся включённой (`combatEnabled` не меняется) — выключается только через `peace`.
- Лог:

```
[2026-10-01T11:14:39.120Z] [INFO] [🏰] Охрана остановлена
[2026-10-01T11:14:39.120Z] [INFO] [⚔] Бой остановлен
[2026-10-01T11:14:39.121Z] [INFO] [WEB] Остановился
```

### `guard [радиус]`

- Ввод: `guard 8` (без аргумента — `config.guardRadius`)
- Ответ: `Охрана включена (радиус 8)`
- В игре: запоминается текущая точка, запускается `setInterval` на 1000 мс. Раз в секунду, если бот не в бою и отошёл больше чем на 1.5 блока, включается `GoalBlock` — возврат на точку. Радиус в команде и в `status` — это параметр охраны; фактический порог возврата — 1.5 блока.
- Лог:

```
[2026-10-01T11:14:02.711Z] [INFO] [🏰] Охрана остановлена
[2026-10-01T11:14:02.711Z] [INFO] [🏰] Охраняю точку (19, 63, 39), радиус 8
[2026-10-01T11:14:02.712Z] [INFO] [WEB] Охрана включена (радиус 8)
```

- При уходе точки: `[INFO] [🏰] Возвращаюсь к точке (3.2 > 1.5)` и `GoalBlock`.
- В бою охрана молчит: `if (bot.pvp?.target) return;`

### `unguard`

- Ввод: `unguard`
- Ответ: `Охрана снята`
- В игре: `clearInterval`, сброс цели охраны, `pathfinder.setGoal(null)`.
- Лог:

```
[2026-10-01T11:14:28.336Z] [INFO] [🏰] Охрана остановлена
[2026-10-01T11:14:28.337Z] [INFO] [WEB] Охрана снята
```

### `attack`

- Ввод: `attack`
- Ответ: `Атакую zombie` либо `Врагов рядом нет`, либо `Уже в бою`
- В игре: ищет ближайшую сущность с `type === 'hostile'` в радиусе `combatRadius` и вызывает `bot.pvp.attack(mob)`. Команда дополнительно включает авто-атаку.
- Лог при отсутствии мобов:

```
[2026-10-01T11:14:29.549Z] [INFO] [WEB] Врагов рядом нет
```

### `peace`

- Ввод: `peace`
- Ответ: `Мир`
- В игре: `bot.pvp.stop()`, `combatEnabled = false` — авто-атака больше не срабатывает ни по триггеру, ни по команде `attack` без повторного включения.
- Лог:

```
[2026-10-01T11:14:30.758Z] [INFO] [⚔] Бой остановлен
[2026-10-01T11:14:30.758Z] [INFO] [WEB] Мир
```

### `armor`

- Ввод: `armor`
- Ответ: `Броня надета`
- В игре: `bot.armorManager.equipAll()` — надевает лучший доступный комплект.
- Лог:

```
[2026-10-01T11:14:31.966Z] [INFO] [WEB] Броня надета
```

### `sword`

- Ввод: `sword`
- Ответ: `Оружие в руке` либо `Нет оружия`
- В игре: `equipBestWeapon()` — мечи приоритетнее топоров, сортировка по тиру (`netherite → wooden`) и бонусу `sharpness`. Если лучший предмет уже в руке, лог не пишется.
- Лог:

```
[2026-10-01T11:14:33.179Z] [INFO] [WEB] Оружие в руке
```

Типичная строка смены оружия при авто-экипировке:

```
[INFO] [🗡] В руке: netherite_sword
```

### `status`

- Ввод: `status`
- Ответ: `HP:20 Food:20 Pos:19,63,39 Guard:OFF Combat:ON Target:null`
- В игре: ничего не меняет, только читает состояние. `Guard` = `ON(r=<радиус>)` или `OFF`, `Combat` = `ON`/`OFF`, `Target` — ник цели или `null`.
- Лог:

```
[2026-10-01T11:14:05.917Z] [INFO] [WEB] HP:20 Food:20 Pos:19,63,39 Guard:OFF Combat:ON Target:null
```

### `stats`

- Ввод: `stats`
- Ответ: `🍖 potions 0/0, apples 0/0, food 0/0, blacklist=[]`
- Формат `эффективно/попыток` по каждому классу расходников плюс текущий чёрный список зелий.
- Лог:

```
[2026-10-01T11:14:34.393Z] [INFO] [WEB] 🍖 potions 0/0, apples 0/0, food 0/0, blacklist=[]
```

Пример с накопленными расходами: `🍖 potions 0/2, apples 1/1, food 0/0, blacklist=[24,25]`.

### `potions`

- Ввод: `potions`
- Ответ — несколько строк (длинные режутся по 240 символов, лимит чата 256):

```
[POTIONS] registry=MISSING typeof=undefined
[POTIONS] effectsRegistry=OK blacklist=[]
[POTIONS] всего=2
id=24 name=potion displayName=Potion components=[{"type":"potion_contents","data":{"potionId":24,"customEffects":[]}}] registryName=undefined
id=25 name=potion displayName=Potion components=[{"type":"potion_contents","data":{"potionId":25,"customEffects":[]}}] registryName=undefined
```

- Первая строка говорит, есть ли реестр зелий, вторая — реестр эффектов и чёрный список, дальше — по каждому зелью `potionId`, `displayName` и сырые `components`. Это главный инструмент для разбора зелий на 1.21.11.

### `clearpotions`

- Ввод: `clearpotions`
- Ответ: `Чёрный список зелий очищен`
- Лог (стек оставлен намеренно — срабатывает только на ручной вызов):

```
[2026-10-01T11:14:37.613Z] [INFO] [🍖] clearPotionBlacklist() вызван из:
Error
    at clearPotionBlacklist (E:\develope\mc-bot-andrew\src\consumables.js:67:58)
    at executeCommand (E:\develope\mc-bot-andrew\src\commands.js:139:31)
    at WebSocket.<anonymous> (E:\develope\mc-bot-andrew\src\web.js:79:17)
[2026-10-01T11:14:37.614Z] [INFO] [🍖] Чёрный список зелий: очищен
[2026-10-01T11:14:37.615Z] [INFO] [WEB] Чёрный список зелий очищен
```

### `help`

- Ввод: `help`
- Ответ: 14 строк со списком команд.

```
[2026-10-01T11:14:40.331Z] [INFO] [WEB] Доступные команды:
  follow <ник> — следовать за игроком
  stop — остановить всё
  guard [радиус] — охранять точку
  unguard — снять охрану
  attack — атаковать ближайшего врага
  peace — прекрать бой
  armor — надеть броню
  sword — взять оружие
  status — показать статус
  potions — отчёт по зельям в инвентаре
  clearpotions — очистить чёрный список зелий
  stats — счётчики расходов (зелья/яблоки/еда)
  help — список команд
  quit — выйти
```

### `quit`

- Ввод: `quit`
- Ответ: нет — процесс завершается.
- Лог:

```
[2026-10-01T11:14:42.343Z] [WARN] Завершение: Команда из web
[2026-10-01T11:14:42.347Z] [WARN] End: graceful shutdown
[2026-10-01T11:14:42.348Z] [INFO] [🏰] Охрана остановлена
[2026-10-01T11:14:42.348Z] [WARN] Reconnect #1 через 5с (backoff[0])
[2026-10-01T11:14:43.354Z] [INFO] Process exit with code 0
```

Строка `Reconnect #1` — особенность: `quit` вызывает `safety.gracefulShutdown`, а флаг `isShuttingDown` в `bot.js` при этом не выставляется, поэтому планируется переподключение. До него дело не доходит: через 1с срабатывает `process.exit(0)`.

---

## 2. Авто-функции: последовательности в логе

### 2.1 Старт и вход в сервер

```
[2026-10-01T11:13:53.959Z] [INFO] [LOG] TTY=false, file=./logs/bot-2026-10-01.log
[2026-10-01T11:13:54.169Z] [INFO] mineflayer-pvp загружен
[2026-10-01T11:13:54.170Z] [INFO] mineflayer-armor-manager загружен
[2026-10-01T11:13:54.170Z] [INFO] mineflayer-auto-eat загружен
[2026-10-01T11:13:54.171Z] [INFO] [BOT] bindEvents вызван
[2026-10-01T11:13:54.174Z] [INFO] [CLI] Неинтерактивный режим (stdin не TTY), CLI отключён
[2026-10-01T11:13:54.186Z] [INFO] [WEB] Web GUI запущен на http://localhost:3000
[2026-10-01T11:13:54.277Z] [INFO] [CLI] stdin закрыт (EOF)
[2026-10-01T11:13:54.582Z] [INFO] [WEB] Порт 3000 подтверждён — Web GUI отвечает
[2026-10-01T11:13:55.342Z] [INFO] haise вошёл
[2026-10-01T11:13:55.376Z] [INFO] [🍖] potions registry: MISSING
[2026-10-01T11:13:55.377Z] [INFO] [🍖] effects registry: OK
```

Порядок важен: плагины → события → CLI → Web GUI → login → реестры зелий в `bot.once('spawn')`. Строки `potions registry:` и `effects registry:` — единственный реальный маркер спавна в проекте, его использует smoke-тест.

### 2.2 Авто-атака враждебных

Срабатывает на каждом 10-м тике, если `combatEnabled` и бот не в бою:

```
[2026-10-01T11:01:38.435Z] [INFO] [⚔] Цель: creeper @ 5.0м
[2026-10-01T10:59:36.849Z] [INFO] [⚔] Цель: zombie @ 3.1м
```

При охране радиус расширяется: `guardRadius + 4` вместо `combatRadius`. Сторожевой таймер при зависшем бое:

```
[WARN] [⚔] Сторожевой таймер: бой длится >30с, цель не двигается. Сбрасываем.
```

### 2.3 Авто-экипировка оружия

```
[INFO] [🗡] В руке: netherite_sword
[INFO] [🛡] Щит в левой руке
```

Срабатывает при `spawn`, при `playerCollect` (через 500 мс) и на каждом 20-м тике, если в руке не оружие и бот не ест. Повторно тот же предмет не логируется.

### 2.4 Авто-лечение и авто-еда

Цикл при `hp < autoHealThreshold` (10) и пустом чёрном списке:

```
[2026-10-01T11:01:40.977Z] [WARN] [🍖] enchanted_golden_apple использован, но эффекта нет (hp=0, food=17)
[2026-10-01T11:01:41.927Z] [WARN] [🍖] potion использован, эффекта нет — id=25 в чёрный список (hp=0, food=17)
[2026-10-01T11:01:41.927Z] [INFO] [🗡] В руке: netherite_sword
[2026-10-01T11:01:42.963Z] [WARN] [🍖] все зелья в инвентаре в чёрном списке (2 шт), пропускаю — используй !clearpotions для сброса
[2026-10-01T11:01:46.524Z] [INFO] [🍖] Съел enchanted_golden_apple
[2026-10-01T11:01:46.525Z] [INFO] [🗡] В руке: netherite_sword
```

Разбор: зелье без эффекта → `potionId` в чёрный список → когда все зелья заблокированы, одна строка-подсказка про `!clearpotions` (не спамится на неизменный инвентарь) → яблоко/еда поднимают HP → оружие возвращается в руку. Успешный цикл выглядит так: `[INFO] [🍖] Пью Potion` → `[INFO] [🗡] В руке: netherite_sword`.

### 2.5 Охрана точки

```
[INFO] [🏰] Охрана остановлена
[INFO] [🏰] Охраняю точку (19, 63, 39), радиус 8
[INFO] [🏰] Возвращаюсь к точке (3.2 > 1.5)     ← при уходе, только вне боя
```

### 2.6 Reconnect с backoff

```
[INFO] haise вошёл                       ← login: сброс reconnectCount и backoffIndex
[WARN] End: <причина обрыва>
[WARN] Reconnect #1 через 5с (backoff[0])
[WARN] Reconnect #2 через 10с (backoff[1])
[WARN] Reconnect #3 через 30с (backoff[2])
[WARN] Reconnect #4 через 60с (backoff[3])
[WARN] Reconnect #5 через 120с (backoff[4])  ← далее кап 120с
```

### 2.7 Смерть

```
[WARN] Смерть. Возрождаюсь...
[INFO] [🏰] Охрана остановлена
[INFO] [⚔] Бой остановлен
[INFO] [🗡] В руке: netherite_sword          ← экипировка на новом спавне
```

Пауза перед `bot.respawn()` — 1 с. Все отложенные таймеры (`respawnTimer`, `collectTimers`) гасятся, чтобы старые срабатывания не били по новому инстансу.

### 2.8 Heartbeat

```
[2026-10-01T11:14:25.348Z] [INFO] [HEARTBEAT] uptime=30s, tick=599, mem=58MB, hp=20, connected=true
```

Раз в 30 с. `tick` — счётчик `physicsTick`, полезен для проверки, что бот не подвисает.

### 2.9 Занятый Web-порт

```
[INFO] [WEB] Web GUI запущен на http://localhost:3000
[INFO] haise вошёл
[ERROR] [WEB] Порт 3000 занят — Web GUI недоступен. Освободи порт и перезапусти, либо задай другой webPort в config.json.
[INFO] [🍖] Съел enchanted_golden_apple
```

Порядок важен: bind на Windows проходит успешно даже при занятом порте, поэтому в логе сначала идёт «запущен», затем самозапрос обнаруживает, что отвечает чужой процесс. Игра продолжается.

### 2.10 Диагностика при `debug: true`

```
[INFO] [DBG] tick=500, hostiles=2, radius=10, pvp=zombie
```

Раз в 100 тиков (~5 с).

---

## 3. Диаграмма состояний

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    v                                          │
IDLE ──follow <ник>──> FOLLOWING ──stop / unguard──> IDLE ─────┘
  │                        │
  │                        └── (приходит враждебный) ──┐
  │                                                    v
  ├──guard [r]──> GUARDING ──(приходит враждебный)──> FIGHTING ──> GUARDING
  │                   │   ▲                              │        (возврат на точку)
  │                   │   └──(бой окончен, возврат >1.5)──┘
  │                   │
  │                   └──unguard / stop / follow──> IDLE
  │
  └──(враждебный в радиусе, combatEnabled)──> FIGHTING ──> IDLE

FOLLOWING ──(враждебный в радиусе)──> FIGHTING ──> FOLLOWING (следование продолжается)

Отдельные ветки, не состояния:
  IDLE/FOLLOWING/GUARDING/FIGHTING ──quit / SIGINT / SIGTERM──> SHUTDOWN (exit 0 через 1с)
  любой ──end──> RECONNECT (backoff 5с→120с) ──login──> IDLE
```

Подробности переходов:

| Переход | Условие | Кто инициирует |
|---------|---------|----------------|
| `IDLE → FOLLOWING` | `follow <ник>`, игрок виден | `src/commands.js` → `src/follow.js` |
| `FOLLOWING → IDLE` | `stop`, `unguard`, `follow` другого игрока | `src/commands.js` |
| `IDLE → GUARDING` | `guard [r]` | `src/commands.js` → `src/guard.js` |
| `GUARDING → FIGHTING` | враждебный в радиусе, каждый 10-й тик | `bot.js` → `src/combat.js` |
| `GUARDING → GUARDING` | уход > 1.5 блока вне боя | `src/guard.js` (`GoalBlock`) |
| `→ FIGHTING` | `attack` вручную | `src/commands.js` → `attackEntity()` |
| `FIGHTING → IDLE` | `peace`, `stop`, смерть цели | `src/combat.js` → `stopCombat()` |
| `FIGHTING` зависает | 30 с без движения цели | `checkWatchdog()` |
| любое → `SHUTDOWN` | `quit`, Ctrl+C | `src/safety.js` |

Счётчик `combatEnabled` — отдельный переключатель, а не состояние: `peace` выключает авто-атаку, `attack` включает обратно. `stop` его не трогает.

---

## 4. Карта ответственности модулей

| Модуль | Функция | Событие / триггер | Побочный эффект |
|--------|---------|-------------------|----------------|
| `bot.js` | `createBot()` | старт | `mineflayer.createBot`, загрузка 4 плагинов |
| `bot.js` | `bindEvents()` | старт | однократная привязка, флаг `bot.__eventsBound` |
| `bot.js` | `login` | сервер | сброс `reconnectCount`, `backoffIndex`, старт heartbeat |
| `bot.js` | `spawn` | спавн | броня, оружие, щит, авто-еда, восстановление следования |
| `bot.js` | `playerCollect` | подбор | броня и оружие через 500 мс |
| `bot.js` | `physicsTick` | каждый тик | счётчик тиков, авто-атака (10), экипировка и лечение (20), `[DBG]` (100) |
| `bot.js` | `chat` | сообщение в игре | трансляция в Web GUI + `executeCommand('game', ...)` |
| `bot.js` | `death` | смерть | таймеры, снятие режимов, `respawn()` через 1 с |
| `bot.js` | `error` / `kicked` / `end` | ошибки и обрыв | лог; на `end` — reconnect с backoff |
| `bot.js` | `gracefulShutdown()` | SIGINT / SIGTERM | выход с кодом 0 через 1 с |
| `src/commands.js` | `executeCommand()` | чат / CLI / WS | 14 команд, единый разбор аргументов |
| `src/commands.js` | `sendReply()` | после каждой команды | ответ в чат / WS + строка `[<SOURCE>]` в лог |
| `src/combat.js` | `findHostileMob()` | `physicsTick` / `attack` | ближайший `hostile` в радиусе |
| `src/combat.js` | `autoAttack()` | 10-й тик | `pvp.attack()`, лог `Цель:` |
| `src/combat.js` | `checkWatchdog()` | 10-й тик | `pvp.stop()` при зависании |
| `src/combat.js` | `stopCombat()` | `peace` / `stop` / смерть | сброс боя и таймера |
| `src/consumables.js` | `setBot()` → `spawn` | спавн | очистка чёрного списка, чтение реестров |
| `src/consumables.js` | `autoHeal()` | 20-й тик при `hp < 14` | зелье → яблоко → еда, кулдауны 10 с / 5 с |
| `src/consumables.js` | `findHealingPotion()` | внутри лечения | 3 уровня поиска: реестр → `customEffects` → чёрный список |
| `src/consumables.js` | `setupAutoEat()` | спавн | `startAt = autoEatStartAt`, бан яблок и зелий |
| `src/consumables.js` | `getStats()` | `stats` | счётчики + чёрный список |
| `src/consumables.js` | `describePotions()` | `potions` | отчёт по инвентарю |
| `src/consumables.js` | `clearPotionBlacklist()` | `clearpotions` | полный сброс + стек вызова в лог |
| `src/equipment.js` | `equipBestWeapon()` | спавн / подбор / 20-й тик / `sword` | `bot.equip`, лог при смене |
| `src/equipment.js` | `equipShield()` | спавн | щит в `off-hand` |
| `src/equipment.js` | `weaponScore()` | при сортировке | тир + `sharpness` |
| `src/guard.js` | `startGuard()` | `guard` | точка, радиус, `setInterval` 1000 мс |
| `src/guard.js` | интервал охраны | каждую секунду | `GoalBlock` при уходе > 1.5, пропуск в бою |
| `src/guard.js` | `stopGuard()` | `unguard` / `stop` / `follow` / смерть | сброс цели и таймера |
| `src/follow.js` | `startFollowing()` | `follow` | `GoalFollow` с `followDistance` |
| `src/follow.js` | `stopFollowing()` | `stop` / смерть | `setGoal(null)` |
| `src/logger.js` | `info/warn/error/debug()` | любое событие | запись в `logs/bot-ГГГГ-ММ-ДД.log` (UTF-8), stdout при TTY, WS-кадр `log` |
| `src/logger.js` | `startHeartbeat()` | `login` | строка `[HEARTBEAT]` раз в 30 с |
| `src/logger.js` | `uncaughtException` | фатальная ошибка | стек в лог + `process.exit(1)` |
| `src/web.js` | `init()` | старт | HTTP + WS на `WEB_PORT_OVERRIDE` или `webPort` |
| `src/web.js` | `verifyWebGui()` | после `listen` | самозапрос: подтверждение или «порт занят» |
| `src/web.js` | `broadcastStatus()` | 1 раз в секунду | кадр `status` всем клиентам |
| `src/web.js` | `ws.on('message')` | сообщение WS | `{type:'command'}` → `executeCommand('web', ...)` |
| `src/cli.js` | `init()` | старт | промпт `bot> ` при TTY, буфер команд иначе |
| `src/cli.js` | `notifyReady()` | `login` | выполнение отложенных команд |
| `src/safety.js` | `gracefulShutdown()` | `quit` / сигнал | `bot.quit()` + `process.exit(0)` через 1 с |
| `tests/smoke.js` | `main()` | `node tests/smoke.js` | 12 проверок, код возврата 0 / 1 / 2 |