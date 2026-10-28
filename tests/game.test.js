import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TYPES, CONFIG, RECIPES, getCatalog } from '../shared/catalog.js';
import { createWorld, joinPlayer, applyCommand, advanceWorld, nextWakeAt, publicWorld } from '../shared/game.js';

function setup({ keepGold = false } = {}) {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Tom', 0);
  if (!keepGold) world.cards = world.cards.filter((card) => card.type === 'human');
  const get = (cardId) => world.cards.find((card) => card.id === cardId);
  const human = () => get(player.cardId);
  const add = (type, extra = {}) => {
    const cardId = `t${world.nextId++}`;
    const card = { id: cardId, type, stackId: cardId, order: 0, x: 800, y: 400, ...extra };
    if (['tree', 'rock', 'berryBush'].includes(type)) card.remaining ??= CONFIG.sourceUses;
    if (type === 'rat') card.hp ??= CONFIG.ratHp;
    if (type === 'piggyBank') card.gold ??= 0;
    world.cards.push(card);
    return card;
  };
  const command = (value, now = world.clock.lastAt, rng = () => 0) => applyCommand(world, value, { playerId: player.id, now, rng });
  const move = (card, extra = {}) => command({ type: 'move', cardId: card.id, x: card.x, y: card.y, ...extra });
  return { world, player, add, get, human, command, move };
}

function prepareJob(fixture, ingredients) {
  const cards = Object.entries(ingredients).flatMap(([type, count]) => Array.from({ length: count }, () => fixture.add(type)));
  const stackId = cards[0].id;
  cards.forEach((card, order) => Object.assign(card, { stackId, order }));
  fixture.move(fixture.human(), { targetId: cards[0].id });
  return cards.map((card) => card.id);
}

test('a world starts with exactly nine visible gold cards and no implicit materials', () => {
  const world = createWorld(123);
  assert.equal(world.cards.length, 9);
  assert.ok(world.cards.every((card) => card.type === 'gold'));
  assert.equal(new Set(world.cards.map((card) => card.stackId)).size, 1);
  assert.deepEqual(world.clock, { elapsed: 0, lastAt: 123 });
});

test('joining is normalized and idempotent, including after death', () => {
  const f = setup({ keepGold: true });
  assert.equal(joinPlayer(f.world, '  tOm ', 999).id, f.player.id);
  assert.equal(f.world.cards.filter((card) => card.type === 'human').length, 1);
  const other = joinPlayer(f.world, 'Mia', 1000);
  assert.notEqual(other.id, f.player.id);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 9);
  f.human().type = 'corpse';
  f.human().hp = 0;
  joinPlayer(f.world, 'Tom', 9999);
  assert.equal(f.world.cards.filter((card) => card.ownerId === f.player.id).length, 1);
  assert.equal(f.human().type, 'corpse');
  for (const name of ['', '   ', 'a'.repeat(25), 'Tom\u0000']) assert.throws(() => joinPlayer(f.world, name));
});

test('only joined players can send authoritative commands; rejected commands are atomic', () => {
  const f = setup();
  const before = JSON.stringify(f.world);
  assert.throws(() => applyCommand(f.world, { type: 'move', cardId: f.player.cardId, x: 50, y: 50 }, { playerId: 'unknown' }));
  assert.throws(() => f.move(f.human(), { zone: 'shop' }), /kostet/);
  assert.throws(() => f.move(f.human(), { x: Infinity }), /position/i);
  assert.equal(JSON.stringify(f.world), before);
});

test('gold funds exactly three packs; an already opened package cannot be opened twice', () => {
  const f = setup({ keepGold: true });
  for (let index = 0; index < 3; index++) {
    f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
  }
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'pack').length, 3);
  const packs = f.world.cards.filter((card) => card.type === 'pack').map((card) => card.id);
  for (const cardId of packs) f.command({ type: 'move', cardId, x: 600, y: 400, zone: 'open' });
  assert.equal(f.world.cards.filter((card) => card.type === 'tree').length, 9);
  assert.throws(() => f.command({ type: 'move', cardId: packs[0], x: 600, y: 400, zone: 'open' }), /nicht mehr/);
  assert.equal(f.world.cards.filter((card) => card.type === 'tree').length, 9);
});

test('single gold cards jointly pay for a shared package and preserve progress through a reload', () => {
  const f = setup({ keepGold: true });
  const other = joinPlayer(f.world, 'Mia', 0);
  let coin = f.world.cards.find((card) => card.type === 'gold');
  const first = f.move(coin, { split: true, zone: 'shop' });
  assert.equal(f.world.shopPaid, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'pack').length, 0);
  assert.match(first.message, /Noch 2 Gold/);

  const loaded = JSON.parse(JSON.stringify(publicWorld(f.world)));
  coin = loaded.cards.find((card) => card.type === 'gold');
  const second = applyCommand(loaded, { type: 'move', cardId: coin.id, x: 700, y: 500, split: true, zone: 'shop' }, { playerId: other.id, now: 0 });
  assert.equal(loaded.shopPaid, 2);
  assert.match(second.message, /Noch 1 Gold/);
  coin = loaded.cards.find((card) => card.type === 'gold');
  const third = applyCommand(loaded, { type: 'move', cardId: coin.id, x: 700, y: 500, split: true, zone: 'shop' }, { playerId: f.player.id, now: 0 });
  assert.equal(loaded.shopPaid, 0);
  assert.equal(loaded.cards.filter((card) => card.type === 'pack').length, 1);
  assert.equal(loaded.cards.filter((card) => card.type === 'gold').length, 6);
  assert.match(third.message, /neues Basicpaket/);
});

test('partial shop payments consume only the remainder and support worlds without shopPaid', () => {
  const f = setup({ keepGold: true });
  delete f.world.shopPaid;
  assert.equal(publicWorld(f.world).shopPaid, 0);
  f.move(f.world.cards.find((card) => card.type === 'gold'), { split: true, zone: 'shop' });
  assert.equal(f.world.shopPaid, 1);
  f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
  assert.equal(f.world.shopPaid, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'pack').length, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 6);
});

test('buying from a sidebar drop keeps surplus gold in place and creates the pack near its original stack', () => {
  const f = setup({ keepGold: true });
  const coin = f.world.cards.find((card) => card.type === 'gold');
  const original = { x: coin.x, y: coin.y };
  f.move(coin, { x: 1650, y: 1000, zone: 'shop' });
  const remaining = f.world.cards.filter((card) => card.type === 'gold');
  assert.equal(remaining.length, 6);
  assert.ok(remaining.every((card) => card.x === original.x && card.y === original.y));
  const pack = f.world.cards.find((card) => card.type === 'pack');
  assert.equal(pack.x, original.x + 155);
  assert.equal(pack.y, original.y);
});

test('opening and selling from footer drop zones produce cards near their original cards', () => {
  const opened = setup();
  const pack = opened.add('pack', { x: 700, y: 400 });
  opened.move(pack, { x: 1650, y: 1000, zone: 'open' });
  const contents = opened.world.cards.filter((card) => card.type === 'tree');
  assert.equal(contents.length, 3);
  assert.deepEqual(contents.map((card) => ({ x: card.x, y: card.y })), [
    { x: 700, y: 400 }, { x: 855, y: 400 }, { x: 1010, y: 400 },
  ]);

  const sold = setup();
  const wood = sold.add('wood', { x: 700, y: 400 });
  sold.move(wood, { x: 1650, y: 1000, zone: 'sell' });
  const gold = sold.world.cards.find((card) => card.type === 'gold');
  assert.equal(gold.x, 850);
  assert.equal(gold.y, 400);
});

