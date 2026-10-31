import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addCard } from '@stackfriends/shared/game.js';
import { GameService } from '../../server/service.js';
import { readConfig } from '../../server/config.js';

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stackfriends-personal-'));
  let timestamp = options.now ?? 1_000_000;
  const config = { ...readConfig({}), worldFile: path.join(directory, 'personal-worlds.json'), legacyWorldFile: path.join(directory, 'world.json') };
  const service = await new GameService(config, { now: () => timestamp, rng: () => .5, ...options }).init();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, config, directory, now: () => timestamp, advance: (milliseconds) => timestamp += milliseconds };
}
export async function edit(service, id, operation) {
  return service.repository.transaction(async (context) => {
    const player = await context.playerById(id), result = operation(player.world, player);
    await context.savePlayer(player); return result;
  });
}
export async function hall(service, id) { return edit(service, id, (world) => addCard(world, 'town_hall', 1400, 700)); }
