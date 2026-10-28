import { createGameServer } from '../server/app.js';

// Vercel's Node runtime accepts an http.Server and forwards WebSocket upgrades.
// Route every /api/* request to this function, including /api/socket itself.
const game = await createGameServer().catch(() => {
  throw new Error('StackFriends konnte den Cloudspeicher nicht verbinden. MONGODB_URI, REDIS_URL und Netzwerkfreigabe prüfen.');
});
export default game.server;
