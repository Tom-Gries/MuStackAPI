import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app.js';
import { readConfig } from './config.js';

// Resolve repository-local environment files independently of the shell's cwd.
// Vercel supplies environment variables directly.
for (const filename of ['.env.local', '.env']) dotenv.config({ path: fileURLToPath(new URL(`../${filename}`, import.meta.url)), override: false });

async function main() {
  const config = readConfig(process.argv.includes('--local')
    ? { PORT: process.env.PORT, WORLD_FILE: process.env.WORLD_FILE }
    : process.env);
  const game = await createGameServer({ config });
  game.server.listen(config.port, '127.0.0.1', () => {
    const storage = config.mongoUri ? `MongoDB${config.redisUrl ? ' + Redis' : ', lokaler Echtzeitverteiler'}` : 'lokaler, gespeicherter Weltstand';
    console.log(`StackFriends: http://127.0.0.1:${config.port} (${storage})`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await game.close();
    process.exit(0);
  });
}

main().catch(() => {
  // Connection libraries can include a complete URI in diagnostics. Never log it.
  console.error('StackFriends konnte nicht starten. Bitte MongoDB-/Redis-Konfiguration, Netzwerkfreigabe und Datenbankrechte prüfen.');
  process.exitCode = 1;
});
