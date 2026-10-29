import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { LOCK_TTL, PRESENCE_TTL } from './config.js';
import { MongoRealtimeStore } from './mongo-realtime.js';

export const SOCKET_TICKET_TTL = 30_000;

export class Realtime extends EventEmitter {
  constructor(config, now = Date.now, options = {}) {
    super();
    this.config = config;
    this.now = now;
    this.instanceId = randomUUID();
    this.store = options.store || (options.database ? new MongoRealtimeStore(options.database, {
      worldId: options.worldId || config.worldId || 'shared', instanceId: this.instanceId, now,
    }) : null);
    this.presence = new Map();
    this.locks = new Map();
    this.socketTickets = new Map();
    this.connectionTasks = new Map();
    this.watchTask = Promise.resolve();
    this.closed = false;
    this.metrics = { publications: 0, dragPreviews: 0, publicationBytes: 0, presenceReads: 0, presenceWrites: 0 };
  }

  async init() {
    if (this.config.mongoUri && !this.store) throw new Error('Die Echtzeitverbindung benötigt die MongoDB-Verbindung des Weltspeichers.');
    await this.store?.init();
    return this;
  }

  connectionTask(connectionId, operation) {
    const task = (this.connectionTasks.get(connectionId) || Promise.resolve()).catch(() => {}).then(operation);
    this.connectionTasks.set(connectionId, task);
    task.finally(() => {
      if (this.connectionTasks.get(connectionId) === task) this.connectionTasks.delete(connectionId);
    }).catch(() => {});
    return task;
  }

  updateWatch() {
    if (!this.store) return Promise.resolve();
    const task = this.watchTask.catch(() => {}).then(() => this.closed || !this.presence.size
      ? this.store.stop()
      : this.store.start((event) => this.emit('event', event), () => this.emit('unavailable'), () => this.emit('resync')));
    this.watchTask = task;
    return task;
  }

  async publish(event) {
    this.emit('event', event);
    this.metrics.publications++;
    this.metrics.publicationBytes += Buffer.byteLength(JSON.stringify({ instanceId: this.instanceId, event }));
    if (event.type === 'drag') this.metrics.dragPreviews++;
    if (this.store) {
      try { await this.store.publish(event); }
      catch { this.emit('unavailable'); }
    }
  }

  async issueSocketTicket(token) {
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + SOCKET_TICKET_TTL;
    if (this.store) await this.store.issueSocketTicket(ticket, token, expiresAt);
    else {
      for (const [key, entry] of this.socketTickets) if (entry.expiresAt <= this.now()) this.socketTickets.delete(key);
      while (this.socketTickets.size >= 1000) this.socketTickets.delete(this.socketTickets.keys().next().value);
      this.socketTickets.set(ticket, { token, expiresAt });
    }
    return ticket;
  }

  async consumeSocketTicket(ticket) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(ticket)) return undefined;
    if (this.store) return this.store.consumeSocketTicket(ticket);
    const entry = this.socketTickets.get(ticket);
    this.socketTickets.delete(ticket);
    return entry?.expiresAt > this.now() ? entry.token : undefined;
  }

  touch(connectionId, player) {
    return this.connectionTask(connectionId, async () => {
      if (this.closed) throw new Error('Die Echtzeitverbindung ist geschlossen.');
      const expiresAt = this.now() + PRESENCE_TTL;
      if (this.store) {
        await this.store.touch(connectionId, player, expiresAt);
        this.metrics.presenceWrites++;
      }
      this.presence.set(connectionId, { connectionId, id: player.id, name: player.name, expiresAt });
      await this.updateWatch();
      return expiresAt;
    });
  }

  remove(connectionId) {
    return this.connectionTask(connectionId, async () => {
      this.presence.delete(connectionId);
      try {
        if (this.store) {
          await this.store.remove(connectionId);
          this.metrics.presenceWrites++;
        }
        await this.releaseOwner(connectionId);
      } finally { await this.updateWatch(); }
    });
  }

  async online() {
    if (this.store) {
      this.metrics.presenceReads++;
      return this.store.online();
    }
    for (const [id, entry] of this.presence) if (entry.expiresAt <= this.now()) this.presence.delete(id);
    const entries = [...this.presence.values()];
    const players = new Map(entries.map(({ id, name }) => [id, { id, name }]));
    return { players: [...players.values()], activeUntil: Math.max(0, ...entries.map((entry) => entry.expiresAt)) };
  }

  async acquire(cardIds, connectionId, playerId) {
    if (!cardIds.length) return false;
    const ids = [...new Set(cardIds)];
    const owner = `${connectionId}|${playerId}`;
    const expiresAt = this.now() + LOCK_TTL;
    if (this.store) {
      if (!(await this.store.acquire(ids, connectionId, playerId, expiresAt))) return false;
    } else {
      for (const id of ids) {
        const lock = this.locks.get(id);
        if (lock && lock.expiresAt > this.now() && lock.owner !== owner) return false;
      }
    }
    for (const id of ids) this.locks.set(id, { owner, connectionId, playerId, expiresAt });
    return true;
  }

  async release(cardIds, connectionId, playerId) {
    const owner = `${connectionId}|${playerId}`;
    if (this.store && cardIds.length) await this.store.release(cardIds, connectionId, playerId);
    for (const id of cardIds) if (this.locks.get(id)?.owner === owner) this.locks.delete(id);
  }

  async releaseOwner(connectionId) {
    const groups = new Map();
    for (const [id, lock] of this.locks) {
      if (lock.connectionId !== connectionId) continue;
      if (!groups.has(lock.playerId)) groups.set(lock.playerId, []);
      groups.get(lock.playerId).push(id);
    }
    for (const [playerId, ids] of groups) await this.release(ids, connectionId, playerId);
  }

  async claimEvent(revision) { return this.store ? this.store.claimEvent(revision) : true; }

  async close() {
    this.closed = true;
    this.socketTickets.clear();
    await Promise.allSettled([...this.connectionTasks.values()]);
    for (const id of [...this.presence.keys()]) await this.remove(id).catch(() => {});
    await this.watchTask.catch(() => {});
    await this.store?.close();
  }
}
