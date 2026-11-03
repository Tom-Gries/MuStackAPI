import test from 'node:test';
import assert from 'node:assert/strict';
import { addCard, applyCommand } from '@stackfriends/shared/game.js';
import { applySimulationOperation } from '@stackfriends/shared/local-simulation.js';
import { fixture, edit, hall } from './helpers/personal.js';

const options = (baseRevision) => ({ localSimulation: true, baseRevision });
const advanceOp = (at, activeUntil = at) => ({ kind: 'advance', at, activeUntil });
const commandOp = (at, command) => ({ kind: 'command', at, activeUntil: at, command });
const packet = (baseRevision, operations, saveId = 'local-save-001') => ({ baseRevision, operations, saveId, simulation: 'local' });
const human = (world) => world.cards.find((card) => card.type === 'human');
const stored = (service, playerId) => service.repository.read((context) => context.playerById(playerId));

test('local join/load keeps saved simulation and world revision while preserving name identity', async (t) => {
  const { service, advance, now } = await fixture(t);
  const a = await service.join('Alice', 'tab-a', options());
  assert.equal(a.lastSave, null); assert.ok(Number.isInteger(a.world.randomState));
  const tree = await edit(service, a.player.id, (world) => {
    const source = addCard(world, 'tree', 1000, 500);
    applyCommand(world, { type: 'move', cardId: human(world).id, targetId: source.id, x: 1000, y: 500 }, { playerId: a.player.id, now: now() });
    return source;
  });
  const before = (await stored(service, a.player.id)).world;
  advance(86_400_000);
  const loaded = await service.loadLocal(a.token, true, 'tab-a');
  assert.equal(loaded.world.clock.lastAt, before.clock.lastAt);
  assert.equal(loaded.world.clock.elapsed, before.clock.elapsed);
  assert.equal(loaded.world.cards.find((card) => card.id === tree.id).remaining, 5);
  assert.equal(loaded.world.revision, before.revision);
  assert.ok(loaded.resumeActiveUntil < now());
  const again = await service.join('alice', 'tab-b', options());
  assert.equal(again.player.id, a.player.id);
  assert.equal(again.world.revision, before.revision);
  assert.equal(again.world.cards.filter((card) => card.type === 'human').length, 1);
  assert.equal((await service.loadLocal()).world, null);
});

test('local commands and random package results save together once with an ack containing no world', async (t) => {
  const { service, now } = await fixture(t), a = await service.join('Alice', 'tab-a', options());
  const local = structuredClone(a.world), operations = [];
  const append = (command) => {
    const operation = commandOp(now(), command); operations.push(operation);
    return applySimulationOperation(local, operation, { playerId: a.player.id });
  };
  for (const coin of local.cards.filter((card) => card.type === 'gold').slice(0, 3)) append({ type: 'move', cardId: coin.id, split: true, takeAbove: false, x: 1000, y: 500, zone: 'shop', packId: 'basic' });
  const pack = local.cards.find((card) => card.type === 'pack');
  append({ type: 'open-pack', cardId: pack.id });
  append({ type: 'open-pack', cardId: pack.id });
  append({ type: 'move', cardId: human(local).id, x: 1100, y: 700, split: true, takeAbove: true });
  assert.equal((await stored(service, a.player.id)).world.cards.filter((card) => card.type === 'gold').length, 9);
  const saved = await service.saveLocal(a.token, packet(a.world.revision, operations), 'tab-a');
  assert.equal(Object.hasOwn(saved, 'world'), false);
  assert.equal(saved.revision, a.world.revision + 1);
  assert.deepEqual(saved.lastSave, { id: 'local-save-001', revision: saved.revision });
  local.revision = saved.revision;
  assert.deepEqual((await stored(service, a.player.id)).world, local);
  assert.equal((await service.loadLocal(a.token)).lastSave.id, 'local-save-001');
});

