import { fileURLToPath } from 'node:url';

export const PRESENCE_TTL = 15_000;
export const HEARTBEAT_MS = 5_000;
export const LOCK_TTL = 10_000;
export const MAX_COMMANDS = 2_000;

export function resolveMongoUri(env) {
  if (!env.MONGODB_URI) return undefined;
  let uri = env.MONGODB_URI.trim();
  const placeholders = [
    [/<(?:db_)?username>|\{username\}|\$\{MONGODB_USERNAME\}/gi, env.MONGODB_USERNAME],
    [/<(?:db_)?password>|\{password\}|\$\{MONGODB_PASSWORD\}/gi, env.MONGODB_PASSWORD],
  ];
  for (const [pattern, value] of placeholders) {
    if (!pattern.test(uri)) continue;
    if (!value) throw new Error('Die MongoDB-Adresse enthält einen Platzhalter ohne zugehörige Zugangsdaten.');
    pattern.lastIndex = 0;
    uri = uri.replace(pattern, () => encodeURIComponent(value));
  }
  return uri;
}

export function readConfig(env = process.env) {
  const cloud = env.VERCEL === '1' || Boolean(env.MONGODB_URI);
  if (env.VERCEL === '1' && (!env.MONGODB_URI || !env.REDIS_URL)) {
    throw new Error('Für den Cloudbetrieb sind MONGODB_URI und REDIS_URL erforderlich. Lokaler Dateispeicher ist auf Vercel deaktiviert.');
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
    mongoUri: resolveMongoUri(env),
    mongoDatabase: env.MONGODB_DB || env.MONGODB_DATABASE || 'StackFriends-dev',
    redisUrl: env.REDIS_URL,
    redisNamespace: env.REDIS_NAMESPACE || `stackfriends:${env.MONGODB_DB || env.MONGODB_DATABASE || 'StackFriends-dev'}`,
    worldFile: env.WORLD_FILE || fileURLToPath(new URL('../.data/world.json', import.meta.url)),
    port: Number(env.PORT || 3001),
    secureCookie: env.VERCEL === '1' || env.COOKIE_SECURE === 'true',
    publicOrigin: env.APP_ORIGIN || env.PUBLIC_ORIGIN,
    socketOrigin,
  };
}
