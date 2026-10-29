import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { createWorld } from '@stackfriends/shared/game.js';
import { FileRepository } from '../server/repository.js';
import { Realtime } from '../server/realtime.js';
import { GameService } from '../server/service.js';

async function fixture(t) {
  const now = () => 1000;
  const repository = new FileRepository('unused-in-memory-test', now);
  repository.state = { world: createWorld(now()), sessions: {}, commandIds: [], activeUntil: now() };
  repository.persist = async () => {};
  const realtime = new Realtime({}, now);
  const service = await new GameService({ mode: 'local' }, { repository, realtime, now }).init();
  t.after(() => service.close());
  const joined = await service.join('Ada');
  await realtime.touch('tab', joined.player);
  await flush();
  return { service, repository, realtime, joined };
}

test('snapshots return the reconciled world and session without reading the world twice', async (t) => {
  const { service, repository, joined } = await fixture(t);
  const reads = repository.metrics.reads;
  const snapshot = await service.snapshot(joined.token);
  assert.equal(snapshot.player.id, joined.player.id);
  assert.equal(snapshot.world.revision, repository.state.world.revision);
  assert.equal(repository.metrics.reads, reads);
  assert.equal((await service.snapshot('invalid')).player, null);
});

test('a committed local move schedules from its own world without an extra Mongo world read', async (t) => {
  const { service, repository, joined } = await fixture(t);
  let fullReads = 0;
  t.mock.method(repository, 'world', async () => { fullReads++; return structuredClone(repository.state.world); });
  const reads = repository.metrics.reads;
  await service.execute(joined.token, { type: 'move', cardId: joined.player.cardId, x: 600, y: 400, split: true }, 'move-once');
  await flush();
  assert.equal(repository.metrics.reads - reads, 1, 'only the projected command context is read');
  assert.equal(fullReads, 0);
  assert.equal(repository.state.world.cards.find((card) => card.id === joined.player.cardId).x, 600);
});

test('a delayed older local publication cannot cancel the timer of a newer commit', async (t) => {
  const { service, repository, realtime } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayedRevision = repository.state.world.revision + 1;
  const publish = realtime.publish.bind(realtime);
  t.mock.method(realtime, 'publish', async (event) => {
    if (event.revision === delayedRevision) await gate;
    return publish(event);
  });
  const older = service.commit(() => ({}));
  await flush();
  const newer = await service.commit((state) => {
    state.world.jobs = [{ id: 'future-job', timeBase: 'world', dueAt: 60_000 }];
  });
  await flush();
  const timer = service.timer;
  assert.ok(timer, 'the newer job must have a scheduled timer');
  release();
  await older;
  await flush();
  assert.equal(service.timer, timer);
  await service.schedule({ ...newer.world, revision: delayedRevision, jobs: [] });
  assert.equal(service.timer, timer, 'a delayed connect must not cancel it either');
});

test('foreign patches read fresh projected state and an interrupted read cannot replace a newer timer', async (t) => {
  const { service, repository, realtime } = await fixture(t);
  const current = structuredClone(repository.state.world);
  current.revision++;
  current.jobs = [{ id: 'foreign-job', timeBase: 'world', dueAt: 60_000 }];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let worldReads = 0;
  t.mock.method(repository, 'world', async () => { worldReads++; await gate; return current; });
  realtime.emit('event', { type: 'patch', revision: current.revision });
  await flush();
  assert.equal(worldReads, 1);
  const newer = { ...current, revision: current.revision + 1, jobs: [{ id: 'newer-job', timeBase: 'world', dueAt: 90_000 }] };
  await service.schedule(newer);
  const timer = service.timer;
  release();
  await flush();
  assert.equal(service.timer, timer);
  assert.equal(service.latestScheduledRevision, newer.revision);
});
