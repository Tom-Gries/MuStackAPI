import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TYPES, DEFAULT_CHICKEN_DROPS, DEFAULT_CREATURE, getCatalog, validateCatalog } from '../shared/catalog.js';
import { createWorld, joinPlayer, applyCommand, advanceWorld } from '../shared/game.js';
import { combatEnemyIds } from '../shared/combat.js';

function legacyWorld() {
  const world = createWorld(0);
  world.catalog.contentVersion = 2;
  delete world.catalog.cardTypes.cookedMeat;
  world.catalog.cardTypes.knife.effects = [];
  delete world.catalog.cardTypes.chicken.deathDrops;
  world.catalog.cardTypes.campfire.name = 'Lagerfeuer';
  world.catalog.recipes = world.catalog.recipes.filter((recipe) => !['knife', 'campfire', 'cookMeat'].includes(recipe.id));
  return world;
}

test('version-two catalogs lazily gain the new cooking content and weapon effect without changing stored state', () => {
  const world = legacyWorld();
  const before = JSON.stringify(world);
  const catalog = getCatalog(world);
  assert.equal(catalog.contentVersion, 3);
  assert.deepEqual(catalog.cardTypes.cookedMeat, CARD_TYPES.cookedMeat);
  assert.deepEqual(catalog.cardTypes.knife.effects, [{ kind: 'weapon', damage: 1 }]);
  assert.deepEqual(catalog.cardTypes.chicken.deathDrops, DEFAULT_CHICKEN_DROPS);
  assert.equal(catalog.cardTypes.campfire.name, 'Feuer');
  for (const id of ['knife', 'campfire', 'cookMeat']) assert.equal(catalog.recipes.filter((recipe) => recipe.id === id).length, 1);
  assert.equal(JSON.stringify(world), before);
  assert.deepEqual(getCatalog(world), catalog);
  assert.equal(JSON.stringify(world), before);
});

test('content upgrades preserve customized cards, package balances and existing recipes', () => {
  const world = legacyWorld();
  world.catalog.cardTypes.wood.name = 'Bauholz';
  world.catalog.cardTypes.campfire.name = 'Kochstelle';
  world.catalog.cardTypes.knife.effects = [{ kind: 'weapon', damage: 4 }, { kind: 'tool', sourceTypes: ['tree'], multiplier: .8 }];
  world.catalog.packs.find((pack) => pack.id === 'farm').price = 13;
  world.catalog.recipes.find((recipe) => recipe.id === 'axe').duration = 17000;
  world.catalog.recipes.push({ id: 'specialMeal', name: 'Spezialmahl', ingredients: { berry: 3 }, result: 'meat', resultCount: 2, duration: 12000, requiresHuman: true, timeBase: 'world' });
  const savedPacks = structuredClone(world.catalog.packs);
  const savedRecipes = structuredClone(world.catalog.recipes);
  const savedKnife = structuredClone(world.catalog.cardTypes.knife);
  const catalog = getCatalog(world);
  assert.equal(catalog.cardTypes.wood.name, 'Bauholz');
  assert.equal(catalog.cardTypes.campfire.name, 'Kochstelle');
  assert.deepEqual(catalog.cardTypes.knife, savedKnife);
  assert.deepEqual(catalog.packs, savedPacks);
  for (const recipe of savedRecipes) assert.deepEqual(catalog.recipes.find((entry) => entry.id === recipe.id), recipe);
});

test('an explicitly customized chicken death drop survives upgrades including a zero-chance setting', () => {
  for (const deathDrops of [{ chance: 25, outputs: [{ type: 'bone', count: 2, weight: 1 }] }, { chance: 0, outputs: [] }]) {
    const world = legacyWorld();
    world.catalog.cardTypes.chicken.deathDrops = structuredClone(deathDrops);
    assert.deepEqual(getCatalog(world).cardTypes.chicken.deathDrops, deathDrops);
  }
});

