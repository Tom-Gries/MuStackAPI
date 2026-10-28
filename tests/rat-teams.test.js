import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, joinPlayer, advanceWorld, applyCommand } from '../shared/game.js';
import { combatEnemyIds, combatHumanIds } from '../shared/combat.js';

function setup(humans = 1) {
  const world = createWorld(0);
  const players = Array.from({ length: humans }, (_, i) => joinPlayer(world, `Team ${i}`, 0));
  world.cards = world.cards.filter((card) => card.type === 'human');
  world.cards.forEach((card, i) => Object.assign(card, { x: 400 + i * 20, y: 300 }));
  function rat(id, x = 405, hp = 2) {
    const card = { id, type: 'rat', x, y: 300, hp, stackId: id, order: 0 };
    world.cards.push(card); return card;
  }
  return { world, players, rat, move(cardId, x, now = 0) { applyCommand(world, { type: 'move', cardId, x, y: 300, split: true }, { playerId: players[0].id, now }); } };
}

test('nearby rats share one battle, each attacks, and every defeated rat drops loot exactly once', () => {
  const f = setup(); f.rat('rat-a'); f.rat('rat-b', 420);
  advanceWorld(f.world, 0);
  assert.equal(f.world.combats.length, 1);
  assert.deepEqual(new Set(combatEnemyIds(f.world.combats[0])), new Set(['rat-a', 'rat-b']));
  advanceWorld(f.world, 2000, { rng: () => 0 });
  assert.equal(f.world.cards.find((card) => card.type === 'human').hp, 73);
  assert.equal(f.world.combats[0].lastDamage.length, 2);
  advanceWorld(f.world, 8000, { rng: () => 0 });
  assert.equal(f.world.combats.length, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 2);
  const reloaded = JSON.parse(JSON.stringify(f.world));
  advanceWorld(reloaded, 90000, { rng: () => 0 });
  assert.equal(reloaded.cards.filter((card) => card.type === 'gold').length, 2);
});

test('two humans cooperate against a rat team and the surviving rat stays in the same fight', () => {
  const f = setup(2); f.rat('rat-a'); f.rat('rat-b', 430);
  advanceWorld(f.world, 0);
  const fightId = f.world.combats[0].id;
  advanceWorld(f.world, 2000, { rng: () => 0 });
  assert.equal(f.world.combats[0].id, fightId);
  assert.deepEqual(combatEnemyIds(f.world.combats[0]), ['rat-b']);
  assert.equal(combatHumanIds(f.world.combats[0]).length, 2);
  advanceWorld(f.world, 4000, { rng: () => 0 });
  assert.equal(f.world.combats.length, 0);
  assert.equal(f.world.cards.filter((card) => card.type === 'gold').length, 2);
  assert.equal(f.world.cards.filter((card) => card.type === 'human').reduce((sum, card) => sum + card.hp, 0), 147);
});

test('a reinforcing rat joins without delaying the current attack', () => {
  const f = setup(); f.rat('rat-a', 405, 6);
  advanceWorld(f.world, 0);
  const due = f.world.combats[0].nextAttackAt;
  f.rat('rat-b', 420); advanceWorld(f.world, 1000);
  assert.equal(f.world.combats[0].nextAttackAt, due);
  assert.equal(combatEnemyIds(f.world.combats[0]).length, 2);
  advanceWorld(f.world, 2000);
  assert.equal(f.world.cards.find((card) => card.type === 'human').hp, 73);
});

test('distant rats follow a busy human and join upon reaching combat range', () => {
  const f = setup(); f.rat('rat-a', 405, 20); const other = f.rat('rat-b', 850);
  advanceWorld(f.world, 0);
  assert.equal(other.motion.targetId, f.players[0].cardId);
  assert.deepEqual(combatEnemyIds(f.world.combats[0]), ['rat-a']);
  advanceWorld(f.world, 10000);
  assert.equal(f.world.combats.length, 1);
  assert.ok(combatEnemyIds(f.world.combats[0]).includes('rat-b'));
});

test('separate rat encounters merge when the front lines meet without duplicating fighters', () => {
  const f = setup(2);
  f.world.cards.find((card) => card.id === f.players[1].cardId).x = 600;
  f.rat('rat-a', 440, 10); f.rat('rat-b', 560, 10);
  advanceWorld(f.world, 0);
  assert.equal(f.world.combats.length, 2);
  f.move(f.players[1].cardId, 530, 1000);
  assert.equal(f.world.combats.length, 1);
  assert.equal(combatEnemyIds(f.world.combats[0]).length, 2);
  assert.equal(combatHumanIds(f.world.combats[0]).length, 2);
  assert.equal(f.world.combats[0].nextAttackAt, 2000);
});

test('team attacks respect distance and fleeing all humans ends the battle', () => {
  const f = setup(2);
  f.world.cards.find((card) => card.id === f.players[1].cardId).x = 600;
  f.rat('rat-a', 440, 10); f.rat('rat-b', 560, 10);
  advanceWorld(f.world, 0);
  f.move(f.players[1].cardId, 530, 1000);
  advanceWorld(f.world, 2000);
  const humans = f.world.cards.filter((card) => card.type === 'human');
  assert.deepEqual(humans.map((human) => human.hp), [74, 74]);
  f.move(f.players[0].cardId, 1300, 2100);
  f.move(f.players[1].cardId, 1500, 2200);
  assert.equal(f.world.combats.length, 0);
});
