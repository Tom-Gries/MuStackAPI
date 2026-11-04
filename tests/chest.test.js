import test from 'node:test';
import assert from 'node:assert/strict';
import { addCard } from '@stackfriends/shared/game.js';
import { applySimulationOperation } from '@stackfriends/shared/local-simulation.js';
import { DEFAULT_CATALOG } from '@stackfriends/shared/catalog.js';
import { GameService } from '../server/service.js';
import { fixture, edit, hall } from './helpers/personal.js';

const options = (baseRevision) => ({ localSimulation: true, baseRevision });
const packet = (baseRevision, operations, saveId) => ({ simulation: 'local', baseRevision, operations, saveId, catalogContentVersion: DEFAULT_CATALOG.contentVersion });
const append = (world, operations, at, command) => {
  const operation = { kind: 'command', at, activeUntil: at, command };
  applySimulationOperation(world, operation, { playerId: world.id });
  operations.push(operation);
};

test('chest journals persist exact contents and IDs across a restart, retries and retrieval', async (t) => {
  const { service, config, now } = await fixture(t), joined = await service.join('Alice', 'tab-a', options());
  const setup = await edit(service, joined.player.id, (world) => ({
    chest: addCard(world, 'chest', 1200, 700),
    wood: addCard(world, 'wood', 900, 500),
    berry: addCard(world, 'berry', 1000, 500),
  }));
  const loaded = await service.loadLocal(joined.token), local = structuredClone(loaded.world), operations = [];
  for (const item of [setup.wood, setup.berry]) append(local, operations, now(), { type: 'store', cardId: setup.chest.id, itemId: item.id, split: true, takeAbove: false });
  const request = packet(loaded.world.revision, operations, 'chest-save-01');
  const [saved, retried] = await Promise.all([service.saveLocal(joined.token, request), service.saveLocal(joined.token, request)]);
  assert.equal(saved.revision, retried.revision); assert.equal(retried.duplicate, true);
  await service.close();
  const reopened = await new GameService(config, { now }).init(); t.after(() => reopened.close());
  const restored = await reopened.loadLocal(joined.token), chest = restored.world.cards.find((card) => card.id === setup.chest.id);
  local.revision = saved.revision;
  assert.deepEqual(restored.world, local);
  assert.deepEqual(chest.contents.map((card) => card.id), [setup.wood.id, setup.berry.id]);
  assert.ok(!restored.world.cards.some((card) => card.id === setup.wood.id || card.id === setup.berry.id));

  const next = structuredClone(restored.world), take = [];
  append(next, take, now(), { type: 'retrieve', cardId: setup.chest.id, itemId: setup.wood.id, x: 1000, y: 650 });
  await reopened.saveLocal(joined.token, packet(restored.world.revision, take, 'chest-save-02'));
  const after = (await reopened.loadLocal(joined.token)).world;
  assert.deepEqual(after.cards.find((card) => card.id === setup.chest.id).contents.map((card) => card.id), [setup.berry.id]);
  assert.equal(after.cards.filter((card) => card.id === setup.wood.id).length, 1);
});

test('material inspection includes stored resources without exposing chest IDs or card data', async (t) => {
  const { service } = await fixture(t), alice = await service.join('Alice'), bob = await service.join('Bob');
  await hall(service, alice.player.id);
  await edit(service, bob.player.id, (world) => {
    const chest = addCard(world, 'chest', 1200, 700), wood = addCard(world, 'wood', 900, 500), berry = addCard(world, 'berry', 1000, 500);
    chest.contents = [wood, berry];
    world.cards = world.cards.filter((card) => card.id !== wood.id && card.id !== berry.id);
  });
  const result = await service.materials(alice.token, bob.player.id);
  assert.deepEqual(result.materials, [{ type: 'berry', count: 1 }, { type: 'chest', count: 1 }, { type: 'gold', count: 9 }, { type: 'wood', count: 1 }]);
  assert.ok(!Object.hasOwn(result, 'world'));
  assert.ok(result.materials.every((entry) => Object.keys(entry).sort().join(',') === 'count,type'));
});

test('a filled chest cannot be gifted; emptying it enables the gift', async (t) => {
  const { service, now } = await fixture(t), alice = await service.join('Alice', 'tab-a', options()), bob = await service.join('Bob', 'tab-b', options());
  await hall(service, alice.player.id);
  const setup = await edit(service, alice.player.id, (world) => ({ chest: addCard(world, 'chest', 1200, 700), wood: addCard(world, 'wood', 900, 500) }));
  const loaded = await service.loadLocal(alice.token), local = structuredClone(loaded.world), operations = [];
  append(local, operations, now(), { type: 'store', cardId: setup.chest.id, itemId: setup.wood.id, split: true, takeAbove: false });
  const saved = await service.saveLocal(alice.token, packet(loaded.world.revision, operations, 'filled-chest-01'));
  await assert.rejects(service.gift(alice.token, { recipientId: bob.player.id, cardId: setup.chest.id, takeAbove: false, commandId: 'filled-chest-gift' }, 'tab-a', options(saved.revision)), /[Kk]iste|leer/);
  const unchanged = await service.loadLocal(alice.token);
  assert.deepEqual(unchanged.world.cards.find((card) => card.id === setup.chest.id).contents.map((card) => card.id), [setup.wood.id]);
  assert.equal((await service.presence(bob.token)).hasPendingGifts, false);
  const next = structuredClone(unchanged.world), take = [];
  append(next, take, now(), { type: 'retrieve', cardId: setup.chest.id, itemId: setup.wood.id });
  const emptied = await service.saveLocal(alice.token, packet(unchanged.world.revision, take, 'empty-chest-01'));
  await service.gift(alice.token, { recipientId: bob.player.id, cardId: setup.chest.id, takeAbove: false, commandId: 'empty-chest-gift' }, 'tab-a', options(emptied.revision));
  const receiver = await service.loadLocal(bob.token);
  const delivered = await service.sync(bob.token, true, 'tab-b', options(receiver.world.revision));
  assert.equal(delivered.world.cards.filter((card) => card.type === 'chest').length, 1);
  assert.equal(delivered.world.cards.filter((card) => card.type === 'wood').length, 0);
});

test('global catalog edits cannot delete a resource kept only in another player chest', async (t) => {
  const { service } = await fixture(t), editor = await service.join('Editor'), alice = await service.join('Alice');
  const added = structuredClone(editor.world.catalog);
  added.cardTypes.chest_test_resource = { ...added.cardTypes.wood, name: 'Kisten-Testressource' };
  const configured = await service.execute(editor.token, { type: 'catalog-save', catalog: added, baseCatalogRevision: added.revision }, 'chest-catalog-add');
  await service.sync(alice.token);
  await edit(service, alice.player.id, (world) => {
    const chest = addCard(world, 'chest', 1200, 700), resource = addCard(world, 'chest_test_resource', 1000, 500);
    chest.contents = [resource]; world.cards = world.cards.filter((card) => card.id !== resource.id);
  });
  const removed = structuredClone(configured.world.catalog); delete removed.cardTypes.chest_test_resource;
  await assert.rejects(service.execute(editor.token, { type: 'catalog-save', catalog: removed, baseCatalogRevision: removed.revision }, 'chest-catalog-remove'), /Karten|Kiste|verwendet/);
  const current = await service.snapshot(alice.token);
  assert.ok(current.world.catalog.cardTypes.chest_test_resource);
  assert.equal(current.world.cards.find((card) => card.type === 'chest').contents[0].type, 'chest_test_resource');
});
