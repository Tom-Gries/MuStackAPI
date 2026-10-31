import test from 'node:test';
import assert from 'node:assert/strict';
import { addCard } from '@stackfriends/shared/game.js';
import { fixture, edit, hall } from './helpers/personal.js';

test('new names have independent fresh worlds; an existing normalized name keeps one human and progress', async (t) => {
  const { service } = await fixture(t), a = await service.join('  Änne  '), b = await service.join('Bob');
  assert.notEqual(a.world.id, b.world.id);
  for (const session of [a, b]) {
    assert.equal(session.world.cards.filter((card) => card.type === 'human').length, 1);
    assert.equal(session.world.cards.filter((card) => card.type === 'gold').length, 9);
    assert.equal(session.world.players.length, 1);
    assert.equal(session.world.players[0].id, session.player.id);
    assert.equal(session.world.catalog.cardTypes.town_hall.name, 'Rathaus');
  }
  await edit(service, a.player.id, (world) => addCard(world, 'wood', 600, 200));
  const again = await service.join('änne');
  assert.equal(again.player.id, a.player.id);
  assert.equal(again.world.cards.filter((card) => card.type === 'human').length, 1);
  assert.equal(again.world.cards.filter((card) => card.type === 'wood').length, 1);
  assert.equal((await service.snapshot(a.token)).player.id, a.player.id);
});

test('anonymous session exposes no board and protected actions require a cookie', async (t) => {
  const { service } = await fixture(t); await service.join('Tom');
  assert.equal((await service.snapshot()).world, null);
  assert.equal((await service.snapshot('invalid-cookie-value')).player, null);
  await assert.rejects(service.sync('invalid-cookie-value'), { status: 401 });
  await assert.rejects(service.players(), { status: 401 });
});

test('commands mutate only the cookie owner world even when an unrelated world/player is supplied', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  const card = a.world.cards.find((entry) => entry.type === 'gold');
  await service.execute(a.token, { type: 'move', cardId: card.id, x: 1000, y: 800, split: true, takeAbove: false, playerId: b.player.id, worldId: b.world.id }, 'ownership-1');
  assert.equal((await service.snapshot(a.token)).world.cards.find((entry) => entry.id === card.id).x, 1000);
  assert.notEqual((await service.snapshot(b.token)).world.cards.find((entry) => entry.id === card.id).x, 1000);
});

test('Rathaus gates social endpoints, and a player list contains only profiles and online status', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  await assert.rejects(service.players(a.token), { status: 403 });
  await assert.rejects(service.materials(a.token, b.player.id), { status: 403 });
  await assert.rejects(service.gift(a.token, { recipientId: b.player.id, cardId: a.world.cards[0].id, commandId: 'gift-no-hall' }), { status: 403 });
  await hall(service, a.player.id);
  const listed = await service.players(a.token);
  assert.equal(listed.players.length, 2);
  for (const player of listed.players) assert.deepEqual(Object.keys(player).sort(), ['id', 'lastSavedAt', 'name', 'online']);
  const materials = await service.materials(a.token, b.player.id);
  assert.deepEqual(materials.materials, [{ type: 'gold', count: 9 }]);
  assert.ok(!('world' in materials));
});

test('gift debit and durable inbox survive offline recipient; delivery and retries never duplicate', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  await hall(service, a.player.id); await service.sync(b.token, false);
  const gold = a.world.cards.find((card) => card.type === 'gold');
  const request = { recipientId: b.player.id, cardId: gold.id, takeAbove: false, commandId: 'one-gift-001' };
  const [first, retry] = await Promise.all([service.gift(a.token, request), service.gift(a.token, request)]);
  assert.equal(first.giftId, retry.giftId);
  assert.equal(first.world.cards.filter((card) => card.type === 'gold').length, 8);
  assert.equal((await service.snapshot(b.token)).world.cards.filter((card) => card.type === 'gold').length, 9);
  await service.presence(a.token, false);
  const presence = await service.presence(b.token);
  assert.equal(presence.hasOtherPlayersOnline, false);
  assert.equal(presence.hasPendingGifts, true);
  assert.ok(!('world' in presence));
  const received = await service.sync(b.token);
  assert.equal(received.world.cards.filter((card) => card.type === 'gold').length, 10);
  assert.equal(received.giftMessages.length, 1);
  assert.equal(received.hasPendingGifts, false);
  const again = await service.sync(b.token);
  assert.equal(again.world.cards.filter((card) => card.type === 'gold').length, 10);
  assert.deepEqual(again.giftMessages, []);
  assert.equal((await service.gift(a.token, request)).giftId, first.giftId);
});

