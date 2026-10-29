import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/app.js';
import { readConfig, resolveMongoUri } from '../server/config.js';
import { GameService } from '../server/service.js';

async function setup(t, existingDirectory) {
  const directory = existingDirectory || await mkdtemp(path.join(tmpdir(), 'wald-werk-test-'));
  const config = { mode: 'local', worldFile: path.join(directory, 'world.json'), secureCookie: false };
  const game = await createGameServer({ config, rng: () => 0.1 });
  await new Promise((resolve) => game.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${game.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await game.close(); } };
  t.after(async () => { await close(); if (!existingDirectory) await rm(directory, { recursive: true, force: true }); });
  async function request(url, data, cookie, headers = {}) {
    const response = await fetch(`${address}${url}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  const join = (name) => request('/api/join', { name });
  const command = (cookie, body, id) => request('/api/command', { command: body, commandId: id }, cookie);
  return { game, address, request, join, command, directory, close };
}

async function connect(address, cookie) {
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/socket', { headers: { Cookie: cookie } });
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const entry of [...waiters]) {
      if (entry.predicate(message)) {
        clearTimeout(entry.timeout);
        waiters.splice(waiters.indexOf(entry), 1);
        entry.resolve(message);
      }
    }
  });
  const wait = (predicate) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve, timeout: setTimeout(() => reject(new Error('WebSocket-Nachricht nicht rechtzeitig angekommen.')), 3_000) };
      waiters.push(entry);
    });
  };
  socket.on('error', () => {});
  await wait((message) => message.type === 'state');
  return { socket, messages, wait, send: (data) => socket.send(JSON.stringify(data)) };
}

test('cloud config requires MongoDB on Vercel; MongoDB can be tried locally', () => {
  assert.throws(() => readConfig({ VERCEL: '1' }), /MONGODB_URI/);
  assert.throws(() => readConfig({ VERCEL: '1', MONGODB_URI: ' ' }), /MONGODB_URI/);
  const config = readConfig({ MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB: 'test_world', APP_ORIGIN: 'https://example.test' });
  assert.equal(config.mongoDatabase, 'test_world');
  assert.equal(config.publicOrigin, 'https://example.test');
  assert.equal(readConfig({}).mongoDatabase, 'StackFriends-dev');
  const encoded = 'mongodb+srv://a%40b:x%3Ay%2Fz@example.test/';
  assert.equal(resolveMongoUri({ MONGODB_URI: ` ${encoded} ` }), encoded);
  for (const credentials of ['<username>:<db_password>', '{username}:{password}', '${MONGODB_USERNAME}:${MONGODB_PASSWORD}']) {
    assert.throws(() => resolveMongoUri({ MONGODB_URI: `mongodb+srv://${credentials}@example.test/` }), /Platzhalter/);
  }
  const production = readConfig({ VERCEL: '1', MONGODB_URI: encoded, APP_ORIGIN: 'https://example.test' });
  assert.equal(production.mode, 'cloud');
  assert.equal(production.mongoUri, encoded);
  assert.equal(production.secureCookie, true);
  assert.equal(readConfig({}).secureCookie, false);
});

test('concurrent joins create one human per normalized name, one starting gold pile, and an HttpOnly session', async (t) => {
  const { join, request } = await setup(t);
  const [first, second] = await Promise.all([join('  Änne  '), join('änne')]);
  assert.equal(first.status, 200);
  assert.equal(first.body.player.id, second.body.player.id);
  const state = await request('/api/session', undefined, first.cookie);
  assert.equal(state.body.world.players.length, 1);
  assert.equal(state.body.world.cards.filter((card) => card.type === 'human').length, 1);
  assert.equal(state.body.world.cards.filter((card) => card.type === 'gold').length, 9);
  assert.equal(state.body.player.name.toLocaleLowerCase('de-DE'), 'änne');
  assert.equal((await join('<script>')).status, 400);
  assert.equal((await request('/api/join', { name: 'Intruder' }, undefined, { Origin: 'https://other.example' })).status, 403);
});

