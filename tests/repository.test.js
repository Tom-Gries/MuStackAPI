import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorld } from '@stackfriends/shared/game.js';
import { FileRepository, MongoRepository, mongoUpdate } from '../server/repository.js';
import { GameService } from '../server/service.js';
import { MemoryMongoClient } from './helpers/mongo-personal.js';
import { hall } from './helpers/personal.js';

test('file bootstrap copies only edited catalog, keeps legacy bytes, and persists personal cookies independently', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stackfriends-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyFilename = path.join(directory, 'world.json'), filename = path.join(directory, 'personal-worlds.json'), world = createWorld(1000);
  world.catalog.cardTypes.wood.name = 'Eigenes Holz'; world.cards.push({ id: 'old-progress', type: 'wood' });
  const legacy = JSON.stringify({ world, sessions: { secret: { playerId: 'old-player' } } }); await writeFile(legacyFilename, legacy);
  const repository = await new FileRepository(filename, () => 1000).init(), service = await new GameService({ mode: 'local' }, { repository, now: () => 1000 }).init();
  const joined = await service.join('Fresh');
  assert.equal(joined.world.catalog.cardTypes.wood.name, 'Eigenes Holz'); assert.ok(joined.world.catalog.cardTypes.town_hall);
  assert.ok(!joined.world.cards.some((card) => card.id === 'old-progress'));
  assert.equal(await readFile(legacyFilename, 'utf8'), legacy); await service.close();
  const reopened = await new GameService({ mode: 'local' }, { repository: await new FileRepository(filename).init() }).init();
  assert.equal((await reopened.snapshot(joined.token)).player.id, joined.player.id); await reopened.close();
});

test('Mongo bootstraps edited legacy definitions once and does not copy legacy accounts or cards', async (t) => {
  const world = createWorld(1000); world.catalog.cardTypes.wood.name = 'Atlas-Holz';
  const client = new MemoryMongoClient({ worlds: [{ _id: 'shared', world }] }), repository = await new MongoRepository('mongodb://unused', 'test', () => 1000, { client }).init();
  const service = await new GameService({ mode: 'cloud' }, { repository, now: () => 1000 }).init(); t.after(() => service.close());
  const joined = await service.join('Fresh'); assert.equal(joined.world.catalog.cardTypes.wood.name, 'Atlas-Holz');
  assert.equal(client.documents.personalPlayers.length, 1); assert.equal(client.documents.worlds[0].world.players.length, 0);
  assert.ok(client.documents.gameCatalog[0].catalog.cardTypes.town_hall);
});

test('Mongo gift debit, inbox, pending flag and receipt commit atomically across collections', async (t) => {
  const client = new MemoryMongoClient(), repository = await new MongoRepository('mongodb://unused', 'test', () => 1000, { client }).init();
  const service = await new GameService({ mode: 'cloud' }, { repository, now: () => 1000 }).init(); t.after(() => service.close());
  const a = await service.join('A'), b = await service.join('B'); await hall(service, a.player.id);
  const request = { recipientId: b.player.id, cardId: a.world.cards[0].id, takeAbove: false, commandId: 'mongo-gift-01' };
  const [sent, retried] = await Promise.all([service.gift(a.token, request), service.gift(a.token, request)]);
  assert.equal(sent.giftId, retried.giftId); assert.equal(client.documents.personalGifts.length, 1);
  assert.equal(client.documents.personalPlayers.find((player) => player._id === b.player.id).pendingGiftCount, 1);
  const rawTransaction = repository.transaction.bind(repository);
  repository.transaction = (operation) => rawTransaction((context) => { context.savePlayer = async () => { throw new Error('abort receipt'); }; return operation(context); });
  await assert.rejects(service.sync(b.token), /abort receipt/); repository.transaction = rawTransaction;
  assert.equal(client.documents.personalGifts[0].status, 'pending');
  const received = await service.sync(b.token); assert.equal(received.world.cards.filter((card) => card.type === 'gold').length, 10);
  assert.equal(client.documents.personalGifts[0].status, 'delivered'); assert.equal(client.documents.personalPlayers.find((player) => player._id === b.player.id).pendingGiftCount, 0);
  const giftWrites = client.calls.filter((call) => call.name === 'personalGifts' && call.method === 'replaceOne'); assert.ok(giftWrites.every((call) => call.transaction));
  assert.ok(client.calls.some((call) => call.name === 'gameCatalog' && call.update?.$inc?.fence && call.transaction));
});

test('Mongo heartbeat selects metadata only and world updates omit unchanged catalog bytes', async (t) => {
  const client = new MemoryMongoClient(), repository = await new MongoRepository('mongodb://unused', 'test', () => 1000, { client }).init();
  const service = await new GameService({ mode: 'cloud' }, { repository, now: () => 1000 }).init(); t.after(() => service.close());
  const a = await service.join('A'); client.calls = []; await service.presence(a.token);
  const read = client.calls.find((call) => call.name === 'personalPlayers' && call.method === 'findOne'); assert.equal(read.projection.world, 0);
  assert.ok(client.calls.every((call) => call.name !== 'gameCatalog' && call.name !== 'personalGifts'));
  client.calls = [];
  await service.execute(a.token, { type: 'move', cardId: a.player.cardId, x: 1000, y: 800 }, 'mongo-move-01');
  const update = client.calls.find((call) => call.name === 'personalPlayers' && call.method === 'updateOne').update;
  assert.ok(!JSON.stringify(update).includes('cardTypes')); assert.ok(JSON.stringify(update).length < 2000);
});

test('field diff preserves array removals and nested deletions without resending unchanged data', () => {
  const before = { revision: 1, world: { catalog: { large: 'x'.repeat(4000) }, cards: [{ id: 'a', x: 1, motion: { x: 3 }, metadata: 'x'.repeat(400) }, { id: 'b', x: 2 }] } };
  const after = structuredClone(before); after.revision++; after.world.cards[0].x = 9; delete after.world.cards[0].motion;
  const update = mongoUpdate(before, after);
  assert.equal(update.$set['world.cards.0.x'], 9); assert.equal(update.$unset['world.cards.0.motion'], 1); assert.ok(!JSON.stringify(update).includes('large'));
  after.world.cards.pop(); assert.deepEqual(mongoUpdate(before, after).$set['world.cards'], after.world.cards);
});
