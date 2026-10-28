import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TYPES, DEFAULT_CATALOG, PROTECTED_CARD_TYPES, getCatalog, getCardTypes, getRecipes, getPacks, getCardDefinition, validateCatalog } from '../shared/catalog.js';
import { createWorld, joinPlayer, applyCommand, publicWorld } from '../shared/game.js';
import { ART_LIBRARY } from '../shared/art-library.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const customCard = (changes = {}) => ({ name: 'Kristall', category: 'resource', color: '#aabbcc', icon: '◆', art: 'flint', sellPrice: 2, description: 'Ein neuer Rohstoff.', effects: [], ...changes });
function fixture() {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Katalogtest', 0);
  return { world, save(catalog, baseCatalogRevision = getCatalog(world).revision) {
    return applyCommand(world, { type: 'catalog-save', catalog, baseCatalogRevision }, { playerId: player.id, now: 0 });
  } };
}

test('legacy saves resolve complete immutable defaults without changing stored state', () => {
  const world = createWorld(0);
  delete world.catalog;
  delete world.shopPayments;
  const stored = JSON.stringify(world);
  assert.equal(getCatalog(world), DEFAULT_CATALOG);
  assert.equal(getCardTypes(world).tree.effects[0].uses, 5);
  assert.equal(getCardDefinition(world, 'berry').effects[0].amount, 1);
  assert.equal(getRecipes(world).find((recipe) => recipe.id === 'strawberryField').timeBase, 'real');
  assert.equal(getPacks(world)[0].size, 3);
  const publicState = publicWorld(world);
  assert.equal(publicState.catalog.revision, 0);
  publicState.catalog.cardTypes.tree.name = 'Privater Entwurf';
  assert.equal(CARD_TYPES.tree.name, 'Baum');
  assert.equal(JSON.stringify(world), stored);
  assert.ok(Object.isFrozen(DEFAULT_CATALOG.recipes[0].ingredients));
});

test('whole-catalog saves create, edit and delete unused card definitions and persist the revision', () => {
  const f = fixture();
  const catalog = copy(getCatalog(f.world));
  catalog.cardTypes.crystal = customCard();
  f.save(catalog);
  assert.equal(f.world.catalog.revision, 1);
  assert.equal(f.world.catalog.cardTypes.crystal.name, 'Kristall');
  const loaded = JSON.parse(JSON.stringify(publicWorld(f.world)));
  assert.equal(getCardDefinition(loaded, 'crystal').sellPrice, 2);
  const edited = copy(getCatalog(f.world));
  edited.cardTypes.crystal.name = 'Bergkristall';
  f.save(edited);
  assert.equal(f.world.catalog.revision, 2);
  assert.equal(f.world.catalog.cardTypes.crystal.name, 'Bergkristall');
  const deleted = copy(getCatalog(f.world));
  delete deleted.cardTypes.crystal;
  f.save(deleted);
  assert.equal(f.world.catalog.revision, 3);
  assert.equal(f.world.catalog.cardTypes.crystal, undefined);
});

test('catalog revisions reject stale or omitted updates atomically with status 409', () => {
  const f = fixture();
  const first = copy(getCatalog(f.world));
  first.cardTypes.wood.name = 'Bauholz';
  f.save(first);
  const before = JSON.stringify(f.world);
  for (const baseCatalogRevision of [0, undefined, -1, '1']) {
    assert.throws(() => applyCommand(f.world, { type: 'catalog-save', catalog: first, baseCatalogRevision }, { playerId: f.world.players[0].id, now: 0 }), (error) => error.status === 409);
    assert.equal(JSON.stringify(f.world), before);
  }
});

test('core cards retain identities, mechanical categories and unsellable humans/currency', () => {
  for (const id of PROTECTED_CARD_TYPES) {
    const removed = copy(DEFAULT_CATALOG);
    delete removed.cardTypes[id];
    assert.throws(() => validateCatalog(removed), /Grundkarte|Kategorie/);
    const changed = copy(DEFAULT_CATALOG);
    changed.cardTypes[id].category = changed.cardTypes[id].category === 'resource' ? 'tool' : 'resource';
    assert.throws(() => validateCatalog(changed), /Kategorie/);
  }
  const sold = copy(DEFAULT_CATALOG);
  sold.cardTypes.gold.sellPrice = 1;
  assert.throws(() => validateCatalog(sold), /unverkäuflich/);
  const noBasic = copy(DEFAULT_CATALOG);
  noBasic.packs = [];
  assert.throws(() => validateCatalog(noBasic), /Basicpaket/);
});

