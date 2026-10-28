import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoRepository, FileRepository } from '../server/repository.js';
import { createWorld } from '../shared/game.js';

const hash = 'a'.repeat(64);
const get = (value, location) => location.split('.').reduce((parent, key) => parent?.[key], value);
function set(value, location, next) {
  const keys = location.split('.');
  let parent = value;
  for (let index = 0; index < keys.length - 1; index++) {
    parent[keys[index]] ??= /^\d+$/.test(keys[index + 1]) ? [] : {};
    parent = parent[keys[index]];
  }
  parent[keys.at(-1)] = structuredClone(next);
}
function stateFixture(cardCount = 4, historyCount = 0) {
  const world = createWorld(0);
  world.revision = 7;
  world.players = [{ id: 'player-a', name: 'A', cardId: 'card-0' }];
  world.cards = Array.from({ length: cardCount }, (_, index) => ({ id: `card-${index}`, type: 'wood', x: index * 10, y: 300, stackId: `stack-${index}`, order: 0 }));
  world.catalog = { description: 'unchanged catalog content '.repeat(1000) };
  return { _id: 'shared', world, sessions: { [hash]: { playerId: 'player-a', createdAt: 0 } }, commandIds: Array.from({ length: historyCount }, (_, index) => ({ id: `player-a:command-${index}`, at: index })), activeUntil: 0 };
}

// This fake enforces the revision predicate and applies one document update
// atomically. It records actual query/update payloads rather than mocking a
// repository result, so the tests exercise retries and the generated operators.
class Collection {
  constructor(state) { this.state = structuredClone(state); this.queries = []; this.updates = []; }
  matches(filter) {
    return Object.entries(filter).every(([location, expected]) => expected?.$exists !== undefined
      ? (get(this.state, location) !== undefined) === expected.$exists : get(this.state, location) === expected);
  }
  async findOne(filter, options) {
    this.queries.push(structuredClone({ filter, options }));
    let result = null;
    if (this.matches(filter)) {
      const fields = Object.entries(options?.projection || {}).filter(([, include]) => include === 1);
      result = fields.length ? {} : structuredClone(this.state);
      for (const [location] of fields) if (get(this.state, location) !== undefined) set(result, location, get(this.state, location));
      if (options?.projection?._id === 0) delete result._id;
    }
    await Promise.resolve();
    return result;
  }
  async updateOne(filter, update) {
    this.updates.push(structuredClone({ filter, update }));
    this.beforeUpdate?.();
    if (!this.matches(filter)) return { modifiedCount: 0 };
    const paths = Object.values(update).flatMap((values) => Object.keys(values));
    for (const location of paths) assert.ok(!paths.some((other) => other !== location && other.startsWith(`${location}.`)), 'MongoDB update paths must not overlap');
    const next = structuredClone(this.state);
    for (const [location, value] of Object.entries(update.$set || {})) set(next, location, value);
    for (const location of Object.keys(update.$unset || {})) {
      const keys = location.split('.');
      delete get(next, keys.slice(0, -1).join('.'))[keys.at(-1)];
    }
    for (const [location, operation] of Object.entries(update.$push || {})) {
      let values = [...(get(next, location) || []), ...structuredClone(operation.$each)];
      if (operation.$slice !== undefined) values = operation.$slice < 0 ? values.slice(operation.$slice) : values.slice(0, operation.$slice);
      set(next, location, values);
    }
    this.state = next;
    return { modifiedCount: 1 };
  }
}
function repository(t, collection) {
  const result = new MongoRepository('mongodb://127.0.0.1:27017', 'isolated-test');
  result.collection = collection;
  t.after(() => result.close());
  return result;
}

