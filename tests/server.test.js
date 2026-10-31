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