test('pack draws cover configured common and rare boundaries', () => {
  const f = setup();
  const pack = f.add('pack');
  const rolls = [0.3299, 0.33, 0.66];
  f.command({ type: 'move', cardId: pack.id, x: 500, y: 400, zone: 'open' }, 0, () => rolls.shift());
  assert.deepEqual(f.world.cards.filter((card) => card.type !== 'human').map((card) => card.type), ['tree', 'rock', 'berryBush']);
  const rare = f.add('pack');
  const rareRolls = [0.98, 0.99, 0.99999];
  f.command({ type: 'move', cardId: rare.id, x: 1000, y: 700, zone: 'open' }, 0, () => rareRolls.shift());
  assert.equal(f.world.cards.filter((card) => card.type === 'rat').length, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'soil').length, 2);
});

test('each package click releases exactly one card and the third click removes the package', () => {
  const f = setup({ keepGold: true });
  f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
  const pack = f.world.cards.find((card) => card.type === 'pack');
  assert.equal(pack.cardsLeft, 3);
  const rolls = [0, 0.5, 0.9];
  for (let click = 0; click < 3; click++) {
    const result = f.command({ type: 'open-pack', cardId: pack.id }, 0, () => rolls.shift());
    assert.equal(f.world.cards.filter((card) => ['tree', 'rock', 'berryBush'].includes(card.type)).length, click + 1);
    if (click < 2) assert.equal(f.get(pack.id).cardsLeft, 2 - click);
    assert.match(result.message, /entdeckt/);
  }
  assert.equal(f.get(pack.id), undefined);
  assert.deepEqual(f.world.cards.filter((card) => ['tree', 'rock', 'berryBush'].includes(card.type)).map((card) => card.type), ['tree', 'rock', 'berryBush']);
  assert.throws(() => f.command({ type: 'open-pack', cardId: pack.id }), /nicht mehr/);
});

test('old packages default to three cards, and their partial contents survive public-state reloads', () => {
  const f = setup();
  const pack = f.add('pack');
  assert.equal(pack.cardsLeft, undefined);
  assert.equal(publicWorld(f.world).cards.find((card) => card.id === pack.id).cardsLeft, 3);
  f.command({ type: 'open-pack', cardId: pack.id });
  assert.equal(f.get(pack.id).cardsLeft, 2);
  const loaded = JSON.parse(JSON.stringify(publicWorld(f.world)));
  applyCommand(loaded, { type: 'open-pack', cardId: pack.id }, { playerId: f.player.id, now: 0, rng: () => 0 });
  assert.equal(loaded.cards.find((card) => card.id === pack.id).cardsLeft, 1);
  assert.equal(loaded.cards.filter((card) => card.type === 'tree').length, 2);
});

test('legacy opening of a partly clicked package only releases the remaining contents', () => {
  const f = setup();
  const pack = f.add('pack');
  f.command({ type: 'open-pack', cardId: pack.id });
  f.move(f.get(pack.id), { zone: 'open' });
  assert.equal(f.get(pack.id), undefined);
  assert.equal(f.world.cards.filter((card) => card.type === 'tree').length, 3);
});

test('invalid package clicks are atomic and never draw random loot', () => {
  const f = setup();
  const empty = f.add('pack', { cardsLeft: 0 });
  const before = JSON.stringify(f.world);
  let draws = 0;
  const rng = () => { draws++; return 0; };
  assert.throws(() => f.command({ type: 'open-pack', cardId: f.player.cardId }, 0, rng), /kein Paket/);
  assert.throws(() => f.command({ type: 'open-pack', cardId: empty.id }, 0, rng), /leer/);
  assert.throws(() => f.command({ type: 'open-pack', cardId: 'missing' }, 0, rng), /nicht mehr/);
  assert.equal(draws, 0);
  assert.equal(JSON.stringify(f.world), before);
});

test('automatic card placement keeps both requested positions and free-space searches below the toolbar', () => {
  const direct = setup();
  const highPack = direct.add('pack', { x: 800, y: 24 });
  direct.command({ type: 'open-pack', cardId: highPack.id });
  assert.equal(direct.world.cards.find((card) => card.type === 'tree').y, 112);

  const crowded = setup();
  const pack = crowded.add('pack', { x: 800, y: 160 });
  crowded.add('wood', { x: 955, y: 160 });
  crowded.command({ type: 'open-pack', cardId: pack.id });
  const output = crowded.world.cards.find((card) => card.type === 'tree');
  assert.ok(output.y >= 112, `automatic output appeared at y=${output.y}`);
  assert.ok(output.x !== 955 || output.y !== 160);
});

test('a whole stack moves and split removes exactly the selected card including its root', () => {
  const f = setup();
  const a = f.add('wood');
  const b = f.add('stone', { stackId: a.stackId, order: 1 });
  const c = f.add('berry', { stackId: a.stackId, order: 2 });
  f.move(b, { x: 300, y: 350 });
  assert.ok([a, b, c].map((card) => f.get(card.id)).every((card) => card.x === 300 && card.y === 350));
  f.move(f.get(b.id), { split: true, x: 500, y: 550 });
  assert.notEqual(f.get(b.id).stackId, f.get(a.id).stackId);
  assert.equal(f.get(a.id).stackId, f.get(c.id).stackId);
  assert.deepEqual([f.get(a.id).order, f.get(c.id).order], [0, 1]);
  f.move(f.get(a.id), { split: true, x: 100, y: 100 });
  assert.notEqual(f.get(a.id).stackId, f.get(c.id).stackId);
  assert.equal(f.get(c.id).x, 300);
});

test('takeAbove moves the selected middle card and every higher card, leaving lower cards behind', () => {
  const f = setup();
  const bottom = f.add('wood');
  const middle = f.add('stone', { stackId: bottom.stackId, order: 1 });
  const top = f.add('berry', { stackId: bottom.stackId, order: 2 });
  f.move(middle, { split: true, takeAbove: true, x: 300, y: 600 });
  assert.equal(f.get(bottom.id).x, 800);
  assert.equal(f.get(bottom.id).y, 400);
  assert.equal(f.get(bottom.id).order, 0);
  assert.notEqual(f.get(middle.id).stackId, f.get(bottom.id).stackId);
  assert.equal(f.get(middle.id).stackId, f.get(top.id).stackId);
  assert.deepEqual([middle.id, top.id].map((cardId) => ({ x: f.get(cardId).x, y: f.get(cardId).y, order: f.get(cardId).order })), [
    { x: 300, y: 600, order: 0 }, { x: 300, y: 600, order: 1 },
  ]);
});

test('takeAbove from the bottom moves all cards; taking the top moves only that card', () => {
  const f = setup();
  const bottom = f.add('wood');
  const middle = f.add('stone', { stackId: bottom.stackId, order: 1 });
  const top = f.add('berry', { stackId: bottom.stackId, order: 2 });
  f.move(bottom, { takeAbove: true, x: 300, y: 600 });
  assert.ok([bottom, middle, top].every((card) => f.get(card.id).x === 300 && f.get(card.id).y === 600));
  assert.equal(new Set([bottom, middle, top].map((card) => f.get(card.id).stackId)).size, 1);
  f.move(f.get(top.id), { takeAbove: true, x: 700, y: 800 });
  assert.equal(f.get(bottom.id).stackId, f.get(middle.id).stackId);
  assert.notEqual(f.get(top.id).stackId, f.get(middle.id).stackId);
  assert.equal(f.get(top.id).order, 0);
  assert.equal(f.get(bottom.id).x, 300);
  assert.equal(f.get(top.id).x, 700);
});