test('failed gift creation cannot consume cards, and failed receipt cannot acknowledge its inbox', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  await hall(service, a.player.id);
  const request = { recipientId: b.player.id, cardId: a.world.cards[0].id, takeAbove: false, commandId: 'atomic-gift-1' };
  const transaction = service.repository.transaction.bind(service.repository);
  service.repository.transaction = (operation) => transaction((context) => { context.saveGift = async () => { throw new Error('simulated storage failure'); }; return operation(context); });
  await assert.rejects(service.gift(a.token, request), /simulated/);
  service.repository.transaction = transaction;
  assert.equal((await service.snapshot(a.token)).world.cards.filter((card) => card.type === 'gold').length, 9);
  await service.gift(a.token, request);
  service.repository.transaction = (operation) => transaction((context) => { context.savePlayer = async () => { throw new Error('simulated receipt failure'); }; return operation(context); });
  await assert.rejects(service.sync(b.token), /simulated/);
  service.repository.transaction = transaction;
  const received = await service.sync(b.token);
  assert.equal(received.world.cards.filter((card) => card.type === 'gold').length, 10);
  assert.equal(received.giftMessages.length, 1);
});

test('retrying a gift of the last Rathaus returns its durable receipt after access is gone', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  const building = await hall(service, a.player.id);
  const request = { recipientId: b.player.id, cardId: building.id, commandId: 'hall-gift-001' };
  const sent = await service.gift(a.token, request);
  await assert.rejects(service.players(a.token), { status: 403 });
  assert.equal((await service.gift(a.token, request)).giftId, sent.giftId);
  await edit(service, a.player.id, (_world, player) => { player.commandIds = []; });
  assert.equal((await service.gift(a.token, request)).giftId, sent.giftId);
});

test('human gifts, gifts to self and reused action IDs with different content are rejected atomically', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  await hall(service, a.player.id);
  const human = a.world.cards.find((card) => card.type === 'human');
  await assert.rejects(service.gift(a.token, { recipientId: b.player.id, cardId: human.id, commandId: 'human-gift-1' }), /Menschen/);
  await assert.rejects(service.gift(a.token, { recipientId: a.player.id, cardId: a.world.cards[0].id, commandId: 'self-gift-1' }), /anderen/);
  const command = { type: 'move', cardId: human.id, x: 1000, y: 500 };
  await service.execute(a.token, command, 'stable-command-1');
  assert.equal((await service.execute(a.token, command, 'stable-command-1')).duplicate, true);
  await assert.rejects(service.execute(a.token, { ...command, x: 1100 }, 'stable-command-1'), { status: 409 });
});

test('two tabs cannot lose independent completed actions and hiding one does not pause the other', async (t) => {
  const { service, advance } = await fixture(t), a = await service.join('A', 'tab-a');
  await service.sync(a.token, true, 'tab-b');
  const [one, two] = a.world.cards.filter((card) => card.type === 'gold');
  await Promise.all([
    service.execute(a.token, { type: 'move', cardId: one.id, split: true, takeAbove: false, x: 1000, y: 500 }, 'tab-command-1', 'tab-a'),
    service.execute(a.token, { type: 'move', cardId: two.id, split: true, takeAbove: false, x: 1200, y: 500 }, 'tab-command-2', 'tab-b'),
  ]);
  advance(5000); await service.sync(a.token, false, 'tab-a');
  advance(5000); const result = await service.sync(a.token, true, 'tab-b');
  assert.equal(result.world.cards.find((card) => card.id === one.id).x, 1000);
  assert.equal(result.world.cards.find((card) => card.id === two.id).x, 1200);
  assert.equal(result.world.clock.elapsed, 10_000);
  assert.equal(result.onlinePlayers.length, 1);
});

test('offline world time pauses, real growth continues once, and session reads do not reactivate leases', async (t) => {
  const { service, advance, now } = await fixture(t), a = await service.join('A', 'tab-a');
  await edit(service, a.player.id, (world) => {
    const soil = addCard(world, 'soil', 900, 500), berry = addCard(world, 'berry', 1100, 500);
    world.testSoil = soil.id; world.testBerry = berry.id;
  });
  let world = (await service.snapshot(a.token)).world;
  await service.execute(a.token, { type: 'move', cardId: world.testBerry, targetId: world.testSoil, x: 900, y: 500 }, 'grow-start-1', 'tab-a');
  advance(5000); const paused = await service.sync(a.token, false, 'tab-a');
  advance(2 * 86_400_000); const session = await service.snapshot(a.token);
  assert.equal(session.world.clock.elapsed, paused.world.clock.elapsed);
  const resumed = await service.sync(a.token, true, 'tab-a');
  assert.equal(resumed.world.clock.elapsed, paused.world.clock.elapsed);
  assert.equal(resumed.world.cards.filter((card) => card.type === 'field').length, 1);
  assert.ok(resumed.world.cards.find((card) => card.type === 'field').readyAt < now());
});

