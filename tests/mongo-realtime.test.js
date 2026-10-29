import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { MongoRealtimeStore } from '../server/mongo-realtime.js';
import { createMongoMemory } from './helpers/mongo-memory.js';

async function fixture(t) {
  let now = 1_000;
  const memory = createMongoMemory();
  const a = await new MongoRealtimeStore(memory.database, { instanceId: 'a', now: () => now }).init();
  const b = await new MongoRealtimeStore(memory.database, { instanceId: 'b', now: () => now }).init();
  t.after(async () => { await a.close(); await b.close(); });
  return { ...memory, a, b, setNow(value) { now = value; } };
}

test('Mongo coordination creates TTL indexes and one atomic lock document per world', async (t) => {
  const { database, collections, calls } = await fixture(t);
  const other = await new MongoRealtimeStore(database, { worldId: 'another-world', instanceId: 'other' }).init();
  t.after(() => other.close());
  assert.equal(collections.get('realtime_locks').docs.size, 2);
  assert.equal(calls.filter((call) => call.operation === 'createIndex' && call.args[1]?.expireAfterSeconds === 0).length, 12);
  assert.deepEqual(collections.get('realtime_locks').docs.get('shared'), { _id: 'shared', locks: [] });
});

test('overlapping simultaneous stack locks acquire every card or none', async (t) => {
  const { a, b, collections } = await fixture(t);
  const accepted = await Promise.all([
    a.acquire(['one', 'overlap'], 'connection-a', 'player-a', 11_000),
    b.acquire(['overlap', 'three'], 'connection-b', 'player-b', 11_000),
  ]);
  assert.deepEqual(accepted, [true, false]);
  const held = collections.get('realtime_locks').docs.get('shared').locks;
  assert.deepEqual(held.map((entry) => entry.cardId), ['one', 'overlap']);
  assert.equal(await b.acquire(['three'], 'connection-b', 'player-b', 11_000), true, 'the losing attempt must not reserve its unrelated card');
  assert.equal(await a.acquire(['one', 'overlap'], 'connection-a', 'player-a', 11_000), true, 'same-owner idempotent renewal remains valid');
});

test('expired locks renew at the exact boundary and a stale release cannot delete a new owner', async (t) => {
  const { a, b, setNow, collections } = await fixture(t);
  assert.equal(await a.acquire(['card'], 'old', 'player', 11_000), true);
  setNow(10_999);
  assert.equal(await b.acquire(['card'], 'new', 'other', 21_000), false);
  setNow(11_000);
  assert.equal(await b.acquire(['card'], 'new', 'other', 21_000), true);
  await a.release(['card'], 'old', 'player');
  assert.equal(await a.acquire(['card'], 'old', 'player', 21_000), false);
  await b.release(['card'], 'new', 'other');
  assert.deepEqual(collections.get('realtime_locks').docs.get('shared').locks, []);
});

test('acquisition prunes expired abandoned locks while keeping unrelated live owners', async (t) => {
  const { a, b, setNow, collections } = await fixture(t);
  await a.acquire(['expired'], 'gone', 'a', 2_000);
  await b.acquire(['live'], 'remaining', 'b', 8_000);
  setNow(2_000);
  await a.acquire(['new'], 'current', 'a', 9_000);
  assert.deepEqual(collections.get('realtime_locks').docs.get('shared').locks.map((entry) => entry.cardId), ['live', 'new']);
});

test('tickets are cross-instance, single-use and expire before delayed TTL cleanup', async (t) => {
  const { a, b, setNow, collections } = await fixture(t);
  const ticket = 'an-opaque-random-ticket';
  await a.issueSocketTicket(ticket, 'session-token', 31_000);
  const document = [...collections.get('realtime_tickets').docs.values()][0];
  assert.ok(!document._id.includes(ticket));
  const consumed = await Promise.all([a.consumeSocketTicket(ticket), b.consumeSocketTicket(ticket)]);
  assert.equal(consumed.filter((entry) => entry === 'session-token').length, 1);
  assert.equal(consumed.filter((entry) => entry === undefined).length, 1);
  await a.issueSocketTicket('expiry', 'other-session', 31_000);
  setNow(31_000);
  assert.equal(await b.consumeSocketTicket('expiry'), undefined);
  assert.equal(collections.get('realtime_tickets').docs.size, 1, 'expired physical document can still be awaiting Mongo TTL cleanup');
});

test('scheduled revisions have one claimant and expired claims can be reused without TTL deletion', async (t) => {
  const { a, b, setNow, collections } = await fixture(t);
  assert.deepEqual(await Promise.all([a.claimEvent(42), b.claimEvent(42)]), [true, false]);
  setNow(5_999);
  assert.equal(await b.claimEvent(42), false);
  setNow(6_000);
  assert.equal(await b.claimEvent(42), true);
  assert.equal(collections.get('realtime_claims').docs.size, 1);
  assert.equal(await a.claimEvent(43), true);
});

