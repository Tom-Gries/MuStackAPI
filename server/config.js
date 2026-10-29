import { fileURLToPath } from 'node:url';

export const PRESENCE_TTL = 15_000;
export const HEARTBEAT_MS = 5_000;
export const LOCK_TTL = 10_000;
export const MAX_COMMANDS = 2_000;

export function resolveMongoUri(env) {
  if (!env.MONGODB_URI) return undefined;
  const uri = env.MONGODB_URI.trim();
  if (/[<>{}]/.test(uri)) throw new Error('MONGODB_URI enthält Platzhalter. Bitte eine vollständige MongoDB-Verbindungsadresse verwenden.');
  return uri || undefined;
}

export function readConfig(env = process.env) {
  const mongoUri = resolveMongoUri(env);
  const mongoDatabase = env.MONGODB_DB?.trim() || 'StackFriends-dev';
  const cloud = env.VERCEL === '1' || Boolean(mongoUri);
  if (env.VERCEL === '1' && !mongoUri) {
    throw new Error('Für den Cloudbetrieb ist MONGODB_URI erforderlich. Lokaler Dateispeicher ist auf Vercel deaktiviert.');
  }
  let socketOrigin;
  if (env.API_ORIGIN) {
    let address;
    try { address = new URL(env.API_ORIGIN); } catch { throw new Error('API_ORIGIN muss eine gültige HTTP- oder HTTPS-Adresse sein.'); }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') throw new Error('API_ORIGIN muss nur den Ursprung der API enthalten, zum Beispiel https://api.example.com.');
    if (address.protocol === 'http:' && (env.VERCEL === '1' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))) throw new Error('API_ORIGIN benötigt HTTPS. HTTP ist nur in der lokalen Entwicklung auf localhost erlaubt.');
    socketOrigin = address.origin;
  }
  return {
    mode: cloud ? 'cloud' : 'local',
    mongoUri,
    mongoDatabase,
    worldFile: env.WORLD_FILE || fileURLToPath(new URL('../.data/world.json', import.meta.url)),
    port: Number(env.PORT || 3001),
    secureCookie: env.VERCEL === '1',
    publicOrigin: env.APP_ORIGIN,
    socketOrigin,
  };
}
