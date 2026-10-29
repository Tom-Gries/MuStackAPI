import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { LOCK_TTL, PRESENCE_TTL } from './config.js';

const LOCK_SCRIPT = `
  for i,key in ipairs(KEYS) do
    local owner = redis.call('GET', key)
    if owner and owner ~= ARGV[1] then return 0 end
  end
  for i,key in ipairs(KEYS) do redis.call('SET', key, ARGV[1], 'PX', ARGV[2]) end
  return 1
`;
const RELEASE_SCRIPT = `
  for i,key in ipairs(KEYS) do
    if redis.call('GET', key) == ARGV[1] then redis.call('DEL', key) end
  end
  return 1
`;
const CONSUME_TICKET_SCRIPT = `
  local value = redis.call('GET', KEYS[1])
  if value then redis.call('DEL', KEYS[1]) end
  return value
`;
const PRESENCE_SCRIPTS = {
  stackfriendsPresenceTouch: `
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
    redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
    return 1
  `,
  stackfriendsPresenceRemove: `
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('HDEL', KEYS[2], ARGV[1])
    return 1
  `,
  stackfriendsPresenceRead: `
    local now = tonumber(ARGV[1])
    local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
    for _,id in ipairs(expired) do redis.call('HDEL', KEYS[2], id) end
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
    local active = redis.call('ZRANGEBYSCORE', KEYS[1], now + 1, '+inf', 'WITHSCORES')
    local reply = {0}
    local seen = {}
    for i = 1,#active,2 do
      local raw = redis.call('HGET', KEYS[2], active[i])
      local valid, player = false, nil
      if raw then valid, player = pcall(cjson.decode, raw) end
      if valid and type(player) == 'table' and type(player.id) == 'string' and type(player.name) == 'string' then
        reply[1] = math.max(reply[1], tonumber(active[i + 1]))
        if not seen[player.id] then
          seen[player.id] = true
          reply[#reply + 1] = cjson.encode({id = player.id, name = player.name})
        end
      else
        redis.call('ZREM', KEYS[1], active[i])
        redis.call('HDEL', KEYS[2], active[i])
      end
    end
    return reply
  `,
};
export const SOCKET_TICKET_TTL = 30_000;

export class Realtime extends EventEmitter {
  constructor(config, now = Date.now) {
    super();
    this.config = config;
    this.now = now;
    this.instanceId = randomUUID();
    this.prefix = `${config.redisNamespace || `wald-werk:${config.mongoDatabase || 'local'}`}:v1:`;
    this.presence = new Map();
    this.locks = new Map();
    this.socketTickets = new Map();
    this.closed = false;
    this.metrics = { publications: 0, dragPreviews: 0, publicationBytes: 0, presenceReads: 0, presenceWrites: 0 };
  }

  async init() {
    if (this.config.redisUrl) {
      const options = { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true, retryStrategy: (times) => Math.min(times * 500, 5_000) };
      this.redis = new Redis(this.config.redisUrl, options);
      this.subscriber = new Redis(this.config.redisUrl, options);
      for (const connection of [this.redis, this.subscriber]) {
        connection.on('error', () => this.emit('unavailable'));
      }
      this.subscriber.on('message', (_channel, data) => {
        try {
          const envelope = JSON.parse(data);
          if (envelope.instanceId !== this.instanceId) this.emit('event', envelope.event);
        } catch { /* Ignore malformed messages outside the application protocol. */ }
      });
      this.subscriber.on('ready', () => {
        if (this.started) this.emit('resync');
      });
      await Promise.all([this.redis.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(`${this.prefix}events`);
      this.started = true;
    }
    return this;
  }

  async publish(event) {
    this.emit('event', event);
    const encoded = JSON.stringify({ instanceId: this.instanceId, event });
    this.metrics.publications++;
    this.metrics.publicationBytes += Buffer.byteLength(encoded);
    if (event.type === 'drag') this.metrics.dragPreviews++;
    if (this.redis) {
      try { await this.redis.publish(`${this.prefix}events`, encoded); }
      catch { this.emit('unavailable'); }
    }
  }

  async issueSocketTicket(token) {
    const ticket = randomBytes(24).toString('base64url');
    const entry = { token, expiresAt: this.now() + SOCKET_TICKET_TTL };
    if (this.redis) await this.redis.set(`${this.prefix}socket-ticket:${ticket}`, JSON.stringify(entry), 'PX', SOCKET_TICKET_TTL);
    else {
      for (const [key, previous] of this.socketTickets) if (previous.expiresAt <= this.now()) this.socketTickets.delete(key);
      while (this.socketTickets.size >= 1000) this.socketTickets.delete(this.socketTickets.keys().next().value);
      this.socketTickets.set(ticket, entry);
    }
    return ticket;
  }

  async consumeSocketTicket(ticket) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(ticket)) return undefined;
    let entry;
    if (this.redis) {
      const serialized = await this.redis.eval(CONSUME_TICKET_SCRIPT, 1, `${this.prefix}socket-ticket:${ticket}`);
      if (!serialized) return undefined;
      try { entry = JSON.parse(serialized); } catch { return undefined; }
    } else {
      entry = this.socketTickets.get(ticket);
      this.socketTickets.delete(ticket);
    }
    return entry?.expiresAt > this.now() ? entry.token : undefined;
  }