test('presence heartbeat avoids loading/saving world and has no game timers', async (t) => {
  const events = [], { service, advance } = await fixture(t, { onPlayerOnline: (player) => events.push(player.id) }), a = await service.join('A', 'tab-a');
  const before = (await service.snapshot(a.token)).world;
  advance(60_000); const presence = await service.presence(a.token, true, 'tab-a');
  assert.ok(!('world' in presence));
  assert.deepEqual((await service.snapshot(a.token)).world, before);
  assert.equal(events.length, 1);
  await service.presence(a.token, false, 'tab-a');
  await service.sync(a.token, true, 'tab-a');
  assert.equal(events.length, 2);
  assert.equal(service.timer, undefined);
  assert.equal(service.realtime, undefined);
});

test('client epochs ignore delayed pause after resume and old commands after hiding', async (t) => {
  const { service, advance } = await fixture(t), initial = { id: 'tab-a', epoch: 0, active: true }, a = await service.join('A', initial);
  advance(1000); await service.sync(a.token, false, { ...initial, epoch: 1, active: false });
  advance(1000); await service.sync(a.token, true, { ...initial, epoch: 2 });
  advance(1000); const delayedPause = await service.presence(a.token, false, { ...initial, epoch: 1, active: false });
  assert.equal(delayedPause.onlinePlayers.length, 1);
  advance(1000); const active = await service.sync(a.token, true, { ...initial, epoch: 2 });
  assert.equal(active.world.clock.elapsed, 3000);
  await service.sync(a.token, false, { ...initial, epoch: 3, active: false });
  advance(10_000);
  const lateCommand = await service.execute(a.token, { type: 'move', cardId: a.player.cardId, x: 1100, y: 700 }, 'late-command-01', { ...initial, epoch: 2 });
  assert.equal(lateCommand.onlinePlayers.length, 0);
  assert.equal(lateCommand.world.clock.elapsed, active.world.clock.elapsed);
  const sameEpoch = await service.presence(a.token, true, { ...initial, epoch: 3 });
  assert.equal(sameEpoch.onlinePlayers.length, 0);
  advance(10_000); const resumed = await service.sync(a.token, true, { ...initial, epoch: 4 });
  assert.equal(resumed.world.clock.elapsed, active.world.clock.elapsed);
});

test('catalog edits are global while protecting offline worlds, pending gifts and partial pack payments', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B');
  await hall(service, a.player.id);
  let catalog = structuredClone(a.world.catalog);
  catalog.cardTypes.test_resource = { ...catalog.cardTypes.wood, name: 'Testressource' };
  const saved = await service.execute(a.token, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-add-1');
  assert.equal((await service.sync(b.token)).world.catalog.cardTypes.test_resource.name, 'Testressource');
  const card = await edit(service, b.player.id, (world) => addCard(world, 'test_resource', 1000, 500));
  catalog = structuredClone(saved.world.catalog); delete catalog.cardTypes.test_resource;
  await assert.rejects(service.execute(a.token, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-delete-1'), /noch Karten/);
  await hall(service, b.player.id);
  await service.gift(b.token, { recipientId: a.player.id, cardId: card.id, commandId: 'catalog-gift-1' });
  // A third player edits without receiving the pending gift themselves.
  const c = await service.join('C');
  await assert.rejects(service.execute(c.token, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-delete-2'), /noch Karten/);
  await edit(service, b.player.id, (world) => { world.shopPayments.basic = 1; world.shopPaid = 1; });
  catalog = structuredClone(saved.world.catalog); catalog.packs.find((pack) => pack.id === 'basic').price++;
  await assert.rejects(service.execute(c.token, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'catalog-price-1'), /angezahlten/);
});

test('a peaceful pending creature gift cannot be made aggressive by a catalog edit', async (t) => {
  const { service } = await fixture(t), a = await service.join('A'), b = await service.join('B'), c = await service.join('C');
  await hall(service, a.player.id);
  const cow = await edit(service, a.player.id, (world) => addCard(world, 'cow', 1200, 700));
  await service.gift(a.token, { recipientId: b.player.id, cardId: cow.id, commandId: 'pending-cow-1' });
  const catalog = structuredClone(c.world.catalog); catalog.cardTypes.cow.creature.aggressive = true;
  await assert.rejects(service.execute(c.token, { type: 'catalog-save', catalog, baseCatalogRevision: catalog.revision }, 'angry-cow-edit-1'), /wartendes Geschenk/);
  const received = await service.sync(b.token);
  assert.equal(received.world.cards.filter((card) => card.type === 'cow').length, 1);
  assert.equal(received.world.catalog.cardTypes.cow.creature.aggressive, false);
});
