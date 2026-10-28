import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, joinPlayer, applyCommand } from '../shared/game.js';
import { CONFIG } from '../shared/catalog.js';

function setup(hp = 70) {
  const world = createWorld(0);
  const player = joinPlayer(world, 'Essentest', 0);
  world.cards = world.cards.filter((card) => card.type === 'human');
  const get = (id) => world.cards.find((card) => card.id === id);
  const human = () => get(player.cardId);
  Object.assign(human(), { x: 300, y: 300, hp });
  const add = (type, extra = {}) => {
    const id = `food-test-${world.nextId++}`;
    world.cards.push({ id, type, stackId: id, order: 0, x: 900, y: 400, ...extra });
    return id;
  };
  const stack = (types) => {
    const ids = types.map((type) => add(type));
    ids.forEach((id, order) => Object.assign(get(id), { stackId: ids[0], order }));
    return ids;
  };
  const command = (value) => applyCommand(world, value, { playerId: player.id, now: 0, rng: () => 0 });
  const feed = (id, selection = {}) => command({ type: 'move', cardId: id, x: human().x, y: human().y, targetId: player.cardId, ...selection });
  return { world, player, get, human, add, stack, command, feed };
}

test('a food stack heals to full and leaves surplus cards intact at their original position', () => {
  const f = setup(72);
  const foods = f.stack(Array(5).fill('berry'));
  const origin = { x: f.get(foods[0]).x, y: f.get(foods[0]).y, stackId: f.get(foods[0]).stackId };
  f.feed(foods[0]);
  assert.equal(f.human().hp, CONFIG.humanHp);
  assert.ok(foods.slice(0, 3).every((id) => !f.get(id)));
  const remaining = foods.slice(3).map(f.get);
  assert.ok(remaining.every((card) => card && card.x === origin.x && card.y === origin.y && card.stackId === origin.stackId));
  assert.deepEqual(remaining.map((card) => card.order), [0, 1]);
});

test('not enough food is consumed completely and heals exactly its combined amount', () => {
  const f = setup(61);
  const foods = f.stack(['berry', 'berry', 'berry']);
  f.feed(foods[0]);
  assert.equal(f.human().hp, 64);
  assert.ok(foods.every((id) => !f.get(id)));
});

test('mixed healing strengths are eaten by stack order until full without wasting later food', () => {
  const f = setup(69);
  f.world.catalog.cardTypes.medicine = { ...f.world.catalog.cardTypes.berry, name: 'Heilkraut', effects: [{ kind: 'heal', amount: 5 }] };
  const foods = f.stack(['berry', 'medicine', 'berry', 'medicine']);
  // Physical card array order is not authoritative for a stack's eating order.
  f.world.cards.reverse();
  f.feed(foods[0]);
  assert.equal(f.human().hp, 75);
  assert.equal(f.get(foods[0]), undefined);
  assert.equal(f.get(foods[1]), undefined);
  assert.ok(f.get(foods[2]));
  assert.ok(f.get(foods[3]));
});

test('a stronger last portion caps healing at75 and never consumes a surplus portion', () => {
  const f = setup(74);
  f.world.catalog.cardTypes.medicine = { ...f.world.catalog.cardTypes.berry, name: 'Heilkraut', effects: [{ kind: 'heal', amount: 5 }] };
  const foods = f.stack(['medicine', 'berry']);
  f.feed(foods[0]);
  assert.equal(f.human().hp, 75);
  assert.equal(f.get(foods[0]), undefined);
  assert.ok(f.get(foods[1]));
});

test('grabbing a middle food card feeds only that card and the cards above it', () => {
  const f = setup(70);
  const foods = f.stack(Array(5).fill('berry'));
  f.feed(foods[2], { takeAbove: true });
  assert.equal(f.human().hp, 73);
  assert.ok(foods.slice(0, 2).every((id) => f.get(id)));
  assert.ok(foods.slice(2).every((id) => !f.get(id)));
});

test('splitting one food card consumes one even when more food is in its stack', () => {
  const f = setup(70);
  const foods = f.stack(Array(4).fill('berry'));
  f.feed(foods[1], { split: true });
  assert.equal(f.human().hp, 71);
  assert.equal(f.get(foods[1]), undefined);
  assert.ok([foods[0], foods[2], foods[3]].every((id) => f.get(id)));
});

test('full health and corpses never consume a dragged food stack', () => {
  for (const corpse of [false, true]) {
    const f = setup(corpse ? 0 : 75);
    if (corpse) f.human().type = 'corpse';
    const foods = f.stack(['berry', 'berry', 'berry']);
    f.feed(foods[0]);
    assert.equal(f.human().hp, corpse ? 0 : 75);
    assert.equal(f.human().type, corpse ? 'corpse' : 'human');
    assert.ok(foods.every((id) => f.get(id)));
  }
});

test('a mixed non-healing stack uses normal stacking without consuming any cards', () => {
  const f = setup(70);
  const items = f.stack(['berry', 'wood', 'berry']);
  f.feed(items[0]);
  assert.equal(f.human().hp, 70);
  assert.ok(items.every((id) => f.get(id)?.stackId === f.human().stackId));
});

test('feeding preserves the target human and its equipped tool', () => {
  const f = setup(72);
  const knife = f.add('knife');
  f.command({ type: 'move', cardId: knife, x: 300, y: 300, targetId: f.player.cardId });
  const foods = f.stack(Array(5).fill('berry'));
  f.feed(foods[0]);
  assert.equal(f.human().hp, 75);
  assert.equal(f.human().toolId, knife);
  assert.equal(f.get(knife).equippedTo, f.player.cardId);
  assert.equal(f.world.cards.filter((card) => card.type === 'human').length, 1);
});

test('a filled piggy bank with a healing effect rejects the whole feeding attempt atomically', () => {
  const f = setup(74);
  f.world.catalog.cardTypes.piggyBank.effects = [{ kind: 'heal', amount: 1 }];
  const foods = f.stack(['berry', 'piggyBank']);
  f.get(foods[1]).gold = 9;
  const before = JSON.stringify(f.world);
  assert.throws(() => f.feed(foods[0]), /Sparschwein zuerst/);
  assert.equal(JSON.stringify(f.world), before);
});
