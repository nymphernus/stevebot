'use strict';

// Smoke-тест всей системы: node tests/smoke.js
// Только стандартная библиотека Node + уже установленный ws.
// Ничего в src/ и bot.js не изменяется — тест только читает поведение.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const BOT_LOG_OUT = path.join(__dirname, 'smoke-bot.log');
const config = require(path.join(ROOT, 'config.json'));
const CONFIG_WEB_PORT = config.webPort ?? 3000;
const OVERRIDE_PORT = 3100; // используется, если порт из config.json занят
let wsPort = CONFIG_WEB_PORT;
const wsUrl = () => `ws://127.0.0.1:${wsPort}/`;
const BOT_LOG_FILE = path.join(
  ROOT, 'logs', `bot-${new Date().toISOString().split('T')[0]}.log`
);

const LOGIN_TIMEOUT_MS = 30000;
const STATUS_TIMEOUT_MS = 5000;
const REPLY_TIMEOUT_MS = 3000;
const QUIT_TIMEOUT_MS = 5000;

const results = [];
let child = null;
let killed = false;

function ok(name) {
  results.push({ ok: true, name });
}

function fail(name, reason) {
  results.push({ ok: false, name, reason });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Ожидание условия с опросом
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

// Лог-файл бота: logger пишет туда всегда, stdout — только при TTY.
// Накапливаем содержимое целиком, иначе строка, прочитанная одной проверкой,
// теряется для следующей (инкрементальный хвост съедал маркер спавна).
let logOffset = 0;
let logBuf = '';
const LOG_BUF_MAX = 200000;

function readBotLog() {
  if (fs.existsSync(BOT_LOG_FILE)) {
    const size = fs.statSync(BOT_LOG_FILE).size;
    if (size < logOffset) {
      logOffset = 0;
      logBuf = ''; // файл пересоздан
    }
    if (size > logOffset) {
      const fd = fs.openSync(BOT_LOG_FILE, 'r');
      const buf = Buffer.alloc(size - logOffset);
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      fs.closeSync(fd);
      logOffset = size;
      logBuf += buf.toString('utf8');
      if (logBuf.length > LOG_BUF_MAX) logBuf = logBuf.slice(-LOG_BUF_MAX);
    }
  }
  return logBuf;
}

// Порт свободен?
// Проверка через bind НЕ работает на Windows: если порт держит процесс на
// 0.0.0.0 (а бот слушает именно так), то bind на 127.0.0.1 проходит успешно.
// Поэтому спрашиваем через connect — он видит слушателя независимо от адреса.
function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (verdict) => {
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(1500, () => settle(false)); // кто-то не отвечает — считаем занятым
    socket.once('connect', () => settle(false)); // кто-то слушает
    socket.once('error', () => settle(true)); // ECONNREFUSED — порт свободен
  });
}

// Вариант B: порт из config.json занят — поднимаем GUI на OVERRIDE_PORT
// через WEB_PORT_OVERRIDE (bot.js → src/web.js). Тест от занятости 3000 не зависит.
// Возвращает 'env', если оба порта заняты (это не FAIL системы).
async function resolveWebPort() {
  if (await portFree(CONFIG_WEB_PORT)) {
    wsPort = CONFIG_WEB_PORT;
    return null;
  }
  if (!(await portFree(OVERRIDE_PORT))) {
    console.log(`FAIL: порты ${CONFIG_WEB_PORT} и ${OVERRIDE_PORT} заняты. Освободи и повтори.`);
    return 'env';
  }
  wsPort = OVERRIDE_PORT;
  console.log(
    `[WEB] override port → ${OVERRIDE_PORT} (порт ${CONFIG_WEB_PORT} занят, боту передан WEB_PORT_OVERRIDE=${OVERRIDE_PORT})`
  );
  return null;
}

function killBot() {
  if (!child || child.exitCode !== null || killed) return;
  killed = true;
  try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
}

function report() {
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log('SMOKE TEST');
  for (const r of results) {
    console.log(r.ok ? `[OK]  ${r.name}` : `[FAIL] ${r.name} — ${r.reason}`);
  }
  if (passed === results.length) {
    console.log(`PASS ${passed}/${results.length}`);
  } else {
    console.log(`FAIL ${results.length - passed} из ${results.length} проверок не прошли`);
  }
  console.log(`лог бота: ${BOT_LOG_OUT}`);
  return passed === results.length;
}

