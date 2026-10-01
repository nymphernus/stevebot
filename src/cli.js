const readline = require('readline');
const logger = require('./logger');
const { executeCommand } = require('./commands');

let rl = null;
let context = null;
let explicitQuit = false;
let pendingCommands = [];
let botReady = false;

/**
 * Инициализация CLI.
 * @param {Object} ctx - контекст с функциями getBot, getCombatEnabled, setCombatEnabled, getTickCounter, gracefulShutdown
 */
function init(ctx) {
  context = ctx;

  const isTTY = process.stdin.isTTY;

  if (!isTTY) {
    logger.info('[CLI] Неинтерактивный режим (stdin не TTY), CLI отключён');
    // В неинтерактивном режиме просто читаем stdin и буферизуем команды
    process.stdin.setEncoding('utf8');
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          pendingCommands.push(trimmed);
        }
      }
      flushPending();
    });
    process.stdin.on('end', () => {
      // EOF — не завершаем бота, просто логируем
      logger.info('[CLI] stdin закрыт (EOF)');
    });
    return;
  }

  // Интерактивный режим (TTY)
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'bot> '
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Выводим введённую команду
    console.log(`[CLI] ${trimmed}`);

    // Выполняем команду
    try {
      await executeCommand('cli', 'console', trimmed);
    } catch (e) {
      logger.error(`CLI error: ${e.message}`);
    }

    // Повторный промпт
    rl.prompt();
  });

  rl.on('close', () => {
    // Завершаем только при явном quit, не при EOF
    if (explicitQuit) {
      logger.info('CLI closed');
      if (context && context.gracefulShutdown) {
        context.gracefulShutdown('CLI');
      }
    }
  });

  // Первый промпт
  rl.prompt();

  logger.info('[CLI] Интерактивный режим');
}

/**
 * Уведомить CLI, что бот готов (подключился к серверу).
 */
function notifyReady() {
  botReady = true;
  flushPending();
}

/**
 * Выполнить накопленные команды.
 */
async function flushPending() {
  if (!botReady) return;

  while (pendingCommands.length > 0) {
    const cmd = pendingCommands.shift();
    try {
      await executeCommand('cli', 'console', cmd);
    } catch (e) {
      logger.error(`CLI error: ${e.message}`);
    }
  }
}

module.exports = {
  init,
  notifyReady
};
