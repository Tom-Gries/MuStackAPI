import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { Realtime } from '../server/realtime.js';
import { createMongoMemory } from './helpers/mongo-memory.js';

async function fixture(t) {
  let now = 0;
  const memory = createMongoMemory();
  const a = await new Realtime({}, () => now, { database: memory.database }).init();
  const b = await new Realtime({}, () => now, { database: memory.database }).init();
  t.after(async () => { await a.close(); await b.close(); });
  return { a, b, ...memory, setNow: (value) => { now = value; } };
}

test('MongoDB presence snapshots see another API instance immediately without a local cache', async (t) => {
  const { a, b } = await fixture(t);
  assert.deepEqual(await a.online(), { players: [], activeUntil: 0 });
  await b.touch('remote-tab', { id: 'b', name: 'B' });
  assert.deepEqual(await a.online(), { players: [{ id: 'b', name: 'B' }], activeUntil: 15000 });
  await b.remove('remote-tab');
  assert.deepEqual(await a.online(), { players: [], activeUntil: 0 });
  assert.equal(a.metrics.presenceReads, 3);
});

test('two tabs of one player stay online until the last connection expires or closes', async (t) => {
  const { a, b, setNow } = await fixture(t);
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

test('fresh MongoDB heartbeats survive expiry and do not rely on immediate TTL cleanup', async (t) => {
  const { a, b, database, setNow } = await fixture(t);
  await a.touch('renewed', { id: 'a', name: 'A' });
  await b.touch('expired', { id: 'b', name: 'B' });
  setNow(14999);
  await a.touch('renewed', { id: 'a', name: 'A' });
  setNow(15000);
  assert.deepEqual(await a.online(), { players: [{ id: 'a', name: 'A' }], activeUntil: 29999 });
  const stored = [...database.collection('realtime_presence').docs.values()];
  assert.equal(stored.some((entry) => entry.connectionId === 'expired'), true, 'expired documents may remain until MongoDB TTL maintenance');
  setNow(29999);
  assert.deepEqual(await a.online(), { players: [], activeUntil: 0 });
});

test('heartbeats update one compact connection record rather than appending presence history', async (t) => {
  const { a, database, setNow } = await fixture(t);
  const player = { id: 'player', name: 'Spieler' };
  await a.touch('a-long-connection-uuid', player);
  setNow(5000);
  await a.touch('a-long-connection-uuid', player);
  const records = [...database.collection('realtime_presence').docs.values()];
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].player, player);
  assert.equal(Number(records[0].expiresAt), 20000);
  assert.equal(a.metrics.presenceWrites, 2);
});

test('malformed presence records cannot extend active world time', async (t) => {
  const { a, database } = await fixture(t);
  await a.touch('valid', { id: 'old', name: 'Alt' });
  const records = database.collection('realtime_presence').docs;
  const valid = [...records.values()][0];
  for (const [id, player] of [['missing', undefined], ['wrong-shape', { id: 'x' }]]) {
    records.set(id, { ...valid, _id: id, connectionId: id, player, expiresAt: new Date(999999) });
  }
  assert.deepEqual(await a.online(), { players: [{ id: 'old', name: 'Alt' }], activeUntil: 15000 });
});

test('local file mode preserves multi-tab presence and exact expiry without a database', async (t) => {
  let now = 0;
  const realtime = new Realtime({}, () => now);
  t.after(() => realtime.close());
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

test('two API instances exchange socket events once and close watches when local players leave', async (t) => {
  const { a, b, database } = await fixture(t);
  const streams = database.streams;
  assert.equal(streams.size, 0, 'HTTP-only instances do not keep a change stream open');
  await a.touch('a-tab', { id: 'a', name: 'A' });
  await b.touch('b-tab', { id: 'b', name: 'B' });
  assert.equal(streams.size, 2);
  const receivedA = [];
  const receivedB = [];
  a.on('event', (event) => receivedA.push(event));
  b.on('event', (event) => receivedB.push(event));
  const event = { type: 'drag', cardId: 'tree', x: 400, y: 300, connectionId: 'a-tab' };
  await a.publish(event);
  await flush();
  assert.deepEqual(receivedA, [event]);
  assert.deepEqual(receivedB, [event]);
  await a.remove('a-tab');
  assert.equal(streams.size, 1);
  await b.remove('b-tab');
  assert.equal(streams.size, 0);
});

test('stack reservations remain atomic across instances and expired owners cannot release newer leases', async (t) => {
  const { a, b, setNow } = await fixture(t);
  assert.equal(await a.acquire(['wood', 'human'], 'a-tab', 'a'), true);
  assert.equal(await b.acquire(['human', 'stone'], 'b-tab', 'b'), false);
  assert.equal(await a.acquire(['stone'], 'a-tab', 'a'), true, 'failed overlapping acquisition must not reserve its uncontested cards');
  setNow(10000);
  assert.equal(await b.acquire(['wood', 'human', 'stone'], 'b-tab', 'b'), true);
  await a.release(['wood', 'human', 'stone'], 'a-tab', 'a');
  assert.equal(await a.acquire(['wood'], 'a-tab', 'a'), false);
  await b.release(['wood', 'human', 'stone'], 'b-tab', 'b');
  assert.equal(await a.acquire(['wood'], 'a-tab', 'a'), true);
});
