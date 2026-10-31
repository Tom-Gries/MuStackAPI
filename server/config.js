import { fileURLToPath } from 'node:url';

export const SYNC_INTERVAL_MS = 60_000;
export const ACTIVE_LEASE_MS = 65_000;
export const PRESENCE_LEASE_MS = 125_000;
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
  if (env.APP_ORIGIN) {
    let address;
    try { address = new URL(env.APP_ORIGIN); } catch { throw new Error('APP_ORIGIN muss eine gültige HTTP- oder HTTPS-Adresse sein.'); }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') throw new Error('APP_ORIGIN muss nur den Ursprung des Frontends enthalten.');
  }
  return {
    mode: cloud ? 'cloud' : 'local',
    mongoUri,
    mongoDatabase,
    worldFile: env.WORLD_FILE || fileURLToPath(new URL('../.data/personal-worlds.json', import.meta.url)),
    legacyWorldFile: fileURLToPath(new URL('../.data/world.json', import.meta.url)),
    port: Number(env.PORT || 3001),
    secureCookie: env.VERCEL === '1',
    publicOrigin: env.APP_ORIGIN,
  };
}
