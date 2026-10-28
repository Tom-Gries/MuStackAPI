import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { parse, serialize } from 'cookie';
import { WebSocketServer, WebSocket } from 'ws';
import { GameService, errorWithStatus } from './service.js';
import { readConfig, HEARTBEAT_MS, PRESENCE_TTL } from './config.js';

const COOKIE = 'wald_und_werk';
const MAX_MESSAGE_BYTES = 256 * 1024;
const readToken = (request) => {
  try { return parse(request.headers.cookie || '')[COOKIE]; } catch { return undefined; }
};

function verifyOrigin(request, config) {
  const origin = request.headers.origin;
  if (!origin) return; // Non-browser API clients cannot send the HttpOnly cookie via cross-origin forms.
  let url;
  try { url = new URL(origin); } catch { throw errorWithStatus('Ungültiger Ursprung der Anfrage.', 403); }
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  if (url.host === host || (config.publicOrigin && url.origin === new URL(config.publicOrigin).origin)) return;
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^((127\.0\.0\.1)|(localhost)|(\[::1\]))(:\d+)?$/.test(host || '')) return;
  throw errorWithStatus('Diese Spielaktion stammt von einer anderen Webseite.', 403);
}

export async function createGameServer(options = {}) {
  const config = options.config || readConfig();
  const service = options.service || await new GameService(config, options).init();
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: MAX_MESSAGE_BYTES, strict: true }));
  const joinLimits = new Map();
  app.get('/api/health', (_request, response) => response.json({ ok: true, mode: config.mode, storage: config.mode === 'cloud' ? 'mongodb' : 'file' }));
  app.get('/api/session', async (request, response) => {
    response.json(await service.snapshot(readToken(request)));
  });
  app.post('/api/join', async (request, response) => {
    verifyOrigin(request, config);
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (joinLimits.get(address) || []).filter((time) => now - time < 60_000);
    if (recent.length >= 30) throw errorWithStatus('Zu viele Namenswechsel. Bitte warte kurz.', 429);
    recent.push(now);
    joinLimits.set(address, recent);
    if (joinLimits.size > 500) for (const [key, times] of joinLimits) if (now - times.at(-1) > 60_000) joinLimits.delete(key);
    const joined = await service.join(request.body?.name);
    response.setHeader('Set-Cookie', serialize(COOKIE, joined.token, {
      httpOnly: true, sameSite: 'lax', secure: config.secureCookie,
      path: '/', maxAge: 365 * 24 * 60 * 60,
    }));
    const { token: _token, ...publicSession } = joined;
    response.json(publicSession);
  });
  app.post('/api/command', async (request, response) => {
    verifyOrigin(request, config);
    if (!request.is('application/json')) throw errorWithStatus('Spielaktionen benötigen JSON.', 415);
    response.json(await service.execute(readToken(request), request.body?.command, request.body?.commandId));
  });
  app.post('/api/socket-ticket', async (request, response) => {
    verifyOrigin(request, config);
    const token = readToken(request);
    await service.authenticate(token);
    const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = config.secureCookie || forwardedProtocol === 'https' ? 'https' : 'http';
    const origin = config.socketOrigin || `${protocol}://${request.headers.host}`;
    const socketAddress = new URL('/api/socket', origin);
    socketAddress.protocol = socketAddress.protocol === 'https:' ? 'wss:' : 'ws:';
    let ticket;
    try { ticket = await service.realtime.issueSocketTicket(token); }
    catch { throw errorWithStatus('Die Echtzeitverbindung ist gerade nicht verfügbar.', 503); }
    response.json({ ticket, socketUrl: socketAddress.href });
  });

  const metrics = { messagesSent: 0, bytesSent: 0, messagesReceived: 0, bytesReceived: 0, backpressureDisconnects: 0 };
  if (config.mode === 'local') app.get('/api/metrics', (_request, response) => response.json({ transport: metrics, database: service.repository.metrics, realtime: service.realtime.metrics, simulation: service.metrics }));
  app.use('/api', (_request, response) => response.status(404).json({ message: 'Dieser API-Endpunkt existiert nicht.' }));
  const dist = options.staticDirectory ? path.resolve(options.staticDirectory) : null;
  if (dist && existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/.*/, (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  }
  else app.get('/', (_request, response) => response.json({ name: 'StackFriends API', health: '/api/health' }));
  app.use((error, _request, response, _next) => {
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 400);
    response.status(status >= 400 && status < 600 ? status : 500).json({ message: status >= 500 ? 'Der Spielserver ist gerade nicht erreichbar. Bitte versuche es erneut.' : error.type === 'entity.too.large' ? 'Die Einstellungen sind zu groß. Bitte verwende weniger Einträge oder kürzere Texte.' : error.message || 'Die Spielaktion ist ungültig.' });
  });

  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has('stackfriends') ? 'stackfriends' : false,
  });
  let closing = false;
  const connections = new Map();
  const disconnections = new Set();
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (message.type === 'drag' && socket.bufferedAmount > 64 * 1024) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      metrics.backpressureDisconnects++;
      socket.close(1013, 'Bitte erneut verbinden.');
      return;
    }
    const data = JSON.stringify(message);
    metrics.messagesSent++;
    metrics.bytesSent += Buffer.byteLength(data);
    socket.send(data);
  };
  const sendState = async (socket, token) => {
    const snapshot = await service.snapshot(token);
    send(socket, { type: 'state', ...snapshot });
  };
  service.on('event', (event) => {
    for (const [id, connection] of connections) {
      if (event.type === 'drag' && event.connectionId === id) continue;
      send(connection.socket, event);
    }
  });
  service.on('resync', () => {
    for (const { socket, token } of connections.values()) sendState(socket, token).catch(() => socket.close(1012, 'Bitte erneut verbinden.'));
  });
  service.on('unavailable', () => {
    // A missed transient publication must never leave two replicas silently divergent.
    for (const { socket } of connections.values()) socket.close(1012, 'Verbindung zum Weltverteiler wird wiederhergestellt.');
  });
  service.on('fault', () => {
    for (const { socket } of connections.values()) send(socket, { type: 'error', message: 'Eine Spielaktion konnte nicht gespeichert werden. Bitte erneut versuchen.' });
  });

  server.on('upgrade', async (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/api/socket') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      verifyOrigin(request, config);
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim());
      let token;
      if (protocols) {
        const suppliedTicket = protocols.find((protocol) => protocol.startsWith('ticket.'));
        if (protocols.length !== 2 || !protocols.includes('stackfriends') || !suppliedTicket) throw errorWithStatus('Ungültiger Verbindungsnachweis.', 401);
        token = await service.realtime.consumeSocketTicket(suppliedTicket.slice(7));
      } else token = readToken(request);
      const player = await service.authenticate(token);
      if (closing || socket.destroyed) return socket.destroy();
      sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit('connection', websocket, request, { token, player }));
    } catch (error) {
      socket.write(`HTTP/1.1 ${error.status === 403 ? '403 Forbidden' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });

  sockets.on('connection', (socket, _request, { token, player }) => {
    const id = randomUUID();
    const connection = { socket, token, player, lastSeen: Date.now(), messageTimes: [], pending: Promise.resolve() };
    connections.set(id, connection);
    connection.pending = connection.pending.then(async () => {
      await service.connect(id, player);
      await sendState(socket, token);
    }).catch(() => socket.close(1011, 'Der Weltstand konnte nicht geladen werden.'));
    socket.on('pong', () => {
      connection.lastSeen = Date.now();
      service.realtime.touch(id, player).catch(() => socket.close(1012, 'Bitte erneut verbinden.'));
    });
    socket.on('message', (buffer) => {
      metrics.messagesReceived++;
      metrics.bytesReceived += buffer.length;
      let message;
      try { message = JSON.parse(buffer.toString()); }
      catch { return send(socket, { type: 'error', message: 'Ungültige Nachricht.' }); }
      if (!message || typeof message !== 'object') return;
      const now = Date.now();
      connection.messageTimes = connection.messageTimes.filter((time) => now - time < 1_000);
      connection.messageTimes.push(now);
      if (connection.messageTimes.length > 100) return socket.close(1008, 'Zu viele Nachrichten.');
      connection.pending = connection.pending.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (message.type === 'ping') {
          connection.lastSeen = Date.now();
          await service.realtime.touch(id, player);
          return send(socket, { type: 'pong', serverTime: service.now() });
        }
        if (message.type === 'resync') return sendState(socket, token);
        if (message.type === 'command') {
          const result = await service.execute(token, message.command, message.commandId, id);
          return send(socket, { type: 'ack', commandId: message.commandId, message: result.message });
        }
        if (message.type === 'drag-start') return service.dragStart(id, player, message.cardId, message.split, message.takeAbove);
        if (message.type === 'drag') return service.drag(id, player, message);
        if (message.type === 'drag-end') return service.dragEnd(id, player, message.cardId);
        throw errorWithStatus('Unbekannte Nachricht.');
      }).catch((error) => send(socket, { type: 'error', message: error.status >= 500 ? 'Der Spielserver ist gerade nicht erreichbar.' : error.message, commandId: message.commandId, cardId: message.cardId }));
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      connections.delete(id);
      const leaving = connection.pending.finally(() => service.disconnect(id, connection.lastSeen + PRESENCE_TTL)).catch(() => {});
      disconnections.add(leaving);
      leaving.finally(() => disconnections.delete(leaving));
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const { socket, lastSeen } of connections.values()) {
      if (now - lastSeen >= PRESENCE_TTL) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  async function close() {
    closing = true;
    clearInterval(heartbeat);
    const pending = [...connections.values()].map((connection) => connection.pending.catch(() => {}));
    for (const { socket } of connections.values()) socket.terminate();
    await Promise.all(pending);
    await new Promise((resolve) => sockets.close(resolve));
    await Promise.all([...disconnections]);
    await new Promise((resolve) => server.close(resolve));
    await service.close();
  }
  return { app, server, service, sockets, close, metrics };
}