test('concurrent/retried purchase consumes exactly three gold; opening a package twice cannot duplicate cards', async (t) => {
  const { join, command, request } = await setup(t);
  const player = await join('Tom');
  const gold = player.body.world.cards.find((card) => card.type === 'gold');
  const purchase = { type: 'move', cardId: gold.id, zone: 'shop', x: 500, y: 400 };
  const replies = await Promise.all([command(player.cookie, purchase, 'buy-once'), command(player.cookie, purchase, 'buy-once')]);
  assert.ok(replies.some((reply) => reply.status === 200));
  const retry = await command(player.cookie, purchase, 'buy-once');
  assert.equal(retry.status, 200);
  let state = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(state.cards.filter((card) => card.type === 'gold').length, 6);
  assert.equal(state.cards.filter((card) => card.type === 'pack').length, 1);
  const pack = state.cards.find((card) => card.type === 'pack');
  const open = { type: 'move', cardId: pack.id, zone: 'open', x: 700, y: 400 };
  await command(player.cookie, open, 'open-once');
  await command(player.cookie, open, 'open-once');
  state = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(state.cards.filter((card) => card.type === 'pack').length, 0);
  assert.equal(state.cards.filter((card) => card.type === 'tree').length, 3);
  assert.equal((await command(undefined, purchase, 'anonymous')).status, 401);
});

test('a confirmed world and opaque cookie survive a complete backend restart', async (t) => {
  const first = await setup(t);
  const player = await first.join('Mira');
  const human = player.body.world.cards.find((card) => card.type === 'human');
  assert.equal((await first.command(player.cookie, { type: 'move', cardId: human.id, x: 900, y: 700 }, 'move-persist')).status, 200);
  await first.close();
  const second = await setup(t, first.directory);
  const response = await second.request('/api/session', undefined, player.cookie);
  assert.equal(response.body.player.name, 'Mira');
  assert.equal(response.body.world.cards.find((card) => card.id === human.id).x, 900);
  assert.equal(response.body.world.cards.filter((card) => card.type === 'gold').length, 9);
});

test('package clicks reveal one card each; repeated HTTP/WS command IDs cannot duplicate a draw', async (t) => {
  const { join, command, request, address } = await setup(t);
  const player = await join('Click Pack');
  const gold = player.body.world.cards.find((card) => card.type === 'gold');
  const purchase = await command(player.cookie, { type: 'move', cardId: gold.id, zone: 'shop', x: 600, y: 450 }, 'click-buy');
  const pack = purchase.body.world.cards.find((card) => card.type === 'pack');
  const open = { type: 'open-pack', cardId: pack.id };
  const first = await Promise.all([command(player.cookie, open, 'click-one'), command(player.cookie, open, 'click-one')]);
  assert.ok(first.some((reply) => reply.status === 200));
  assert.equal((await command(player.cookie, open, 'click-one')).status, 200);
  let world = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(world.cards.filter((card) => card.type === 'tree').length, 1);
  assert.equal(world.cards.find((card) => card.id === pack.id).cardsLeft, 2);
  const client = await connect(address, player.cookie);
  client.send({ type: 'command', commandId: 'click-two', command: open });
  client.send({ type: 'command', commandId: 'click-two', command: open });
  await client.wait((message) => message.type === 'ack' && message.commandId === 'click-two' && client.messages.filter((entry) => entry.type === 'ack' && entry.commandId === 'click-two').length === 2);
  world = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(world.cards.filter((card) => card.type === 'tree').length, 2);
  assert.equal(world.cards.find((card) => card.id === pack.id).cardsLeft, 1);
  client.socket.close();
  assert.equal((await command(player.cookie, open, 'click-three')).status, 200);
  assert.equal((await command(player.cookie, open, 'click-three')).status, 200);
  world = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(world.cards.some((card) => card.id === pack.id), false);
  assert.equal(world.cards.filter((card) => card.type === 'tree').length, 3);
});