test('browser offline catch-up is replayed once; loading itself never manufactures its yields', async (t) => {
  const { service, advance, now } = await fixture(t), a = await service.join('Alice', 'tab-a', options());
  await edit(service, a.player.id, (world) => {
    const tree = addCard(world, 'tree', 1000, 500);
    applyCommand(world, { type: 'move', cardId: human(world).id, targetId: tree.id, x: 1000, y: 500 }, { playerId: a.player.id, now: now() });
  });
  advance(70_000);
  const loaded = await service.loadLocal(a.token), local = structuredClone(loaded.world);
  assert.equal(local.cards.filter((card) => card.type === 'tree').length, 1);
  const operation = advanceOp(now(), local.clock.lastAt);
  applySimulationOperation(local, operation);
  assert.equal(local.cards.filter((card) => ['wood', 'stick'].includes(card.type)).length, 5);
  const request = packet(loaded.world.revision, [operation], 'offline-save-01');
  const [first, second] = await Promise.all([service.saveLocal(a.token, request), service.saveLocal(a.token, request)]);
  assert.equal(first.revision, second.revision);
  assert.ok(second.duplicate);
  const world = (await stored(service, a.player.id)).world;
  assert.equal(world.cards.filter((card) => card.type === 'tree').length, 0);
  assert.equal(world.cards.filter((card) => ['wood', 'stick'].includes(card.type)).length, 5);
});

test('a duplicate committed save can close a newer activity epoch without advancing its world', async (t) => {
  const { service, now, advance } = await fixture(t), client = { id: 'tab-a', epoch: 1, active: true }, a = await service.join('Alice', client, options());
  const request = packet(a.world.revision, [advanceOp(now())], 'epoch-save-01');
  const saved = await service.saveLocal(a.token, request, client), before = (await stored(service, a.player.id)).world;
  advance(1000);
  const retry = await service.saveLocal(a.token, { ...request, active: false }, { ...client, epoch: 2, active: false });
  assert.equal(retry.revision, saved.revision); assert.equal(retry.duplicate, true);
  assert.deepEqual((await stored(service, a.player.id)).world, before);
  assert.deepEqual(retry.onlinePlayers, []);
  const late = await service.saveLocal(a.token, request, client);
  assert.deepEqual(late.onlinePlayers, []);
});

test('stale saves cannot overwrite newer worlds and conflicts contain only the owner state', async (t) => {
  const { service, now } = await fixture(t), a = await service.join('Alice', 'tab-a', options()), b = await service.join('Bob', 'tab-b', options());
  const first = packet(a.world.revision, [commandOp(now(), { type: 'move', cardId: a.player.cardId, x: 1000, y: 600 })]);
  await service.saveLocal(a.token, first);
  await assert.rejects(service.saveLocal(a.token, { ...first, saveId: 'stale-save-01' }), (error) => {
    assert.equal(error.status, 409); assert.equal(error.details.code, 'WORLD_CONFLICT');
    assert.equal(error.details.world.id, a.player.id); assert.notEqual(error.details.world.id, b.player.id);
    assert.equal(error.details.world.cards.find((card) => card.id === a.player.cardId).x, 1000);
    assert.ok(!JSON.stringify(error.details).includes(a.token));
    return true;
  });
  await assert.rejects(service.saveLocal(a.token, { ...first, operations: [] }), { status: 409 });
});

test('invalid or future batches roll back all earlier operations and raw snapshots are rejected', async (t) => {
  const { service, now } = await fixture(t), a = await service.join('Alice', 'tab-a', options());
  const before = (await stored(service, a.player.id)).world;
  const valid = commandOp(now(), { type: 'move', cardId: a.player.cardId, x: 1000, y: 600 });
  await assert.rejects(service.saveLocal(a.token, packet(a.world.revision, [valid, { kind: 'invalid', at: now() }])), { status: 400 });
  assert.deepEqual((await stored(service, a.player.id)).world, before);
  await assert.rejects(service.saveLocal(a.token, packet(a.world.revision, [advanceOp(now() + 5001)])), { status: 400 });
  await assert.rejects(service.saveLocal(a.token, { ...packet(a.world.revision, []), world: a.world }), { status: 400 });
  await assert.rejects(service.saveLocal(a.token, packet(a.world.revision, [commandOp(now(), { type: 'catalog-save', catalog: a.world.catalog })])), { status: 400 });
  assert.deepEqual((await stored(service, a.player.id)).world, before);
});

