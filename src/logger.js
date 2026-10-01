const fs = require('fs');
const path = require('path');

// Принудительно UTF-8 для stdout/stderr
if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding('utf8');
if (process.stderr.setDefaultEncoding) process.stderr.setDefaultEncoding('utf8');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const isTTY = process.stdout.isTTY === true;

// Создаём директорию для логов если её нет
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogFileName() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOGS_DIR, `bot-${date}.log`);
}

function formatMessage(level, message) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${message}`;
}

function writeToFile(formatted) {
  const dir = path.dirname(getLogFileName());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(getLogFileName(), String(formatted) + '\n', { encoding: 'utf8' });
}

// Заглушаем warning о deprecated event physicTick из чужих пакетов
const originalWarn = console.warn;
console.warn = function(...args) {
  const msg = args[0];
  if (typeof msg === 'string' && msg.includes('deprecated event (physicTick)')) {
    return; // игнорируем
  }
  originalWarn.apply(console, args);
};

// Обработчики крашей — записываем stack trace синхронно
process.on('uncaughtException', (err) => {
  const msg = `UNCAUGHT EXCEPTION: ${err.stack || err.message || err}`;
  writeToFile(formatMessage('FATAL', msg));
  if (isTTY) {
    try { process.stdout.write(`\n[FATAL] ${msg}\n`); } catch (e) { /* ignore */ }
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = `UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : reason}`;
  writeToFile(formatMessage('FATAL', msg));
  if (isTTY) {
    try { process.stdout.write(`\n[FATAL] ${msg}\n`); } catch (e) { /* ignore */ }
  }
});

process.on('exit', (code) => {
  const msg = `Process exit with code ${code}`;
  writeToFile(formatMessage('INFO', msg));
});

// Heartbeat каждые 30 секунд
let heartbeatInterval = null;
function startHeartbeat(getBot, getTickCounter) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  const startTime = Date.now();
  heartbeatInterval = setInterval(() => {
    const bot = getBot ? getBot() : null;
    const tick = getTickCounter ? getTickCounter() : 0;
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const hp = bot && bot.health ? bot.health.toFixed(0) : 'N/A';
    const connected = bot && bot.entity ? 'true' : 'false';
    const msg = `[HEARTBEAT] uptime=${uptime}s, tick=${tick}, mem=${mem}MB, hp=${hp}, connected=${connected}`;
    writeToFile(formatMessage('INFO', msg));
    if (isTTY) {
      try { process.stdout.write(`[+] ${msg}\n`); } catch (e) { /* ignore */ }
    }
  }, 30000);
}

const logger = {
  info(message) {
    const formatted = formatMessage('INFO', message);
    writeToFile(formatted);
    if (isTTY) {
      try { process.stdout.write(`[+] ${message}\n`); } catch (e) { /* ignore */ }
    }
    try { require('./web').broadcastLog('info', String(message)); } catch (e) { /* ignore */ }
  },

  warn(message) {
    const formatted = formatMessage('WARN', message);
    writeToFile(formatted);
    if (isTTY) {
      try { process.stdout.write(`[!] ${message}\n`); } catch (e) { /* ignore */ }
    }
    try { require('./web').broadcastLog('warn', String(message)); } catch (e) { /* ignore */ }
  },

  error(message) {
    const formatted = formatMessage('ERROR', message);
    writeToFile(formatted);
    if (isTTY) {
      try { process.stdout.write(`[-] ${message}\n`); } catch (e) { /* ignore */ }
    }
    try { require('./web').broadcastLog('error', String(message)); } catch (e) { /* ignore */ }
  },

  debug(message) {
    const formatted = formatMessage('DEBUG', message);
    writeToFile(formatted);
  },

  startHeartbeat
};

module.exports = logger;