test('WebSockets share deltas, reserve stacks, throttle previews, and never persist previews in the world', async (t) => {
  const { join, game, address } = await setup(t);
  const a = await join('Anna');
  const b = await join('Ben');
  const clientA = await connect(address, a.cookie);
  const clientB = await connect(address, b.cookie);
  const human = a.body.world.cards.find((card) => card.type === 'human');
  clientA.send({ type: 'drag-start', cardId: human.id, split: true });
  const lock = await clientA.wait((message) => message.type === 'lock' && message.cardId === human.id);
  assert.equal(lock.playerId, a.body.player.id);
  assert.equal(lock.split, true);
  clientB.send({ type: 'drag-start', cardId: human.id });
  const blocked = await clientB.wait((message) => message.type === 'error' && message.cardId === human.id);
  assert.match(blocked.message, /jemand anderes/);
  const writes = game.service.repository.metrics.writes;
  for (let index = 0; index < 20; index++) clientA.send({ type: 'drag', cardId: human.id, x: 500 + index, y: 500 });
  await clientB.wait((message) => message.type === 'drag' && message.cardId === human.id);
  assert.equal(game.service.repository.metrics.writes, writes);
  assert.ok(game.service.realtime.metrics.dragPreviews <= 2);
  clientA.send({ type: 'command', commandId: 'socket-drop', command: { type: 'move', cardId: human.id, x: 650, y: 500, split: true } });
  await clientA.wait((message) => message.type === 'ack' && message.commandId === 'socket-drop');
  const patch = await clientB.wait((message) => message.type === 'patch' && message.upsert.some((card) => card.id === human.id && card.x === 650));
  assert.equal(patch.baseRevision + 1, patch.revision);
  assert.equal(patch.world, undefined);
  clientB.send({ type: 'drag-start', cardId: human.id });
  const newLock = await clientB.wait((message) => message.type === 'lock' && message.cardId === human.id && message.playerId === b.body.player.id);
  assert.equal(newLock.playerId, b.body.player.id);
  clientA.socket.close();
  clientB.socket.close();
});

test('world work pauses offline and resumes with the remaining duration, using a controlled clock', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wald-werk-clock-'));
  let now = 1_000;
  const service = await new GameService({ mode: 'local', worldFile: path.join(directory, 'world.json') }, { now: () => now, rng: () => 0.1 }).init();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const player = await service.join('Clock');
  await service.connect('clock-connection', player.player);
  const gold = player.world.cards.find((card) => card.type === 'gold');
  let result = await service.execute(player.token, { type: 'move', cardId: gold.id, zone: 'shop', x: 600, y: 500 }, 'clock-buy');
  const pack = result.world.cards.find((card) => card.type === 'pack');
  result = await service.execute(player.token, { type: 'move', cardId: pack.id, zone: 'open', x: 650, y: 500 }, 'clock-open');
  const tree = result.world.cards.find((card) => card.type === 'tree');
  await service.execute(player.token, { type: 'move', cardId: player.player.cardId, targetId: tree.id, x: tree.x, y: tree.y }, 'clock-work');
  now = 5_000;
  await service.disconnect('clock-connection', now);
  now = 125_000;
  const paused = await service.snapshot(player.token);
  assert.equal(paused.world.clock.elapsed, 4_000);
  assert.equal(paused.world.cards.filter((card) => card.type === 'wood').length, 0);
  await service.connect('clock-return', player.player);
  assert.ok(service.timer, 'Returning to a paused job schedules its next completion.');
  now = 131_000;
  await service.runScheduled();
  const finished = await service.snapshot(player.token);
  assert.equal(finished.world.cards.filter((card) => card.type === 'wood').length, 1);
  assert.equal(finished.world.clock.elapsed, 10_000);
});