test('local sync and gifts use saved revisions without simulating pending world events', async (t) => {
  const { service, now, advance } = await fixture(t), a = await service.join('Alice', 'tab-a', options()), b = await service.join('Bob', 'tab-b', options());
  await hall(service, a.player.id);
  const alice = await service.loadLocal(a.token), coin = alice.world.cards.find((card) => card.type === 'gold');
  const save = await service.saveLocal(a.token, packet(alice.world.revision, [advanceOp(now())]));
  const gift = await service.gift(a.token, { recipientId: b.player.id, cardId: coin.id, split: true, takeAbove: false, commandId: 'local-gift-01' }, 'tab-a', options(save.revision));
  assert.equal(gift.world.cards.filter((card) => card.type === 'gold').length, 8);
  advance(60_000);
  const before = (await stored(service, b.player.id)).world;
  const bob = await service.sync(b.token, true, 'tab-b', options(before.revision));
  assert.equal(bob.world.clock.lastAt, before.clock.lastAt);
  assert.equal(bob.world.clock.elapsed, before.clock.elapsed);
  assert.equal(bob.world.cards.filter((card) => card.type === 'gold').length, 10);
  assert.equal(bob.giftMessages.length, 1);
  assert.equal(bob.lastSave, null);
  assert.equal(bob.catalogRevision, bob.world.catalog.revision);
});

test('retrying a local gift of the final Rathaus bypasses stale base and the lost permission', async (t) => {
  const { service } = await fixture(t), a = await service.join('Alice', 'tab-a', options()), b = await service.join('Bob', 'tab-b', options());
  await hall(service, a.player.id);
  const loaded = await service.loadLocal(a.token), townHall = loaded.world.cards.find((card) => card.type === 'town_hall');
  const request = { recipientId: b.player.id, cardId: townHall.id, takeAbove: false, commandId: 'last-hall-local' };
  const first = await service.gift(a.token, request, 'tab-a', options(loaded.world.revision));
  const retry = await service.gift(a.token, request, 'tab-a', options(loaded.world.revision));
  assert.equal(first.giftId, retry.giftId); assert.equal(retry.duplicate, true);
  assert.equal(retry.world.cards.some((card) => card.type === 'town_hall'), false);
});

test('new gifted creature movement starts at receipt time, not before the last saved checkpoint', async (t) => {
  const { service, advance, now } = await fixture(t), a = await service.join('Alice', 'tab-a', options()), b = await service.join('Bob', 'tab-b', options());
  await hall(service, a.player.id);
  const cow = await edit(service, a.player.id, (world) => addCard(world, 'cow', 1200, 700));
  const loaded = await service.loadLocal(a.token);
  await service.gift(a.token, { recipientId: b.player.id, cardId: cow.id, commandId: 'local-cow-gift' }, 'tab-a', options(loaded.world.revision));
  advance(60_000);
  const before = (await stored(service, b.player.id)).world;
  const received = await service.sync(b.token, true, 'tab-b', options(before.revision));
  const receivedCow = received.world.cards.find((card) => card.type === 'cow');
  assert.equal(receivedCow.motion.startedAt, before.clock.elapsed + now() - before.clock.lastAt);
});

test('catalog changes reject old journals until explicit load reconciles the current catalog', async (t) => {
  const { service, now } = await fixture(t), a = await service.join('Alice', 'tab-a', options()), editor = await service.join('Editor');
  const catalog = structuredClone(editor.world.catalog); catalog.cardTypes.wood.name = 'Bauholz';
  await service.execute(editor.token, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-change-local');
  const request = packet(a.world.revision, [advanceOp(now())]);
  await assert.rejects(service.saveLocal(a.token, request), (error) => error.status === 409 && error.details.code === 'CATALOG_CHANGED' && error.details.world.id === a.player.id);
  const loaded = await service.loadLocal(a.token);
  assert.equal(loaded.world.catalog.cardTypes.wood.name, 'Bauholz');
  const saved = await service.saveLocal(a.token, packet(loaded.world.revision, [advanceOp(now())], 'catalog-updated-save'));
  assert.equal(saved.catalogRevision, loaded.world.catalog.revision);
});
