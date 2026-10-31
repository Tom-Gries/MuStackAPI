import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { applyCommand, advanceWorld, nextWakeAt, publicWorld } from '@stackfriends/shared/game.js';
import { getCatalog, validateCatalog } from '@stackfriends/shared/catalog.js';
import { createPersonalWorld, summarizeMaterials, takeGiftCards, receiveGiftCards } from '@stackfriends/shared/personal-world.js';
import { MAX_COMMANDS, SYNC_INTERVAL_MS, ACTIVE_LEASE_MS, PRESENCE_LEASE_MS } from './config.js';
import { createRepository } from './repository.js';

export const errorWithStatus = (message, status = 400) => Object.assign(new Error(message), { status });
export function validateName(input) {
  if (typeof input !== 'string') throw errorWithStatus('Bitte gib deinen Namen ein.');
  const name = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24 || !/^[\p{L}\p{N} ._'’-]+$/u.test(name)) throw errorWithStatus('Dein Name muss 1–24 Zeichen lang sein und darf Buchstaben, Zahlen, Leerzeichen, Bindestriche und Punkte enthalten.');
  return name;
}
export const hashToken = (token) => typeof token === 'string' && token.length > 10 && token.length < 200 ? createHash('sha256').update(token).digest('hex') : null;
const signature = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const commandId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:-]{8,128}$/.test(value)) throw errorWithStatus('Die Spielaktion benötigt eine eindeutige Aktions-ID.');
  return value;
};
const profile = (player) => ({ id: player._id, name: player.name, cardId: player.world?.players[0]?.cardId });
function clientKey(value = 'legacy') {
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.id;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw errorWithStatus('Die Browser-ID ist ungültig.');
  return value;
}