test('a move and full 2,000-command rolling history persist as one small revision-checked delta', async (t) => {
  const initial = stateFixture(1000, 2000);
  const collection = new Collection(initial);
  const repo = repository(t, collection);
  const result = await repo.mutate((state) => {
    state.world.cards[17].x = 777;
    state.commandIds.push({ id: 'player-a:next-command', at: 3000 });
    state.commandIds = state.commandIds.slice(-2000);
    state.activeUntil = 15_000;
    return { value: { message: 'moved' } };
  });
  assert.equal(collection.updates.length, 1);
  const { filter, update } = collection.updates[0];
  assert.deepEqual(filter, { _id: 'shared', 'world.revision': 7 });
  assert.equal(update.$set['world.cards.17.x'], 777);
  assert.equal(update.$set['world.revision'], 8);
  assert.deepEqual(update.$push.commandIds, { $each: [{ id: 'player-a:next-command', at: 3000 }], $slice: -2000 });
  assert.ok(repo.metrics.writeBytes < Buffer.byteLength(JSON.stringify(initial)) / 100, 'a move must send less than 1% of this full document');
  t.diagnostic(`Mongo JSON write payload, 1,000 cards and 2,000 commands: ${Buffer.byteLength(JSON.stringify(initial))} bytes full document -> ${repo.metrics.writeBytes} bytes atomic delta`);
  assert.equal(collection.state.world.cards[17].x, 777);
  assert.equal(collection.state.commandIds.length, 2000);
  assert.equal(collection.state.commandIds[0].id, 'player-a:command-1');
  assert.equal(collection.state.commandIds.at(-1).id, 'player-a:next-command');
  assert.equal(result.before.cards[17].x, 170);
  assert.equal(result.world.cards[17].x, 777);
  assert.equal(result.result.message, 'moved');
});

test('new cards and commands append without retransmitting their unchanged arrays', async (t) => {
  const collection = new Collection(stateFixture());
  const repo = repository(t, collection);
  const card = { id: 'new-card', type: 'stone', x: 100, y: 100 };
  await repo.mutate((state) => { state.world.cards.push(card); state.commandIds.push({ id: 'one', at: 1 }); });
  const update = collection.updates[0].update;
  assert.deepEqual(update.$push['world.cards'], { $each: [card] });
  assert.deepEqual(update.$push.commandIds, { $each: [{ id: 'one', at: 1 }] });
  assert.equal(collection.state.world.cards.at(-1).id, card.id);
});

test('deletions, reordered arrays, new sessions and removed fields retain the exact resulting document', async (t) => {
  const initial = stateFixture();
  initial.world.cards[0].motion = { fromX: 0, toX: 10 };
  const collection = new Collection(initial);
  const repo = repository(t, collection);
  await repo.mutate((state) => {
    state.world.cards.reverse();
    delete state.world.cards.at(-1).motion;
    delete state.sessions[hash];
    state.sessions['b'.repeat(64)] = { playerId: 'player-a', createdAt: 1 };
  });
  const expected = structuredClone(initial);
  expected.world.cards.reverse();
  delete expected.world.cards.at(-1).motion;
  delete expected.sessions[hash];
  expected.sessions['b'.repeat(64)] = { playerId: 'player-a', createdAt: 1 };
  expected.world.revision++;
  assert.deepEqual(collection.state, expected);
  await repo.mutate((state) => { state.world.cards.splice(1, 1); });
  expected.world.cards.splice(1, 1);
  expected.world.revision++;
  assert.deepEqual(collection.state, expected);
});

test('nested fields are unset and keys containing dots cannot become unintended Mongo paths', async (t) => {
  const initial = stateFixture();
  initial.world.cards[0].motion = { fromX: 0, toX: 10 };
  initial.world.extra = { 'literal.dot': 1, kept: 2 };
  const collection = new Collection(initial);
  const repo = repository(t, collection);
  await repo.mutate((state) => { delete state.world.cards[0].motion; state.world.extra['literal.dot'] = 3; });
  const update = collection.updates[0].update;
  assert.equal(update.$unset['world.cards.0.motion'], 1);
  assert.deepEqual(update.$set['world.extra'], { 'literal.dot': 3, kept: 2 });
  assert.equal(collection.state.world.cards[0].motion, undefined);
  assert.equal(collection.state.world.extra['literal.dot'], 3);
  assert.equal(collection.state.world.extra.literal, undefined);
});

test('concurrent repositories retry a stale revision and preserve both mutations', async (t) => {
  const collection = new Collection(stateFixture());
  const first = repository(t, collection);
  const second = repository(t, collection);
  await Promise.all([
    first.mutate((state) => { state.world.cards[0].x = 111; }),
    second.mutate((state) => { state.world.cards[1].x = 222; }),
  ]);
  assert.equal(collection.state.world.cards[0].x, 111);
  assert.equal(collection.state.world.cards[1].x, 222);
  assert.equal(collection.state.world.revision, 9);
  assert.equal(first.metrics.conflicts + second.metrics.conflicts, 1);
});