test('one database stream sends only fresh foreign events for its world', async (t) => {
  const { database, calls, streams, a, b } = await fixture(t);
  const received = [];
  await a.start((event) => received.push(event));
  await a.start((event) => received.push(event));
  assert.equal(streams.size, 1);
  await a.publish({ type: 'own' });
  await b.publish({ type: 'foreign' });
  await database.collection('realtime_events').insertOne({ worldId: 'other', instanceId: 'b', event: { type: 'wrong-world' }, expiresAt: new Date(99_000) });
  await database.collection('realtime_events').insertOne({ worldId: 'shared', instanceId: 'b', event: { type: 'expired' }, expiresAt: new Date(1_000) });
  await flush();
  assert.deepEqual(received, [{ type: 'foreign' }]);
  const watch = calls.find((call) => call.operation === 'watch');
  assert.equal(watch.args[1].maxAwaitTimeMS, 10_000);
  assert.ok(Object.hasOwn(watch.args[1], 'startAtOperationTime'));
  assert.equal(Object.hasOwn(watch.args[1], 'fullDocument'), false, 'world changes must never trigger a fullDocument lookup');
  await a.stop();
  assert.equal(streams.size, 0);
});

test('server operationTime anchors delivery across lazy change-stream startup', async (t) => {
  const { database, a, b } = await fixture(t);
  const received = [];
  database.beforeWatch = () => {
    database.beforeWatch = undefined;
    void b.publish({ type: 'between-ping-and-cursor' });
  };
  await a.start((event) => received.push(event));
  await flush();
  assert.deepEqual(received, [{ type: 'between-ping-and-cursor' }]);
});

test('a committed world write without publication triggers one delayed resync', async (t) => {
  const { database, a } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resyncs = 0;
  await a.start(() => {}, () => {}, () => { resyncs++; });
  const worlds = database.collection('worlds');
  await worlds.insertOne({ _id: 'shared', world: { revision: 1 } });
  await worlds.updateOne({ _id: 'shared' }, { $set: { 'world.revision': 2 } });
  await flush();
  t.mock.timers.tick(999);
  assert.equal(resyncs, 0);
  t.mock.timers.tick(1);
  assert.equal(resyncs, 1);
});

test('normal patch publication cancels the world fallback without extra resync reads', async (t) => {
  const { database, a, b } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resyncs = 0;
  await a.start(() => {}, () => {}, () => { resyncs++; });
  const worlds = database.collection('worlds');
  await worlds.insertOne({ _id: 'shared', world: { revision: 1 } });
  await worlds.updateOne({ _id: 'shared' }, { $set: { 'world.revision': 2 } });
  await b.publish({ type: 'patch', revision: 2 });
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(resyncs, 0);
  await worlds.updateOne({ _id: 'shared' }, { $set: { 'world.revision': 3 } });
  await b.publish({ type: 'patch', revision: 2 });
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(resyncs, 1, 'an older publication cannot hide a newer missing commit');
});

test('raw Readable errors and end retry once per backoff and stop cancels pending recovery', async (t) => {
  const { streams, calls, a } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let unavailable = 0;
  let resyncs = 0;
  await a.start(() => {}, () => { unavailable++; }, () => { resyncs++; });
  const first = [...streams][0];
  assert.equal(first.listenerCount('change'), 0, 'driver automatic emitter recovery must stay disabled');
  assert.equal(calls.filter((call) => call.operation === 'rawStream').length, 1);
  first.readable.emit('error', new Error('private database details'));
  first.readable.emit('end');
  assert.equal(unavailable, 1);
  assert.equal(streams.size, 0);
  assert.equal(first.readable.destroyed, true, 'the raw Readable must be destroyed separately from its cursor');
  t.mock.timers.tick(499);
  await flush();
  assert.equal(streams.size, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(streams.size, 1);
  assert.equal(resyncs, 1);
  const recovered = [...streams][0];
  recovered.readable.emit('end');
  recovered.readable.emit('close');
  assert.equal(unavailable, 2);
  assert.equal(recovered.readable.destroyed, true);
  await a.stop();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(streams.size, 0);
  assert.equal(calls.filter((call) => call.operation === 'watch').length, 2);
});

test('a world deletion still resynchronizes when an older patch arrives afterwards', async (t) => {
  const { database, a, b } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resyncs = 0;
  await a.start(() => {}, () => {}, () => { resyncs++; });
  const worlds = database.collection('worlds');
  await worlds.insertOne({ _id: 'shared', world: { revision: 1 } });
  await worlds.updateOne({ _id: 'shared' }, { $set: { 'world.revision': 2 } });
  await worlds.deleteOne({ _id: 'shared' });
  await b.publish({ type: 'patch', revision: 2 });
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(resyncs, 1);
});

test('stopping the last observer clears world fallback and closes only its stream', async (t) => {
  const { database, streams, a, b } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resyncs = 0;
  await a.start(() => {}, () => {}, () => { resyncs++; });
  await b.start(() => {});
  const first = [...streams][0];
  const worlds = database.collection('worlds');
  await worlds.insertOne({ _id: 'shared', world: { revision: 1 } });
  await worlds.updateOne({ _id: 'shared' }, { $set: { 'world.revision': 2 } });
  await flush();
  await a.stop();
  assert.equal(first.readable.destroyed, true);
  assert.equal(streams.size, 1);
  t.mock.timers.tick(1_000);
  assert.equal(resyncs, 0);
});