async function main() {
  const envBlocked = await resolveWebPort();
  if (envBlocked) return envBlocked;

  // ---- Шаг 1. Запуск бота ----
  const out = fs.createWriteStream(BOT_LOG_OUT, { flags: 'w' });
  let stdoutBuf = '';
  const childEnv = { ...process.env };
  if (wsPort !== CONFIG_WEB_PORT) childEnv.WEB_PORT_OVERRIDE = String(wsPort);
  child = spawn('node', ['bot.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv
  });
  child.stdout.on('data', (d) => { stdoutBuf += d.toString('utf8'); out.write(d); });
  child.stderr.on('data', (d) => { stdoutBuf += d.toString('utf8'); out.write(d); });
  child.on('exit', () => out.end());

  const botLogAll = () => readBotLog() + stdoutBuf;

  // ---- Шаг 2. Ожидание подключения ----
  const login = await waitFor(() => {
    const t = botLogAll();
    const m = t.match(/\[.*?\] \[INFO\] (\S+) вошёл/);
    return m ? m[1] : null;
  }, LOGIN_TIMEOUT_MS);
  if (!login) {
    fail('bot login', `нет строки «вошёл» за ${LOGIN_TIMEOUT_MS / 1000}с`);
    killBot();
    return false;
  }
  ok(`bot login (${login})`);

  // Спавна отдельной строкой нет нигде в коде; маркер спавна —
  // bot.once('spawn') в consumables.js, который пишет «potions registry:»
  const spawnOk = await waitFor(() => {
    const t = botLogAll();
    return t.includes('[🍖] potions registry:') ? true : null;
  }, LOGIN_TIMEOUT_MS);
  if (!spawnOk) {
    fail('bot spawn', `нет маркера спавна «potions registry:» за ${LOGIN_TIMEOUT_MS / 1000}с`);
    killBot();
    return false;
  }
  ok('bot spawn');

  // ---- Шаг 3. WS-подключение и кадр статуса ----
  let ws = null;
  let chatMessages = [];
  const statusFrame = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(value);
    };

    const watchdog = setTimeout(
      () => finish({ error: `нет кадра status за ${STATUS_TIMEOUT_MS / 1000}с` }),
      STATUS_TIMEOUT_MS
    );

    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      finish({ error: e.message });
      return;
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.type === 'status' && msg.data) {
        finish({ data: msg.data });
      } else if (msg.type === 'chat' && msg.data) {
        chatMessages.push(String(msg.data.message || ''));
      }
    });

    ws.on('error', (e) => finish({ error: `WS: ${e.message}` }));
  });

  if (statusFrame.error) {
    fail('ws connect', statusFrame.error);
    killBot();
    return false;
  }
  ok('ws connect');

  const d = statusFrame.data;
  const problems = [];
  if (d.connected !== true) problems.push(`connected=${JSON.stringify(d.connected)}`);
  if (typeof d.hp !== 'number' || !Number.isInteger(d.hp)) problems.push(`hp=${JSON.stringify(d.hp)}`);
  if (typeof d.food !== 'number' || !Number.isInteger(d.food)) problems.push(`food=${JSON.stringify(d.food)}`);
  if (!d.pos || typeof d.pos.x !== 'number') problems.push(`pos=${JSON.stringify(d.pos)}`);
  if (typeof d.guard !== 'string') problems.push(`guard=${JSON.stringify(d.guard)}`);
  if (typeof d.combat !== 'string') problems.push(`combat=${JSON.stringify(d.combat)}`);

  if (problems.length) {
    fail('ws status frame', problems.join('; '));
    killBot();
    return false;
  }
  ok(`ws status frame (hp=${d.hp} food=${d.food} guard=${d.guard} combat=${d.combat})`);

  // ---- Шаги 4-5. Команды и ответы ----
  const plan = [
    { cmd: 'status', expect: ['Guard:OFF', 'Combat:ON'], label: 'cmd status → Guard:OFF Combat:ON' },
    { cmd: 'guard 8', expect: ['Охрана'], label: 'cmd guard 8 → Охрана' },
    { cmd: 'status', expect: ['Guard:ON(r=8)'], label: 'cmd status → Guard:ON(r=8)' },
    { cmd: 'unguard', expect: ['Охрана снята'], label: 'cmd unguard → Охрана снята' },
    { cmd: 'status', expect: ['Guard:OFF'], label: 'cmd status → Guard:OFF' },
    { cmd: 'stats', expect: ['\u{1F356}', 'potions'], label: 'cmd stats → \u{1F356} potions ...' },
    { cmd: 'potions', expect: ['[POTIONS]'], label: 'cmd potions → [POTIONS]' }
  ];

  let allCommandsOk = true;

  for (const step of plan) {
    chatMessages = [];
    ws.send(JSON.stringify({ type: 'command', text: step.cmd }));
    await sleep(500);

    const got = await waitFor(() => {
      const joined = chatMessages.join('\n');
      return step.expect.every((sub) => joined.includes(sub)) ? joined : null;
    }, REPLY_TIMEOUT_MS);

    if (!got) {
      const seen = chatMessages.length ? chatMessages.join(' | ') : '(ответов не было)';
      fail(step.label, `не найдено ${JSON.stringify(step.expect)}; получено: ${seen}`);
      allCommandsOk = false;
    } else {
      ok(step.label);
    }
  }

  if (!allCommandsOk) {
    killBot();
    return false;
  }

  // ---- Шаг 6. Завершение ----
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), QUIT_TIMEOUT_MS);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    try {
      ws.send(JSON.stringify({ type: 'command', text: 'quit' }));
    } catch (e) { /* ignore */ }
  });

  if (exited) {
    ok('bot quit');
  } else {
    fail('bot quit', `процесс не завершился за ${QUIT_TIMEOUT_MS / 1000}с`);
    killBot();
  }

  try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  return true;
}

// Страховка: тест не должен висеть дольше HARD_TIMEOUT_MS ни при каких условиях
const HARD_TIMEOUT_MS = 90000;
setTimeout(() => {
  console.error(`[FAIL] глобальный таймаут ${HARD_TIMEOUT_MS / 1000}с`);
  killBot();
  report();
  process.exit(1);
}, HARD_TIMEOUT_MS);

main()
  .then((result) => {
    if (result === 'env') process.exit(2); // порты заняты — это не FAIL системы
    process.exit(report() ? 0 : 1);
  })
  .catch((e) => {
    console.error(`[FAIL] непредвиденная ошибка теста: ${e.stack || e.message}`);
    killBot();
    report();
    process.exit(1);
  });