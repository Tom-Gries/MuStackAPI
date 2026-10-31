const copy = (value) => structuredClone(value);
const get = (value, location) => location.split('.').reduce((object, key) => object?.[key], value);
function set(value, location, next) {
  const keys = location.split('.'); let object = value;
  for (const key of keys.slice(0, -1)) object = object[key] ??= {};
  object[keys.at(-1)] = copy(next);
}
function unset(value, location) {
  const keys = location.split('.'); let object = value;
  for (const key of keys.slice(0, -1)) { object = object?.[key]; if (!object) return; }
  delete object[keys.at(-1)];
}
function matches(document, filter) { return Object.entries(filter).every(([key, value]) => value?.$gt !== undefined ? get(document, key) > value.$gt : Array.isArray(get(document, key)) ? get(document, key).includes(value) : get(document, key) === value); }
function project(document, projection) {
  if (!document) return null;
  if (!projection) return copy(document);
  const positive = Object.entries(projection).filter(([, value]) => value === 1);
  if (positive.length) { const result = {}; for (const [key] of positive) if (get(document, key) !== undefined) set(result, key, get(document, key)); return result; }
  const result = copy(document); for (const [key] of Object.entries(projection)) unset(result, key); return result;
}

/** Transaction-aware double: reads/writes use isolated snapshots; abort discards every collection change. */
export class MemoryMongoClient {
  constructor(seed = {}) { this.documents = copy(seed); this.calls = []; this.queue = Promise.resolve(); }
  async connect() {}
  async close() {}
  db() { return { collection: (name) => this.collection(name) }; }
  collection(name) {
    const client = this;
    const records = (options = {}) => { const data = options.session?.documents || client.documents; return data[name] ??= []; };
    const track = (method, filter, options) => client.calls.push({ name, method, filter: copy(filter), transaction: Boolean(options?.session), projection: copy(options?.projection) });
    return {
      async createIndex() {},
      async findOne(filter, options = {}) { track('findOne', filter, options); return project(records(options).find((entry) => matches(entry, filter)), options.projection); },
      find(filter, options = {}) {
        track('find', filter, options);
        let result = records(options).filter((entry) => matches(entry, filter)).map((entry) => project(entry, options.projection));
        return { sort(order) { result.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction; } return 0; }); return this; }, async toArray() { return copy(result); } };
      },
      async insertOne(document, options = {}) {
        track('insertOne', { _id: document._id }, options);
        const list = records(options);
        if (list.some((entry) => entry._id === document._id || document.nameKey && entry.nameKey === document.nameKey)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        list.push(copy(document)); return { insertedId: document._id };
      },
      async updateOne(filter, update, options = {}) {
        track('updateOne', filter, options); client.calls.at(-1).update = copy(update);
        const list = records(options); let record = list.find((entry) => matches(entry, filter));
        const existed = Boolean(record);
        if (!record && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };
        if (!record) { record = copy(filter); list.push(record); for (const [key, value] of Object.entries(update.$setOnInsert || {})) set(record, key, value); }
        for (const [key, value] of Object.entries(update.$set || {})) set(record, key, value);
        for (const [key] of Object.entries(update.$unset || {})) unset(record, key);
        for (const [key, value] of Object.entries(update.$inc || {})) set(record, key, (get(record, key) || 0) + value);
        return { matchedCount: existed ? 1 : 0, modifiedCount: 1 };
      },
      async replaceOne(filter, document, options = {}) {
        track('replaceOne', filter, options);
        const list = records(options), index = list.findIndex((entry) => matches(entry, filter));
        if (index < 0) { if (options.upsert) list.push(copy(document)); } else list[index] = copy(document);
        return { matchedCount: index < 0 ? 0 : 1 };
      },
    };
  }
  startSession() {
    const client = this;
    return {
      async withTransaction(operation) {
        const session = this;
        const pending = client.queue.then(async () => {
          session.documents = copy(client.documents);
          try { const result = await operation(); client.documents = session.documents; return result; }
          finally { delete session.documents; }
        });
        client.queue = pending.catch(() => {}); return pending;
      },
      async endSession() {},
    };
  }
}
