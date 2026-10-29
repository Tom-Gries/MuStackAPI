import { createGameServer } from '../server/app.js';
import { startupErrorCode } from '../server/startup-error.js';

// Vercel's Node runtime accepts an http.Server and forwards WebSocket upgrades.
// Route every /api/* request to this function, including /api/socket itself.
const game = await createGameServer().catch((error) => {
  const code = startupErrorCode(error);
  // Never log the original driver error: it can include connection credentials.
  console.error(`STACKFRIENDS_STARTUP_ERROR ${code}`);
  throw new Error(`StackFriends konnte den Cloudspeicher nicht verbinden (${code}). MONGODB_URI, Netzwerkfreigabe und Datenbankrechte prüfen.`);
});
export default game.server;
