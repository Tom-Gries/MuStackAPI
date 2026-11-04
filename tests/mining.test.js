import test from 'node:test';
import assert from 'node:assert/strict';
import { addCard } from '@stackfriends/shared/game.js';
import { applySimulationOperation } from '@stackfriends/shared/local-simulation.js';
import { DEFAULT_CATALOG } from '@stackfriends/shared/catalog.js';
import { GameService } from '../server/service.js';
import { MongoRepository } from '../server/repository.js';
import { MemoryMongoClient } from './helpers/mongo-personal.js';
import { fixture, edit } from './helpers/personal.js';

const miningTypes = ['ironVein', 'coalVein', 'clayPool', 'bat', 'ironOre', 'coal', 'clay'];
const packTypes = ['ironVein', 'coalVein', 'clayPool', 'bat'];
const localOptions = { localSimulation: true };
const packet = (baseRevision, operations, saveId) => ({ baseRevision, operations, saveId, simulation: 'local', catalogContentVersion: DEFAULT_CATALOG.contentVersion });
const playerWorld = (service, id) => service.repository.read(async (context) => (await context.playerById(id)).world);

function versionFour(catalog) {
  const result = structuredClone(catalog);
  result.contentVersion = 4;
  for (const type of miningTypes) delete result.cardTypes[type];
  result.packs = result.packs.filter((pack) => pack.id !== 'mining');
  for (const effect of result.cardTypes.pickaxe.effects) if (effect.kind === 'tool') {
    effect.sourceTypes = effect.sourceTypes.filter((type) => !['ironVein', 'coalVein'].includes(type));
    effect.multiplier = .8;
  }
  result.cardTypes.wood.name = 'Eigenes Bauholz';
  result.packs.find((pack) => pack.id === 'farm').price = 17;
  return result;
}

async function seedOldWorld(service, account) {
  return service.repository.transaction(async (context) => {
    const oldCatalog = versionFour(await context.catalog());
    await context.setCatalog(oldCatalog);
    const player = await context.playerById(account.player.id);
    player.world.catalog = structuredClone(oldCatalog);
    const human = player.world.cards.find((card) => card.id === account.player.cardId);
    human.hp = 66;
    player.world.shopPayments.basic = 1;
    player.world.shopPaid = 1;
    const chest = addCard(player.world, 'chest', 1100, 700);
    const berry = addCard(player.world, 'berry', 900, 500);
    chest.contents = [berry];
    player.world.cards = player.world.cards.filter((card) => card.id !== berry.id);
    await context.savePlayer(player);
    return structuredClone(player.world);
  });
}

function assertUpgrade(loaded, before) {
  const catalog = loaded.world.catalog, mining = catalog.packs.find((pack) => pack.id === 'mining');
  assert.equal(catalog.contentVersion, DEFAULT_CATALOG.contentVersion);
  assert.ok(catalog.contentVersion > 4);
  assert.equal(mining.price, 50);
  assert.equal(mining.size, 3);
  assert.deepEqual(new Set(mining.contents.map((entry) => entry.type)), new Set(packTypes));
  for (const type of miningTypes) assert.ok(catalog.cardTypes[type]);
  assert.equal(catalog.cardTypes.wood.name, 'Eigenes Bauholz');
  assert.equal(catalog.packs.find((pack) => pack.id === 'farm').price, 17);
  assert.equal(catalog.cardTypes.pickaxe.effects.find((effect) => effect.kind === 'tool').multiplier, .8);
  assert.deepEqual(loaded.world.cards, before.cards);
  assert.deepEqual(loaded.world.clock, before.clock);
  assert.deepEqual(loaded.world.shopPayments, before.shopPayments);
  assert.equal(loaded.world.revision, before.revision + 1);
}

test('file content upgrade adds the mining pack to an existing world without losing progress or replaying old journals', async (t) => {
  const { service, config, now } = await fixture(t);
  const account = await service.join('Bergbau-Dateiwelt', 'file-tab', localOptions);
  const before = await seedOldWorld(service, account);
  await service.close();
  const reopened = await new GameService(config, { now }).init();
  t.after(() => reopened.close());
  const oldPacket = { ...packet(before.revision, [{ kind: 'advance', at: now(), activeUntil: now() }], 'old-mining-rules'), catalogContentVersion: 4 };
  await assert.rejects(reopened.saveLocal(account.token, oldPacket), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.details.code, 'CATALOG_CHANGED');
    assert.equal(error.details.world.id, account.player.id);
    return true;
  });
  assert.deepEqual(await playerWorld(reopened, account.player.id), before);
  const loaded = await reopened.loadLocal(account.token);
  assertUpgrade(loaded, before);
  const again = await reopened.loadLocal(account.token);
  assert.equal(again.world.revision, loaded.world.revision);
  const canonical = await reopened.repository.read((context) => context.catalog());
  assert.equal(canonical.packs.filter((pack) => pack.id === 'mining').length, 1);
});