test('IDs, limits, colors, durations and effect shapes are validated before saving', () => {
  const mutations = [
    (catalog) => { catalog.cardTypes['Bad ID'] = customCard(); },
    (catalog) => { catalog.cardTypes.constructor = customCard(); },
    (catalog) => { catalog.cardTypes.wood.color = 'url(unsafe)'; },
    (catalog) => { catalog.cardTypes.wood.sellPrice = -1; },
    (catalog) => { catalog.cardTypes.tree.effects[0].duration = 0; },
    (catalog) => { catalog.cardTypes.tree.effects[0].outputs = [null]; },
    (catalog) => { catalog.cardTypes.tree.effects[0].uses = 1001; },
    (catalog) => { catalog.cardTypes.berry.effects[0].amount = Infinity; },
    (catalog) => { catalog.cardTypes.axe.effects[0].multiplier = 0; },
    (catalog) => { catalog.cardTypes.wood.effects = [{ kind: 'not-implemented' }]; },
    (catalog) => { catalog.cardTypes.berry.effects.push({ kind: 'heal', amount: 1 }); },
    (catalog) => { catalog.recipes[0].duration = 999; },
    (catalog) => { catalog.recipes[0].ingredients.wood = 1.2; },
    (catalog) => { catalog.packs[0].size = 31; },
    (catalog) => { catalog.packs[0].contents[0].weight = 0; },
    (catalog) => { catalog.packs[0].contents = [null]; },
    (catalog) => { catalog.packs[0].contents.push(catalog.packs[0].contents[0]); },
  ];
  for (const mutate of mutations) {
    const catalog = copy(DEFAULT_CATALOG);
    mutate(catalog);
    assert.throws(() => validateCatalog(catalog), (error) => error.status === 400);
  }
});

test('all recipe, package, source-output and tool references must name defined cards', () => {
  const mutations = [
    (catalog) => { catalog.recipes[0].ingredients.missing = 1; },
    (catalog) => { catalog.recipes[0].result = 'missing'; },
    (catalog) => { catalog.packs[0].contents[0].type = 'missing'; },
    (catalog) => { catalog.cardTypes.tree.effects[0].outputs[0].type = 'missing'; },
    (catalog) => { catalog.cardTypes.axe.effects[0].sourceTypes = ['missing']; },
    (catalog) => { delete catalog.cardTypes.bone; },
    (catalog) => { delete catalog.cardTypes.meat; },
  ];
  for (const mutate of mutations) {
    const catalog = copy(DEFAULT_CATALOG);
    mutate(catalog);
    assert.throws(() => validateCatalog(catalog), /nicht definiert|verwendet/);
  }
});

test('ambiguous exact ingredient combinations and duplicate IDs are rejected', () => {
  const catalog = copy(DEFAULT_CATALOG);
  catalog.recipes.push({ ...catalog.recipes[0], id: 'anotherPig', requiresHuman: false });
  assert.throws(() => validateCatalog(catalog), /dieselben Zutaten/);
  catalog.recipes.pop();
  catalog.recipes.push({ ...catalog.recipes[0], ingredients: { wood: 2 } });
  assert.throws(() => validateCatalog(catalog), /doppelt/);
  catalog.recipes.pop();
  catalog.packs.push(copy(catalog.packs[0]));
  assert.throws(() => validateCatalog(catalog), /doppelt/);
});

test('packages, sources and combinations cannot create unnamed extra humans', () => {
  const mutations = [
    (catalog) => { catalog.packs[0].contents[0].type = 'human'; },
    (catalog) => { catalog.cardTypes.tree.effects[0].outputs[0].type = 'human'; },
    (catalog) => { catalog.recipes[0].result = 'human'; },
    (catalog) => { catalog.recipes[0].ingredients.human = 1; },
  ];
  for (const mutate of mutations) {
    const catalog = copy(DEFAULT_CATALOG);
    mutate(catalog);
    assert.throws(() => validateCatalog(catalog), /Menschen|Mensch erforderlich/);
  }
});

