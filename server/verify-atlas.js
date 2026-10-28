// Optional integration check: npm exec -- node server/verify-atlas.js
// Uses a separate temporary document, never the shared playable world.
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { MongoRepository } from './repository.js';

for (const filename of ['.env.local', '.env', 'atlas-credentials.env']) dotenv.config({ path: filename, override: false });
const repositories = [];
let temporaryId;
try {
  const config = readConfig();
  if (!config.mongoUri) throw new Error('MongoDB ist nicht eingerichtet.');
  temporaryId = `verification-${randomUUID()}`;
  const first = new MongoRepository(config.mongoUri, config.mongoDatabase, Date.now, temporaryId);
  const second = new MongoRepository(config.mongoUri, config.mongoDatabase, Date.now, temporaryId);
  repositories.push(first, second);
  await Promise.all(repositories.map((repository) => repository.init()));
  const startingState = await first.read();
  if (startingState.world.cards.filter((card) => card.type === 'gold').length !== 9) throw new Error('Initialisierung fehlgeschlagen.');
  const once = (state) => {
    if (state.commandIds.some((entry) => entry.id === 'verification-once')) return { changed: false };
    state.world.cards.pop();
    state.commandIds.push({ id: 'verification-once' });
    return {};
  };
  await Promise.all([first.mutate(once), second.mutate(once)]);
  const onceState = await second.read();
  if (onceState.world.cards.length !== 8 || onceState.world.revision !== 1 || onceState.commandIds.length !== 1) throw new Error('Atomarer Wiederholschutz fehlgeschlagen.');
  await Promise.all([
    first.mutate((state) => { state.world.cards.pop(); return {}; }),
    second.mutate((state) => { state.world.cards.pop(); return {}; }),
  ]);
  const finalState = await first.read();
  if (finalState.world.cards.length !== 6 || finalState.world.revision !== 3) throw new Error('Konkurrierende Änderung fehlgeschlagen.');
  console.log(JSON.stringify({ ok: true, initializedOnce: true, concurrentCas: true, idempotency: true, sharedWorldUntouched: true }));
} catch {
  console.error('Atlas-Prüfung fehlgeschlagen. Bitte Zugangsdaten, Netzwerkfreigabe und Datenbankrechte prüfen. Es wurden keine Zugangsdaten ausgegeben.');
  process.exitCode = 1;
} finally {
  if (repositories[0]?.collection && temporaryId) await repositories[0].collection.deleteOne({ _id: temporaryId }).catch(() => {});
  await Promise.all(repositories.map((repository) => repository.close().catch(() => {})));
}