export class GameService {
  constructor(config, options = {}) {
    this.config = config; this.now = options.now || Date.now; this.rng = options.rng || Math.random; this.repository = options.repository;
    this.onPlayerOnline = options.onPlayerOnline;
    this.metrics = { acceptedCommands: 0, duplicateCommands: 0, synchronizations: 0, giftsSent: 0 };
  }
  async init() { this.repository ||= await createRepository(this.config, this.now); return this; }
  async requirePlayer(context, token, minimal = false) {
    const hash = hashToken(token);
    const player = hash && await context[minimal ? 'presencePlayer' : 'playerByToken'](hash);
    if (!player) throw errorWithStatus('Bitte melde dich mit deinem Namen an.', 401);
    return player;
  }
  async authenticate(token) { return this.repository.read(async (context) => profile(await this.requirePlayer(context, token, true))); }
  async presenceInfo(context, playerId, now) {
    const onlinePlayers = (await context.presencePlayers(now)).map((player) => ({ id: player._id, name: player.name }));
    return { onlinePlayers, hasOtherPlayersOnline: onlinePlayers.some((player) => player.id !== playerId), presenceIntervalMs: SYNC_INTERVAL_MS };
  }
  touch(player, now, active = true, suppliedClientId, allowResume = true) {
    const clientId = clientKey(suppliedClientId);
    const state = suppliedClientId && typeof suppliedClientId === 'object' ? suppliedClientId : {};
    const epoch = state.epoch;
    if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) throw errorWithStatus('Die Aktivitätsnummer ist ungültig.');
    if (state.active !== undefined && typeof state.active !== 'boolean') throw errorWithStatus('Der Aktivitätsstatus muss wahr oder falsch sein.');
    active = state.active ?? active;
    const clients = Object.fromEntries(Object.entries(player.clients || {}).filter(([, lease]) => lease.lastSeenAt + PRESENCE_LEASE_MS > now));
    const previous = clients[clientId];
    // Keep inactive tombstones until any already-sent HTTP request has expired.
    // A delayed pagehide cannot pause a resumed tab, and an old command cannot
    // resurrect a hidden tab. Legacy clients remain supported independently.
    if (previous?.epoch !== undefined && (epoch === undefined || epoch < previous.epoch || epoch === previous.epoch && previous.active === false && active)) return false;
    const becameOnline = active && !(player.presenceUntil > now);
    clients[clientId] = { active, ...(epoch !== undefined ? { epoch } : {}), presenceUntil: active ? now + PRESENCE_LEASE_MS : now, activeUntil: active && (allowResume || player.activeUntil >= now) ? now + ACTIVE_LEASE_MS : Math.min(now, player.activeUntil || 0), lastSeenAt: now };
    player.clients = Object.fromEntries(Object.entries(clients).sort(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt).slice(0, 32));
    const activeClients = Object.values(player.clients).filter((lease) => lease.active !== false);
    player.presenceUntil = Math.max(now, ...activeClients.map((lease) => lease.presenceUntil));
    player.lastSeenAt = now;
    player.activeUntil = Math.max(Math.min(now, player.activeUntil || 0), ...activeClients.map((lease) => lease.activeUntil));
    return becameOnline;
  }
  async notifyOnline(result) {
    if (result.becameOnline && this.onPlayerOnline) {
      try { await this.onPlayerOnline(result.player); } catch { /* Gameplay remains available if optional notifications fail. */ }
    }
    delete result.becameOnline;
    return result;
  }
  overlay(player, catalog, now) {
    const world = player.world;
    if (getCatalog(world).revision !== catalog.revision) {
      // Reconcile changed recipes/equipment before any old job can complete.
      applyCommand(world, { type: 'catalog-save', catalog, baseCatalogRevision: getCatalog(world).revision }, { playerId: player._id, now, rng: this.rng });
    }
    world.catalog = structuredClone(catalog);
  }
  async collectGifts(context, player, now) {
    const gifts = await context.pendingGifts(player._id), messages = [];
    for (const gift of gifts) {
      receiveGiftCards(player.world, gift.cards, now);
      gift.status = 'delivered'; gift.deliveredAt = now;
      await context.saveGift(gift);
      messages.push({ giftId: gift._id, senderId: gift.senderId, senderName: gift.senderName, count: gift.cards.length, message: `${gift.senderName} hat dir ${gift.cards.length === 1 ? 'eine Karte' : `${gift.cards.length} Karten`} geschenkt.` });
    }
    player.pendingGiftCount = 0;
    return messages;
  }
  async response(context, player, now, extra = {}) {
    return { player: profile(player), world: publicWorld(player.world), mode: this.config.mode, serverTime: now, syncIntervalMs: SYNC_INTERVAL_MS, nextWakeAt: nextWakeAt(player.world, now), hasPendingGifts: (player.pendingGiftCount || 0) > 0, ...(await this.presenceInfo(context, player._id, now)), ...extra };
  }
  async withWorld(token, active, operation, clientId) {
    const now = this.now();
    const result = await this.repository.transaction(async (context) => {
      const player = await this.requirePlayer(context, token), catalog = await context.catalog();
      this.overlay(player, catalog, now);
      advanceWorld(player.world, now, { activeUntil: player.activeUntil || 0, rng: this.rng });
      const giftMessages = await this.collectGifts(context, player, now);
      const extra = operation ? await operation(context, player, catalog, now) : {};
      const becameOnline = this.touch(player, now, active, clientId);
      player.revision++; player.world.revision++; player.lastSavedAt = now;
      await context.savePlayer(player);
      return this.response(context, player, now, { giftMessages, becameOnline, ...extra });
    });
    return this.notifyOnline(result);
  }
  async snapshot(token) {
    if (!hashToken(token)) return { player: null, world: null, mode: this.config.mode, serverTime: this.now(), syncIntervalMs: SYNC_INTERVAL_MS, presenceIntervalMs: SYNC_INTERVAL_MS, onlinePlayers: [], hasOtherPlayersOnline: false };
    try { return await this.repository.read(async (context) => {
      const player = await this.requirePlayer(context, token), catalog = await context.catalog();
      player.world.catalog = catalog;
      return this.response(context, player, this.now());
    }); }
    catch (error) { if (error.status === 401) return this.snapshot(); throw error; }
  }
  async join(input, clientId) {
    clientKey(clientId);
    const name = validateName(input), nameKey = name.toLocaleLowerCase('de-DE'), token = randomBytes(32).toString('base64url'), now = this.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.repository.transaction(async (context) => {
          const catalog = await context.catalog();
          let player = await context.playerByName(nameKey);
          if (!player) {
            player = { _id: randomUUID(), name, nameKey, tokenHashes: [], commandIds: [], revision: 0, createdAt: now, lastSavedAt: now, activeUntil: now };
            player.world = createPersonalWorld({ id: player._id, name, nameKey }, catalog, now);
          } else {
            this.overlay(player, catalog, now);
            advanceWorld(player.world, now, { activeUntil: player.activeUntil || 0, rng: this.rng });
          }
          player.tokenHashes = [...player.tokenHashes, hashToken(token)].slice(-32);
          const giftMessages = await this.collectGifts(context, player, now), becameOnline = this.touch(player, now, true, clientId);
          player.revision++; player.world.revision++; player.lastSavedAt = now;
          await context.savePlayer(player);
          return this.response(context, player, now, { token, giftMessages, becameOnline });
        });
        return this.notifyOnline(result);
      } catch (error) { if (error.code !== 11000 || attempt === 2) throw error; }
    }
  }
  async sync(token, active = true, clientId) { this.metrics.synchronizations++; return this.withWorld(token, active, undefined, clientId); }
  remember(player, id, requestHash, extra) { player.commandIds = [...player.commandIds, { id, requestHash, ...extra }].slice(-MAX_COMMANDS); }
  duplicate(player, id, requestHash) {
    const previous = player.commandIds.find((entry) => entry.id === id);
    if (!previous) return null;
    if (previous.requestHash !== requestHash) throw errorWithStatus('Diese Aktions-ID wurde bereits für eine andere Aktion verwendet.', 409);
    this.metrics.duplicateCommands++;
    return { message: previous.message, ...(previous.giftId ? { giftId: previous.giftId } : {}), duplicate: true };
  }
  async execute(token, command, suppliedId, clientId) {
    const id = commandId(suppliedId);
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw errorWithStatus('Die Spielaktion ist ungültig.');
    const requestHash = signature({ kind: 'command', command });
    return this.withWorld(token, true, async (context, player, catalog) => {
      const previous = this.duplicate(player, id, requestHash); if (previous) return previous;
      if (command.type === 'catalog-save') {
        if (command.baseCatalogRevision !== catalog.revision) throw errorWithStatus('Der Katalog wurde inzwischen geändert. Lade den aktuellen Stand und versuche es erneut.', 409);
        const candidate = validateCatalog(command.catalog, player.world);
        const worlds = await context.players();
        for (const other of worlds) validateCatalog(candidate, { ...other.world, catalog });
        const pending = await context.pendingGifts();
        validateCatalog(candidate, { catalog, cards: pending.flatMap((gift) => gift.cards) });
        for (const gift of pending) {
          const destination = structuredClone(worlds.find((other) => other._id === gift.recipientId)?.world || player.world);
          destination.catalog = candidate;
          try { receiveGiftCards(destination, gift.cards, this.now()); }
          catch (error) { throw errorWithStatus(`Ein wartendes Geschenk würde durch diese Änderung ungültig: ${error.message}`); }
        }
      }
      const outcome = applyCommand(player.world, command, { playerId: player._id, now: this.now(), rng: this.rng });
      if (command.type === 'catalog-save') await context.setCatalog(player.world.catalog);
      this.remember(player, id, requestHash, { message: outcome.message }); this.metrics.acceptedCommands++;
      return { message: outcome.message };
    }, clientId);
  }
  async players(token) {
    return this.repository.read(async (context) => {
      this.requireTownHall(await this.requirePlayer(context, token)); const now = this.now();
      return { players: (await context.presencePlayers()).map((player) => ({ id: player._id, name: player.name, lastSavedAt: player.lastSavedAt, online: player.presenceUntil > now })).sort((a, b) => a.name.localeCompare(b.name, 'de')) };
    });
  }
  async materials(token, playerId) {
    if (typeof playerId !== 'string' || playerId.length > 100) throw errorWithStatus('Wähle einen Spieler aus.');
    return this.repository.read(async (context) => {
      this.requireTownHall(await this.requirePlayer(context, token)); const player = await context.playerById(playerId);
      if (!player) throw errorWithStatus('Dieser Spieler wurde nicht gefunden.', 404);
      return { player: { id: player._id, name: player.name }, materials: summarizeMaterials(player.world), savedAt: player.lastSavedAt };
    });
  }
  async gift(token, selection, clientId = selection?.clientId) {
    const id = commandId(selection?.commandId), { recipientId, cardId, split = true, takeAbove = true } = selection;
    if (typeof recipientId !== 'string' || recipientId.length > 100 || typeof cardId !== 'string' || cardId.length > 100 || typeof split !== 'boolean' || typeof takeAbove !== 'boolean') throw errorWithStatus('Das Geschenk ist ungültig.');
    const requestHash = signature({ kind: 'gift', recipientId, cardId, split, takeAbove });
    return this.withWorld(token, true, async (context, player, _catalog, now) => {
      const previous = this.duplicate(player, id, requestHash); if (previous) return previous;
      const operationId = `${player._id}:${id}`, existing = await context.giftByOperation(operationId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw errorWithStatus('Diese Aktions-ID wurde bereits verwendet.', 409);
        return { message: existing.message, giftId: existing._id, duplicate: true };
      }
      this.requireTownHall(player);
      if (recipientId === player._id) throw errorWithStatus('Wähle einen anderen Spieler für dein Geschenk.');
      const recipient = await context.playerById(recipientId);
      if (!recipient) throw errorWithStatus('Dieser Spieler wurde nicht gefunden.', 404);
      const cards = takeGiftCards(player.world, { cardId, split, takeAbove }, now), giftId = randomUUID();
      const message = `${cards.length === 1 ? 'Karte' : `${cards.length} Karten`} an ${recipient.name} gesendet.`;
      await context.saveGift({ _id: giftId, operationId, requestHash, senderId: player._id, senderName: player.name, recipientId, cards, createdAt: now, status: 'pending', message });
      await context.updatePresence(recipient, { pendingGiftCount: (recipient.pendingGiftCount || 0) + 1 });
      this.remember(player, id, requestHash, { message, giftId }); this.metrics.giftsSent++;
      return { message, giftId };
    }, clientId);
  }
  async presence(token, active = true, clientId) {
    const now = this.now();
    const result = await this.repository.transaction(async (context) => {
      const player = await this.requirePlayer(context, token, true), becameOnline = this.touch(player, now, active, clientId, false);
      const fields = { presenceUntil: player.presenceUntil, lastSeenAt: now, clients: player.clients, activeUntil: player.activeUntil };
      await context.updatePresence(player, fields);
      return { player: profile(player), serverTime: now, hasPendingGifts: (player.pendingGiftCount || 0) > 0, ...(await this.presenceInfo(context, player._id, now)), becameOnline };
    });
    return this.notifyOnline(result);
  }
  async close() { await this.repository.close(); }
  requireTownHall(player) {
    if (!player.world.cards.some((card) => card.type === 'town_hall')) throw errorWithStatus('Baue zuerst ein Rathaus, um andere Spieler zu besuchen und Geschenke zu verschicken.', 403);
  }
}
