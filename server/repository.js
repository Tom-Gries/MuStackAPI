import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { getCatalog } from '@stackfriends/shared/catalog.js';
import { ensurePersonalCatalog } from '@stackfriends/shared/personal-world.js';

const clone = (value) => structuredClone(value);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const empty = (catalog = getCatalog()) => ({ schemaVersion: 2, catalog: ensurePersonalCatalog(catalog), players: {}, gifts: {} });
const storageError = (cause) => Object.assign(new Error('Der persönliche Weltstand konnte nicht gespeichert werden. Bitte versuche es erneut.', { cause }), { status: 503 });

/** Send changed fields only. A transaction protects concurrent tabs and gifts. */
export function mongoUpdate(before, after) {
  const update = { $set: {}, $unset: {} };
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const visit = (left, right, key) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (right === undefined) { update.$unset[key] = 1; return; }
    if (object(left) && object(right) && Object.keys({ ...left, ...right }).every((name) => !name.includes('.') && !name.startsWith('$'))) {
      for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[name], right[name], key ? `${key}.${name}` : name);
    } else if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
      const elementUpdate = { $set: {}, $unset: {} };
      const start = clone(update);
      for (let index = 0; index < right.length; index++) visit(left[index], right[index], `${key}.${index}`);
      for (const operator of ['$set', '$unset']) for (const location of Object.keys(update[operator])) if (location.startsWith(`${key}.`)) elementUpdate[operator][location] = update[operator][location];
      if (bytes(elementUpdate) > bytes(right)) {
        for (const operator of ['$set', '$unset']) for (const location of Object.keys(update[operator])) if (location.startsWith(`${key}.`)) delete update[operator][location];
        Object.assign(update.$set, start.$set); Object.assign(update.$unset, start.$unset); update.$set[key] = right;
      }
    } else update.$set[key] = right;
  };
  visit(before, after, '');
  return Object.fromEntries(Object.entries(update).filter(([, changes]) => Object.keys(changes).length));
}

class FileContext {
  constructor(state) { this.state = state; }
  async catalog() { return clone(this.state.catalog); }
  async setCatalog(catalog) { this.state.catalog = clone(catalog); }
  async playerByToken(hash) { return clone(Object.values(this.state.players).find((player) => player.tokenHashes.includes(hash)) || null); }
  async playerByName(nameKey) { return clone(Object.values(this.state.players).find((player) => player.nameKey === nameKey) || null); }
  async playerById(id) { return clone(this.state.players[id] || null); }
  async players() { return clone(Object.values(this.state.players)); }
  async presencePlayer(hash) { const player = await this.playerByToken(hash); if (!player) return null; const { world, commandIds, ...profile } = player; return profile; }
  async presencePlayers(now) { return Object.values(this.state.players).filter((player) => now === undefined || player.presenceUntil > now).map(({ _id, name, presenceUntil, lastSavedAt }) => ({ _id, name, presenceUntil, lastSavedAt })); }
  async updatePresence(player, fields) { Object.assign(this.state.players[player._id], fields); }
  async savePlayer(player) { this.state.players[player._id] = clone(player); }
  async pendingGifts(recipientId) { return clone(Object.values(this.state.gifts).filter((gift) => gift.status === 'pending' && (!recipientId || gift.recipientId === recipientId))); }
  async giftByOperation(operationId) { return clone(Object.values(this.state.gifts).find((gift) => gift.operationId === operationId) || null); }
  async saveGift(gift) { this.state.gifts[gift._id] = clone(gift); }
}

