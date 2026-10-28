import test from 'node:test';
import assert from 'node:assert/strict';
import { Realtime } from '../server/realtime.js';

// A shared Redis command fixture, with separate clients/script registries for
// separate API instances. Presence scripts execute as one indivisible command.
function redisStore() { return { scores: new Map(), people: new Map() }; }
function redisClient(store) {
  const client = { definitions: new Map(), calls: [] };
  client.defineCommand = (name, definition) => {
    assert.equal(definition.numberOfKeys, 2);
    client.definitions.set(name, definition);
    client[name] = async (...args) => {
      client.calls.push({ name, args });
      const [presence, people, ...values] = args;
      const scores = store.scores.get(presence) || new Map();
      const records = store.people.get(people) || new Map();
      store.scores.set(presence, scores); store.people.set(people, records);
      if (name === 'stackfriendsPresenceTouch') {
        scores.set(values[1], Number(values[0])); records.set(values[1], values[2]); return 1;
      }
      if (name === 'stackfriendsPresenceRemove') {
        scores.delete(values[0]); records.delete(values[0]); return 1;
      }
      assert.equal(name, 'stackfriendsPresenceRead');
      const now = Number(values[0]);
      const players = new Map();
      let activeUntil = 0;
      for (const [id, expiry] of [...scores].sort((a, b) => a[1] - b[1])) {
        if (expiry <= now) { scores.delete(id); records.delete(id); continue; }
        let player;
        try { player = JSON.parse(records.get(id)); } catch { /* Missing/corrupt record. */ }
        if (!player || typeof player.id !== 'string' || typeof player.name !== 'string') {
          scores.delete(id); records.delete(id); continue;
        }
        activeUntil = Math.max(activeUntil, expiry);
        if (!players.has(player.id)) players.set(player.id, { id: player.id, name: player.name });
      }
      return [activeUntil, ...[...players.values()].map(JSON.stringify)];
    };
  };
  return client;
}
function fixture() {
  let now = 0;
  const store = redisStore();
  const a = new Realtime({ redisNamespace: 'presence-test' }, () => now);
  const b = new Realtime({ redisNamespace: 'presence-test' }, () => now);
  a.redis = redisClient(store); b.redis = redisClient(store);
  return { a, b, store, setNow: (value) => { now = value; } };
}

test('presence snapshots see other API instances immediately without a local TTL cache', async () => {
  const { a, b } = fixture();
  assert.deepEqual(await a.online(), { players: [], activeUntil: 0 });
  await b.touch('remote-tab', { id: 'b', name: 'B' });
  assert.deepEqual(await a.online(), { players: [{ id: 'b', name: 'B' }], activeUntil: 15000 });
  await b.remove('remote-tab');
  assert.deepEqual(await a.online(), { players: [], activeUntil: 0 });
  assert.equal(a.redis.calls.length, 3, 'Each snapshot is one Redis command, including expired cleanup.');
  assert.equal(a.redis.definitions.size, 1, 'The Lua command is defined once for EVALSHA caching.');
  assert.equal(a.metrics.presenceReads, 3);
});

test('two tabs of one player stay online until the last connection expires or closes', async () => {
  const { a, b, setNow } = fixture();
  const player = { id: 'same', name: 'Tom' };
  await a.touch('first', player);
  setNow(5000);
  await b.touch('second', player);
  assert.deepEqual(await a.online(), { players: [player], activeUntil: 20000 });
  await a.remove('first');
  assert.deepEqual(await a.online(), { players: [player], activeUntil: 20000 });
  setNow(19999);
  assert.deepEqual(await a.online(), { players: [player], activeUntil: 20000 });
  setNow(20000);
  assert.deepEqual(await b.online(), { players: [], activeUntil: 0 });
});

test('fresh heartbeats survive expiry cleanup and expiration is exact at the TTL boundary', async () => {
  const { a, b, store, setNow } = fixture();
  await a.touch('renewed', { id: 'a', name: 'A' });
  await b.touch('expired', { id: 'b', name: 'B' });
  setNow(14999);
  await b.touch('renewed', { id: 'a', name: 'A' });
  setNow(15000);
  assert.deepEqual(await a.online(), { players: [{ id: 'a', name: 'A' }], activeUntil: 29999 });
  assert.equal(store.scores.get(`${a.prefix}presence`).has('expired'), false);
  assert.equal(store.people.get(`${a.prefix}people`).has('expired'), false);
  setNow(29999);
  assert.deepEqual(await a.online(), { players: [], activeUntil: 0 });
});

test('compact heartbeat records remain readable during rolling deployment and use one cached command', async () => {
  const { a, store, setNow } = fixture();
  const player = { id: 'player', name: 'Spieler' };
  await a.touch('a-long-connection-uuid', player);
  setNow(5000);
  await a.touch('a-long-connection-uuid', player);
  const record = JSON.parse(store.people.get(`${a.prefix}people`).get('a-long-connection-uuid'));
  assert.deepEqual(record, { ...player, expiresAt: 20000 });
  assert.equal(a.redis.calls.length, 2);
  assert.equal(a.redis.definitions.size, 1);
  assert.equal(a.metrics.presenceWrites, 2);
  const oldEntry = { connectionId: 'a-long-connection-uuid', ...record };
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < Buffer.byteLength(JSON.stringify(oldEntry)));
});

test('legacy records are supported; missing or corrupt people cannot extend active world time', async () => {
  const { a, store } = fixture();
  await a.touch('legacy', { id: 'old', name: 'Alt' });
  const scores = store.scores.get(`${a.prefix}presence`);
  const records = store.people.get(`${a.prefix}people`);
  records.set('legacy', JSON.stringify({ connectionId: 'legacy', id: 'old', name: 'Alt', expiresAt: 999999 }));
  scores.set('missing', 999999);
  scores.set('broken', 999999); records.set('broken', '{invalid');
  scores.set('wrong-shape', 999999); records.set('wrong-shape', JSON.stringify({ id: 'x' }));
  assert.deepEqual(await a.online(), { players: [{ id: 'old', name: 'Alt' }], activeUntil: 15000 });
  assert.equal(scores.size, 1);
  assert.equal(records.size, 1);
});

test('local presence keeps the same multi-tab, exact-expiry behavior without Redis', async () => {
  let now = 0;
  const realtime = new Realtime({}, () => now);
  const player = { id: 'same', name: 'Tom' };
  await realtime.touch('first', player);
  now = 5000;
  await realtime.touch('second', player);
  now = 15000;
  assert.deepEqual(await realtime.online(), { players: [player], activeUntil: 20000 });
  assert.equal(realtime.presence.has('first'), false);
  await realtime.remove('second');
  assert.deepEqual(await realtime.online(), { players: [], activeUntil: 0 });
});
