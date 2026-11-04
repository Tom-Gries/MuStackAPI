import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGameServer } from '../server/app.js';
import { fixture } from './helpers/personal.js';

async function httpFixture(t, options = {}) {
  const setup = await fixture(t), game = await createGameServer({ ...setup, ...options });
  game.server.listen(0, '127.0.0.1'); await once(game.server, 'listening');
  t.after(() => game.close());
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const post = (route, body, cookie, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) });
  return { ...setup, game, base, post };
}

test('HTTP sessions use opaque HttpOnly cookies and session exposes only the owner board', async (t) => {
  const { base, post } = await httpFixture(t);
  assert.equal((await (await fetch(`${base}/api/session`)).json()).world, null);
  const joined = await post('/api/join', { name: 'Alice', clientId: 'alice-tab' }), a = await joined.json(), cookie = joined.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.ok(!('token' in a));
  const b = await (await post('/api/join', { name: 'Bob' })).json();
  const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie.split(';')[0] } })).json();
  assert.equal(session.player.name, 'Alice'); assert.notEqual(session.world.id, b.world.id);
  assert.equal(session.syncIntervalMs, 60000); assert.equal(session.presenceIntervalMs, 60000);
  assert.equal((await fetch(`${base}/api/socket-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});

test('HTTP mutations enforce origin and JSON, and never return private startup details', async (t) => {
  const { base, post, game } = await httpFixture(t);
  assert.equal((await post('/api/join', { name: 'A' }, null, { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post('/api/join', { name: 'A', extra: 'x'.repeat(270000) })).status, 413);
  const joined = await post('/api/join', { name: 'A' }), cookie = joined.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/sync', { active: 'false' }, cookie)).status, 400);
  game.service.sync = async () => { throw Object.assign(new Error('mongodb://private-user:private-password@host/'), { status: 503 }); };
  const unavailable = await post('/api/sync', {}, cookie);
  assert.equal(unavailable.status, 503); assert.ok(!(await unavailable.text()).includes('private'));
});

test('HTTP heartbeat is a small profile response; command IDs and authentication are mandatory', async (t) => {
  const { base, post } = await httpFixture(t), joined = await post('/api/join', { name: 'A', clientId: 'tab-a' });
  const cookie = joined.headers.get('set-cookie').split(';')[0], session = await joined.json();
  const heartbeat = await (await post('/api/presence', { active: true, clientId: 'tab-a' }, cookie)).json();
  assert.ok(!('world' in heartbeat)); assert.equal(heartbeat.hasOtherPlayersOnline, false); assert.equal(heartbeat.hasPendingGifts, false);
  assert.ok(JSON.stringify(heartbeat).length < 1000);
  assert.equal((await post('/api/command', { command: { type: 'move', cardId: session.player.cardId, x: 900, y: 400 } }, cookie)).status, 400);
  assert.equal((await post('/api/sync', {})).status, 401);
  assert.equal((await fetch(`${base}/api/players`, { headers: { Cookie: cookie } })).status, 403);
});

test('HTTP local load/save routes use the same cookie and return revision acks without a board', async (t) => {
  const { post, advance, now } = await httpFixture(t);
  assert.equal((await (await post('/api/load', { simulation: 'local' })).json()).world, null);
  const joined = await post('/api/join', { name: 'Browser', simulation: 'local', clientId: 'browser-tab', clientEpoch: 1, active: true });
  const state = await joined.json(), cookie = joined.headers.get('set-cookie').split(';')[0];
  advance(60_000);
  const loaded = await (await post('/api/load', { simulation: 'local', clientId: 'browser-tab', clientEpoch: 1, active: true }, cookie)).json();
  assert.equal(loaded.world.clock.lastAt, state.world.clock.lastAt);
  assert.equal(loaded.world.revision, state.world.revision);
  const body = { simulation: 'local', saveId: 'http-local-save', catalogContentVersion: loaded.world.catalog.contentVersion, baseRevision: loaded.world.revision, operations: [{ kind: 'command', at: now(), activeUntil: now(), command: { type: 'move', cardId: state.player.cardId, x: 1000, y: 800 } }], clientId: 'browser-tab', clientEpoch: 1, active: true };
  const response = await post('/api/save', body, cookie), saved = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(saved, 'world'), false);
  assert.equal(saved.revision, state.world.revision + 1);
  assert.equal(saved.saveId, body.saveId);
  assert.equal(saved.catalogRevision, state.world.catalog.revision);
  const synced = await (await post('/api/sync', { simulation: 'local', baseRevision: saved.revision, clientId: 'browser-tab', clientEpoch: 1, active: true }, cookie)).json();
  assert.equal(synced.world.cards.find((card) => card.id === state.player.cardId).x, 1000);
  assert.equal(synced.lastSave.id, body.saveId);
});

test('HTTP stale local saves expose a safe conflict payload and protected mutations stay guarded', async (t) => {
  const { post, now } = await httpFixture(t), joined = await post('/api/join', { name: 'Browser', simulation: 'local' });
  const state = await joined.json(), cookie = joined.headers.get('set-cookie').split(';')[0];
  const body = { simulation: 'local', saveId: 'http-first-save', catalogContentVersion: state.world.catalog.contentVersion, baseRevision: state.world.revision, operations: [{ kind: 'advance', at: now(), activeUntil: now() }] };
  assert.equal((await post('/api/save', body, cookie)).status, 200);
  const stale = await post('/api/save', { ...body, saveId: 'http-stale-save' }, cookie), error = await stale.json();
  assert.equal(stale.status, 409);
  assert.equal(error.code, 'WORLD_CONFLICT');
  assert.equal(error.world.id, state.player.id);
  assert.equal(error.player.id, state.player.id);
  assert.ok(!JSON.stringify(error).includes(cookie));
  assert.equal((await post('/api/save', body)).status, 401);
  assert.equal((await post('/api/save', body, cookie, { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await post('/api/command', { simulation: 'local', baseRevision: error.revision, commandId: 'no-direct-local', command: { type: 'move', cardId: state.player.cardId, x: 500, y: 500 } }, cookie)).status, 400);
});
