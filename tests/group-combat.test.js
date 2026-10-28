import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, joinPlayer, applyCommand, advanceWorld } from '../shared/game.js';
import { getCatalog } from '../shared/catalog.js';
import { combatHumanIds } from '../shared/combat.js';

function setup({ hp = 2, targetHp = 75 } = {}) {
  const world = createWorld(0);
  const a = joinPlayer(world, 'Tom', 0), b = joinPlayer(world, 'Mia', 0);
  const human = world.cards.find((card) => card.id === a.cardId), helper = world.cards.find((card) => card.id === b.cardId);
  Object.assign(human, { x: 400, y: 300, hp: targetHp });
  Object.assign(helper, { x: 1300, y: 900 });
  const cow = { id: 'cow', type: 'cow', hp, x: 405, y: 300, stackId: 'cow', order: 0 };
  world.cards = [human, helper, cow];
  Object.assign(world.catalog.cardTypes.cow.creature, { aggressive: true, behavior: 'stationary', hp });
  const move = (card, x, y, now = 0) => applyCommand(world, { type: 'move', cardId: card.id, split: true, x, y }, { playerId: a.id, now });
  return { world, human, helper, cow, move, a };
}

test('two humans defeat a two-life enemy in one round with only one retaliation and one loot draw', () => {
  const f = setup();
  f.world.catalog.cardTypes.cow.deathDrops = { chance: 100, outputs: [{ type: 'meat', count: 3, weight: 1 }] };
  Object.assign(f.helper, { x: 420, y: 300 });
  advanceWorld(f.world, 0);
  assert.deepEqual(new Set(combatHumanIds(f.world.combats[0])), new Set([f.human.id, f.helper.id]));
  advanceWorld(f.world, 2000, { rng: () => 0 });
  assert.equal(f.world.cards.some((card) => card.id === f.cow.id), false);
  assert.equal(f.human.hp + f.helper.hp, 149);
  assert.equal(f.world.cards.filter((card) => card.type === 'meat').length, 3);
  advanceWorld(f.world, 100000, { rng: () => 0 });
  assert.equal(f.world.cards.filter((card) => card.type === 'meat').length, 3);
});

test('joining and leaving an ongoing battle retains its attack timer and keeps remaining fighters engaged', () => {
  const f = setup({ hp: 5 });
  advanceWorld(f.world, 0);
  const due = f.world.combats[0].nextAttackAt;
  f.move(f.helper, 430, 300, 1000);
  assert.equal(f.world.combats[0].humanIds.length, 2);
  assert.equal(f.world.combats[0].nextAttackAt, due);
  f.move(f.human, 1300, 900, 1500);
  assert.deepEqual(f.world.combats[0].humanIds, [f.helper.id]);
  assert.equal(f.world.combats[0].humanId, f.helper.id);
  assert.equal(f.world.combats[0].nextAttackAt, due);
  advanceWorld(f.world, 2000);
  assert.equal(f.world.cards.find((card) => card.id === f.cow.id).hp, 4);
  assert.equal(f.world.cards.find((card) => card.id === f.helper.id).hp, 74);
});

