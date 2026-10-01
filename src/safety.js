const logger = require('./logger');

let isShuttingDown = false;
let bot = null;

function setBot(instance) {
  bot = instance;
}

function gracefulShutdown(reason) {
  logger.warn(`Завершение: ${reason}`);
  isShuttingDown = true;

  try {
    if (bot) {
      bot.chat('Отключаюсь...');
      bot.quit('graceful shutdown');
    }
  } catch (e) {
    // Игнорируем ошибки при отключении
  }

  setTimeout(() => process.exit(0), 1000);
}

function setupProcessHandlers() {
  process.on('SIGINT', () => gracefulShutdown('SIGINT (Ctrl+C)'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (e) => logger.error(`Uncaught: ${e.message}`));
  process.on('unhandledRejection', (r) => logger.error(`Rejection: ${r}`));
}

function shouldReconnect(reconnectCount, maxReconnectAttempts) {
  if (isShuttingDown) return false;
  if (maxReconnectAttempts === -1) return true;
  return reconnectCount < maxReconnectAttempts;
}

module.exports = {
  setBot,
  gracefulShutdown,
  setupProcessHandlers,
  shouldReconnect,
  get isShuttingDown() { return isShuttingDown; }
};
