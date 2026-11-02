import test from 'node:test';
import assert from 'node:assert/strict';
import { addCard } from '@stackfriends/shared/game.js';
import { fixture, edit } from './helpers/personal.js';
import { GameService } from '../server/service.js';

const count = (world, type) => world.cards.filter((card) => card.type === type).length;
const worker = (world) => world.cards.find((card) => card.type === 'human');

async function startTree(setup, player, { axe = false, clientId } = {}) {
  if (axe) {
    const tool = await edit(setup.service, player.player.id, (world) => addCard(world, 'axe', 1200, 700));
    await setup.service.execute(player.token, { type: 'move', cardId: tool.id, targetId: player.player.cardId, x: 400, y: 400 }, 'equip-axe-01', clientId);
  }
  const tree = await edit(setup.service, player.player.id, (world) => addCard(world, 'tree', 900, 500));
  await setup.service.execute(player.token, { type: 'move', cardId: player.player.cardId, targetId: tree.id, x: tree.x, y: tree.y, split: true, takeAbove: false }, 'start-tree-01', clientId);
  return tree;
}

test('a cookie return catches up partial tree work and then removes the exhausted tree', async (t) => {
  const setup = await fixture(t), { service, advance, now } = setup, player = await service.join('Alice', 'tab-a');
  const tree = await startTree(setup, player, { clientId: 'tab-a' });
  await service.sync(player.token, false, 'tab-a');
  advance(25_000);
  const partial = await service.snapshot(player.token);
  assert.equal(count(partial.world, 'wood'), 2);
  assert.equal(partial.world.cards.find((card) => card.id === tree.id).remaining, 3);
  assert.equal(partial.world.jobs[0].dueAt - partial.world.clock.elapsed, 5000);
  assert.equal(partial.world.clock.lastAt, now());
  assert.equal(partial.onlinePlayers.length, 0);
  const stored = await service.repository.read((context) => context.playerById(player.player.id));
  assert.equal(stored.activeUntil, now() - 25_000);
  assert.equal(stored.world.cards.filter((card) => card.type === 'wood').length, 2);
  advance(25_000);
  const finished = await service.snapshot(player.token);
  assert.equal(count(finished.world, 'tree'), 0);
  assert.equal(count(finished.world, 'wood'), 5);
  assert.equal(finished.world.jobs.length, 0);
  assert.equal(worker(finished.world).hp, 75);
});

test('a returning existing name receives all completed work without creating another human', async (t) => {
  const setup = await fixture(t), { service, advance } = setup, original = await service.join('Alice', 'old-tab');
  await startTree(setup, original, { clientId: 'old-tab' });
  await service.sync(original.token, false, 'old-tab');
  advance(86_400_000);
  const returning = await service.join('alice', 'new-tab');
  assert.equal(returning.player.id, original.player.id);
  assert.equal(count(returning.world, 'human'), 1);
  assert.equal(count(returning.world, 'tree'), 0);
  assert.equal(count(returning.world, 'wood'), 5);
  assert.equal(count((await service.snapshot(original.token)).world, 'wood'), 5);
});

test('parallel cookie returns persist tree outputs exactly once and a restart preserves them', async (t) => {
  const setup = await fixture(t), { service, config, now, advance } = setup, player = await service.join('Alice');
  await startTree(setup, player);
  await service.sync(player.token, false);
  advance(50_000);
  const [first, second] = await Promise.all([service.snapshot(player.token), service.snapshot(player.token)]);
  assert.equal(count(first.world, 'wood'), 5);
  assert.equal(count(second.world, 'wood'), 5);
  assert.equal(first.world.revision, second.world.revision);
  const restarted = await new GameService(config, { now, rng: () => .5 }).init();
  try {
    const after = await restarted.snapshot(player.token);
    assert.equal(count(after.world, 'wood'), 5);
    assert.equal(count(after.world, 'tree'), 0);
    assert.equal(new Set(after.world.cards.map((card) => card.id)).size, after.world.cards.length);
  } finally { await restarted.close(); }
});

test('the offline source queue works through all sources with normal output counts', async (t) => {
  const { service, advance } = await fixture(t), player = await service.join('Alice');
  const first = await edit(service, player.player.id, (world) => {
    const tree = addCard(world, 'tree', 900, 500, { stackId: 'offline-sources', order: 0 });
    addCard(world, 'rock', 900, 500, { stackId: tree.stackId, order: 1 });
    addCard(world, 'berryBush', 900, 500, { stackId: tree.stackId, order: 2 });
    return tree;
  });
  await service.execute(player.token, { type: 'move', cardId: player.player.cardId, targetId: first.id, x: first.x, y: first.y }, 'source-queue-01');
  await service.sync(player.token, false);
  advance(150_000);
  const returned = await service.snapshot(player.token);
  for (const type of ['tree', 'rock', 'berryBush']) assert.equal(count(returned.world, type), 0);
  for (const type of ['wood', 'stone', 'berry']) assert.equal(count(returned.world, type), 5);
  assert.equal(returned.world.jobs.length, 0);
});

test('equipped tools keep their speed bonus during offline production', async (t) => {
  const setup = await fixture(t), { service, advance } = setup, player = await service.join('Alice');
  await startTree(setup, player, { axe: true });
  await service.sync(player.token, false);
  advance(25_000);
  const returned = await service.snapshot(player.token);
  assert.equal(count(returned.world, 'tree'), 0);
  assert.equal(count(returned.world, 'wood'), 5);
  assert.equal(count(returned.world, 'axe'), 1);
  assert.ok(worker(returned.world).toolId);
});

test('an unfinished building completes from its remaining time while the player is away', async (t) => {
  const { service, advance } = await fixture(t), player = await service.join('Alice');
  const anchor = await edit(service, player.player.id, (world) => {
    const types = [...Array(5).fill('wood'), ...Array(5).fill('stone')];
    return types.map((type, order) => addCard(world, type, 900, 500, { stackId: 'offline-building', order }))[0];
  });
  await service.execute(player.token, { type: 'move', cardId: player.player.cardId, targetId: anchor.id, x: anchor.x, y: anchor.y }, 'build-warehouse-01');
  advance(10_000);
  const paused = await service.sync(player.token, false);
  assert.equal(paused.world.jobs[0].recipeId, 'warehouse');
  advance(20_000);
  const returned = await service.snapshot(player.token);
  assert.equal(count(returned.world, 'warehouse'), 1);
  assert.equal(count(returned.world, 'wood'), 0);
  assert.equal(count(returned.world, 'stone'), 0);
  assert.equal(count(returned.world, 'human'), 1);
  assert.equal(returned.world.jobs.length, 0);
});

test('an offline return catches up work time but does not deal unseen combat damage', async (t) => {
  const { service, advance } = await fixture(t), player = await service.join('Alice');
  const rat = await edit(service, player.player.id, (world) => addCard(world, 'rat', 900, 500));
  const started = await service.execute(player.token, { type: 'move', cardId: player.player.cardId, targetId: rat.id, x: rat.x, y: rat.y }, 'start-battle-01');
  assert.equal(started.world.combats.length, 1);
  await service.sync(player.token, false);
  advance(86_400_000);
  const returned = await service.snapshot(player.token);
  assert.equal(worker(returned.world).hp, 75);
  assert.equal(returned.world.cards.find((card) => card.id === rat.id).hp, 2);
  assert.equal(returned.world.combats[0].nextAttackAt - returned.world.clock.elapsed, 2000);
  assert.equal(returned.onlinePlayers.length, 0);
});
