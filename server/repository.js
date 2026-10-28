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

/** File writes are serialized and atomically renamed; this adapter is local-only. */
export class FileRepository {
  constructor(filename, now = Date.now) {
    this.filename = filename;
    this.now = now;
    this.queue = Promise.resolve();
    this.metrics = { reads: 0, writes: 0, conflicts: 0 };
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
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    await rename(temporary, this.filename);
    this.metrics.writes++;
  }

  async read() {
    await this.queue;
    this.metrics.reads++;
    return structuredClone(this.state);
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

/** Each complete world mutation, consumption and command ID commit in one CAS. */
export class MongoRepository {
  constructor(uri, database, now = Date.now, worldId = 'shared') {
    this.client = new MongoClient(uri, { maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 8_000 });
    this.database = database;
    this.now = now;
    this.worldId = worldId;
    this.metrics = { reads: 0, writes: 0, conflicts: 0 };
  }

  async init() {
    await this.client.connect();
    this.collection = this.client.db(this.database).collection('worlds');
    try {
      await this.collection.insertOne({ _id: this.worldId, ...initialState(this.now()) });
      this.metrics.writes++;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    return this;
  }

  async read() {
    this.metrics.reads++;
    let state;
    try { state = await this.collection.findOne({ _id: this.worldId }); }
    catch { throw storageError(); }
    if (!state) throw new Error('Die gemeinsame Welt wurde nicht gefunden.');
    delete state._id;
    return state;
  }

  async mutate(change) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const draft = await this.read();
      const before = structuredClone(draft.world);
      const result = await change(draft);
      if (result?.changed === false) return { world: before, before, result: result.value, changed: false };
      draft.world.revision = before.revision + 1;
      let update;
      try {
        update = await this.collection.replaceOne(
          { _id: this.worldId, 'world.revision': before.revision },
          { _id: this.worldId, ...draft },
        );
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
