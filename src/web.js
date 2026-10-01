const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const logger = require('./logger');

let wss = null;
let server = null;
let context = null;
const clients = new Set();

function init(ctx) {
  context = ctx;
  const config = require('../config.json');
  // WEB_PORT_OVERRIDE позволяет поднять GUI на другом порту (например, smoke-тест)
  const overridePort = process.env.WEB_PORT_OVERRIDE
    ? parseInt(process.env.WEB_PORT_OVERRIDE, 10)
    : null;
  const port = Number.isInteger(overridePort) && overridePort > 0
    ? overridePort
    : (config.webPort ?? 3000);
  const token = config.webToken || '';

  server = http.createServer((req, res) => {
    // Служебный самозапрос: подтверждаем, что порт обслуживает именно наш сервер
    if (probeToken && req.headers['x-web-probe'] === probeToken) {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (token) {
      const clientToken = url.searchParams.get('token') || '';
      if (clientToken !== token) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    } else {
      const ip = req.socket.remoteAddress;
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }

    if (pathname === '/' || pathname === '/index.html') {
      const filePath = path.join(__dirname, '..', 'public', 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info(`[WEB] Клиент подключён (${clients.size} всего)`);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'command' && msg.text) {
          const { executeCommand } = require('./commands');
          await executeCommand('web', 'web', msg.text);
        }
      } catch (e) {
        logger.error(`[WEB] Ошибка обработки сообщения: ${e.message}`);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`[WEB] Клиент отключён (${clients.size} всего)`);
    });

    ws.on('error', (e) => {
      logger.error(`[WEB] Ошибка WebSocket: ${e.message}`);
    });
  });

  if (Number.isInteger(overridePort) && overridePort > 0) {
    logger.info(`[WEB] override port → ${port} (WEB_PORT_OVERRIDE, в config.json ${config.webPort ?? 3000})`);
  }

  server.listen(port, () => {
    logger.info(`[WEB] Web GUI запущен на http://localhost:${port}`);
  });

  // Порт может быть занят осиротевшим процессом — это не повод ронять бота
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      portTaken(port);
    } else {
      logger.error(`[WEB] Ошибка сервера: ${err.message}`);
    }
  });

  setInterval(broadcastStatus, 1000);

  verifyWebGui(port);
}

// На Windows listen() не всегда отдаёт EADDRINUSE: если порт держит процесс,
// слушающий 127.0.0.1, то bind на 0.0.0.0 проходит успешно (SO_REUSEADDR),
// а запросы уходят постороннему — Web GUI молча недоступен без всякой ошибки.
// Поэтому после listen делаем самозапрос и проверяем, отвечает ли наш сервер.
let probeToken = null;
let guiBroken = false;

function portTaken(port) {
  if (guiBroken) return;
  guiBroken = true;
  probeToken = null;
  logger.error(`[WEB] Порт ${port} занят — Web GUI недоступен. Освободи порт и перезапусти, либо задай другой webPort в config.json.`);
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
  }
}

function verifyWebGui(port) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  probeToken = token;
  const req = http.request(
    { host: '127.0.0.1', port, path: '/', timeout: 2000, headers: { 'x-web-probe': token } },
    (res) => {
      res.resume();
      if (res.statusCode === 204) {
        probeToken = null;
        logger.info(`[WEB] Порт ${port} подтверждён — Web GUI отвечает`);
        return;
      }
      portTaken(port);
    }
  );
  req.on('timeout', () => { req.destroy(); portTaken(port); });
  req.on('error', () => portTaken(port));
  req.end();
}

function broadcastStatus() {
  if (!context || !context.getBot) return;
  const bot = context.getBot();

  let guardInfo = { active: false, radius: 0 };
  try {
    const g = require('./guard');
    if (g && g.getGuardInfo) guardInfo = g.getGuardInfo() || guardInfo;
  } catch {}

  const statusData = {
    connected: !!(bot && bot.entity),
    hp: bot && bot.health != null ? Math.round(bot.health) : 0,
    food: bot && bot.food != null ? Math.round(bot.food) : 0,
    pos: bot && bot.entity ? {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z)
    } : { x: 0, y: 0, z: 0 },
    guard: guardInfo.active ? `ON(r=${guardInfo.radius})` : 'OFF',
    combat: context.getCombatEnabled ? (context.getCombatEnabled() ? 'ON' : 'OFF') : 'OFF',
    target: bot && bot.pvp && bot.pvp.target ? bot.pvp.target.name : null,
    home: (() => {
      try {
        const s = require('./spawnpoint').get();
        return s.set ? `${s.pos.x},${s.pos.y},${s.pos.z}` : 'none';
      } catch { return 'none'; }
    })(),
    loot: (() => {
      try {
        const l = require('./looting').getStatus();
        return l.enabled ? 'ON' : 'OFF';
      } catch { return 'OFF'; }
    })()
  };

  broadcast('status', statusData);
}

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) {
      try { client.send(message); } catch {}
    }
  }
}

function broadcastLog(level, message) {
  broadcast('log', { level, message: String(message) });
}

function broadcastChat(user, message) {
  broadcast('chat', { user, message });
}

module.exports = { init, broadcast, broadcastLog, broadcastChat, broadcastStatus };