test('takeAbove carries selected humans with their tools and appends the tail in order to another stack', () => {
  const f = setup();
  const axe = f.add('axe');
  f.move(axe, { targetId: f.player.cardId });
  const bottom = f.add('wood');
  f.move(f.human(), { targetId: bottom.id });
  const top = f.add('berry');
  f.move(top, { targetId: bottom.id });
  const destination = f.add('stone', { x: 300, y: 700 });
  f.move(f.human(), { split: true, takeAbove: true, targetId: destination.id });
  assert.notEqual(f.get(bottom.id).stackId, f.human().stackId);
  assert.equal(f.human().stackId, f.get(destination.id).stackId);
  assert.equal(f.get(top.id).stackId, f.human().stackId);
  assert.equal(f.get(axe.id).stackId, f.human().stackId);
  assert.equal(f.get(axe.id).equippedTo, f.player.cardId);
  assert.deepEqual([destination.id, f.player.cardId, top.id].map((cardId) => f.get(cardId).order), [0, 1, 2]);
  f.move(f.get(axe.id), { split: true, takeAbove: true, x: 1100, y: 800 });
  assert.equal(f.human().toolId, undefined);
  assert.equal(f.get(axe.id).equippedTo, undefined);
  assert.equal(f.human().stackId, f.get(top.id).stackId);
  assert.notEqual(f.get(axe.id).stackId, f.human().stackId);
});

test('takeAbove keeps complete work stacks running, but cancels when required cards remain below', () => {
  const f = setup();
  const tree = f.add('tree');
  f.move(f.human(), { targetId: tree.id });
  advanceWorld(f.world, 5000);
  const jobId = f.world.jobs[0].id;
  f.move(f.get(tree.id), { split: true, takeAbove: true, x: 400, y: 700 });
  assert.equal(f.world.jobs[0].id, jobId);
  assert.equal(f.world.jobs[0].dueAt, 10_000);
  f.move(f.human(), { split: true, takeAbove: true, x: 1000, y: 800 });
  assert.equal(f.world.jobs.length, 0);
  assert.equal(f.get(tree.id).x, 400);
  assert.equal(f.human().x, 1000);
});

test('another joined player may move an existing human; coordinates are clamped to the board', () => {
  const f = setup();
  const other = joinPlayer(f.world, 'Mia', 0);
  applyCommand(f.world, { type: 'move', cardId: f.player.cardId, x: -9999, y: 99999 }, { playerId: other.id, now: 0 });
  assert.equal(f.human().x, 24);
  assert.equal(f.human().y, CONFIG.worldHeight - CONFIG.cardHeight - 24);
});

for (const [sourceType, expectedType, roll] of [['tree', 'wood', 0], ['tree', 'stick', 0.8], ['rock', 'stone', 0], ['rock', 'flint', 0.9], ['berryBush', 'berry', 0]]) {
  test(`${sourceType} yields five ${expectedType} cards then disappears, without frame ticks`, () => {
    const f = setup();
    const source = f.add(sourceType);
    f.move(f.human(), { targetId: source.id });
    assert.equal(f.world.jobs.length, 1);
    assert.equal(nextWakeAt(f.world, 0), 10_000);
    advanceWorld(f.world, 49_999, { activeUntil: 49_999, rng: () => roll });
    assert.equal(f.world.cards.filter((card) => card.type === expectedType).length, 4);
    assert.equal(f.get(source.id).remaining, 1);
    advanceWorld(f.world, 50_000, { activeUntil: 50_000, rng: () => roll });
    assert.equal(f.world.cards.filter((card) => card.type === expectedType).length, 5);
    assert.equal(f.get(source.id), undefined);
    assert.equal(f.world.jobs.length, 0);
    assert.equal(f.human().hp, 75);
    assert.equal(nextWakeAt(f.world, 50_000), null);
  });
}

test('a mixed source stack is exhausted sequentially by stack order with only one source job', () => {
  const f = setup();
  const rock = f.add('rock', { order: 1 });
  const tree = f.add('tree', { stackId: rock.stackId, order: 0 });
  const bush = f.add('berryBush', { stackId: rock.stackId, order: 2 });
  f.move(f.human(), { targetId: tree.id });
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].sourceId, tree.id);
  assert.deepEqual(f.world.jobs[0].cardIds.sort(), [f.player.cardId, tree.id].sort());

  advanceWorld(f.world, 49_999, { rng: () => 0 });
  assert.equal(f.get(tree.id).remaining, 1);
  assert.equal(f.get(rock.id).remaining, 5);
  assert.equal(f.get(bush.id).remaining, 5);
  assert.equal(f.world.cards.filter((card) => card.type === 'wood').length, 4);
  advanceWorld(f.world, 50_000, { rng: () => 0 });
  assert.equal(f.get(tree.id), undefined);
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].sourceId, rock.id);
  assert.equal(f.world.jobs[0].dueAt, 60_000);
  advanceWorld(f.world, 100_000, { rng: () => 0 });
  assert.equal(f.get(rock.id), undefined);
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].sourceId, bush.id);
  advanceWorld(f.world, 150_000, { rng: () => 0 });
  assert.equal(f.get(bush.id), undefined);
  assert.equal(f.world.jobs.length, 0);
  for (const type of ['wood', 'stone', 'berry']) assert.equal(f.world.cards.filter((card) => card.type === type).length, 5);
});

test('a human below several sources also works through the whole queue', () => {
  const f = setup();
  const tree = f.add('tree', { remaining: 1 });
  const rock = f.add('rock', { remaining: 1 });
  const bush = f.add('berryBush', { remaining: 1 });
  for (const source of [tree, rock, bush]) f.move(source, { targetId: f.player.cardId });
  assert.equal(f.human().order, 0);
  assert.equal(f.world.jobs[0].sourceId, tree.id);
  advanceWorld(f.world, 30_000, { rng: () => 0 });
  assert.ok([tree, rock, bush].every((source) => !f.get(source.id)));
  assert.equal(f.world.jobs.length, 0);
  for (const type of ['wood', 'stone', 'berry']) assert.equal(f.world.cards.filter((card) => card.type === type).length, 1);
});

test('adding a lower source keeps the current source and its progress until exhaustion', () => {
  const f = setup();
  const rock = f.add('rock');
  f.move(f.human(), { targetId: rock.id });
  advanceWorld(f.world, 5000);
  const originalJob = { ...f.world.jobs[0] };
  const tree = f.add('tree');
  f.move(f.get(rock.id), { takeAbove: true, targetId: tree.id });
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].id, originalJob.id);
  assert.equal(f.world.jobs[0].sourceId, rock.id);
  assert.equal(f.world.jobs[0].dueAt, originalJob.dueAt);
  assert.deepEqual(f.world.jobs[0].cardIds, originalJob.cardIds);
  assert.ok(f.get(tree.id).order < f.get(rock.id).order);
  advanceWorld(f.world, 10_000, { rng: () => 0 });
  assert.equal(f.get(rock.id).remaining, 4);
  assert.equal(f.get(tree.id).remaining, 5);
  assert.equal(f.world.jobs[0].sourceId, rock.id);
  advanceWorld(f.world, 50_000, { rng: () => 0 });
  assert.equal(f.get(rock.id), undefined);
  assert.equal(f.world.jobs[0].sourceId, tree.id);
  assert.equal(f.world.jobs[0].dueAt, 60_000);
});

test('removing a queued source preserves current work; moving its worker away cancels it', () => {
  const f = setup();
  const tree = f.add('tree');
  f.move(f.human(), { targetId: tree.id });
  const rock = f.add('rock');
  f.move(rock, { targetId: tree.id });
  advanceWorld(f.world, 5000);
  const originalJob = { ...f.world.jobs[0] };
  f.move(f.get(rock.id), { split: true, x: 400, y: 800 });
  assert.equal(f.world.jobs[0].id, originalJob.id);
  assert.equal(f.world.jobs[0].dueAt, originalJob.dueAt);
  f.move(f.get(tree.id), { takeAbove: true, x: 300, y: 700 });
  assert.equal(f.world.jobs[0].id, originalJob.id);
  f.move(f.human(), { takeAbove: true, x: 1200, y: 800 });
  assert.equal(f.world.jobs.length, 0);
  assert.equal(f.get(tree.id).remaining, 5);
});

