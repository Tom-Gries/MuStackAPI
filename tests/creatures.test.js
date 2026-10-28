import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, joinPlayer, advanceWorld, nextWakeAt, applyCommand } from '../shared/game.js';
import { getCatalog } from '../shared/catalog.js';

function setup(profile = {}) {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Test', 0);
  const human = world.cards.find((card) => card.id === player.cardId);
  Object.assign(human, { x: 400, y: 300 });
  world.cards = [human];
  Object.assign(world.catalog.cardTypes.cow.creature, { behavior: 'stationary', hp: 2, ...profile });
  const cow = { id: 'test-cow', type: 'cow', x: 800, y: 300, order: 0, stackId: 'test-cow', hp: 2 };
  world.cards.push(cow);
  return { world, player, human, cow };
}

test('stationary peaceful creatures neither move nor attack nearby humans', () => {
  const { world, cow, human } = setup();
  cow.x = human.x + 20;
  assert.equal(advanceWorld(world, 10000), false);
  assert.equal(cow.motion, undefined);
  assert.equal(world.combats.length, 0);
  assert.equal(human.hp, 75);
  assert.equal(nextWakeAt(world, 10000), null);
});

test('peaceful wandering uses one trajectory and pauses without presence', () => {
  const { world, cow } = setup({ behavior: 'wander' });
  advanceWorld(world, 0);
  const first = structuredClone(cow.motion);
  assert.equal(first.behavior, 'wander');
  assert.ok(first.duration >= 2000);
  const half = first.duration / 2;
  assert.equal(advanceWorld(world, half), false);
  const elapsed = world.clock.elapsed;
  advanceWorld(world, 86400000, { activeUntil: half });
  assert.equal(world.clock.elapsed, elapsed);
  assert.deepEqual(cow.motion, first);
  advanceWorld(world, 86400000 + Math.ceil(half) + 1);
  assert.ok(cow.motion.startedAt >= first.duration);
  assert.equal(world.combats.length, 0);
});

test('seeking creatures follow the configured card type and retarget after a move', () => {
  const { world, player, cow } = setup({ behavior: 'seek', target: 'wood' });
  const wood = { id: 'target-wood', type: 'wood', x: 100, y: 300, order: 0, stackId: 'target-wood' };
  world.cards.push(wood);
  advanceWorld(world, 0);
  assert.equal(cow.motion.targetId, wood.id);
  const arrival = cow.motion.duration;
  advanceWorld(world, arrival);
  assert.equal(cow.motion, undefined);
  assert.equal(world.combats.length, 0);
  applyCommand(world, { type: 'move', cardId: wood.id, x: 1100, y: 300 }, { playerId: player.id, now: arrival });
  assert.equal(world.cards.find((card) => card.id === cow.id).motion.targetX, 1100);
});

test('aggressive stationary creatures start combat and use their own damage and life', () => {
  const { world, cow, human } = setup({ aggressive: true, damage: 3 });
  cow.x = 490;
  advanceWorld(world, 0);
  assert.equal(world.combats.length, 1);
  advanceWorld(world, 2000);
  assert.equal(human.hp, 72);
  assert.equal(cow.hp, 1);
  advanceWorld(world, 4000);
  assert.equal(human.hp, 69);
  assert.equal(world.cards.some((card) => card.id === cow.id), false);
  assert.equal(world.combats.length, 0);
});

test('a human placed on a peaceful creature provokes combat without making it aggressive', () => {
  const { world, player, human, cow } = setup();
  applyCommand(world, { type: 'move', cardId: human.id, targetId: cow.id, x: cow.x, y: cow.y }, { playerId: player.id, now: 0 });
  assert.equal(world.combats.length, 1);
  assert.equal(world.catalog.cardTypes.cow.creature.aggressive, false);
});

test('a wandering attacker reaches combat at the path intersection instead of its endpoint', () => {
  const { world, cow } = setup({ aggressive: true, behavior: 'wander' });
  cow.x = 100;
  cow.motion = { behavior: 'wander', fromX: 100, fromY: 300, toX: 700, toY: 300, startedAt: 0, duration: 6000 };
  assert.equal(nextWakeAt(world, 0), 2000);
  advanceWorld(world, 2000);
  assert.equal(world.combats.length, 1);
  assert.equal(cow.x, 300);
  assert.equal(cow.motion, undefined);
});

test('invalid creature settings and removed target references are rejected atomically', () => {
  for (const change of [{ aggressive: 'yes' }, { behavior: 'flying' }, { target: 'missing' }, { hp: -1 }, { speed: 0 }]) {
    const { world, player } = setup();
    const before = JSON.stringify(world);
    const catalog = structuredClone(getCatalog(world));
    Object.assign(catalog.cardTypes.cow.creature, change);
    assert.throws(() => applyCommand(world, { type: 'catalog-save', catalog, baseCatalogRevision: 0 }, { playerId: player.id, now: 0 }));
    assert.equal(JSON.stringify(world), before);
  }
});

test('old catalogs gain the seven new cards lazily and deleted new cards stay deleted', () => {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Altstand', 0);
  delete world.catalog.contentVersion;
  world.catalog.packs = world.catalog.packs.filter((pack) => pack.id === 'basic');
  world.catalog.recipes = world.catalog.recipes.filter((recipe) => !['huhn', 'ei'].includes(recipe.id));
  const added = ['campfire', 'knife', 'cow', 'rabbit', 'chicken', 'egg', 'barn'];
  for (const id of added) delete world.catalog.cardTypes[id];
  const original = JSON.stringify(world);
  assert.equal(getCatalog(world).cardTypes.cow.category, 'creature');
  assert.equal(JSON.stringify(world), original);
  const catalog = structuredClone(getCatalog(world));
  delete catalog.cardTypes.cow;
  applyCommand(world, { type: 'catalog-save', catalog, baseCatalogRevision: 0 }, { playerId: player.id, now: 0 });
  assert.equal(getCatalog(world).contentVersion, 3);
  assert.equal(getCatalog(world).cardTypes.cow, undefined);
});