test('Mongo catalog initialization persists mining defaults and upgrades an existing personal world once', async (t) => {
  const client = new MemoryMongoClient(), now = () => 1000;
  const config = { mode: 'cloud' };
  const firstRepository = await new MongoRepository('mongodb://unused', 'test', now, { client }).init();
  const first = await new GameService(config, { repository: firstRepository, now }).init();
  const account = await first.join('Bergbau-Mongowelt', 'mongo-tab', localOptions);
  const before = await seedOldWorld(first, account);
  await first.close();
  const repository = await new MongoRepository('mongodb://unused', 'test', now, { client }).init();
  const reopened = await new GameService(config, { repository, now }).init();
  t.after(() => reopened.close());
  assert.ok(client.documents.gameCatalog[0].catalog.packs.some((pack) => pack.id === 'mining'));
  const loaded = await reopened.loadLocal(account.token);
  assertUpgrade(loaded, before);
  const again = await reopened.loadLocal(account.token);
  assert.equal(again.world.revision, loaded.world.revision);
  assert.deepEqual((await playerWorld(reopened, account.player.id)).cards, before.cards);
});

test('mining purchase, reveals and resource storage save in one deterministic batch and survive a restart', async (t) => {
  const { service, config, now } = await fixture(t);
  const account = await service.join('Bergbau-Journal', 'journal-tab', localOptions);
  const setup = await edit(service, account.player.id, (world) => ({
    pig: addCard(world, 'piggyBank', 900, 300, { gold: 50 }),
    chest: addCard(world, 'chest', 1400, 700),
    resources: ['ironOre', 'coal', 'clay'].map((type) => addCard(world, type, 1100, 600)),
  }));
  const loaded = await service.loadLocal(account.token), local = structuredClone(loaded.world), operations = [];
  const reads = service.repository.metrics.reads, writes = service.repository.metrics.writes;
  const append = (command) => {
    const operation = { kind: 'command', at: now(), activeUntil: now(), command };
    applySimulationOperation(local, operation, { playerId: local.id });
    operations.push(operation);
  };
  append({ type: 'move', cardId: setup.pig.id, x: 900, y: 300, zone: 'shop', packId: 'mining', split: true, takeAbove: false });
  assert.equal(local.cards.find((card) => card.id === setup.pig.id).gold, 0);
  const pack = local.cards.find((card) => card.type === 'pack' && card.packId === 'mining');
  assert.ok(pack);
  assert.equal(pack.cardsLeft, 3);
  const idsBeforeReveal = new Set(local.cards.map((card) => card.id));
  for (let count = 0; count < 3; count++) append({ type: 'open-pack', cardId: pack.id });
  const revealed = local.cards.filter((card) => !idsBeforeReveal.has(card.id));
  assert.equal(revealed.length, 3);
  assert.ok(revealed.every((card) => packTypes.includes(card.type)));
  assert.equal(local.cards.some((card) => card.id === pack.id), false);
  for (const resource of setup.resources) append({ type: 'store', cardId: setup.chest.id, itemId: resource.id, split: true, takeAbove: false });
  assert.equal(service.repository.metrics.reads, reads);
  assert.equal(service.repository.metrics.writes, writes);
  const request = packet(loaded.world.revision, operations, 'mining-batch-save');
  const saved = await service.saveLocal(account.token, request);
  assert.equal(Object.hasOwn(saved, 'world'), false);
  const duplicate = await service.saveLocal(account.token, request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, saved.revision);
  local.revision = saved.revision;
  assert.deepEqual(await playerWorld(service, account.player.id), local);
  await service.close();
  const reopened = await new GameService(config, { now }).init();
  t.after(() => reopened.close());
  const restored = await reopened.loadLocal(account.token);
  assert.deepEqual(restored.world, local);
  const contents = restored.world.cards.find((card) => card.id === setup.chest.id).contents;
  assert.deepEqual(contents.map((card) => card.id), setup.resources.map((card) => card.id));
  assert.deepEqual(contents.map((card) => card.type), ['ironOre', 'coal', 'clay']);
  assert.equal(restored.world.cards.filter((card) => revealed.some((entry) => entry.id === card.id)).length, 3);
});