test('a card type cannot disappear while instances or already purchased package contents need it', () => {
  const f = fixture();
  const catalog = copy(getCatalog(f.world));
  catalog.cardTypes.crystal = customCard();
  f.save(catalog);
  f.world.cards.push({ id: 'testCrystal', type: 'crystal', x: 700, y: 500, order: 0, stackId: 'testCrystal' });
  const removed = copy(getCatalog(f.world));
  delete removed.cardTypes.crystal;
  const before = JSON.stringify(f.world);
  assert.throws(() => f.save(removed), /noch Karten/);
  assert.equal(JSON.stringify(f.world), before);
  f.world.cards = f.world.cards.filter((card) => card.type !== 'crystal');
  f.world.cards.push({ id: 'testPack', type: 'pack', packContents: [{ type: 'crystal', weight: 1 }], packSize: 1, cardsLeft: 1, x: 700, y: 500, order: 0, stackId: 'testPack' });
  assert.throws(() => f.save(removed), /gekauften Pakets/);
});

test('partial payments protect package deletion and price changes while other edits remain possible', () => {
  const f = fixture();
  const catalog = copy(getCatalog(f.world));
  catalog.packs.push({ ...copy(catalog.packs[0]), id: 'forest', name: 'Waldpaket', price: 5 });
  f.save(catalog);
  f.world.shopPayments.forest = 2;
  const removed = copy(getCatalog(f.world));
  removed.packs = removed.packs.filter((pack) => pack.id !== 'forest');
  assert.throws(() => f.save(removed), /angezahltes Paket/);
  const changed = copy(getCatalog(f.world));
  const forest = changed.packs.find((pack) => pack.id === 'forest');
  forest.price = 6;
  assert.throws(() => f.save(changed), /Preis.*angezahlten Pakets/);
  forest.price = 5;
  forest.name = 'Waldschatz';
  f.save(changed);
  assert.equal(getPacks(f.world).find((pack) => pack.id === 'forest').name, 'Waldschatz');
});

test('unused custom definitions can be removed with all their references in one atomic save', () => {
  const f = fixture();
  const catalog = copy(getCatalog(f.world));
  catalog.cardTypes.crystal = customCard();
  catalog.cardTypes.vein = customCard({ name: 'Kristallader', category: 'source', effects: [{ kind: 'source', duration: 1000, uses: 2, outputs: [{ type: 'crystal', count: 1, weight: 1 }] }] });
  catalog.packs.push({ ...copy(catalog.packs[0]), id: 'crystals', contents: [{ type: 'vein', weight: 1 }] });
  catalog.recipes.push({ id: 'crystalRecipe', name: 'Kristall schleifen', ingredients: { crystal: 1 }, duration: 1000, result: 'flint', requiresHuman: true, timeBase: 'world' });
  f.save(catalog);
  const removed = copy(getCatalog(f.world));
  delete removed.cardTypes.crystal;
  assert.throws(() => f.save(removed), /Abbauprodukt/);
  delete removed.cardTypes.vein;
  removed.recipes = removed.recipes.filter((recipe) => recipe.id !== 'crystalRecipe');
  removed.packs = removed.packs.filter((pack) => pack.id !== 'crystals');
  f.save(removed);
  assert.equal(getCardDefinition(f.world, 'crystal'), undefined);
  assert.equal(getCardDefinition(f.world, 'vein'), undefined);
});

test('library illustrations persist by ID and unlisted illustrations are rejected atomically', () => {
  const f = fixture();
  const catalog = copy(getCatalog(f.world));
  const art = ART_LIBRARY[0].id;
  catalog.cardTypes.crystal = customCard({ art });
  f.save(catalog);
  assert.equal(getCardDefinition(JSON.parse(JSON.stringify(publicWorld(f.world))), 'crystal').art, art);
  const before = JSON.stringify(f.world);
  const invalid = copy(getCatalog(f.world));
  invalid.cardTypes.crystal.art = 'art-not-listed';
  assert.throws(() => f.save(invalid), (error) => error.status === 400 && /Unbekannte Illustration/.test(error.message));
  assert.equal(JSON.stringify(f.world), before);
});
