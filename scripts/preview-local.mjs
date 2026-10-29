import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../server/app.js';
import { readConfig } from '../server/config.js';

const frontendDist = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
if (!existsSync(path.join(frontendDist, 'index.html'))) {
  throw new Error('Bitte zuerst im Frontend npm run build ausführen oder FRONTEND_DIST auf einen fertigen Build setzen.');
}
const port = Number(process.env.LOCAL_PREVIEW_PORT || 3003);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Ungültiger lokaler Vorschau-Port.');
const config = { ...readConfig({}), port };
const game = await createGameServer({ config, staticDirectory: frontendDist });
game.server.listen(port, '127.0.0.1', () => console.log(`StackFriends – lokale Dateiwelt: http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await game.close();
  process.exit(0);
});
