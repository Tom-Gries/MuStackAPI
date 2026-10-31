import { createGameServer } from '../server/app.js';
import { startupErrorCode } from '../server/startup-error.js';

// One reusable Node HTTP server handles short requests for personal worlds.
// Vercel routes every /api/* request to this function.
const game = await createGameServer().catch((error) => {
  const code = startupErrorCode(error);
  // Never log the original driver error: it can include connection credentials.
  console.error(`STACKFRIENDS_STARTUP_ERROR ${code}`);
  throw new Error(`StackFriends konnte den Cloudspeicher nicht verbinden (${code}). MONGODB_URI, Netzwerkfreigabe und Datenbankrechte prüfen.`);
});
export default game.server;
