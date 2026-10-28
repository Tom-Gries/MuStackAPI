import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, joinPlayer, applyCommand, advanceWorld } from '../shared/game.js';
import { getCatalog } from '../shared/catalog.js';
import { humanDamage } from '../shared/combat.js';

function setup() {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Küchentest', 0);
  world.cards = world.cards.filter((card) => card.type === 'human');
  Object.assign(world.cards[0], { x: 300, y: 300 });
  const get = (id) => world.cards.find((card) => card.id === id);
  function add(type, extra = {}) {
    const id = `test-${world.nextId++}`;
    world.cards.push({ id, type, stackId: id, order: 0, x: 900, y: 400, ...extra });
    return id;
  }
  function stack(ingredients) {
    const ids = Object.entries(ingredients).flatMap(([type, count]) => Array.from({ length: count }, () => add(type)));
    ids.forEach((id, order) => Object.assign(get(id), { stackId: ids[0], order }));
    return ids;
  }
  const command = (value, now = world.clock.lastAt) => applyCommand(world, value, { playerId: player.id, now, rng: () => 0 });
  const save = (catalog, now = world.clock.lastAt) => command({ type: 'catalog-save', catalog, baseCatalogRevision: getCatalog(world).revision }, now);
  return { world, player, get, add, stack, command, save, human: () => get(player.cardId) };
}

test('a knife needs one stick, one flint and a human, then preserves its worker', () => {
  const f = setup();
  const materials = f.stack({ stick: 1, flint: 1 });
  advanceWorld(f.world, 0);
  assert.equal(f.world.jobs.length, 0);
  f.command({ type: 'move', cardId: f.player.cardId, targetId: materials[0], x: 900, y: 400, split: true });
  assert.equal(f.world.jobs[0].recipeId, 'knife');
  advanceWorld(f.world, 9999);
  assert.ok(materials.every((id) => f.get(id)));
  advanceWorld(f.world, 10000);
  assert.ok(materials.every((id) => !f.get(id)));
  assert.equal(f.world.cards.filter((card) => card.type === 'knife').length, 1);
  assert.equal(f.human().hp, 75);
});

test('three sticks and one flint build a fire without a human', () => {
  const f = setup();
  const materials = f.stack({ stick: 3, flint: 1 });
  advanceWorld(f.world, 0);
  assert.equal(f.world.jobs[0].recipeId, 'campfire');
  assert.equal(f.world.jobs[0].humanId, undefined);
  advanceWorld(f.world, 10000);
  assert.ok(materials.every((id) => !f.get(id)));
  assert.equal(f.world.cards.filter((card) => card.type === 'campfire').length, 1);
});

test('cooking consumes only meat and the same retained fire can cook another meal', () => {
  const f = setup();
  const [fire, meat] = f.stack({ campfire: 1, meat: 1 });
  advanceWorld(f.world, 0);
  assert.equal(f.world.jobs[0].recipeId, 'cookMeat');
  advanceWorld(f.world, 10000);
  assert.ok(f.get(fire));
  assert.equal(f.get(meat), undefined);
  assert.equal(f.world.cards.filter((card) => card.type === 'cookedMeat').length, 1);
  const secondMeat = f.add('meat');
  f.command({ type: 'move', cardId: secondMeat, targetId: fire, x: 900, y: 400 });
  advanceWorld(f.world, 20000);
  assert.ok(f.get(fire));
  assert.equal(f.get(secondMeat), undefined);
  assert.equal(f.world.cards.filter((card) => card.type === 'cookedMeat').length, 2);
  advanceWorld(f.world, 90000);
  assert.equal(f.world.cards.filter((card) => card.type === 'cookedMeat').length, 2);
});