test('an existing equivalent recipe prevents an ambiguous default even when its ID and ingredient order differ', () => {
  const world = legacyWorld();
  const recipe = { id: 'customKnife', name: 'Eigene Klinge', ingredients: { flint: 1, stick: 1 }, result: 'knife', resultCount: 2, duration: 18000, requiresHuman: true, timeBase: 'world' };
  world.catalog.recipes.push(recipe);
  const catalog = getCatalog(world);
  assert.deepEqual(catalog.recipes.find((entry) => entry.id === 'customKnife'), recipe);
  assert.equal(catalog.recipes.some((entry) => entry.id === 'knife'), false);
  const signature = (entry) => JSON.stringify(Object.entries(entry.ingredients).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(catalog.recipes.filter((entry) => signature(entry) === signature(recipe)).length, 1);
  assert.equal(getCatalog({ catalog }).recipes.length, catalog.recipes.length);
});

test('an existing new-recipe ID is preserved and defaults do not reference a deleted ingredient', () => {
  const world = legacyWorld();
  const customFire = { id: 'campfire', name: 'Glut aus Holz', ingredients: { wood: 4 }, result: 'campfire', resultCount: 1, duration: 24000, requiresHuman: false, timeBase: 'world' };
  world.catalog.recipes.push(customFire);
  delete world.catalog.cardTypes.flint;
  world.catalog.cardTypes.rock.effects[0].outputs = [{ type: 'stone', count: 1, weight: 1 }];
  const catalog = getCatalog(world);
  assert.deepEqual(catalog.recipes.find((entry) => entry.id === 'campfire'), customFire);
  assert.equal(catalog.recipes.filter((entry) => entry.id === 'campfire').length, 1);
  assert.equal(catalog.recipes.some((entry) => entry.id === 'knife'), false);
});

test('deleted legacy result cards do not gain dangling default recipes during an upgrade', () => {
  for (const deletedType of ['knife', 'campfire']) {
    const world = legacyWorld();
    delete world.catalog.cardTypes[deletedType];
    world.catalog.recipes = world.catalog.recipes.filter((recipe) => recipe.result !== deletedType && !Object.hasOwn(recipe.ingredients, deletedType));
    const catalog = getCatalog(world);
    assert.equal(catalog.cardTypes[deletedType], undefined);
    assert.equal(catalog.recipes.some((recipe) => recipe.result === deletedType || Object.hasOwn(recipe.ingredients, deletedType)), false);
    assert.doesNotThrow(() => validateCatalog(catalog, world));
  }
});

test('saving version three makes deletion of an unused cooked-meat card and its recipe permanent', () => {
  const world = legacyWorld();
  const player = joinPlayer(world, 'Inhaltsprüfung', 0);
  const upgraded = structuredClone(getCatalog(world));
  applyCommand(world, { type: 'catalog-save', catalog: upgraded, baseCatalogRevision: upgraded.revision }, { playerId: player.id, now: 0 });
  assert.equal(world.catalog.contentVersion, 3);
  const deleted = structuredClone(getCatalog(world));
  deleted.recipes = deleted.recipes.filter((recipe) => recipe.id !== 'cookMeat');
  delete deleted.cardTypes.cookedMeat;
  applyCommand(world, { type: 'catalog-save', catalog: deleted, baseCatalogRevision: deleted.revision }, { playerId: player.id, now: 0 });
  assert.equal(getCatalog(world).cardTypes.cookedMeat, undefined);
  assert.equal(getCatalog(world).recipes.some((recipe) => recipe.id === 'cookMeat'), false);
  const restored = JSON.parse(JSON.stringify(world));
  assert.equal(getCatalog(restored).cardTypes.cookedMeat, undefined);
  assert.equal(getCatalog(restored).recipes.some((recipe) => recipe.id === 'cookMeat'), false);
});

test('peaceful rats stay out of nearby rat teams until a human explicitly provokes them', () => {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Friedensprüfung', 0);
  const human = world.cards.find((card) => card.id === player.cardId);
  Object.assign(human, { x: 400, y: 300, stackId: 'rat-a', order: 1 });
  world.catalog.cardTypes.rat.creature = { ...DEFAULT_CREATURE, aggressive: false, behavior: 'stationary', hp: 10 };
  world.cards = [human,
    { id: 'rat-a', type: 'rat', stackId: 'rat-a', order: 0, hp: 10, x: 400, y: 300 },
    { id: 'rat-b', type: 'rat', stackId: 'rat-b', order: 0, hp: 10, x: 430, y: 300 },
  ];
  advanceWorld(world, 0);
  assert.equal(world.combats.length, 1);
  assert.deepEqual(combatEnemyIds(world.combats[0]), ['rat-a']);
  advanceWorld(world, 2000);
  assert.deepEqual(combatEnemyIds(world.combats[0]), ['rat-a']);
  assert.equal(world.cards.find((card) => card.id === 'rat-b').hp, 10);
  applyCommand(world, { type: 'move', cardId: human.id, targetId: 'rat-b', split: true, x: 430, y: 300 }, { playerId: player.id, now: 2000 });
  assert.deepEqual(new Set(combatEnemyIds(world.combats[0])), new Set(['rat-a', 'rat-b']));
});