test('unrelated materials prevent a multi-source queue without consuming its sources', () => {
  const f = setup();
  const tree = f.add('tree');
  const rock = f.add('rock', { stackId: tree.stackId, order: 1 });
  const wood = f.add('wood', { stackId: tree.stackId, order: 2 });
  f.move(f.human(), { targetId: tree.id });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 50_000, { rng: () => 0 });
  assert.equal(f.get(tree.id).remaining, 5);
  assert.equal(f.get(rock.id).remaining, 5);
  assert.ok(f.get(wood.id));
  f.move(f.get(wood.id), { split: true, x: 1200, y: 800 });
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].sourceId, tree.id);
  assert.equal(f.world.jobs[0].dueAt, 60_000);
});

for (const [tool, firstDuration, secondDuration] of [['axe', 5000, 10_000], ['pickaxe', 10_000, 5000]]) {
  test(`${tool} uses the matching speed separately for each source in the queue`, () => {
    const f = setup();
    const equipped = f.add(tool);
    f.move(equipped, { targetId: f.player.cardId });
    const tree = f.add('tree', { remaining: 1 });
    const rock = f.add('rock', { stackId: tree.stackId, order: 1, remaining: 1 });
    const bush = f.add('berryBush', { stackId: tree.stackId, order: 2, remaining: 1 });
    f.move(f.human(), { targetId: tree.id });
    assert.equal(f.world.jobs[0].duration, firstDuration);
    advanceWorld(f.world, firstDuration, { rng: () => 0 });
    assert.equal(f.get(tree.id), undefined);
    assert.equal(f.world.jobs[0].sourceId, rock.id);
    assert.equal(f.world.jobs[0].duration, secondDuration);
    assert.equal(f.world.jobs[0].dueAt, firstDuration + secondDuration);
    advanceWorld(f.world, firstDuration + secondDuration, { rng: () => 0 });
    assert.equal(f.get(rock.id), undefined);
    assert.equal(f.world.jobs[0].sourceId, bush.id);
    assert.equal(f.world.jobs[0].duration, 10_000);
    assert.equal(f.get(equipped.id).equippedTo, f.player.cardId);
  });
}

test('combat interrupts a source queue and publishes hit state at event boundaries', () => {
  const f = setup();
  const tree = f.add('tree');
  const rock = f.add('rock', { stackId: tree.stackId, order: 1 });
  const bush = f.add('berryBush', { stackId: tree.stackId, order: 2 });
  f.move(f.human(), { targetId: tree.id });
  const rat = f.add('rat', { x: f.human().x + 80, y: f.human().y });
  advanceWorld(f.world, 0);
  assert.equal(f.world.jobs.length, 0);
  assert.equal(f.world.combats.length, 1);
  assert.equal(f.world.combats[0].humanId, f.player.cardId);
  assert.equal(f.world.combats[0].ratId, rat.id);
  assert.equal(nextWakeAt(f.world, 0), 2000);
  assert.equal(advanceWorld(f.world, 1999), false);
  assert.equal(f.human().hp, 75);
  assert.equal(advanceWorld(f.world, 2000), true);
  assert.equal(f.human().hp, 74);
  assert.equal(f.get(rat.id).hp, 1);
  assert.equal(f.world.combats[0].hits, 1);
  assert.equal(f.world.combats[0].lastAttackAt, 2000);
  advanceWorld(f.world, 4000, { rng: () => 0 });
  assert.equal(f.get(rat.id), undefined);
  assert.equal(f.human().hp, 73);
  assert.equal(f.world.combats.length, 0);
  assert.equal(f.world.jobs.length, 1);
  assert.equal(f.world.jobs[0].sourceId, tree.id);
  assert.equal(f.world.jobs[0].dueAt, 14_000);
  assert.ok([tree, rock, bush].every((source) => f.get(source.id).remaining === 5));
});

test('moving an entire work stack retains progress; removing a worker cancels with no reward', () => {
  const f = setup();
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  const jobId = f.world.jobs[0].id;
  advanceWorld(f.world, 5000);
  f.move(f.human(), { x: 500, y: 500 });
  assert.equal(f.world.jobs[0].id, jobId);
  assert.equal(f.world.jobs[0].dueAt, 10_000);
  f.move(f.human(), { split: true, x: 1100, y: 700 });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 50_000);
  assert.equal(f.world.cards.filter((card) => card.type === 'wood').length, 0);
  assert.equal(f.get(source.id).remaining, 5);
});

test('new source output stays beside the worker after older output is moved to another stack', () => {
  const f = setup();
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  advanceWorld(f.world, 10_000, { rng: () => 0 });
  const firstWood = f.world.cards.find((card) => card.type === 'wood');
  const stone = f.add('stone', { x: 300, y: 800 });
  f.move(firstWood, { targetId: stone.id });
  advanceWorld(f.world, 20_000, { rng: () => 0 });
  const woods = f.world.cards.filter((card) => card.type === 'wood');
  assert.equal(woods.length, 2);
  assert.equal(f.get(firstWood.id).stackId, f.get(stone.id).stackId);
  assert.notEqual(woods.find((card) => card.id !== firstWood.id).stackId, f.get(stone.id).stackId);
  assert.equal(f.world.jobs.length, 1);
});

test('mixed source outputs occupy different positions and matching outputs form real movable stacks', () => {
  const f = setup();
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  const rolls = [0, 0.9, 0];
  advanceWorld(f.world, 30_000, { rng: () => rolls.shift() });
  const woods = f.world.cards.filter((card) => card.type === 'wood');
  const stick = f.world.cards.find((card) => card.type === 'stick');
  assert.equal(woods.length, 2);
  assert.equal(woods[0].stackId, woods[1].stackId);
  assert.deepEqual(woods.map((card) => card.order), [0, 1]);
  assert.ok(woods[0].x !== stick.x || woods[0].y !== stick.y);
  f.move(woods[1], { x: 400, y: 700 });
  assert.ok(woods.every((card) => f.get(card.id).x === 400 && f.get(card.id).y === 700));
  assert.ok(f.get(stick.id).x !== 400 || f.get(stick.id).y !== 700);
});

for (const recipe of RECIPES.filter((recipe) => recipe.requiresHuman)) {
  test(`${recipe.name}: exact ingredients complete once and human remains`, () => {
    const f = setup();
    const ingredients = prepareJob(f, recipe.ingredients);
    assert.equal(f.world.jobs.length, 1);
    assert.equal(f.world.jobs[0].recipeId, recipe.id);
    advanceWorld(f.world, recipe.duration - 1);
    assert.equal(f.world.cards.filter((card) => card.type === recipe.result).length, 0);
    advanceWorld(f.world, recipe.duration);
    assert.equal(f.world.cards.filter((card) => card.type === recipe.result).length, 1);
    assert.ok(ingredients.every((cardId) => !f.get(cardId)));
    assert.equal(f.human().type, 'human');
    advanceWorld(f.world, recipe.duration * 10);
    assert.equal(f.world.cards.filter((card) => card.type === recipe.result).length, 1);
  });

  test(`${recipe.name}: interrupted recipe preserves all ingredients`, () => {
    const f = setup();
    const ingredients = prepareJob(f, recipe.ingredients);
    advanceWorld(f.world, recipe.duration / 2);
    f.move(f.get(ingredients[0]), { split: true, x: 50, y: 50 });
    assert.equal(f.world.jobs.length, 0);
    advanceWorld(f.world, recipe.duration * 2);
    assert.ok(ingredients.every((cardId) => f.get(cardId)));
    assert.equal(f.world.cards.filter((card) => card.type === recipe.result).length, 0);
  });
}

test('surplus or unrelated materials prevent crafting without consuming anything', () => {
  const f = setup();
  const ingredients = prepareJob(f, { wood: 5, stone: 1, berry: 1 });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 100_000);
  assert.ok(ingredients.every((cardId) => f.get(cardId)));
});