test('taking a middle card reserves and previews that card and all cards above, including their tools', async (t) => {
  const { join, command, game, address } = await setup(t);
  const a = await join('Tail A');
  const b = await join('Tail B');
  const gold = a.body.world.cards.filter((card) => card.type === 'gold');
  const humanId = a.body.player.cardId;
  await command(a.cookie, { type: 'move', cardId: humanId, targetId: gold[0].id, x: gold[0].x, y: gold[0].y }, 'tail-fixture');
  await game.service.commit((state) => {
    const human = state.world.cards.find((card) => card.id === humanId);
    human.toolId = 'fixture-axe';
    state.world.cards.push({ id: 'fixture-axe', type: 'axe', stackId: human.stackId, order: human.order, equippedTo: humanId, x: human.x, y: human.y });
  });
  const clientA = await connect(address, a.cookie);
  const clientB = await connect(address, b.cookie);
  const selected = gold[7];
  const expected = [gold[7].id, gold[8].id, humanId, 'fixture-axe'].sort();
  clientA.send({ type: 'drag-start', cardId: selected.id, split: true, takeAbove: true });
  const lock = await clientA.wait((message) => message.type === 'lock' && message.cardId === selected.id);
  assert.deepEqual([...lock.cardIds].sort(), expected);
  assert.equal(lock.takeAbove, true);
  assert.equal(game.service.realtime.locks.has(gold[0].id), false, 'Cards below the selection are not drag-reserved.');
  clientA.send({ type: 'drag', cardId: selected.id, x: 850, y: 650, takeAbove: true });
  const preview = await clientB.wait((message) => message.type === 'drag' && message.cardId === selected.id);
  assert.deepEqual([...preview.cardIds].sort(), expected);
  clientA.send({ type: 'command', commandId: 'tail-drop', command: { type: 'move', cardId: selected.id, x: 850, y: 650, split: true, takeAbove: true } });
  await clientA.wait((message) => message.type === 'ack' && message.commandId === 'tail-drop');
  const final = (await game.service.snapshot()).world;
  assert.equal(final.cards.find((card) => card.id === gold[0].id).x, gold[0].x);
  for (const id of expected) assert.equal(final.cards.find((card) => card.id === id).x, 850);
  clientA.send({ type: 'drag-start', cardId: 'fixture-axe', split: true, takeAbove: true });
  const toolLock = await clientA.wait((message) => message.type === 'lock' && message.cardId === 'fixture-axe');
  assert.deepEqual(toolLock.cardIds, ['fixture-axe']);
  clientA.socket.close();
  clientB.socket.close();
});

function catalogFixture(world) {
  assert.ok(world.catalog, 'The public world exposes the editable default catalog for older worlds as well.');
  const catalog = structuredClone(world.catalog);
  catalog.cardTypes.crystal = {
    ...catalog.cardTypes.wood, name: 'Kristall', description: 'Ein gemeinsam erstellter Rohstoff.',
    color: '#aaccee', art: 'wood', sellPrice: 3, effects: [],
  };
  catalog.recipes.push({
    id: 'crystalRecipe', name: 'Kristall formen', ingredients: { wood: 1 },
    duration: 1_000, result: 'crystal', resultCount: 1, requiresHuman: true, timeBase: 'world',
  });
  catalog.packs.push({
    id: 'crystalPack', name: 'Kristallpaket', description: 'Zwei sichere Kristalle.', color: '#aaccee',
    price: 2, size: 2, contents: [{ type: 'crystal', weight: 1 }],
  });
  return catalog;
}

