import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app.js';
import { readConfig } from './config.js';

// Resolve independently of the shell's cwd. Load repository-local credentials as
// a local fallback; Vercel uses its environment and never needs these files.
for (const base of ['../']) for (const filename of ['.env.local', '.env', 'atlas-credentials.env']) dotenv.config({ path: fileURLToPath(new URL(`${base}${filename}`, import.meta.url)), override: false });

async function main() {
  const config = readConfig();
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