test('piggy bank deposits and withdrawals conserve total gold, and full banks cannot be sold', () => {
  const f = setup({ keepGold: true });
  const pig = f.add('piggyBank');
  f.move(f.world.cards.find((card) => card.type === 'gold'), { targetId: pig.id });
  assert.equal(f.get(pig.id).gold, 9);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 0);
  assert.throws(() => f.move(f.get(pig.id), { zone: 'sell' }), /geleert/);
  for (let index = 0; index < 10; index++) f.command({ type: 'withdraw', cardId: pig.id });
  assert.equal(f.get(pig.id).gold, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 9);
  f.move(f.get(pig.id), { x: 100, y: 100 });
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 9);
});

test('piggy bank withdrawals form a genuine whole stack and moved coins stay independent', () => {
  const f = setup();
  const pig = f.add('piggyBank', { gold: 4 });
  f.command({ type: 'withdraw', cardId: pig.id });
  f.command({ type: 'withdraw', cardId: pig.id });
  let coins = f.world.cards.filter((card) => card.type === 'gold');
  assert.equal(coins[0].stackId, coins[1].stackId);
  assert.deepEqual(coins.map((card) => card.order), [0, 1]);
  const movedIds = coins.map((card) => card.id);
  f.move(coins[1], { x: 300, y: 800 });
  assert.ok(movedIds.every((cardId) => f.get(cardId).x === 300 && f.get(cardId).y === 800));
  f.command({ type: 'withdraw', cardId: pig.id });
  coins = f.world.cards.filter((card) => card.type === 'gold');
  const fresh = coins.find((card) => !movedIds.includes(card.id));
  assert.notEqual(fresh.stackId, f.get(movedIds[0]).stackId);
  assert.ok(fresh.x !== 300 || fresh.y !== 800);
});

test('repeated package purchases never create unrelated cards at the same coordinates', () => {
  const f = setup({ keepGold: true });
  for (let index = 0; index < 3; index++) {
    f.move(f.world.cards.find((card) => card.type === 'gold'), { x: 700, y: 500, zone: 'shop' });
  }
  const packs = f.world.cards.filter((card) => card.type === 'pack');
  assert.equal(new Set(packs.map((card) => `${card.x}:${card.y}`)).size, 3);
});

test('selling a resource stack creates precisely the centrally configured gold value', () => {
  const f = setup();
  const a = f.add('wood');
  const b = f.add('axe', { stackId: a.id, order: 1 });
  f.move(a, { zone: 'sell' });
  assert.equal(f.get(a.id), undefined);
  assert.equal(f.get(b.id), undefined);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, CARD_TYPES.wood.sellPrice + CARD_TYPES.axe.sellPrice);
  assert.throws(() => f.move(f.human(), { zone: 'sell' }));
});

for (const [toolType, sourceType, duration] of [['axe', 'tree', 5000], ['pickaxe', 'rock', 5000], ['axe', 'rock', 10_000], ['pickaxe', 'tree', 10_000]]) {
  test(`${toolType} on ${sourceType} uses ${duration}ms and remains equipped`, () => {
    const f = setup();
    const tool = f.add(toolType);
    const source = f.add(sourceType);
    f.move(tool, { targetId: f.player.cardId });
    assert.equal(f.human().toolId, tool.id);
    assert.equal(f.get(tool.id).equippedTo, f.player.cardId);
    f.move(f.human(), { targetId: source.id });
    assert.equal(f.world.jobs[0].duration, duration);
    advanceWorld(f.world, duration);
    assert.equal(f.get(source.id).remaining, 4);
    assert.equal(f.human().toolId, tool.id);
    assert.equal(f.get(tool.id).equippedTo, f.player.cardId);
  });
}

test('tools can be dragged off or unequipped, but only one tool fits each human', () => {
  const f = setup();
  const axe = f.add('axe');
  const pick = f.add('pickaxe');
  f.move(axe, { targetId: f.player.cardId });
  assert.throws(() => f.move(pick, { targetId: f.player.cardId }), /bereits/);
  f.move(f.get(axe.id), { x: 900, y: 500 });
  assert.equal(f.human().toolId, undefined);
  assert.equal(f.get(axe.id).equippedTo, undefined);
  assert.notEqual(f.get(axe.id).stackId, f.human().stackId);
  f.move(f.get(pick.id), { targetId: f.player.cardId });
  f.command({ type: 'unequip', cardId: f.player.cardId });
  assert.equal(f.human().toolId, undefined);
  assert.equal(f.get(pick.id).equippedTo, undefined);
});

test('rat follows nearest living human using one trajectory and two simultaneous combat rounds', () => {
  const f = setup();
  const rat = f.add('rat', { x: f.human().x + 450, y: f.human().y });
  advanceWorld(f.world, 0);
  assert.equal(f.get(rat.id).motion.targetId, f.player.cardId);
  assert.equal(f.get(rat.id).motion.duration, 10_000);
  assert.equal(nextWakeAt(f.world, 0), 10_000);
  advanceWorld(f.world, 10_000);
  assert.equal(f.world.combats.length, 1);
  assert.equal(f.world.combats[0].nextAttackAt, 12_000);
  advanceWorld(f.world, 12_000, { rng: () => 0 });
  assert.equal(f.get(rat.id).hp, 1);
  assert.equal(f.human().hp, 74);
  advanceWorld(f.world, 14_000, { rng: () => 0 });
  assert.equal(f.get(rat.id), undefined);
  assert.equal(f.human().hp, 73);
  assert.equal(f.world.combats.length, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 1);
  advanceWorld(f.world, 100_000, { rng: () => 0 });
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 1);
});

test('rat cannot be moved; dragging a human directly to a rat starts combat and cancels work', () => {
  const f = setup();
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  const rat = f.add('rat', { x: 1200, y: 800 });
  assert.throws(() => f.move(rat, { x: 500 }), /von selbst/);
  f.move(f.human(), { split: true, targetId: rat.id });
  assert.equal(f.world.combats.length, 1);
  assert.equal(f.world.jobs.length, 0);
});

test('rat trajectory changes immediately when its target moves; combat allows escape by splitting', () => {
  const f = setup();
  const rat = f.add('rat', { x: f.human().x + 450, y: f.human().y });
  advanceWorld(f.world, 5000);
  // First advance establishes the trajectory at current game time.
  const firstStarted = f.get(rat.id).motion.startedAt;
  advanceWorld(f.world, 10_000);
  f.move(f.human(), { x: 100, y: 700 });
  assert.ok(f.get(rat.id).motion.startedAt > firstStarted);
  assert.equal(f.get(rat.id).motion.targetX, 100);
  assert.equal(f.get(rat.id).motion.targetY, 700);
  f.move(f.human(), { targetId: rat.id });
  assert.equal(f.world.combats.length, 1);
  f.move(f.human(), { split: true, x: 1600, y: 1000 });
  assert.equal(f.world.combats.length, 0);
  assert.ok(f.get(rat.id).motion);
});

test('dropping a human onto a moving rat resolves its interpolated current position', () => {
  const f = setup();
  const rat = f.add('rat', { x: f.human().x + 450, y: f.human().y });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 5000);
  const visibleX = f.get(rat.id).motion.fromX - 175;
  f.move(f.human(), { targetId: rat.id });
  assert.equal(f.world.combats.length, 1);
  assert.equal(f.human().x, visibleX);
  assert.equal(f.get(rat.id).x, visibleX);
  assert.equal(f.get(rat.id).motion, undefined);
});