test('shared settings are published as deltas, reject stale versions, and survive a backend restart', async (t) => {
  const first = await setup(t);
  const editor = await first.join('Settings A');
  const viewer = await first.join('Settings B');
  const clientA = await connect(first.address, editor.cookie);
  const clientB = await connect(first.address, viewer.cookie);
  const catalog = catalogFixture(editor.body.world);
  catalog.cardTypes.cow.deathDrops = { chance: 75, outputs: [{ type: 'meat', count: 2, weight: 1 }] };
  for (let index = 0; index < 20; index++) catalog.cardTypes[`extra${index}`] = {
    ...catalog.cardTypes.crystal, name: `Zusatzkarte ${index}`, description: 'Eine ausführliche Kartenbeschreibung. '.repeat(40),
  };
  const command = { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision };
  assert.ok(Buffer.byteLength(JSON.stringify(command)) > 24 * 1024, 'Valid settings can exceed the smaller game-command limit.');
  clientA.send({ type: 'command', command, commandId: 'catalog-first' });
  await clientA.wait((message) => message.type === 'ack' && message.commandId === 'catalog-first');
  const patch = await clientB.wait((message) => message.type === 'patch' && message.changes?.catalog?.cardTypes?.crystal);
  assert.equal(patch.changes.catalog.revision, catalog.revision + 1);
  assert.equal(patch.changes.catalog.cardTypes.crystal.name, 'Kristall');
  assert.deepEqual(patch.changes.catalog.cardTypes.cow.deathDrops, catalog.cardTypes.cow.deathDrops);
  assert.ok(patch.changes.catalog.recipes.some((recipe) => recipe.id === 'crystalRecipe'));
  assert.ok(patch.changes.catalog.packs.some((pack) => pack.id === 'crystalPack'));
  const retried = await first.command(editor.cookie, command, 'catalog-first');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.duplicate, true);
  assert.equal(retried.body.world.catalog.revision, catalog.revision + 1);
  const stale = await first.command(viewer.cookie, command, 'catalog-stale');
  assert.equal(stale.status, 409);
  assert.match(stale.body.message, /inzwischen geändert/);
  const nextA = structuredClone(retried.body.world.catalog);
  const nextB = structuredClone(retried.body.world.catalog);
  nextA.cardTypes.crystal.name = 'Kristall A';
  nextB.cardTypes.crystal.name = 'Kristall B';
  const race = await Promise.all([
    first.command(editor.cookie, { type: 'catalog-save', catalog: nextA, baseCatalogRevision: nextA.revision }, 'catalog-race-a'),
    first.command(viewer.cookie, { type: 'catalog-save', catalog: nextB, baseCatalogRevision: nextB.revision }, 'catalog-race-b'),
  ]);
  assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
  const acceptedCatalog = race.find((response) => response.status === 200).body.world.catalog;
  assert.equal(acceptedCatalog.revision, catalog.revision + 2);
  clientA.socket.close();
  clientB.socket.close();
  await first.close();
  const second = await setup(t, first.directory);
  const restored = await second.request('/api/session', undefined, editor.cookie);
  assert.equal(restored.body.player.name, 'Settings A');
  assert.equal(restored.body.world.catalog.revision, catalog.revision + 2);
  assert.equal(restored.body.world.catalog.cardTypes.crystal.name, acceptedCatalog.cardTypes.crystal.name);
  assert.equal(restored.body.world.catalog.cardTypes.crystal.sellPrice, 3);
  assert.deepEqual(restored.body.world.catalog.cardTypes.cow.deathDrops, catalog.cardTypes.cow.deathDrops);
  assert.equal(restored.body.world.catalog.packs.find((pack) => pack.id === 'crystalPack').price, 2);
});