test('separating a cooking stack cancels work without consuming fire or meat', () => {
  const f = setup();
  const [fire, meat] = f.stack({ campfire: 1, meat: 1 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 5000);
  f.command({ type: 'move', cardId: meat, split: true, x: 1300, y: 800 });
  advanceWorld(f.world, 30000);
  assert.ok(f.get(fire));
  assert.ok(f.get(meat));
  assert.equal(f.world.cards.some((card) => card.type === 'cookedMeat'), false);
});

test('a catalog edit can change retained ingredients during cooking without restarting progress', () => {
  const f = setup();
  const [fire, meat] = f.stack({ campfire: 1, meat: 1 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 5000);
  const due = f.world.jobs[0].dueAt;
  const catalog = structuredClone(getCatalog(f.world));
  delete catalog.recipes.find((recipe) => recipe.id === 'cookMeat').keepIngredients;
  f.save(catalog);
  assert.equal(f.world.jobs[0].dueAt, due);
  advanceWorld(f.world, 10000);
  assert.equal(f.get(fire), undefined);
  assert.equal(f.get(meat), undefined);
  assert.equal(f.world.cards.filter((card) => card.type === 'cookedMeat').length, 1);
});

test('removing a running cooking recipe leaves retained and consumed ingredients intact', () => {
  const f = setup();
  const [fire, meat] = f.stack({ campfire: 1, meat: 1 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 5000);
  const catalog = structuredClone(getCatalog(f.world));
  catalog.recipes = catalog.recipes.filter((recipe) => recipe.id !== 'cookMeat');
  f.save(catalog);
  advanceWorld(f.world, 30000);
  assert.ok(f.get(fire));
  assert.ok(f.get(meat));
  assert.equal(f.world.cards.some((card) => card.type === 'cookedMeat'), false);
});

test('equipping and unequipping a knife changes actual solo combat damage', () => {
  const f = setup();
  const knife = f.add('knife');
  assert.equal(humanDamage(f.world, f.human()), 1);
  f.command({ type: 'move', cardId: knife, targetId: f.player.cardId, x: 300, y: 300 });
  assert.equal(humanDamage(f.world, f.human()), 2);
  f.command({ type: 'unequip', cardId: f.player.cardId });
  assert.equal(humanDamage(f.world, f.human()), 1);
  f.command({ type: 'move', cardId: knife, targetId: f.player.cardId, x: 300, y: 300 });
  const rat = f.add('rat', { hp: 2, x: 305, y: 300 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 2000, { rng: () => 0 });
  assert.equal(f.get(rat), undefined);
  assert.equal(f.human().hp, 74);
  assert.equal(f.get(knife).equippedTo, f.player.cardId);
});

test('an equipped knife adds damage in a cooperative fight without granting the helper the same bonus', () => {
  const f = setup();
  const helper = joinPlayer(f.world, 'Helfer', 0);
  Object.assign(f.get(helper.cardId), { x: 330, y: 300 });
  const knife = f.add('knife');
  f.command({ type: 'move', cardId: knife, targetId: f.player.cardId, x: 300, y: 300 });
  const cow = f.add('cow', { hp: 4, x: 310, y: 300 });
  Object.assign(f.world.catalog.cardTypes.cow.creature, { aggressive: true, behavior: 'stationary', hp: 4 });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 2000);
  assert.equal(f.get(cow).hp, 1);
  assert.equal(humanDamage(f.world, f.get(helper.cardId)), 1);
  assert.equal(f.world.combats[0].lastHitDamage, 3);
});

test('a human on a chicken provokes combat and suspends its autonomous egg recipe', () => {
  const f = setup();
  const chicken = f.add('chicken', { hp: 20 });
  Object.assign(f.world.catalog.cardTypes.chicken.creature, { hp: 20, behavior: 'stationary' });
  advanceWorld(f.world, 0);
  assert.equal(f.world.jobs[0].recipeId, 'ei');
  f.command({ type: 'move', cardId: f.player.cardId, targetId: chicken, x: 900, y: 400, split: true });
  assert.equal(f.world.combats.length, 1);
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 10000, { rng: () => 0 });
  assert.equal(f.get(chicken).hp, 15);
  assert.equal(f.world.cards.some((card) => card.type === 'egg'), false);
});

for (const [roll, output] of [[0, 'bone'], [.5, 'egg'], [.99, 'meat']]) {
  test(`a defeated chicken drops exactly one ${output} at roll ${roll}`, () => {
    const f = setup();
    const chicken = f.add('chicken', { hp: 2 });
    f.command({ type: 'move', cardId: f.player.cardId, targetId: chicken, x: 900, y: 400, split: true });
    advanceWorld(f.world, 4000, { rng: () => roll });
    assert.equal(f.get(chicken), undefined);
    assert.equal(f.world.cards.filter((card) => ['bone', 'egg', 'meat'].includes(card.type)).length, 1);
    assert.equal(f.world.cards.filter((card) => card.type === output).length, 1);
    advanceWorld(f.world, 30000, { rng: () => roll });
    assert.equal(f.world.cards.filter((card) => card.type === output).length, 1);
  });
}

test('weapon settings and retained-ingredient references reject invalid catalog edits atomically', () => {
  for (const change of [
    (catalog) => { catalog.cardTypes.knife.effects = [{ kind: 'weapon', damage: 0 }]; },
    (catalog) => { catalog.cardTypes.knife.effects = [{ kind: 'weapon', damage: 101 }]; },
    (catalog) => { catalog.cardTypes.wood.effects = [{ kind: 'weapon', damage: 1 }]; },
    (catalog) => { catalog.recipes.find((recipe) => recipe.id === 'cookMeat').keepIngredients = ['wood']; },
    (catalog) => { catalog.recipes.find((recipe) => recipe.id === 'cookMeat').keepIngredients = ['missing']; },
  ]) {
    const f = setup();
    const catalog = structuredClone(getCatalog(f.world));
    change(catalog);
    const before = JSON.stringify(f.world);
    assert.throws(() => f.save(catalog));
    assert.equal(JSON.stringify(f.world), before);
  }
});