/** Local operations serialize, clone first, then atomically replace a separate personal-worlds file. */
export class FileRepository {
  constructor(filename, now = Date.now, options = {}) {
    this.filename = filename; this.legacyFilename = options.legacyFilename || path.join(path.dirname(filename), 'world.json'); this.now = now; this.queue = Promise.resolve();
    this.metrics = { reads: 0, writes: 0, conflicts: 0, readBytes: 0, writeBytes: 0 };
  }
  async init() {
    try {
      this.state = JSON.parse(await readFile(this.filename, 'utf8'));
      if (this.state.schemaVersion !== 2 || !this.state.players || !this.state.gifts || !this.state.catalog) throw new Error('Ungültiger persönlicher Weltstand.');
      const catalog = ensurePersonalCatalog(this.state.catalog);
      if (JSON.stringify(catalog) !== JSON.stringify(this.state.catalog)) { this.state.catalog = catalog; await this.persist(this.state); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let catalog;
      try { const legacy = JSON.parse(await readFile(this.legacyFilename, 'utf8')); catalog = getCatalog(legacy.world || legacy); }
      catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
      this.state = empty(catalog); await this.persist(this.state);
    }
    return this;
  }
  async persist(state) {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`, contents = JSON.stringify(state);
    await writeFile(temporary, contents, 'utf8'); await rename(temporary, this.filename);
    this.metrics.writes++; this.metrics.writeBytes += Buffer.byteLength(contents);
  }
  async transaction(operation) {
    const pending = this.queue.then(async () => {
      const state = clone(this.state); this.metrics.reads++;
      const result = await operation(new FileContext(state));
      if (JSON.stringify(state) !== JSON.stringify(this.state)) { await this.persist(state); this.state = state; }
      return result;
    });
    this.queue = pending.catch(() => {}); return pending;
  }
  async read(operation) { await this.queue; this.metrics.reads++; return operation(new FileContext(clone(this.state))); }
  async close() { await this.queue; }
}

class MongoContext {
  constructor(repository, session) { this.repository = repository; this.session = session; this.before = new Map(); }
  get options() { return this.session ? { session: this.session } : {}; }
  async one(collection, filter) { this.repository.metrics.reads++; const value = await collection.findOne(filter, this.options); if (value) this.repository.metrics.readBytes += bytes(value); return value; }
  async catalog() {
    const document = await this.one(this.repository.catalogs, { _id: 'global' });
    if (this.session) {
      // The small fence prevents catalog validation and a world mutation from
      // committing incompatible cross-document snapshots.
      await this.repository.catalogs.updateOne({ _id: 'global', revision: document.catalog.revision }, { $inc: { fence: 1 } }, this.options); this.repository.metrics.writes++;
    }
    return document.catalog;
  }
  async setCatalog(catalog) { await this.repository.catalogs.updateOne({ _id: 'global' }, { $set: { catalog, revision: catalog.revision } }, this.options); this.repository.metrics.writes++; }
  async remember(player) { if (player) this.before.set(player._id, clone(player)); return player; }
  async playerByToken(hash) { return this.remember(await this.one(this.repository.players, { tokenHashes: hash })); }
  async playerByName(nameKey) { return this.remember(await this.one(this.repository.players, { nameKey })); }
  async playerById(id) { return this.remember(await this.one(this.repository.players, { _id: id })); }
  async players() { this.repository.metrics.reads++; return this.repository.players.find({}, this.options).toArray(); }
  async presencePlayer(hash) { this.repository.metrics.reads++; return this.repository.players.findOne({ tokenHashes: hash }, { ...this.options, projection: { world: 0, commandIds: 0 } }); }
  async presencePlayers(now) { this.repository.metrics.reads++; return this.repository.players.find(now === undefined ? {} : { presenceUntil: { $gt: now } }, { ...this.options, projection: { _id: 1, name: 1, presenceUntil: 1, lastSavedAt: 1 } }).toArray(); }
  async updatePresence(player, fields) { await this.repository.players.updateOne({ _id: player._id }, { $set: fields }, this.options); this.repository.metrics.writes++; this.repository.metrics.writeBytes += bytes(fields); }
  async savePlayer(player) {
    const previous = this.before.get(player._id);
    if (previous) {
      const update = mongoUpdate(previous, player); if (!Object.keys(update).length) return;
      const result = await this.repository.players.updateOne({ _id: player._id, revision: previous.revision }, update, this.options);
      if (result.matchedCount !== 1) throw Object.assign(new Error('Deine Welt wurde gleichzeitig geändert. Bitte versuche es erneut.'), { status: 409 });
      this.repository.metrics.writeBytes += bytes(update);
    } else { await this.repository.players.insertOne(player, this.options); this.repository.metrics.writeBytes += bytes(player); }
    this.repository.metrics.writes++; this.before.set(player._id, clone(player));
  }
  async pendingGifts(recipientId) { this.repository.metrics.reads++; return this.repository.gifts.find({ status: 'pending', ...(recipientId ? { recipientId } : {}) }, this.options).sort({ createdAt: 1, _id: 1 }).toArray(); }
  async giftByOperation(operationId) { return this.one(this.repository.gifts, { operationId }); }
  async saveGift(gift) { await this.repository.gifts.replaceOne({ _id: gift._id }, gift, { ...this.options, upsert: true }); this.repository.metrics.writes++; this.repository.metrics.writeBytes += bytes(gift); }
}

/** One pooled client; requests finish their transactions and hold no persistent transport. */
export class MongoRepository {
  constructor(uri, database, now = Date.now, options = {}) {
    this.uri = uri; this.database = database; this.now = now;
    this.client = options.client || new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000 });
    this.metrics = { reads: 0, writes: 0, conflicts: 0, readBytes: 0, writeBytes: 0 };
  }
  async init() {
    await this.client.connect(); const database = this.client.db(this.database);
    this.players = database.collection('personalPlayers'); this.gifts = database.collection('personalGifts'); this.catalogs = database.collection('gameCatalog');
    await Promise.all([
      this.players.createIndex({ nameKey: 1 }, { unique: true }), this.players.createIndex({ tokenHashes: 1 }), this.players.createIndex({ presenceUntil: 1 }),
      this.gifts.createIndex({ operationId: 1 }, { unique: true }), this.gifts.createIndex({ recipientId: 1, status: 1, createdAt: 1 }),
    ]);
    const existing = await this.catalogs.findOne({ _id: 'global' });
    if (!existing) {
      const legacy = await database.collection('worlds').findOne({ _id: 'shared' }); const catalog = ensurePersonalCatalog(getCatalog(legacy?.world));
      try { await this.catalogs.updateOne({ _id: 'global' }, { $setOnInsert: { catalog, revision: catalog.revision, fence: 0, schemaVersion: 2 } }, { upsert: true }); }
      catch (error) { if (error.code !== 11000) throw error; }
    } else {
      const catalog = ensurePersonalCatalog(existing.catalog);
      if (JSON.stringify(catalog) !== JSON.stringify(existing.catalog)) await this.catalogs.updateOne({ _id: 'global', revision: existing.revision }, { $set: { catalog } });
    }
    return this;
  }
  async transaction(operation) {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => operation(new MongoContext(this, session)), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 }); }
    catch (error) { if (error.status || error.code === 11000 || !error.name?.startsWith('Mongo')) throw error; throw storageError(error); }
    finally { await session.endSession(); }
  }
  async read(operation) { try { return await operation(new MongoContext(this)); } catch (error) { if (error.status) throw error; throw storageError(error); } }
  async close() { await this.client.close(); }
}

export async function createRepository(config, now) {
  const repository = config.mongoUri ? new MongoRepository(config.mongoUri, config.mongoDatabase, now) : new FileRepository(config.worldFile, now, { legacyFilename: config.legacyWorldFile });
  try { return await repository.init(); }
  catch (error) { await repository.close().catch(() => {}); if (config.mongoUri) throw storageError(error); throw error; }
}
