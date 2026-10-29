import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createGameServer } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { Realtime } from '../server/realtime.js';

const FRONTEND = 'https://play.example.test';
async function setup(t, now = Date.now, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stackfriends-tickets-'));
  const game = await createGameServer({ ...options, config: { mode: 'local', worldFile: path.join(directory, 'world.json'), publicOrigin: FRONTEND, socketOrigin: 'https://api.example.test' }, now });
  await new Promise((resolve) => game.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${game.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await game.close(); } };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  async function request(route, body, cookie, origin = FRONTEND) {
    const response = await fetch(`${address}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json(), headers: response.headers };
  }
  return { game, address, request, close, join: () => request('/api/join', { name: 'Getrennter Client' }) };
}

function socketState(t, address, { ticket, cookie, protocols, origin = FRONTEND } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address.replace('http:', 'ws:') + '/api/socket', protocols || (ticket ? ['stackfriends', `ticket.${ticket}`] : []), { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    t.after(() => ws.terminate());
    const messages = [];
    const waiters = new Set();
    const wait = (predicate) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((ready, failed) => {
        const entry = { predicate, ready, timer: setTimeout(() => { waiters.delete(entry); failed(new Error('Erwartete Socket-Nachricht fehlt.')); }, 3000) };
        waiters.add(entry);
      });
    };
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Keine Verbindungsbestätigung.')); }, 3000);
    ws.on('error', () => {});
    ws.on('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); ws.terminate(); resolve({ status: response.statusCode }); });
    ws.on('message', (data) => {
      const message = JSON.parse(data);
      messages.push(message);
      for (const entry of [...waiters]) if (entry.predicate(message)) { clearTimeout(entry.timer); waiters.delete(entry); entry.ready(message); }
      if (message.type === 'state') { clearTimeout(timer); resolve({ status: 101, state: message, protocol: ws.protocol, socket: ws, messages, wait }); }
    });
  });
}

function socketClosed(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hintergrundverbindung wurde nicht geschlossen.')), 3000);
    socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

test('a first-party session issues a no-store ticket and connects to another origin without a cookie', async (t) => {
  const f = await setup(t);
  const joined = await f.join();
  assert.equal(joined.status, 200);
  const issued = await f.request('/api/socket-ticket', {}, joined.cookie);
  assert.equal(issued.status, 200);
  assert.match(issued.body.ticket, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(issued.body.socketUrl, 'wss://api.example.test/api/socket');
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(issued.body).includes(joined.cookie.split('=')[1]), false);
  const connected = await socketState(t, f.address, { ticket: issued.body.ticket });
  assert.equal(connected.status, 101);
  assert.equal(connected.protocol, 'stackfriends');
  assert.equal(connected.state.player.name, joined.body.player.name);
  assert.equal((await socketState(t, f.address, { ticket: issued.body.ticket })).status, 401);
});

test('ticket creation needs an authenticated cookie and the allowed frontend origin', async (t) => {
  const f = await setup(t);
  assert.equal((await f.request('/api/socket-ticket', {})).status, 401);
  const joined = await f.join();
  assert.equal((await f.request('/api/socket-ticket', {}, joined.cookie, 'https://other.example.test')).status, 403);
});

test('a socket prepares one private thirty-second ticket for a direct one-use reconnect', async (t) => {
  const f = await setup(t, () => 1000, { socketTicketRefreshMs: 20 });
  const joined = await f.join();
  const other = await f.request('/api/join', { name: 'Anderer Client' });
  let issued = 0;
  const issueTicket = f.game.service.realtime.issueSocketTicket.bind(f.game.service.realtime);
  t.mock.method(f.game.service.realtime, 'issueSocketTicket', async (...args) => { issued++; return issueTicket(...args); });
  const first = await socketState(t, f.address, { cookie: joined.cookie });
  const second = await socketState(t, f.address, { cookie: other.cookie });
  const prepared = await first.wait((message) => message.type === 'socket-ticket');
  const otherPrepared = await second.wait((message) => message.type === 'socket-ticket');
  assert.match(prepared.ticket, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(prepared.serverTime, 1000);
  assert.equal(prepared.expiresAt, 31000);
  assert.notEqual(otherPrepared.ticket, prepared.ticket);
  assert.equal(second.messages.some((message) => message.ticket === prepared.ticket), false, 'prepared tickets must never be broadcast');
  assert.equal(JSON.stringify(prepared).includes(joined.cookie.split('=')[1]), false);
  assert.equal(Object.hasOwn(prepared, 'socketUrl'), false, 'the client keeps the URL of its existing socket');
  await delay(60);
  assert.equal(issued, 2, 'each existing connection prepares exactly one ticket');
  const reconnected = await socketState(t, f.address, { ticket: prepared.ticket });
  assert.equal(reconnected.status, 101);
  assert.equal(reconnected.state.player.id, joined.body.player.id);
  assert.equal((await socketState(t, f.address, { ticket: prepared.ticket })).status, 401);
});

test('prepared reconnect tickets retain the existing thirty-second expiry', async (t) => {
  let now = 1000;
  const f = await setup(t, () => now, { socketTicketRefreshMs: 20 });
  const joined = await f.join();
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  const prepared = await connected.wait((message) => message.type === 'socket-ticket');
  now = prepared.expiresAt;
  assert.equal((await socketState(t, f.address, { ticket: prepared.ticket })).status, 401);
});

test('closing a socket or the server cancels its pending ticket preparation', async (t) => {
  const f = await setup(t, Date.now, { socketTicketRefreshMs: 100 });
  const joined = await f.join();
  let issued = 0;
  t.mock.method(f.game.service.realtime, 'issueSocketTicket', async () => { issued++; return 'unused'; });
  // Keep the deadline pending while the real socket handshake completes, even
  // when the host is busy; advance it only after each connection has closed.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  const closed = new Promise((resolve) => connected.socket.once('close', resolve));
  connected.socket.close();
  await closed;
  t.mock.timers.tick(140);
  assert.equal(issued, 0);
  await socketState(t, f.address, { cookie: joined.cookie });
  await f.close();
  t.mock.timers.tick(140);
  assert.equal(issued, 0);
});

test('ticket preparation failure leaves an established socket healthy for HTTP fallback later', async (t) => {
  const f = await setup(t, Date.now, { socketTicketRefreshMs: 20 });
  const joined = await f.join();
  let attempts = 0;
  const failedPreparation = t.mock.method(f.game.service.realtime, 'issueSocketTicket', async () => { attempts++; throw new Error('private Redis details'); });
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  await delay(80);
  assert.equal(attempts, 1);
  assert.equal(connected.socket.readyState, WebSocket.OPEN);
  assert.equal(connected.messages.some((message) => message.type === 'socket-ticket' || message.type === 'error'), false);
  connected.socket.send(JSON.stringify({ type: 'ping' }));
  assert.equal((await connected.wait((message) => message.type === 'pong')).type, 'pong');
  failedPreparation.mock.restore();
  const fallback = await f.request('/api/socket-ticket', {}, joined.cookie);
  assert.equal(fallback.status, 200);
  assert.equal((await socketState(t, f.address, { ticket: fallback.body.ticket })).status, 101);
});

test('local connections and an explicit zero refresh delay do not prepare tickets', async (t) => {
  for (const options of [{}, { socketTicketRefreshMs: 0 }]) {
    const f = await setup(t, Date.now, options);
    const joined = await f.join();
    const connected = await socketState(t, f.address, { cookie: joined.cookie });
    await delay(50);
    assert.equal(f.game.service.realtime.socketTickets.size, 0);
    assert.equal(connected.messages.some((message) => message.type === 'socket-ticket'), false);
  }
});

test('the server closes a declared hidden socket without relying on another browser timer', async (t) => {
  const f = await setup(t, Date.now, { hiddenSocketTimeoutMs: 20 });
  const joined = await f.join();
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  const closed = socketClosed(connected.socket);
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: true }));
  assert.equal(await closed, 1000);
  assert.equal(connected.messages.some((message) => message.type === 'error'), false);
});

test('returning visible cancels the server deadline and a later hidden phase gets its own deadline', async (t) => {
  const f = await setup(t, Date.now, { hiddenSocketTimeoutMs: 20 });
  const joined = await f.join();
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: true }));
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: false }));
  await delay(70);
  assert.equal(connected.socket.readyState, WebSocket.OPEN);
  const closed = socketClosed(connected.socket);
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: true }));
  assert.equal(await closed, 1000);
});

test('visibility accepts booleans only and an invalid value does not start a hidden deadline', async (t) => {
  const f = await setup(t, Date.now, { hiddenSocketTimeoutMs: 20 });
  const joined = await f.join();
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: 'true' }));
  const error = await connected.wait((message) => message.type === 'error');
  assert.match(error.message, /Sichtbarkeit/);
  await delay(70);
  assert.equal(connected.socket.readyState, WebSocket.OPEN);
});

test('an explicit zero hidden timeout disables the server deadline', async (t) => {
  const f = await setup(t, Date.now, { hiddenSocketTimeoutMs: 0 });
  const joined = await f.join();
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: true }));
  await delay(70);
  assert.equal(connected.socket.readyState, WebSocket.OPEN);
});

test('a slow saved command cannot delay the hidden connection deadline', async (t) => {
  const f = await setup(t, Date.now, { hiddenSocketTimeoutMs: 20 });
  const joined = await f.join();
  const connected = await socketState(t, f.address, { cookie: joined.cookie });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(f.game.service, 'execute', async () => { await gate; return {}; });
  const closed = socketClosed(connected.socket);
  connected.socket.send(JSON.stringify({ type: 'command', commandId: 'pending', command: { type: 'withdraw' } }));
  connected.socket.send(JSON.stringify({ type: 'visibility', hidden: true }));
  try { assert.equal(await closed, 1000); }
  finally { release(); }
});

test('WebSocket origin checks happen before consuming a valid one-time ticket', async (t) => {
  const f = await setup(t); const joined = await f.join();
  const issued = await f.request('/api/socket-ticket', {}, joined.cookie);
  assert.equal((await socketState(t, f.address, { ticket: issued.body.ticket, origin: 'https://other.example.test' })).status, 403);
  assert.equal((await socketState(t, f.address, { ticket: issued.body.ticket })).status, 101);
});

test('ticket storage failures return a temporary error without exposing connection details', async (t) => {
  const f = await setup(t); const joined = await f.join();
  f.game.service.realtime.issueSocketTicket = async () => { throw new Error('private-connection-details'); };
  const response = await f.request('/api/socket-ticket', {}, joined.cookie);
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.body).includes('private-connection-details'), false);
});

test('tickets expire after thirty seconds and malformed protocols cannot fall back to cookies', async (t) => {
  let now = 0;
  const f = await setup(t, () => now); const joined = await f.join();
  const issued = await f.request('/api/socket-ticket', {}, joined.cookie);
  now = 30000;
  assert.equal((await socketState(t, f.address, { ticket: issued.body.ticket })).status, 401);
  assert.equal((await socketState(t, f.address, { cookie: joined.cookie, protocols: ['unrecognized'] })).status, 401);
  assert.equal((await socketState(t, f.address, { cookie: joined.cookie, protocols: ['stackfriends', 'ticket.invalid'] })).status, 401);
});

test('same-origin legacy cookie WebSockets still work and the API does not serve game assets', async (t) => {
  const f = await setup(t); const joined = await f.join();
  assert.equal((await socketState(t, f.address, { cookie: joined.cookie })).status, 101);
  const root = await f.request('/');
  assert.equal(root.body.name, 'StackFriends API');
  const asset = await fetch(`${f.address}/card-art/cow-v1.png`);
  assert.equal(asset.status, 404);
});

test('ticket storage is shared across API instances and consumed atomically in Redis', async () => {
  let now = 1000;
  const entries = new Map();
  const calls = [];
  const redis = {
    async set(key, value, mode, ttl) { calls.push({ mode, ttl }); entries.set(key, value); return 'OK'; },
    async eval(script, count, key) {
      assert.match(script, /DEL/); assert.equal(count, 1);
      const previous = entries.get(key); entries.delete(key); return previous || null;
    },
  };
  const a = new Realtime({ redisNamespace: 'tickets-test' }, () => now);
  const b = new Realtime({ redisNamespace: 'tickets-test' }, () => now);
  a.redis = redis; b.redis = redis;
  const ticket = await a.issueSocketTicket('opaque-session');
  assert.deepEqual(calls, [{ mode: 'PX', ttl: 30000 }]);
  const consumed = await Promise.all([a.consumeSocketTicket(ticket), b.consumeSocketTicket(ticket)]);
  assert.equal(consumed.filter((value) => value === 'opaque-session').length, 1);
  const expired = await a.issueSocketTicket('opaque-session');
  now += 30000;
  assert.equal(await b.consumeSocketTicket(expired), undefined);
});

test('local ticket memory is bounded, expired entries disappear, and API_ORIGIN is validated', async () => {
  let now = 0;
  const realtime = new Realtime({}, () => now);
  const first = await realtime.issueSocketTicket('session');
  for (let i = 0; i < 1005; i++) await realtime.issueSocketTicket('session');
  assert.equal(realtime.socketTickets.size, 1000);
  assert.equal(await realtime.consumeSocketTicket(first), undefined);
  now = 30000; await realtime.issueSocketTicket('new-session');
  assert.equal(realtime.socketTickets.size, 1);
  assert.equal(readConfig({ API_ORIGIN: 'https://api.example.test/' }).socketOrigin, 'https://api.example.test');
  assert.equal(readConfig({ API_ORIGIN: 'http://localhost:3001' }).socketOrigin, 'http://localhost:3001');
  for (const address of ['file:///tmp/api', 'https://user:password@example.test/', 'https://api.example.test/path', 'http://api.example.test']) assert.throws(() => readConfig({ API_ORIGIN: address }), /API_ORIGIN/);
  assert.throws(() => readConfig({ VERCEL: '1', MONGODB_URI: 'mongodb://localhost', REDIS_URL: 'redis://localhost', API_ORIGIN: 'http://localhost:3001' }), /API_ORIGIN/);
  assert.equal(readConfig({}).worldFile, fileURLToPath(new URL('../.data/world.json', import.meta.url)));
});