test('invalid settings references and oversized commands leave the catalog and world unchanged', async (t) => {
  const { join, command, request, game } = await setup(t);
  const editor = await join('Settings Validation');
  const catalog = catalogFixture(editor.body.world);
  catalog.packs.find((pack) => pack.id === 'crystalPack').contents = [{ type: 'missingType', weight: 1 }];
  const before = (await request('/api/session', undefined, editor.cookie)).body.world;
  const writes = game.service.repository.metrics.writes;
  const rejected = await command(editor.cookie, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-invalid');
  assert.equal(rejected.status, 400);
  assert.equal(game.service.repository.metrics.writes, writes);
  let after = (await request('/api/session', undefined, editor.cookie)).body.world;
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.catalog, before.catalog);
  assert.deepEqual(after.cards, before.cards);
  assert.equal((await command(undefined, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-anonymous')).status, 401);
  const gold = before.cards.find((card) => card.type === 'gold');
  assert.equal((await command(editor.cookie, { type: 'move', cardId: gold.id, x: 600, y: 500, padding: 'x'.repeat(25 * 1024) }, 'ordinary-large')).status, 413);
  const oversized = await command(editor.cookie, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision, padding: 'x'.repeat(256 * 1024) }, 'catalog-large');
  assert.equal(oversized.status, 413);
  assert.match(oversized.body.message, /zu groß/);
  after = (await request('/api/session', undefined, editor.cookie)).body.world;
  assert.deepEqual(after.catalog, before.catalog);
  assert.equal(after.revision, before.revision);
});

test('newly configured packages can be purchased and opened through the normal HTTP game commands', async (t) => {
  const { join, command, request } = await setup(t);
  const editor = await join('Settings Pack');
  const catalog = catalogFixture(editor.body.world);
  const saved = await command(editor.cookie, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'pack-catalog');
  assert.equal(saved.status, 200, saved.body.message);
  const gold = saved.body.world.cards.find((card) => card.type === 'gold');
  const bought = await command(editor.cookie, { type: 'move', cardId: gold.id, zone: 'shop', packId: 'crystalPack', x: 600, y: 450 }, 'custom-pack-buy');
  assert.equal(bought.status, 200, bought.body.message);
  const pack = bought.body.world.cards.find((card) => card.type === 'pack');
  assert.ok(pack);
  assert.equal(pack.packId, 'crystalPack');
  assert.equal(pack.packName, 'Kristallpaket');
  assert.equal(pack.cardsLeft, 2);
  assert.equal(bought.body.world.cards.filter((card) => card.type === 'gold').length, 7);
  assert.equal((await command(editor.cookie, { type: 'open-pack', cardId: pack.id }, 'custom-pack-open-one')).status, 200);
  assert.equal((await command(editor.cookie, { type: 'open-pack', cardId: pack.id }, 'custom-pack-open-two')).status, 200);
  const final = (await request('/api/session', undefined, editor.cookie)).body.world;
  assert.equal(final.cards.some((card) => card.id === pack.id), false);
  assert.equal(final.cards.filter((card) => card.type === 'crystal').length, 2);
});

test('piggy bank purchases are idempotent and concurrent drops cannot overspend the remaining package price', async (t) => {
  const { join, command, request, game } = await setup(t);
  const player = await join('Pig Shop');
  const price = player.body.world.catalog.packs.find((pack) => pack.id === 'basic').price;
  await game.service.commit((state) => {
    state.world.cards = state.world.cards.filter((card) => card.type !== 'gold');
    state.world.cards.push({ id: 'pig-shop-once', type: 'piggyBank', stackId: 'pig-shop-once', order: 0, x: 900, y: 500, gold: price });
  });
  const purchase = { type: 'move', cardId: 'pig-shop-once', zone: 'shop', packId: 'basic', x: 600, y: 450 };
  const sameId = await Promise.all([
    command(player.cookie, purchase, 'pig-buy-once'),
    command(player.cookie, purchase, 'pig-buy-once'),
  ]);
  assert.ok(sameId.some((response) => response.status === 200));
  const retry = await command(player.cookie, purchase, 'pig-buy-once');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  let world = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(world.cards.filter((card) => card.type === 'pack').length, 1);
  assert.equal(world.cards.find((card) => card.id === 'pig-shop-once').gold, 0);
  assert.equal(world.cards.filter((card) => card.type === 'gold').length, 0);
  const remainingPrice = price - 1;
  await game.service.commit((state) => {
    state.world.shopPaid = 1;
    state.world.shopPayments.basic = 1;
    state.world.cards.push({ id: 'pig-shop-race', type: 'piggyBank', stackId: 'pig-shop-race', order: 0, x: 1100, y: 500, gold: remainingPrice });
  });
  const racedPurchase = { ...purchase, cardId: 'pig-shop-race' };
  const race = await Promise.all([
    command(player.cookie, racedPurchase, 'pig-race-a'),
    command(player.cookie, racedPurchase, 'pig-race-b'),
  ]);
  assert.equal(race.filter((response) => response.status === 200).length, 1);
  assert.ok(race.some((response) => [400, 409].includes(response.status)));
  world = (await request('/api/session', undefined, player.cookie)).body.world;
  assert.equal(world.cards.filter((card) => card.type === 'pack').length, 2);
  assert.equal(world.cards.find((card) => card.id === 'pig-shop-race').gold, 0);
  assert.ok(world.cards.filter((card) => card.type === 'piggyBank').every((card) => card.gold >= 0));
  assert.equal(world.shopPaid, 0);
  assert.equal(world.shopPayments.basic, 0);
  assert.equal(world.cards.filter((card) => card.type === 'gold').length, 0);
});
