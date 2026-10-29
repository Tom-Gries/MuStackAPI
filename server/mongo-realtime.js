import { createHash } from 'node:crypto';

const EVENT_TTL = 60_000;
const CLAIM_TTL = 5_000;
const duplicateKey = (error) => error?.code === 11000;
const validPlayer = (player) => typeof player?.id === 'string' && typeof player?.name === 'string';

/** Shared ephemeral coordination; durable worlds remain in MongoRepository. */
export class MongoRealtimeStore {
  constructor(database, { worldId = 'shared', instanceId, now = Date.now } = {}) {
    this.database = database;
    this.worldId = worldId;
    this.instanceId = instanceId;
    this.now = now;
    this.events = database.collection('realtime_events');
    this.presence = database.collection('realtime_presence');
    this.locks = database.collection('realtime_locks');
    this.tickets = database.collection('realtime_tickets');
    this.claims = database.collection('realtime_claims');
    this.generation = 0;
    this.retryAttempt = 0;
    this.lastDeliveredRevision = -1;
    this.running = false;
    this.closed = false;
  }

  id(value) { return JSON.stringify([this.worldId, value]); }

  async init() {
    await Promise.all([
      this.events.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.presence.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.presence.createIndex({ worldId: 1, expiresAt: 1 }),
      this.tickets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.claims.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
    try { await this.locks.insertOne({ _id: this.worldId, locks: [] }); }
    catch (error) { if (!duplicateKey(error)) throw error; }
    return this;
  }

  async start(onEvent, onUnavailable, onResync) {
    if (this.closed) throw new Error('Der Echtzeitverteiler ist geschlossen.');
    this.handlers = { onEvent, onUnavailable, onResync };
    if (this.running) return this.starting;
    this.running = true;
    const generation = ++this.generation;
    this.starting = this.open(generation, false).catch((error) => {
      if (generation === this.generation) {
        this.running = false;
        this.handlers?.onUnavailable?.();
      }
      throw error;
    });
    return this.starting;
  }

  async open(generation, recovering) {
    // The anchor is taken before watch() starts its lazy cursor. Events written
    // during cursor startup remain in the oplog and cannot fall into that gap.
    const reply = await this.database.command({ ping: 1 });
    const operationTime = reply.operationTime || reply.$clusterTime?.clusterTime;
    if (!operationTime) throw new Error('MongoDB stellt keine Echtzeit-Änderungen bereit.');
    if (!this.running || generation !== this.generation || this.closed) return;
    const stream = this.database.watch([{ $match: {
      'ns.coll': { $in: ['worlds', 'realtime_events'] },
      $or: [
        { 'ns.coll': 'realtime_events', operationType: 'insert', 'fullDocument.worldId': this.worldId, 'fullDocument.instanceId': { $ne: this.instanceId } },
        { 'ns.coll': 'worlds', 'documentKey._id': this.worldId, operationType: { $in: ['update', 'replace', 'delete'] } },
      ],
    } }], { startAtOperationTime: operationTime, maxAwaitTimeMS: 10_000 });
    this.stream = stream;
    const current = () => this.running && !this.closed && generation === this.generation && this.stream === stream;
    const handleChange = (change) => {
      if (!current()) return;
      this.retryAttempt = 0;
      if (change.ns?.coll === 'worlds') {
        this.queueWorldResync(change.updateDescription?.updatedFields?.['world.revision']);
        return;
      }
      const record = change.fullDocument;
      if (record?.worldId !== this.worldId || record.instanceId === this.instanceId || !(record.expiresAt instanceof Date) || record.expiresAt.getTime() <= this.now()) return;
      if (record.event && typeof record.event === 'object') {
        this.delivered(record.event);
        this.handlers?.onEvent?.(record.event);
      }
    };
    // Emitted when the server has opened/resumed its cursor, even on idle data.
    stream.on('resumeTokenChanged', () => { if (current()) this.retryAttempt = 0; });
    const interrupted = () => {
      if (!current()) return;
      this.stream = undefined;
      this.changes = undefined;
      changes?.destroy();
      this.handlers?.onUnavailable?.();
      void stream.close().catch(() => {});
      this.queueRetry(generation);
    };
    stream.on('error', interrupted);
    stream.on('close', interrupted);
    // Read the public raw Readable API: unlike .on('change'), stream() does not
    // run the driver's competing automatic resume loop. This store owns retry.
    const changes = stream.stream();
    this.changes = changes;
    changes.on('error', interrupted);
    changes.on('end', interrupted);
    changes.on('close', interrupted);
    changes.on('data', handleChange);
    if (recovering) this.handlers?.onResync?.();
  }

  delivered(event) {
    if (event.type !== 'patch' || !Number.isSafeInteger(event.revision)) return;
    this.lastDeliveredRevision = Math.max(this.lastDeliveredRevision, event.revision);
    if (!this.fallbackUnversioned && this.fallbackRevision !== undefined && this.fallbackRevision <= this.lastDeliveredRevision) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = undefined;
      this.fallbackRevision = undefined;
    }
  }

  queueWorldResync(revision) {
    if (Number.isSafeInteger(revision)) {
      if (revision <= this.lastDeliveredRevision) return;
      this.fallbackRevision = Math.max(this.fallbackRevision ?? -1, revision);
    } else this.fallbackUnversioned = true;
    if (this.fallbackTimer) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = undefined;
      if (!this.running || this.closed) return;
      this.lastDeliveredRevision = Math.max(this.lastDeliveredRevision, this.fallbackRevision ?? -1);
      this.fallbackRevision = undefined;
      this.fallbackUnversioned = false;
      this.handlers?.onResync?.();
    }, 1_000);
    this.fallbackTimer.unref?.();
  }

  queueRetry(generation) {
    if (!this.running || this.closed || generation !== this.generation || this.retryTimer) return;
    const delay = Math.min(500 * 2 ** Math.min(this.retryAttempt++, 5), 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.running || this.closed || generation !== this.generation) return;
      this.starting = this.open(generation, true).catch(() => {
        if (!this.running || this.closed || generation !== this.generation) return;
        this.handlers?.onUnavailable?.();
        this.queueRetry(generation);
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  async stop() {
    this.running = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = undefined;
    this.fallbackRevision = undefined;
    this.fallbackUnversioned = false;
    const stream = this.stream;
    this.stream = undefined;
    const changes = this.changes;
    this.changes = undefined;
    changes?.destroy();
    await stream?.close();
  }

  async publish(event) {
    this.delivered(event);
    await this.events.insertOne({ worldId: this.worldId, instanceId: this.instanceId, event, expiresAt: new Date(this.now() + EVENT_TTL) });
  }

  async touch(connectionId, player, expiresAt) {
    await this.presence.updateOne({ _id: this.id(connectionId) }, { $set: {
      worldId: this.worldId, connectionId, player: { id: player.id, name: player.name }, expiresAt: new Date(expiresAt),
    } }, { upsert: true });
  }

  async remove(connectionId) {
    await this.presence.deleteOne({ _id: this.id(connectionId) });
  }

  async online() {
    const entries = await this.presence.find({ worldId: this.worldId, expiresAt: { $gt: new Date(this.now()) } })
      .project({ _id: 0, player: 1, expiresAt: 1 }).toArray();
    const players = new Map();
    let activeUntil = 0;
    for (const entry of entries) {
      if (!validPlayer(entry.player) || !(entry.expiresAt instanceof Date)) continue;
      players.set(entry.player.id, { id: entry.player.id, name: entry.player.name });
      activeUntil = Math.max(activeUntil, entry.expiresAt.getTime());
    }
    return { players: [...players.values()], activeUntil };
  }

  async acquire(ids, connectionId, playerId, expiresAt) {
    if (!ids.length) return false;
    const now = new Date(this.now());
    const owner = connectionId + '|' + playerId;
    const unique = [...new Set(ids)];
    const result = await this.locks.updateOne({
      _id: this.worldId,
      locks: { $not: { $elemMatch: { cardId: { $in: unique }, owner: { $ne: owner }, expiresAt: { $gt: now } } } },
    }, [{ $set: { locks: { $concatArrays: [
      { $filter: { input: { $ifNull: ['$locks', []] }, as: 'lock', cond: { $and: [
        { $gt: ['$$lock.expiresAt', now] },
        { $not: [{ $in: ['$$lock.cardId', { $literal: unique }] }] },
      ] } } },
      { $literal: unique.map((cardId) => ({ cardId, owner, expiresAt: new Date(expiresAt) })) },
    ] } } }]);
    // matchedCount also accepts an idempotent same-owner renewal with no diff.
    return result.matchedCount === 1;
  }

  async release(ids, connectionId, playerId) {
    if (!ids.length) return;
    const owner = connectionId + '|' + playerId;
    await this.locks.updateOne({ _id: this.worldId }, [{ $set: { locks: { $filter: {
      input: { $ifNull: ['$locks', []] }, as: 'lock', cond: { $not: [{ $and: [
        { $eq: ['$$lock.owner', { $literal: owner }] },
        { $in: ['$$lock.cardId', { $literal: ids }] },
      ] }] },
    } } } }]);
  }

  async claimEvent(revision) {
    const now = this.now();
    try {
      const result = await this.claims.updateOne({ _id: this.id(revision), expiresAt: { $lte: new Date(now) } }, {
        $set: { worldId: this.worldId, instanceId: this.instanceId, expiresAt: new Date(now + CLAIM_TTL) },
      }, { upsert: true });
      return result.modifiedCount === 1 || result.upsertedCount === 1;
    } catch (error) { if (duplicateKey(error)) return false; throw error; }
  }

  ticketId(ticket) { return this.id(createHash('sha256').update(ticket).digest('hex')); }

  async issueSocketTicket(ticket, token, expiresAt) {
    await this.tickets.insertOne({ _id: this.ticketId(ticket), worldId: this.worldId, token, expiresAt: new Date(expiresAt) });
  }

  async consumeSocketTicket(ticket) {
    const entry = await this.tickets.findOneAndDelete({ _id: this.ticketId(ticket), expiresAt: { $gt: new Date(this.now()) } });
    return typeof entry?.token === 'string' ? entry.token : undefined;
  }

  async close() {
    this.closed = true;
    await this.stop();
  }
}