test('a retried duplicate command cannot consume or create a card twice', async (t) => {
  const collection = new Collection(stateFixture());
  const first = repository(t, collection);
  const second = repository(t, collection);
  const once = (state) => {
    if (state.commandIds.some((entry) => entry.id === 'shared-command')) return { changed: false, value: 'duplicate' };
    state.world.cards.pop();
    state.commandIds.push({ id: 'shared-command', at: 1 });
    return { value: 'applied' };
  };
  const results = await Promise.all([first.mutate(once), second.mutate(once)]);
  assert.deepEqual(results.map((result) => result.result).sort(), ['applied', 'duplicate']);
  assert.equal(collection.state.world.cards.length, 3);
  assert.equal(collection.state.world.revision, 8);
  assert.equal(first.metrics.writes + second.metrics.writes, 1);
});

test('authentication, command context, scheduling and world reads request only their required fields', async (t) => {
  const initial = stateFixture(1000, 2000);
  initial.sessions['b'.repeat(64)] = { playerId: 'other', createdAt: 2 };
  const collection = new Collection(initial);
  const repo = repository(t, collection);
  assert.deepEqual(await repo.playerForSession(hash), initial.world.players[0]);
  assert.ok(repo.metrics.readBytes < 500);
  assert.deepEqual(collection.queries.at(-1).options.projection, { _id: 0, [`sessions.${hash}`]: 1, 'world.players': 1 });
  const context = await repo.commandContext(hash);
  assert.deepEqual(context.world.cards, initial.world.cards);
  assert.equal(context.world.catalog, undefined);
  assert.equal(context.commandIds, undefined);
  assert.deepEqual(Object.keys(context.sessions), [hash]);
  assert.equal(await repo.revision(), 7);
  assert.deepEqual(collection.queries.at(-1).options.projection, { _id: 0, 'world.revision': 1 });
  assert.deepEqual(await repo.world(), initial.world);
  assert.deepEqual(collection.queries.at(-1).options.projection, { _id: 0, world: 1 });
  assert.equal(await repo.playerForSession('c'.repeat(64)), null);
  assert.deepEqual(await repo.commandContext('c'.repeat(64)), { world: { players: [], cards: [] }, sessions: {} });
  const reads = repo.metrics.reads;
  assert.equal(await repo.playerForSession('bad.$key'), null);
  assert.deepEqual(await repo.commandContext(null), { world: { players: [], cards: [] }, sessions: {} });
  assert.equal(repo.metrics.reads, reads, 'invalid hashes cannot construct Mongo paths or trigger a read');
  collection.state.world.players[0].name = 'Renamed';
  assert.equal((await repo.playerForSession(hash)).name, 'Renamed', 'projected reads must stay fresh across instances');
});

test('the file adapter offers isolated equivalents for projected repository reads', async () => {
  const initial = stateFixture();
  const repo = new FileRepository('unused-by-read-only-test');
  repo.state = initial;
  assert.equal(await repo.revision(), 7);
  const player = await repo.playerForSession(hash);
  player.name = 'changed copy';
  const world = await repo.world();
  world.cards.pop();
  const context = await repo.commandContext(hash);
  context.sessions[hash].playerId = 'changed copy';
  assert.equal(repo.state.world.players[0].name, 'A');
  assert.equal(repo.state.world.cards.length, 4);
  assert.equal(repo.state.sessions[hash].playerId, 'player-a');
  assert.deepEqual(await repo.commandContext('b'.repeat(64)), { world: { players: [], cards: [] }, sessions: {} });
});

test('read/write failures stay sanitized and exhausted CAS retries return a conflict', async (t) => {
  const collection = new Collection(stateFixture());
  const repo = repository(t, collection);
  collection.updateOne = async () => { throw new Error('secret connection detail'); };
  await assert.rejects(repo.mutate((state) => { state.world.cards.pop(); }), (error) => error.status === 503 && !error.message.includes('secret'));
  collection.updateOne = async () => ({ modifiedCount: 0 });
  await assert.rejects(repo.mutate((state) => { state.world.cards.pop(); }), (error) => error.status === 409);
  assert.equal(repo.metrics.conflicts, 12);
  collection.findOne = async () => { throw new Error('secret connection detail'); };
  await assert.rejects(repo.read(), (error) => error.status === 503 && !error.message.includes('secret'));
});