test('berry healing is capped, consumes once, and does not revive a named corpse', () => {
  const f = setup();
  f.human().hp = 74;
  const berry = f.add('berry');
  f.move(berry, { targetId: f.player.cardId });
  assert.equal(f.human().hp, 75);
  assert.equal(f.get(berry.id), undefined);
  assert.throws(() => f.move(berry, { targetId: f.player.cardId }), /nicht mehr/);
  const extra = f.add('berry');
  f.move(extra, { targetId: f.player.cardId });
  assert.ok(f.get(extra.id));
  assert.equal(f.human().hp, 75);
  f.move(f.get(extra.id), { split: true, x: 1400, y: 800 });
  f.human().hp = 1;
  f.add('rat', { x: f.human().x, y: f.human().y });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 2000);
  assert.equal(f.human().type, 'corpse');
  assert.equal(f.human().hp, 0);
  f.move(f.get(extra.id), { targetId: f.player.cardId });
  assert.ok(f.get(extra.id));
  assert.equal(f.human().type, 'corpse');
  joinPlayer(f.world, 'TOM', 10000);
  assert.equal(f.world.cards.filter((card) => card.ownerId === f.player.id).length, 1);
  assert.ok(!f.world.combats.length);
});

test('a dying human drops its equipment and rats ignore corpses', () => {
  const f = setup();
  const axe = f.add('axe');
  f.move(axe, { targetId: f.player.cardId });
  f.human().hp = 1;
  const rat = f.add('rat', { x: f.human().x, y: f.human().y });
  advanceWorld(f.world, 0);
  advanceWorld(f.world, 2000);
  assert.equal(f.human().type, 'corpse');
  assert.equal(f.get(axe.id).equippedTo, undefined);
  assert.equal(f.human().toolId, undefined);
  assert.equal(f.get(rat.id).motion, undefined);
  assert.equal(f.world.combats.length, 0);
});

test('active time stops exactly at the last presence expiry; offline time adds no work or damage', () => {
  const f = setup();
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  advanceWorld(f.world, 30_000, { activeUntil: 5000 });
  assert.equal(f.world.clock.elapsed, 5000);
  assert.equal(f.world.clock.lastAt, 30_000);
  assert.equal(f.get(source.id).remaining, 5);
  advanceWorld(f.world, 60_000, { activeUntil: 5000 });
  assert.equal(f.world.clock.elapsed, 5000);
  assert.equal(f.get(source.id).remaining, 5);
  advanceWorld(f.world, 65_000, { activeUntil: 65_000 });
  assert.equal(f.world.clock.elapsed, 10_000);
  assert.equal(f.get(source.id).remaining, 4);

  const battle = setup();
  battle.add('rat', { x: battle.human().x, y: battle.human().y });
  advanceWorld(battle.world, 0);
  advanceWorld(battle.world, 999_999, { activeUntil: 1000 });
  assert.equal(battle.human().hp, 75);
  assert.equal(battle.world.combats[0].nextAttackAt, 2000);
});

test('soil + berry grows for one real hour offline, then stores only one ten-berry harvest', () => {
  const f = setup();
  const soil = f.add('soil');
  const berry = f.add('berry');
  f.move(berry, { targetId: soil.id });
  assert.equal(f.world.jobs[0].timeBase, 'real');
  assert.equal(f.world.jobs[0].dueAt, 3_600_000);
  assert.equal(nextWakeAt(f.world, 0), 3_600_000);
  advanceWorld(f.world, 3_599_999, { activeUntil: 0 });
  assert.equal(f.world.cards.filter((card) => card.type === 'field').length, 0);
  const sevenDays = 7 * CONFIG.fieldHarvestInterval;
  advanceWorld(f.world, sevenDays, { activeUntil: 0 });
  assert.equal(f.world.clock.elapsed, 0);
  const field = f.world.cards.find((card) => card.type === 'field');
  assert.equal(field.readyAt, CONFIG.fieldGrowDuration + CONFIG.fieldHarvestInterval);
  assert.equal(f.get(soil.id), undefined);
  assert.equal(f.get(berry.id), undefined);
  assert.equal(nextWakeAt(f.world, sevenDays), null);
  f.command({ type: 'harvest', cardId: field.id, x: 1100, y: 500 }, sevenDays);
  assert.equal(f.world.cards.filter((card) => card.type === 'berry').length, 10);
  assert.equal(f.get(field.id).readyAt, sevenDays + CONFIG.fieldHarvestInterval);
  assert.throws(() => f.command({ type: 'harvest', cardId: field.id }, sevenDays), /nicht erntereif/);
  assert.equal(f.world.cards.filter((card) => card.type === 'berry').length, 10);
  f.command({ type: 'harvest', cardId: field.id }, sevenDays + CONFIG.fieldHarvestInterval);
  assert.equal(f.world.cards.filter((card) => card.type === 'berry').length, 20);
});

test('splitting growing soil preserves both ingredients and cancels real-time growth', () => {
  const f = setup();
  const soil = f.add('soil');
  const berry = f.add('berry');
  f.move(berry, { targetId: soil.id });
  advanceWorld(f.world, 500_000, { activeUntil: 0 });
  f.move(f.get(soil.id), { split: true, x: 900, y: 700 });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 100_000_000, { activeUntil: 0 });
  assert.ok(f.get(soil.id));
  assert.ok(f.get(berry.id));
  assert.equal(f.world.cards.filter((card) => card.type === 'field').length, 0);
});

test('idle and partial-progress advances need no state writes; public state is detached JSON', () => {
  const f = setup();
  assert.equal(advanceWorld(f.world, 5000), false);
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  assert.equal(advanceWorld(f.world, 6000), false);
  assert.equal(nextWakeAt(f.world, 7000), 15_000, 'scheduling is anchored to the saved clock, not to each caller');
  const publicState = publicWorld(f.world);
  publicState.cards[0].hp = 0;
  assert.equal(f.human().hp, 75);
  assert.equal(publicState.revision, 0, 'the storage layer, not the engine, increments revisions');
  assert.equal(advanceWorld(f.world, 15_000), true);
});

test('nextWakeAt with a persisted clock never postpones work after an unrelated read', () => {
  const f = setup();
  const source = f.add('tree');
  f.move(f.human(), { targetId: source.id });
  assert.equal(nextWakeAt(f.world, 6000), 10_000);
  assert.equal(nextWakeAt(f.world, 12_000), 12_000, 'overdue events wake immediately');
});

function editCatalog(fixture, edit) {
  const catalog = JSON.parse(JSON.stringify(getCatalog(fixture.world)));
  edit(catalog);
  fixture.command({ type: 'catalog-save', catalog, baseCatalogRevision: getCatalog(fixture.world).revision });
  return catalog;
}

const customDefinition = (changes = {}) => ({ name: 'Kristall', category: 'resource', color: '#b8c9db', icon: '◆', art: 'flint', sellPrice: 3, description: 'Neue Karte', effects: [], ...changes });

test('custom package payment is independent, uses relative weights and snapshots purchased contents', () => {
  const f = setup({ keepGold: true });
  editCatalog(f, (catalog) => {
    catalog.cardTypes.crystal = customDefinition();
    catalog.packs.push({ id: 'crystalPack', name: 'Kristallpaket', description: 'Glitzer!', color: '#b8c9db', price: 2, size: 2, contents: [{ type: 'crystal', weight: 7 }, { type: 'wood', weight: 3 }] });
  });
  let coin = f.world.cards.find((card) => card.type === 'gold');
  f.move(coin, { split: true, zone: 'shop', packId: 'crystalPack' });
  coin = f.world.cards.find((card) => card.type === 'gold');
  f.move(coin, { split: true, zone: 'shop' });
  assert.equal(f.world.shopPayments.crystalPack, 1);
  assert.equal(f.world.shopPaid, 1);
  coin = f.world.cards.find((card) => card.type === 'gold');
  f.move(coin, { zone: 'shop', packId: 'crystalPack' });
  const pack = f.world.cards.find((card) => card.type === 'pack');
  assert.equal(pack.packName, 'Kristallpaket');
  assert.equal(pack.packColor, '#b8c9db');
  assert.equal(pack.packSize, 2);
  assert.equal(pack.cardsLeft, 2);
  assert.equal(f.world.shopPayments.crystalPack, 0);
  assert.equal(f.world.shopPaid, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 6);
  editCatalog(f, (catalog) => {
    catalog.packs = catalog.packs.filter((entry) => entry.id !== 'crystalPack');
  });
  f.command({ type: 'open-pack', cardId: pack.id }, 0, () => 0.6999);
  assert.equal(f.get(pack.id).cardsLeft, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'crystal').length, 1);
  const loaded = JSON.parse(JSON.stringify(publicWorld(f.world)));
  applyCommand(loaded, { type: 'open-pack', cardId: pack.id }, { playerId: f.player.id, now: 0, rng: () => 0.7 });
  assert.equal(loaded.cards.find((card) => card.id === pack.id), undefined);
  assert.equal(loaded.cards.filter((card) => card.type === 'wood').length, 1);
  assert.equal(loaded.cards.filter((card) => card.type === 'crystal').length, 1);
});