  async touch(connectionId, player) {
    const expiresAt = this.now() + PRESENCE_TTL;
    const entry = { connectionId, id: player.id, name: player.name, expiresAt };
    this.presence.set(connectionId, entry);
    if (this.redis) {
      // Keep expiresAt for API instances from the previous deployment; the
      // new atomic reader uses the sorted-set score as its source of truth.
      await this.presenceCommand('stackfriendsPresenceTouch', expiresAt, connectionId, JSON.stringify({ id: player.id, name: player.name, expiresAt }));
      this.metrics.presenceWrites++;
    }
    return expiresAt;
  }

  async remove(connectionId) {
    this.presence.delete(connectionId);
    if (this.redis) {
      await this.presenceCommand('stackfriendsPresenceRemove', connectionId);
      this.metrics.presenceWrites++;
    }
    await this.releaseOwner(connectionId);
  }

  presenceCommand(name, ...args) {
    if (typeof this.redis[name] !== 'function') {
      // ioredis caches the script per connection and uses EVALSHA after the
      // first call, including recovery after Redis clears its script cache.
      this.redis.defineCommand(name, { numberOfKeys: 2, lua: PRESENCE_SCRIPTS[name] });
    }
    return this.redis[name](`${this.prefix}presence`, `${this.prefix}people`, ...args);
  }

  async online() {
    const now = this.now();
    let entries;
    if (this.redis) {
      // Expiry cleanup and the snapshot are one atomic operation: another
      // instance cannot refresh a connection between the scan and deletion.
      const [activeUntil, ...players] = await this.presenceCommand('stackfriendsPresenceRead', now);
      this.metrics.presenceReads++;
      return { players: players.map(JSON.parse), activeUntil: Number(activeUntil) };
    } else {
      for (const [id, entry] of this.presence) if (entry.expiresAt <= now) this.presence.delete(id);
      entries = [...this.presence.values()];
    }
    const players = new Map(entries.map(({ id, name }) => [id, { id, name }]));
    return { players: [...players.values()], activeUntil: Math.max(0, ...entries.map((entry) => entry.expiresAt)) };
  }

  async acquire(cardIds, connectionId, playerId) {
    if (!cardIds.length) return false;
    const owner = `${connectionId}|${playerId}`;
    const expiresAt = this.now() + LOCK_TTL;
    if (this.redis) {
      const accepted = await this.redis.eval(LOCK_SCRIPT, cardIds.length, ...cardIds.map((id) => `${this.prefix}lock:${id}`), owner, LOCK_TTL);
      if (!accepted) return false;
    } else {
      for (const id of cardIds) {
        const lock = this.locks.get(id);
        if (lock && lock.expiresAt > this.now() && lock.owner !== owner) return false;
      }
    }
    for (const id of cardIds) this.locks.set(id, { owner, connectionId, playerId, expiresAt });
    return true;
  }

  async release(cardIds, connectionId, playerId) {
    const owner = `${connectionId}|${playerId}`;
    if (this.redis && cardIds.length) await this.redis.eval(RELEASE_SCRIPT, cardIds.length, ...cardIds.map((id) => `${this.prefix}lock:${id}`), owner);
    for (const id of cardIds) if (this.locks.get(id)?.owner === owner) this.locks.delete(id);
  }

  async releaseOwner(connectionId) {
    const owned = [...this.locks.entries()].filter(([, lock]) => lock.connectionId === connectionId);
    const groups = new Map();
    for (const [id, lock] of owned) {
      if (!groups.has(lock.playerId)) groups.set(lock.playerId, []);
      groups.get(lock.playerId).push(id);
    }
    for (const [playerId, ids] of groups) await this.release(ids, connectionId, playerId);
  }

  async claimEvent(revision) {
    if (!this.redis) return true;
    return (await this.redis.set(`${this.prefix}event:${revision}`, this.instanceId, 'PX', 5_000, 'NX')) === 'OK';
  }

  async close() {
    this.closed = true;
    this.socketTickets.clear();
    for (const id of [...this.presence.keys()]) await this.remove(id).catch(() => {});
    await Promise.all([this.redis?.quit(), this.subscriber?.quit()]);
  }
}
