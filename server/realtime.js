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
const SOCKET_TICKET_TTL = 30_000;

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
    this.metrics = { publications: 0, dragPreviews: 0, publicationBytes: 0 };
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
      await this.redis.multi()
        .zadd(`${this.prefix}presence`, expiresAt, connectionId)
        .hset(`${this.prefix}people`, connectionId, JSON.stringify(entry))
        .exec();
    }
    return expiresAt;
  }

  async remove(connectionId) {
    this.presence.delete(connectionId);
    if (this.redis) await this.redis.multi().zrem(`${this.prefix}presence`, connectionId).hdel(`${this.prefix}people`, connectionId).exec();
    await this.releaseOwner(connectionId);
  }

  async online() {
    const now = this.now();
    let entries;
    if (this.redis) {
      const expired = await this.redis.zrangebyscore(`${this.prefix}presence`, '-inf', now);
      if (expired.length) {
        await this.redis.multi().zrem(`${this.prefix}presence`, ...expired).hdel(`${this.prefix}people`, ...expired).exec();
      }
      const ids = await this.redis.zrangebyscore(`${this.prefix}presence`, now + 1, '+inf');
      entries = ids.length ? (await this.redis.hmget(`${this.prefix}people`, ...ids)).filter(Boolean).map(JSON.parse) : [];
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

  async owns(cardIds, connectionId, playerId) {
    const owner = `${connectionId}|${playerId}`;
    if (this.redis) {
      const values = await this.redis.mget(...cardIds.map((id) => `${this.prefix}lock:${id}`));
      return values.every((value) => value === owner);
    }
    return cardIds.every((id) => {
      const lock = this.locks.get(id);
      return lock?.owner === owner && lock.expiresAt > this.now();
    });
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