test('an edited package changes new purchases while a partly opened package keeps its old size and draws', () => {
  const f = setup({ keepGold: true });
  f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
  const old = f.world.cards.find((card) => card.type === 'pack');
  f.command({ type: 'open-pack', cardId: old.id });
  editCatalog(f, (catalog) => {
    catalog.packs[0].size = 1;
    catalog.packs[0].contents = [{ type: 'stone', weight: 1 }];
  });
  f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
  const recent = f.world.cards.find((card) => card.type === 'pack' && card.id !== old.id);
  assert.equal(recent.cardsLeft, 1);
  f.command({ type: 'open-pack', cardId: recent.id });
  f.command({ type: 'open-pack', cardId: old.id });
  f.command({ type: 'open-pack', cardId: old.id });
  assert.equal(f.world.cards.filter((card) => card.type === 'tree').length, 3);
  assert.equal(f.world.cards.filter((card) => card.type === 'stone').length, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'pack').length, 0);
});

test('custom sources and matching tools generate counted products then exhaust with no frame ticking', () => {
  const f = setup();
  editCatalog(f, (catalog) => {
    catalog.cardTypes.crystal = customDefinition();
    catalog.cardTypes.vein = customDefinition({ name: 'Kristallader', category: 'source', effects: [{ kind: 'source', uses: 2, duration: 2000, outputs: [{ type: 'crystal', count: 2, weight: 1 }] }] });
    catalog.cardTypes.drill = customDefinition({ name: 'Bohrer', category: 'tool', effects: [{ kind: 'tool', sourceTypes: ['vein'], multiplier: 0.5 }] });
  });
  const source = f.add('vein');
  const tool = f.add('drill');
  f.move(tool, { targetId: f.player.cardId });
  f.move(f.human(), { targetId: source.id });
  assert.equal(f.world.jobs[0].duration, 1000);
  assert.equal(f.get(source.id).remaining, 2);
  assert.equal(nextWakeAt(f.world, 0), 1000);
  advanceWorld(f.world, 999, { rng: () => 0 });
  assert.equal(f.world.cards.filter((card) => card.type === 'crystal').length, 0);
  advanceWorld(f.world, 2000, { rng: () => 0 });
  const outputs = f.world.cards.filter((card) => card.type === 'crystal');
  assert.equal(outputs.length, 4);
  assert.equal(new Set(outputs.map((card) => card.stackId)).size, 1);
  assert.equal(f.get(source.id), undefined);
  assert.equal(f.human().toolId, tool.id);
  assert.equal(f.world.jobs.length, 0);
});

test('custom healing and selling use live card effects and metadata', () => {
  const f = setup();
  editCatalog(f, (catalog) => {
    catalog.cardTypes.medicine = customDefinition({ name: 'Heilkraut', category: 'food', sellPrice: 4, effects: [{ kind: 'heal', amount: 5 }] });
  });
  f.human().hp = 72;
  const medicine = f.add('medicine');
  f.move(medicine, { targetId: f.player.cardId });
  assert.equal(f.human().hp, 75);
  assert.equal(f.get(medicine.id), undefined);
  const sold = f.add('medicine');
  f.move(sold, { zone: 'sell' });
  assert.equal(f.get(sold.id), undefined);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 4);
});

test('custom combinations create counted results with a human or autonomously in game time', () => {
  const f = setup();
  editCatalog(f, (catalog) => {
    catalog.cardTypes.crystal = customDefinition();
    catalog.recipes.push({ id: 'crystals', name: 'Kristalle fertigen', ingredients: { wood: 2 }, result: 'crystal', resultCount: 2, requiresHuman: true, duration: 1000, timeBase: 'world' });
    catalog.recipes.push({ id: 'polish', name: 'Schleifen', ingredients: { stone: 1 }, result: 'flint', resultCount: 1, requiresHuman: false, duration: 1000, timeBase: 'world' });
  });
  const ingredients = prepareJob(f, { wood: 2 });
  assert.equal(f.world.jobs[0].recipeId, 'crystals');
  const stone = f.add('stone', { x: 1100, y: 700 });
  f.move(stone);
  assert.equal(f.world.jobs.length, 2);
  advanceWorld(f.world, 1000);
  assert.equal(f.world.cards.filter((card) => card.type === 'crystal').length, 2);
  assert.equal(f.world.cards.filter((card) => card.type === 'flint').length, 1);
  assert.ok(ingredients.every((cardId) => !f.get(cardId)));
  assert.equal(f.get(stone.id), undefined);
  assert.equal(f.human().hp, 75);
});

test('editing a running combination duration preserves progress, and deleting it preserves every ingredient', () => {
  const f = setup();
  const ingredients = prepareJob(f, { wood: 5, stone: 1 });
  advanceWorld(f.world, 5000);
  const jobId = f.world.jobs[0].id;
  editCatalog(f, (catalog) => { catalog.recipes.find((recipe) => recipe.id === 'axe').duration = 10_000; });
  assert.equal(f.world.jobs[0].id, jobId);
  assert.equal(f.world.jobs[0].startedAt, 2500);
  assert.equal(f.world.jobs[0].dueAt, 12_500);
  editCatalog(f, (catalog) => { catalog.recipes = catalog.recipes.filter((recipe) => recipe.id !== 'axe'); });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 100_000);
  assert.ok(ingredients.every((cardId) => f.get(cardId)));
  assert.equal(f.world.cards.filter((card) => card.type === 'axe').length, 0);
});

test('removing a source effect cancels active work, and category changes safely detach equipment', () => {
  const f = setup();
  const source = f.add('tree');
  const tool = f.add('axe');
  f.move(tool, { targetId: f.player.cardId });
  f.move(f.human(), { targetId: source.id });
  advanceWorld(f.world, 2500);
  editCatalog(f, (catalog) => {
    catalog.cardTypes.tree.effects = [];
    catalog.cardTypes.axe.category = 'resource';
    catalog.cardTypes.axe.effects = [];
  });
  assert.equal(f.world.jobs.length, 0);
  assert.equal(f.human().toolId, undefined);
  assert.equal(f.get(tool.id).equippedTo, undefined);
  advanceWorld(f.world, 100_000);
  assert.equal(f.get(source.id).remaining, 5);
  assert.equal(f.world.cards.filter((card) => card.type === 'wood').length, 0);
});

test('fields created from custom packages have a finite next harvest timestamp', () => {
  const f = setup({ keepGold: true });
  editCatalog(f, (catalog) => {
    catalog.packs[0].size = 1;
    catalog.packs[0].contents = [{ type: 'field', weight: 1 }];
  });
  f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
  const pack = f.world.cards.find((card) => card.type === 'pack');
  f.command({ type: 'open-pack', cardId: pack.id });
  const field = f.world.cards.find((card) => card.type === 'field');
  assert.equal(field.readyAt, CONFIG.fieldHarvestInterval);
  assert.throws(() => f.command({ type: 'harvest', cardId: field.id }), /noch nicht erntereif/);
});