test('the surviving helper continues fighting when the enemy target dies', () => {
  const f = setup({ hp: 5, targetHp: 1 });
  Object.assign(f.helper, { x: 430, y: 300 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 2000);
  assert.equal(f.human.type, 'corpse');
  assert.equal(f.cow.hp, 3);
  assert.deepEqual(f.world.combats[0].humanIds, [f.helper.id]);
  advanceWorld(f.world, 4000);
  assert.equal(f.cow.hp, 2);
  assert.equal(f.helper.hp, 74);
});

test('fighters belong to one battle and legacy solo combat resumes without resetting progress', () => {
  const f = setup({ hp: 5 });
  f.world.cards.push({ ...f.cow, id: 'cow2', stackId: 'cow2' });
  advanceWorld(f.world, 0);
  delete f.world.combats[0].humanIds;
  const due = f.world.combats[0].nextAttackAt;
  advanceWorld(f.world, 1000);
  assert.equal(f.world.combats.length, 1);
  assert.deepEqual(f.world.combats[0].humanIds, [f.human.id]);
  assert.equal(f.world.combats[0].nextAttackAt, due);
});

test('group battle pauses offline and resumes with its remaining time', () => {
  const f = setup({ hp: 5 });
  Object.assign(f.helper, { x: 430, y: 300 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 1000);
  advanceWorld(f.world, 1000000, { activeUntil: 1000 });
  assert.equal(f.cow.hp, 5);
  advanceWorld(f.world, 1001000);
  assert.equal(f.cow.hp, 3);
});

for (const [roll, expected] of [[0, 'gold'], [.3999, 'gold'], [.4, 'bone'], [.6999, 'bone'], [.7, 'meat'], [.8999, 'meat'], [.9, null]]) {
  test(`legacy rat loot retains its original distribution at roll ${roll}`, () => {
    const f = setup();
    f.cow.type = 'rat'; delete f.world.catalog.cardTypes.rat.deathDrops;
    advanceWorld(f.world, 0);
    advanceWorld(f.world, 4000, { rng: () => roll });
    assert.deepEqual(f.world.cards.filter((card) => ['gold', 'bone', 'meat'].includes(card.type)).map((card) => card.type), expected ? [expected] : []);
  });
}

test('zero loot chance overrides legacy rat drops and catalog edits persist counted custom loot', () => {
  const f = setup(); f.cow.type = 'rat';
  const catalog = structuredClone(getCatalog(f.world));
  catalog.cardTypes.rat.deathDrops = { chance: 0, outputs: [] };
  applyCommand(f.world, { type: 'catalog-save', catalog, baseCatalogRevision: 0 }, { playerId: f.a.id, now: 0 });
  advanceWorld(f.world, 4000, { rng: () => 0 });
  assert.equal(f.world.cards.some((card) => ['gold', 'bone', 'meat'].includes(card.type)), false);
});

test('invalid loot settings and removal of referenced loot cards fail atomically', () => {
  for (const drops of [{ chance: 101, outputs: [] }, { chance: 50, outputs: [] }, { chance: 100, outputs: [{ type: 'human', count: 1, weight: 1 }] }, { chance: 100, outputs: [{ type: 'meat', count: 31, weight: 1 }] }, { chance: 100, outputs: [{ type: 'missing', count: 1, weight: 1 }] }]) {
    const f = setup(); const before = JSON.stringify(f.world);
    const catalog = structuredClone(getCatalog(f.world)); catalog.cardTypes.cow.deathDrops = drops;
    assert.throws(() => applyCommand(f.world, { type: 'catalog-save', catalog, baseCatalogRevision: 0 }, { playerId: f.a.id, now: 0 }));
    assert.equal(JSON.stringify(f.world), before);
  }
  const f = setup(); const catalog = structuredClone(getCatalog(f.world));
  catalog.cardTypes.loot = { ...catalog.cardTypes.wood, name: 'Beute' };
  catalog.cardTypes.cow.deathDrops = { chance: 100, outputs: [{ type: 'loot', count: 2, weight: 1 }] };
  applyCommand(f.world, { type: 'catalog-save', catalog, baseCatalogRevision: 0 }, { playerId: f.a.id, now: 0 });
  assert.equal(JSON.parse(JSON.stringify(f.world)).catalog.cardTypes.cow.deathDrops.outputs[0].count, 2);
  const removed = structuredClone(getCatalog(f.world)); delete removed.cardTypes.loot;
  assert.throws(() => applyCommand(f.world, { type: 'catalog-save', catalog: removed, baseCatalogRevision: 1 }, { playerId: f.a.id, now: 0 }), /Beute beim Tod/);
});
