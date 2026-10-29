import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { joinPlayer, applyCommand, advanceWorld, nextWakeAt, publicWorld } from '@stackfriends/shared/game.js';
import { MAX_COMMANDS, LOCK_TTL } from './config.js';
import { createRepository } from './repository.js';
import { Realtime } from './realtime.js';

export function errorWithStatus(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function validateName(input) {
  if (typeof input !== 'string') throw errorWithStatus('Bitte gib deinen Namen ein.');
  const name = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24 || !/^[\p{L}\p{N} ._'’-]+$/u.test(name)) {
    throw errorWithStatus('Dein Name muss 1–24 Zeichen lang sein und darf Buchstaben, Zahlen, Leerzeichen, Bindestriche und Punkte enthalten.');
  }
  return name;
}

export const hashToken = (token) => typeof token === 'string' && token.length < 200
  ? createHash('sha256').update(token).digest('hex') : null;

function playerFromSession(state, hash) {
  const session = hash && state.sessions[hash];
  const player = session && state.world.players.find((entry) => entry.id === session.playerId);
  return player || null;
}

function makePatch(beforeWorld, afterWorld) {
  const before = publicWorld(beforeWorld);
  const after = publicWorld(afterWorld);
  const oldCards = new Map(before.cards.map((card) => [card.id, JSON.stringify(card)]));
  const newIds = new Set(after.cards.map((card) => card.id));
  const changes = {};
  for (const [key, value] of Object.entries(after)) {
    if (key !== 'cards' && key !== 'revision' && JSON.stringify(before[key]) !== JSON.stringify(value)) changes[key] = value;
  }
  return {
    type: 'patch', baseRevision: before.revision, revision: after.revision,
    upsert: after.cards.filter((card) => oldCards.get(card.id) !== JSON.stringify(card)),
    remove: before.cards.filter((card) => !newIds.has(card.id)).map((card) => card.id), changes,
  };
}

export class GameService extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.now = options.now || Date.now;
    this.rng = options.rng || Math.random;
    this.repository = options.repository;
    this.realtime = options.realtime;
    this.leases = new Map();
    this.leaseTimers = new Map();
    this.eventWorlds = new WeakMap();
    this.latestScheduledRevision = -1;
    this.timer = null;
    this.closed = false;
    this.metrics = { acceptedCommands: 0, duplicateCommands: 0, scheduledEvents: 0 };
  }

  async init() {
    this.repository ||= await createRepository(this.config, this.now);
    if (!this.realtime) {
      try {
        this.realtime = await new Realtime(this.config, this.now, {
          database: this.repository.client?.db(this.repository.database),
          worldId: this.repository.worldId,
        }).init();
      } catch (error) {
        await this.repository.close();
        throw error;
      }
    }
    this.realtime.on('event', (event) => {
      this.emit('event', event);
      if (event.type === 'patch' && event.revision >= this.latestScheduledRevision) {
        this.latestScheduledRevision = event.revision;
        this.schedule(this.eventWorlds.get(event)).catch((error) => this.emit('fault', error));
      }
    });
    this.realtime.on('resync', () => {
      this.emit('resync');
      // A world commit can survive its publisher. Recover its pending jobs as
      // well as the clients' view, even if no subsequent player action occurs.
      this.schedule().catch((error) => this.emit('fault', error));
    });
    this.realtime.on('unavailable', () => this.emit('unavailable'));
    return this;
  }

  async commit(change) {
    const result = await this.repository.mutate(change);
    if (result.changed) {
      const online = await this.realtime.online().catch(() => ({ players: [] }));
      const event = { ...makePatch(result.before, result.world), serverTime: this.now(), mode: this.config.mode, online: online.players };
      // Local scheduling can reuse this exact commit. Foreign events still read
      // MongoDB, and an older publication cannot replace a newer timer.
      this.eventWorlds.set(event, result.world);
      try { await this.realtime.publish(event); }
      finally { this.eventWorlds.delete(event); }
    }
    return result;
  }

  advance(state, now, activeUntil) {
    const until = Math.max(state.activeUntil || 0, activeUntil || 0);
    return advanceWorld(state.world, now, { activeUntil: until, rng: this.rng });
  }

  async snapshot(token, reconcile = true) {
    const presence = await this.realtime.online();
    let world;
    let player;
    if (reconcile) {
      const result = await this.commit((state) => {
        const changed = this.advance(state, this.now(), presence.activeUntil);
        if (changed) state.activeUntil = presence.activeUntil || Math.min(this.now(), state.activeUntil || 0);
        return { changed, value: playerFromSession(state, hashToken(token)) };
      });
      world = result.world;
      player = result.result;
    } else {
      const state = await this.repository.read();
      world = state.world;
      player = playerFromSession(state, hashToken(token));
    }
    return {
      player, world: publicWorld(world),
      mode: this.config.mode, serverTime: this.now(), online: presence.players,
    };
  }

  async join(nameInput) {
    const name = validateName(nameInput);
    const token = randomBytes(32).toString('base64url');
    const hash = hashToken(token);
    const presence = await this.realtime.online();
    const now = this.now();
    const result = await this.commit((state) => {
      this.advance(state, now, presence.activeUntil);
      const player = joinPlayer(state.world, name, now);
      state.sessions[hash] = { playerId: player.id, createdAt: now };
      // Bound cookie records without ever altering the players or their human cards.
      const sessions = Object.entries(state.sessions);
      if (sessions.length > 5_000) {
        sessions.sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (const [id] of sessions.slice(0, sessions.length - 5_000)) delete state.sessions[id];
      }
      state.activeUntil = presence.activeUntil || now;
      return { value: player };
    });
    return { token, player: result.result, world: publicWorld(result.world), mode: this.config.mode, serverTime: now, online: presence.players };
  }

  async authenticate(token) {
    const player = await this.repository.playerForSession(hashToken(token));
    if (!player) throw errorWithStatus('Bitte gib zuerst deinen Namen ein.', 401);
    return player;
  }

  async connect(connectionId, player) {
    const previous = await this.realtime.online();
    const now = this.now();
    // Reconcile the paused interval BEFORE the new connection starts world time.
    const result = await this.commit((state) => {
      this.advance(state, now, previous.activeUntil);
      state.activeUntil = Math.max(previous.activeUntil, now + 15_000);
    });
    await this.realtime.touch(connectionId, player);
    await this.publishPresence();
    await this.schedule(result.world);
  }

  async disconnect(connectionId, lastPresenceUntil = 0) {
    const before = await this.realtime.online();
    await this.realtime.remove(connectionId);
    for (const [id, lease] of this.leases) {
      if (lease.connectionId === connectionId) {
        this.leases.delete(id);
        await this.realtime.publish({ type: 'drag-end', cardId: id, playerId: lease.playerId });
      }
    }
    const after = await this.realtime.online();
    const now = this.now();
    await this.commit((state) => {
      this.advance(state, now, Math.max(before.activeUntil, lastPresenceUntil));
      state.activeUntil = after.activeUntil || now;
    });
    await this.publishPresence();
  }

  async publishPresence() {
    const online = await this.realtime.online();
    await this.realtime.publish({ type: 'presence', online: online.players, serverTime: this.now() });
  }

  async execute(token, command, commandId, connectionId) {
    if (typeof commandId !== 'string' || commandId.length < 1 || commandId.length > 100) throw errorWithStatus('Die Aktion benötigt eine gültige Kennung.');
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw errorWithStatus('Ungültige Spielaktion.');
    if (!['move', 'open-pack', 'withdraw', 'harvest', 'unequip', 'catalog-save'].includes(command.type)) throw errorWithStatus('Unbekannte Spielaktion.');
    const commandLimit = command.type === 'catalog-save' ? 256 * 1024 - 1024 : 24 * 1024;
    if (Buffer.byteLength(JSON.stringify(command), 'utf8') > commandLimit) throw errorWithStatus(command.type === 'catalog-save' ? 'Die Einstellungen sind zu groß. Bitte verwende weniger Einträge oder kürzere Texte.' : 'Die Spielaktion ist zu groß.', 413);
    const hash = hashToken(token);
    const state = await this.repository.commandContext(hash);
    const player = playerFromSession(state, hash);
    if (!player) throw errorWithStatus('Bitte gib zuerst deinen Namen ein.', 401);
    const owner = connectionId || `http-${randomUUID()}`;
    const involved = new Set();
    for (const id of command.type === 'catalog-save' ? [] : [command.cardId, command.targetId]) {
      if (id == null) continue;
      if (typeof id !== 'string' || id.length > 100) throw errorWithStatus('Ungültige Kartenkennung.');
      const card = state.world.cards.find((entry) => entry.id === id);
      if (card) for (const entry of state.world.cards) if (entry.stackId === card.stackId || entry.id === id) involved.add(entry.id);
    }
    const ids = [...involved];
    if (ids.length && !(await this.realtime.acquire(ids, owner, player.id))) throw errorWithStatus('Diesen Stapel bewegt gerade jemand anderes.', 409);
    const presence = await this.realtime.online();
    const now = this.now();
    try {
      const result = await this.commit((draft) => {
        const current = playerFromSession(draft, hash);
        if (!current) throw errorWithStatus('Deine Sitzung ist abgelaufen. Bitte gib deinen Namen erneut ein.', 401);
        const key = `${current.id}:${commandId}`;
        const duplicate = draft.commandIds.find((entry) => entry.id === key);
        if (duplicate) return { changed: false, value: { message: duplicate.message, duplicate: true } };
        this.advance(draft, now, presence.activeUntil);
        const outcome = applyCommand(draft.world, command, { playerId: current.id, now, rng: this.rng });
        const message = typeof outcome === 'string' ? outcome : outcome?.message;
        draft.commandIds.push({ id: key, at: now, message });
        draft.commandIds = draft.commandIds.slice(-MAX_COMMANDS);
        draft.activeUntil = presence.activeUntil || now;
        return { value: { message } };
      });
      if (result.result?.duplicate) this.metrics.duplicateCommands++;
      else this.metrics.acceptedCommands++;
      return { world: publicWorld(result.world), message: result.result?.message, duplicate: result.result?.duplicate || false };
    } finally {
      await this.realtime.release(ids, owner, player.id).catch(() => {});
      const lease = this.leases.get(command.cardId);
      if (lease?.connectionId === owner) {
        this.leases.delete(command.cardId);
        await this.realtime.publish({ type: 'drag-end', cardId: command.cardId, playerId: player.id });
      }
    }
  }

  async dragStart(connectionId, player, cardId, split = false, takeAbove = false) {
    if (typeof cardId !== 'string' || cardId.length > 100) throw errorWithStatus('Ungültige Karte.');
    const world = await this.repository.world();
    const card = world.cards.find((entry) => entry.id === cardId);
    if (!card || card.type === 'rat') throw errorWithStatus('Diese Karte kann nicht bewegt werden.');
    const group = world.cards.filter((entry) => entry.stackId === card.stackId);
    const selected = card.equippedTo ? [card] : takeAbove
      ? group.filter((entry) => !entry.equippedTo && entry.order >= card.order)
      : split ? [card] : group.filter((entry) => !entry.equippedTo);
    const selectedIds = new Set(selected.map((entry) => entry.id));
    const cardIds = world.cards.filter((entry) => selectedIds.has(entry.id) || (!card.equippedTo && selectedIds.has(entry.equippedTo))).map((entry) => entry.id);
    if (selected.some((entry) => entry.type === 'rat')) throw errorWithStatus('Ratten bewegen sich selbst. Greife eine Karte oberhalb der Ratte.');
    const ids = takeAbove ? cardIds : group.map((entry) => entry.id);
    if (!(await this.realtime.acquire(ids, connectionId, player.id))) throw errorWithStatus('Diesen Stapel bewegt gerade jemand anderes.', 409);
    this.leases.set(cardId, { ids, cardIds, split: Boolean(split), takeAbove: Boolean(takeAbove), connectionId, playerId: player.id, expiresAt: this.now() + LOCK_TTL, lastSent: 0 });
    this.expireLease(cardId);
    await this.realtime.publish({ type: 'lock', cardId, cardIds, split: Boolean(split), takeAbove: Boolean(takeAbove), playerId: player.id, expiresAt: this.now() + LOCK_TTL });
  }

  async drag(connectionId, player, message) {
    const lease = this.leases.get(message.cardId);
    if (!lease || lease.connectionId !== connectionId || lease.expiresAt <= this.now()) throw errorWithStatus('Die Ziehreservierung ist abgelaufen.');
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y) || Math.abs(message.x) > 20_000 || Math.abs(message.y) > 20_000) throw errorWithStatus('Ungültige Kartenposition.');
    if (this.now() - lease.lastSent < 100) return;
    if (lease.expiresAt - this.now() < LOCK_TTL / 2) {
      if (!(await this.realtime.acquire(lease.ids, connectionId, player.id))) throw errorWithStatus('Die Karte ist inzwischen anderweitig reserviert.');
      lease.expiresAt = this.now() + LOCK_TTL;
    }
    lease.lastSent = this.now();
    await this.realtime.publish({ type: 'drag', cardId: message.cardId, cardIds: lease.cardIds, split: lease.split, takeAbove: lease.takeAbove, x: message.x, y: message.y, playerId: player.id, connectionId });
  }

  async dragEnd(connectionId, player, cardId) {
    const lease = this.leases.get(cardId);
    if (lease?.connectionId === connectionId) {
      await this.realtime.release(lease.ids, connectionId, player.id);
      this.leases.delete(cardId);
      await this.realtime.publish({ type: 'drag-end', cardId, playerId: player.id });
    }
  }

  expireLease(cardId) {
    clearTimeout(this.leaseTimers.get(cardId));
    const lease = this.leases.get(cardId);
    if (!lease || this.closed) return;
    const timer = setTimeout(async () => {
      const current = this.leases.get(cardId);
      if (!current) return this.leaseTimers.delete(cardId);
      if (current.expiresAt > this.now()) return this.expireLease(cardId);
      this.leases.delete(cardId);
      this.leaseTimers.delete(cardId);
      await this.realtime.release(current.ids, current.connectionId, current.playerId).catch(() => {});
      await this.realtime.publish({ type: 'drag-end', cardId, playerId: current.playerId });
    }, Math.max(10, lease.expiresAt - this.now()));
    timer.unref?.();
    this.leaseTimers.set(cardId, timer);
  }

  async schedule(knownWorld) {
    if (knownWorld && knownWorld.revision < this.latestScheduledRevision) return;
    clearTimeout(this.timer);
    const generation = this.scheduleGeneration = (this.scheduleGeneration || 0) + 1;
    if (this.closed) return;
    const online = await this.realtime.online();
    if (generation !== this.scheduleGeneration || this.closed) return;
    if (!online.players.length) return;
    const world = knownWorld || await this.repository.world();
    if (generation !== this.scheduleGeneration || this.closed) return;
    if (world.revision < this.latestScheduledRevision) return;
    this.latestScheduledRevision = world.revision;
    const wake = nextWakeAt(world, this.now());
    if (generation !== this.scheduleGeneration || this.closed) return;
    if (wake == null || !Number.isFinite(wake)) return;
    const delay = Math.max(20, Math.min(wake - this.now(), 2_147_000_000));
    this.timer = setTimeout(() => this.runScheduled().catch((error) => this.emit('fault', error)), delay);
    this.timer.unref?.();
  }

  async runScheduled() {
    if (this.closed) return;
    const online = await this.realtime.online();
    if (!online.players.length) return;
    const revision = await this.repository.revision();
    if (!(await this.realtime.claimEvent(revision))) {
      this.timer = setTimeout(() => this.runScheduled().catch((error) => this.emit('fault', error)), 5_050);
      this.timer.unref?.();
      return;
    }
    const result = await this.commit((draft) => {
      const changed = this.advance(draft, this.now(), online.activeUntil);
      if (changed) draft.activeUntil = online.activeUntil;
      return { changed };
    });
    this.metrics.scheduledEvents++;
    if (!result.changed) await this.schedule(result.world);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const timer of this.leaseTimers.values()) clearTimeout(timer);
    await this.realtime.close();
    await this.repository.close();
  }
}