test('legacy growing fields preserve elapsed real-time progress when default recipes are introduced', () => {
  const f = setup();
  const soil = f.add('soil');
  const berry = f.add('berry');
  f.move(berry, { targetId: soil.id });
  const job = f.world.jobs[0];
  delete job.recipeId;
  delete f.world.catalog;
  advanceWorld(f.world, 600_000, { activeUntil: 0 });
  assert.equal(f.world.jobs[0].id, job.id);
  assert.equal(f.world.jobs[0].dueAt, CONFIG.fieldGrowDuration);
  advanceWorld(f.world, CONFIG.fieldGrowDuration, { activeUntil: 0 });
  assert.equal(f.world.cards.filter((card) => card.type === 'field').length, 1);
});

test('valid IDs matching Object prototype names still craft correctly', () => {
  for (const type of ['toString', 'hasOwnProperty', 'valueOf']) {
    const f = setup({ keepGold: true });
    editCatalog(f, (catalog) => {
      const definition = customDefinition();
      delete definition.art;
      catalog.cardTypes[type] = definition;
      catalog.packs[0].size = 1;
      catalog.packs[0].contents = [{ type, weight: 1 }];
      catalog.recipes.push({ id: 'prototypeRecipe', name: 'Neue Kombination', ingredients: { [type]: 1 }, result: 'wood', resultCount: 1, requiresHuman: false, duration: 1000, timeBase: 'world' });
    });
    assert.equal(f.world.catalog.cardTypes[type].art, '');
    f.move(f.world.cards.find((card) => card.type === 'gold'), { zone: 'shop' });
    const pack = f.world.cards.find((card) => card.type === 'pack');
    f.command({ type: 'open-pack', cardId: pack.id });
    assert.equal(f.world.jobs[0]?.recipeId, 'prototypeRecipe');
    advanceWorld(f.world, 1000);
    assert.equal(f.world.cards.filter((card) => card.type === 'wood').length, 1);
    assert.equal(f.world.cards.filter((card) => card.type === type).length, 0);
  }
});

test('healing cannot consume a filled piggy bank or lose its stored gold', () => {
  const f = setup({ keepGold: true });
  editCatalog(f, (catalog) => { catalog.cardTypes.piggyBank.effects = [{ kind: 'heal', amount: 1 }]; });
  f.human().hp = 74;
  const pig = f.add('piggyBank', { gold: 5 });
  const before = JSON.stringify(f.world);
  assert.throws(() => f.move(pig, { targetId: f.player.cardId }), /Leere das Sparschwein zuerst/);
  assert.equal(JSON.stringify(f.world), before);
  assert.equal(f.get(pig.id).gold, 5);
  assert.equal(f.human().hp, 74);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 9);
});

test('filled piggy banks cannot be crafted, and new deposits cancel a running combination safely', () => {
  const f = setup();
  editCatalog(f, (catalog) => {
    catalog.recipes.push({ id: 'recyclePig', name: 'Sparschwein umbauen', ingredients: { piggyBank: 1 }, result: 'wood', resultCount: 1, requiresHuman: true, duration: 1000, timeBase: 'world' });
  });
  const pig = f.add('piggyBank', { gold: 2 });
  f.move(f.human(), { targetId: pig.id });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 2000);
  assert.equal(f.get(pig.id).gold, 2);
  f.command({ type: 'withdraw', cardId: pig.id });
  f.command({ type: 'withdraw', cardId: pig.id });
  assert.equal(f.world.jobs[0].recipeId, 'recyclePig');
  advanceWorld(f.world, 2500);
  const coin = f.world.cards.find((card) => card.type === 'gold');
  f.move(coin, { split: true, targetId: pig.id });
  assert.equal(f.world.jobs.length, 0);
  advanceWorld(f.world, 10_000);
  assert.equal(f.get(pig.id).gold, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'wood').length, 0);
});

test('a piggy bank buys one basic package directly and keeps surplus gold at its original position', () => {
  for (const gold of [3, 8]) {
    const f = setup();
    const pig = f.add('piggyBank', { gold });
    const result = f.move(pig, { x: 1650, y: 1000, zone: 'shop' });
    assert.equal(f.get(pig.id).gold, gold - 3);
    assert.equal(f.get(pig.id).x, 800);
    assert.equal(f.get(pig.id).y, 400);
    assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 0);
    const packs = f.world.cards.filter((card) => card.type === 'pack');
    assert.equal(packs.length, 1);
    assert.equal(packs[0].packId, 'basic');
    assert.equal(packs[0].packName, 'Basicpaket');
    assert.equal(packs[0].cardsLeft, 3);
    assert.deepEqual(packs[0].packContents, getCatalog(f.world).packs[0].contents);
    assert.equal(f.world.shopPaid, 0);
    assert.equal(f.world.shopPayments.basic, 0);
    assert.match(result.message, /neues Basicpaket/);
  }
});

test('a piggy bank only pays the remaining shared price of an already funded package', () => {
  const f = setup({ keepGold: true });
  for (let index = 0; index < 2; index++) f.move(f.world.cards.find((card) => card.type === 'gold'), { split: true, zone: 'shop' });
  const pig = f.add('piggyBank', { gold: 1 });
  f.move(pig, { zone: 'shop' });
  assert.equal(f.get(pig.id).gold, 0);
  assert.equal(f.world.shopPaid, 0);
  assert.equal(f.world.shopPayments.basic, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'pack').length, 1);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 7);
});

test('piggy bank purchases use the selected custom package and keep other package payments', () => {
  const f = setup({ keepGold: true });
  editCatalog(f, (catalog) => {
    catalog.packs.push({ id: 'woodPack', name: 'Holzpaket', description: 'Nur Holz', color: '#aabbcc', price: 2, size: 1, contents: [{ type: 'wood', weight: 1 }] });
  });
  f.move(f.world.cards.find((card) => card.type === 'gold'), { split: true, zone: 'shop' });
  const pig = f.add('piggyBank', { gold: 5 });
  f.move(pig, { zone: 'shop', packId: 'woodPack' });
  assert.equal(f.get(pig.id).gold, 3);
  assert.equal(f.world.shopPaid, 1);
  assert.equal(f.world.shopPayments.basic, 1);
  assert.equal(f.world.shopPayments.woodPack, 0);
  const pack = f.world.cards.find((card) => card.type === 'pack');
  assert.equal(pack.packId, 'woodPack');
  assert.equal(pack.packName, 'Holzpaket');
  assert.equal(pack.cardsLeft, 1);
  assert.deepEqual(pack.packContents, [{ type: 'wood', weight: 1 }]);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 8);
});

test('an insufficient piggy bank leaves its gold, payments and every world card unchanged', () => {
  for (const [paid, gold] of [[0, 2], [2, 0]]) {
    const f = setup();
    f.world.shopPaid = paid;
    f.world.shopPayments.basic = paid;
    const pig = f.add('piggyBank', { gold });
    const before = JSON.stringify(f.world);
    assert.throws(() => f.move(pig, { x: 1600, y: 1000, zone: 'shop' }), /nicht genug Gold/);
    assert.equal(JSON.stringify(f.world), before);
  }
});

test('shop purchases reject piggy banks mixed with other cards without spending stored gold', () => {
  const f = setup();
  const pig = f.add('piggyBank', { gold: 6 });
  f.add('wood', { stackId: pig.stackId, order: 1 });
  const before = JSON.stringify(f.world);
  assert.throws(() => f.move(pig, { zone: 'shop', takeAbove: true }), /gefülltes Sparschwein/);
  assert.equal(JSON.stringify(f.world), before);
});
