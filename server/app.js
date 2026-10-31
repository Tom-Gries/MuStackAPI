import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { parse, serialize } from 'cookie';
import { GameService, errorWithStatus } from './service.js';
import { readConfig } from './config.js';

const COOKIE = 'wald_und_werk';
const readToken = (request) => { try { return parse(request.headers.cookie || '')[COOKIE]; } catch { return undefined; } };
function verifyOrigin(request, config) {
  if (!request.headers.origin) return;
  let origin;
  try { origin = new URL(request.headers.origin); } catch { throw errorWithStatus('Ungültiger Ursprung der Anfrage.', 403); }
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
  if (origin.host === host || config.publicOrigin && origin.origin === new URL(config.publicOrigin).origin) return;
  if (['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && /^((127\.0\.0\.1)|(localhost)|(\[::1\]))(:\d+)?$/.test(host)) return;
  throw errorWithStatus('Diese Spielaktion stammt von einer anderen Webseite.', 403);
}
function active(body) {
  if (body?.active !== undefined && typeof body.active !== 'boolean') throw errorWithStatus('Der Aktivitätsstatus muss wahr oder falsch sein.');
  return body?.active ?? true;
}
function clientState(body) {
  if (body?.clientEpoch === undefined) return body?.clientId;
  if (!Number.isSafeInteger(body.clientEpoch) || body.clientEpoch < 0) throw errorWithStatus('Die Aktivitätsnummer ist ungültig.');
  return { id: body.clientId, epoch: body.clientEpoch, active: active(body) };
}

/** Ordinary short HTTP requests only: no sockets, timers, server subscriptions or long polling. */
export async function createGameServer(options = {}) {
  const config = options.config || readConfig(), service = options.service || await new GameService(config, options).init();
  const app = express(); app.disable('x-powered-by');
  app.use('/api', (_request, response, next) => { response.set('Cache-Control', 'no-store'); response.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use(express.json({ limit: 256 * 1024, strict: true }));
  app.use('/api', (request, _response, next) => {
    if (request.method === 'POST') { verifyOrigin(request, config); if (!request.is('application/json')) throw errorWithStatus('Spielaktionen benötigen JSON.', 415); }
    next();
  });
  const joinLimits = new Map();
  app.get('/api/health', (_request, response) => response.json({ ok: true, mode: config.mode, storage: config.mode === 'cloud' ? 'mongodb' : 'file', transport: 'http', personalWorlds: true }));
  app.get('/api/session', async (request, response) => response.json(await service.snapshot(readToken(request))));
  app.post('/api/join', async (request, response) => {
    const address = request.socket.remoteAddress || 'unknown', now = Date.now(), recent = (joinLimits.get(address) || []).filter((time) => now - time < 60_000);
    if (recent.length >= 30) throw errorWithStatus('Zu viele Namenswechsel. Bitte warte kurz.', 429);
    recent.push(now); joinLimits.set(address, recent);
    if (joinLimits.size > 500) for (const [key, times] of joinLimits) if (now - times.at(-1) > 60_000) joinLimits.delete(key);
    const joined = await service.join(request.body?.name, clientState(request.body));
    response.setHeader('Set-Cookie', serialize(COOKIE, joined.token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookie, path: '/', maxAge: 365 * 24 * 60 * 60 }));
    const { token: _token, ...session } = joined; response.json(session);
  });
  app.post('/api/command', async (request, response) => response.json(await service.execute(readToken(request), request.body?.command, request.body?.commandId, clientState(request.body))));
  app.post('/api/sync', async (request, response) => response.json(await service.sync(readToken(request), active(request.body), clientState(request.body))));
  app.post('/api/presence', async (request, response) => response.json(await service.presence(readToken(request), active(request.body), clientState(request.body))));
  app.get('/api/players', async (request, response) => response.json(await service.players(readToken(request))));
  app.post('/api/materials', async (request, response) => response.json(await service.materials(readToken(request), request.body?.playerId)));
  app.post('/api/gift', async (request, response) => response.json(await service.gift(readToken(request), request.body, clientState(request.body))));
  if (config.mode === 'local') app.get('/api/metrics', (_request, response) => response.json({ database: service.repository.metrics, simulation: service.metrics }));
  app.use('/api', (_request, response) => response.status(404).json({ message: 'Dieser API-Endpunkt existiert nicht.' }));
  const dist = options.staticDirectory ? path.resolve(options.staticDirectory) : null;
  if (dist && existsSync(dist)) { app.use(express.static(dist)); app.get(/.*/, (_request, response) => response.sendFile(path.join(dist, 'index.html'))); }
  else app.get('/', (_request, response) => response.json({ name: 'StackFriends API', health: '/api/health' }));
  app.use((error, _request, response, _next) => {
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 400);
    response.status(status >= 400 && status < 600 ? status : 500).json({ message: status >= 500 ? 'Der Spielserver ist gerade nicht erreichbar. Bitte versuche es erneut.' : error.type === 'entity.too.large' ? 'Die Einstellungen sind zu groß. Bitte verwende weniger Einträge oder kürzere Texte.' : error.message || 'Die Spielaktion ist ungültig.' });
  });
  const server = http.createServer(app);
  return { app, server, service, async close() { if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); }); await service.close(); } };
}
