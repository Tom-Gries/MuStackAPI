import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createWorld } from '@stackfriends/shared/game.js';

function storageError() {
  return Object.assign(new Error('Der Weltstand konnte nicht mit MongoDB abgeglichen werden. Bitte Verbindung und Datenbankrechte prüfen.'), { status: 503 });
}

function initialState(now) {
  return { world: createWorld(now), sessions: {}, commandIds: [], activeUntil: now };
}

const payloadBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sessionHash = (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const sessionPlayer = (state, hash) => state?.world?.players.find((player) => player.id === state.sessions?.[hash]?.playerId) || null;
const emptyContext = () => ({ world: { players: [], cards: [] }, sessions: {} });
const document = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeKey = (key) => key.length > 0 && !key.includes('.') && !key.startsWith('$');
const emptyUpdate = () => ({ $set: {}, $unset: {}, $push: {} });
const mergeUpdate = (target, source) => {
  for (const operator of Object.keys(target)) Object.assign(target[operator], source[operator]);
};

/** All paths address the revision checked by the same atomic updateOne. */
function mongoUpdate(before, after) {
  const update = emptyUpdate();
  const diff = (previous, next, location, changes) => {
    if (equal(previous, next)) return;
    if (next === undefined) { changes.$unset[location] = 1; return; }
    if (Array.isArray(previous) && Array.isArray(next)) {
      if (next.length > previous.length && equal(previous, next.slice(0, previous.length))) {
        changes.$push[location] = { $each: next.slice(previous.length) };
        return;
      }
      // Command deduplication retains a rolling window. Send only its new tail,
      // even once all 2,000 slots are occupied; keep the trim in the same CAS.
      if (location === 'commandIds' && next.length && next[0]?.id) {
        const offset = previous.findIndex((entry) => entry.id === next[0].id);
        const overlap = previous.length - offset;
        if (offset > 0 && overlap <= next.length && equal(previous.slice(offset), next.slice(0, overlap)) && next.length > overlap) {
          changes.$push[location] = { $each: next.slice(overlap), $slice: -next.length };
          return;
        }
      }
      if (previous.length === next.length) {
        const elements = emptyUpdate();
        for (let index = 0; index < next.length; index++) diff(previous[index], next[index], `${location}.${index}`, elements);
        const replacement = { $set: { [location]: next } };
        if (payloadBytes(elements) < payloadBytes(replacement)) { mergeUpdate(changes, elements); return; }
      }
      // Removals/reordering can change array indices; replacing this array is
      // safe and still avoids retransmitting the rest of the world document.
      changes.$set[location] = next;
      return;
    }
    if (document(previous) && document(next)) {
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
      if ([...keys].every(safeKey)) {
        for (const key of keys) diff(Object.hasOwn(previous, key) ? previous[key] : undefined, Object.hasOwn(next, key) ? next[key] : undefined, location ? `${location}.${key}` : key, changes);
        return;
      }
    }
    if (!location) throw new Error('Ungültige Felder im Weltstand.');
    changes.$set[location] = next;
  };
  diff(before, after, '', update);
  return Object.fromEntries(Object.entries(update).filter(([, values]) => Object.keys(values).length));
}

/** File writes are serialized and atomically renamed; this adapter is local-only. */
export class FileRepository {
  constructor(filename, now = Date.now) {
    this.filename = filename;
    this.now = now;
    this.queue = Promise.resolve();
    this.metrics = { reads: 0, writes: 0, conflicts: 0, readBytes: 0, writeBytes: 0 };
  }

  async init() {
    try {
      this.state = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!this.state.world || !this.state.sessions) throw new Error('Ungültiger lokaler Weltstand.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = initialState(this.now());
      await this.persist(this.state);
    }
    return this;
  }

  async persist(state) {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const encoded = JSON.stringify(state);
    await writeFile(temporary, encoded, 'utf8');
    await rename(temporary, this.filename);
    this.metrics.writes++;
    this.metrics.writeBytes += Buffer.byteLength(encoded);
  }

  async read() {
    await this.queue;
    this.metrics.reads++;
    this.metrics.readBytes += payloadBytes(this.state);
    return structuredClone(this.state);
  }

  async world() {
    await this.queue;
    this.metrics.reads++;
    this.metrics.readBytes += payloadBytes(this.state.world);
    return structuredClone(this.state.world);
  }

  async playerForSession(hash) {
    if (!sessionHash(hash)) return null;
    await this.queue;
    this.metrics.reads++;
    const player = sessionPlayer(this.state, hash);
    this.metrics.readBytes += payloadBytes(player);
    return structuredClone(player);
  }

  async commandContext(hash) {
    if (!sessionHash(hash)) return emptyContext();
    await this.queue;
    this.metrics.reads++;
    const session = this.state.sessions[hash];
    const context = session ? { world: { players: this.state.world.players, cards: this.state.world.cards }, sessions: { [hash]: session } } : emptyContext();
    this.metrics.readBytes += payloadBytes(context);
    return structuredClone(context);
  }

  async revision() {
    await this.queue;
    this.metrics.reads++;
    this.metrics.readBytes += payloadBytes(this.state.world.revision);
    return this.state.world.revision;
  }

  async mutate(change) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const before = structuredClone(this.state.world);
      const result = await change(draft);
      if (result?.changed === false) return { world: before, before, result: result.value, changed: false };
      draft.world.revision = before.revision + 1;
      await this.persist(draft);
      this.state = draft;
      return { world: structuredClone(draft.world), before, result: result?.value, changed: true };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close() { await this.queue; }
}

/** Each mutation, consumption and command ID still commit in one atomic CAS. */
export class MongoRepository {
  constructor(uri, database, now = Date.now, worldId = 'shared') {
    this.client = new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 8_000 });
    this.database = database;
    this.now = now;
    this.worldId = worldId;
    // Logical JSON payload sizes for before/after comparisons, excluding BSON,
    // transport framing and negotiated wire compression.
    this.metrics = { reads: 0, writes: 0, conflicts: 0, readBytes: 0, writeBytes: 0 };
  }

  async init() {
    await this.client.connect();
    this.collection = this.client.db(this.database).collection('worlds');
    try {
      const state = { _id: this.worldId, ...initialState(this.now()) };
      await this.collection.insertOne(state);
      this.metrics.writes++;
      this.metrics.writeBytes += payloadBytes(state);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    return this;
  }

  async fetchDocument(filter, projection) {
    this.metrics.reads++;
    let state;
    try { state = await this.collection.findOne(filter, { projection: { _id: 0, ...projection } }); }
    catch { throw storageError(); }
    this.metrics.readBytes += payloadBytes(state);
    return state;
  }

  async read() {
    const state = await this.fetchDocument({ _id: this.worldId });
    if (!state) throw new Error('Die gemeinsame Welt wurde nicht gefunden.');
    return state;
  }

  async world() {
    const state = await this.fetchDocument({ _id: this.worldId }, { world: 1 });
    if (!state) throw new Error('Die gemeinsame Welt wurde nicht gefunden.');
    return state.world;
  }

  async playerForSession(hash) {
    if (!sessionHash(hash)) return null;
    const field = `sessions.${hash}`;
    const state = await this.fetchDocument({ _id: this.worldId, [field]: { $exists: true } }, { [field]: 1, 'world.players': 1 });
    return sessionPlayer(state, hash);
  }

  async commandContext(hash) {
    if (!sessionHash(hash)) return emptyContext();
    const field = `sessions.${hash}`;
    return await this.fetchDocument({ _id: this.worldId, [field]: { $exists: true } }, { [field]: 1, 'world.players': 1, 'world.cards': 1 }) || emptyContext();
  }

  async revision() {
    const state = await this.fetchDocument({ _id: this.worldId }, { 'world.revision': 1 });
    if (!state) throw new Error('Die gemeinsame Welt wurde nicht gefunden.');
    return state.world.revision;
  }

  async mutate(change) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const previous = await this.read();
      const draft = structuredClone(previous);
      const before = previous.world;
      const result = await change(draft);
      if (result?.changed === false) return { world: before, before, result: result.value, changed: false };
      draft.world.revision = before.revision + 1;
      let update;
      try {
        const filter = { _id: this.worldId, 'world.revision': before.revision };
        const changes = mongoUpdate(previous, draft);
        this.metrics.writeBytes += payloadBytes({ filter, update: changes });
        update = await this.collection.updateOne(filter, changes);
      } catch { throw storageError(); }
      if (update.modifiedCount === 1) {
        this.metrics.writes++;
        return { world: draft.world, before, result: result?.value, changed: true };
      }
      this.metrics.conflicts++;
    }
    const error = new Error('Die Welt ist gerade beschäftigt. Bitte versuche die Aktion erneut.');
    error.status = 409;
    throw error;
  }

  async close() { await this.client.close(); }
}

export async function createRepository(config, now) {
  try {
    const repository = config.mongoUri
      ? new MongoRepository(config.mongoUri, config.mongoDatabase, now, config.worldId)
      : new FileRepository(config.worldFile, now);
    return await repository.init();
  } catch (error) {
    if (config.mongoUri) throw storageError();
    throw error;
  }
}
