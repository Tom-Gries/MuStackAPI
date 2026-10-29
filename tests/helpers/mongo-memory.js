import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const field = (document, path) => path.split('.').reduce((value, key) => value?.[key], document);
const same = (left, right) => isDeepStrictEqual(left, right);

function condition(value, query) {
  if (query instanceof Date || query === null || typeof query !== 'object' || Array.isArray(query)) return same(value, query);
  return Object.entries(query).every(([operator, expected]) => {
    if (operator === '$gt') return value > expected;
    if (operator === '$lte') return value <= expected;
    if (operator === '$ne') return !same(value, expected);
    if (operator === '$in') return expected.some((entry) => same(value, entry));
    if (operator === '$exists') return (value !== undefined) === expected;
    if (operator === '$elemMatch') return Array.isArray(value) && value.some((entry) => matches(entry, expected));
    if (operator === '$not') return !condition(value, expected);
    throw new Error('Unsupported fixture query operator: ' + operator);
  });
}

function matches(document, query) {
  return Object.entries(query).every(([path, expected]) => {
    if (path === '$or') return expected.some((entry) => matches(document, entry));
    if (path === '$and') return expected.every((entry) => matches(document, entry));
    return condition(field(document, path), expected);
  });
}

function expression(value, document, variables = {}) {
  if (typeof value === 'string' && value.startsWith('$$')) {
    const [name, ...path] = value.slice(2).split('.');
    return path.length ? field(variables[name], path.join('.')) : variables[name];
  }
  if (typeof value === 'string' && value.startsWith('$')) return field(document, value.slice(1));
  if (Array.isArray(value)) return value.map((entry) => expression(entry, document, variables));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const entries = Object.entries(value);
  if (entries.length !== 1 || !entries[0][0].startsWith('$')) return Object.fromEntries(entries.map(([key, entry]) => [key, expression(entry, document, variables)]));
  const [operator, input] = entries[0];
  if (operator === '$literal') return clone(input);
  if (operator === '$filter') return expression(input.input, document, variables).filter((entry) => expression(input.cond, document, { ...variables, [input.as]: entry }));
  const values = expression(input, document, variables);
  if (operator === '$ifNull') return values[0] ?? values[1];
  if (operator === '$concatArrays') return values.flat();
  if (operator === '$and') return values.every(Boolean);
  if (operator === '$not') return !values[0];
  if (operator === '$eq') return same(values[0], values[1]);
  if (operator === '$gt') return values[0] > values[1];
  if (operator === '$in') return values[1].some((entry) => same(values[0], entry));
  throw new Error('Unsupported fixture expression: ' + operator);
}

function setField(document, path, value) {
  const keys = path.split('.');
  let target = document;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  target[keys.at(-1)] = clone(value);
}

/** Atomic, query-checked Mongo surface for isolated multi-instance tests. */
export function createMongoMemory() {
  const collections = new Map();
  const calls = [];
  const streams = new Set();
  const history = [];
  let operationTime = 0;
  const database = { streams };
  const record = (collection, operation, args) => calls.push({ collection, operation, args: clone(args) });
  const deliver = (stream, change) => {
    if (stream.closed || !stream.pipeline.every((stage) => !stage.$match || matches(change, stage.$match))) return;
    if (stream.readable && !stream.readable.destroyed) stream.readable.emit('data', clone(change));
    stream.emit('change', clone(change));
  };
  const changed = (name, operationType, before, after, updatedFields) => {
    const change = { _id: { sequence: ++operationTime }, clusterTime: operationTime, operationType, ns: { db: 'fixture', coll: name }, documentKey: { _id: (after || before)._id } };
    if (operationType === 'insert' || operationType === 'replace') change.fullDocument = clone(after);
    if (operationType === 'update') change.updateDescription = { updatedFields: clone(updatedFields), removedFields: [] };
    history.push(change);
    for (const stream of streams) queueMicrotask(() => deliver(stream, change));
  };
  database.watch = (pipeline, options = {}) => {
    record('$database', 'watch', [pipeline, options]);
    const stream = new EventEmitter();
    stream.pipeline = pipeline;
    stream.closed = false;
    stream.stream = (options) => {
      record('$database', 'rawStream', [options]);
      if (!stream.readable) {
        const readable = new EventEmitter();
        readable.destroyed = false;
        readable.destroy = () => {
          if (!readable.destroyed) { readable.destroyed = true; readable.emit('close'); }
          return readable;
        };
        stream.readable = readable;
      }
      return stream.readable;
    };
    stream.close = async () => {
      if (stream.closed) return;
      stream.closed = true;
      streams.delete(stream);
      stream.readable?.destroy();
      stream.emit('close');
    };
    database.beforeWatch?.();
    const through = operationTime;
    streams.add(stream);
    queueMicrotask(() => {
      if (stream.closed) return;
      for (const change of history) if (change.clusterTime > (options.startAtOperationTime ?? through) && change.clusterTime <= through) deliver(stream, change);
      stream.emit('resumeTokenChanged', { sequence: through });
    });
    return stream;
  };
  database.command = async (command) => { record('$database', 'command', [command]); return { ok: 1, operationTime }; };
  database.collection = (name) => {
    if (collections.has(name)) return collections.get(name);
    const docs = new Map();
    const collection = { docs, streams };
    collection.createIndex = async (...args) => { record(name, 'createIndex', args); return 'fixture-index'; };
    collection.insertOne = async (input) => {
      record(name, 'insertOne', [input]);
      const document = { _id: input._id ?? randomUUID(), ...clone(input) };
      if (docs.has(document._id)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
      docs.set(document._id, document);
      changed(name, 'insert', undefined, document);
      return { acknowledged: true, insertedId: document._id };
    };
    collection.find = (query) => {
      record(name, 'find', [query]);
      let projection;
      const cursor = { project(value) { projection = value; return cursor; }, async toArray() {
        return [...docs.values()].filter((entry) => matches(entry, query)).map((entry) => {
          if (!projection) return clone(entry);
          const result = {};
          for (const [key, enabled] of Object.entries(projection)) if (enabled && field(entry, key) !== undefined) setField(result, key, field(entry, key));
          return result;
        });
      } };
      return cursor;
    };
    collection.findOneAndDelete = async (query) => {
      record(name, 'findOneAndDelete', [query]);
      const document = [...docs.values()].find((entry) => matches(entry, query));
      if (!document) return null;
      docs.delete(document._id); changed(name, 'delete', document);
      return clone(document);
    };
    collection.deleteOne = async (query) => {
      record(name, 'deleteOne', [query]);
      const document = [...docs.values()].find((entry) => matches(entry, query));
      if (!document) return { deletedCount: 0 };
      docs.delete(document._id); changed(name, 'delete', document);
      return { deletedCount: 1 };
    };
    collection.updateOne = async (query, update, options = {}) => {
      record(name, 'updateOne', [query, update, options]);
      let document = [...docs.values()].find((entry) => matches(entry, query));
      const inserting = !document;
      if (inserting && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      if (inserting) {
        document = { _id: query._id ?? randomUUID() };
        if (docs.has(document._id)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      const before = clone(document);
      const updatedFields = {};
      if (Array.isArray(update)) {
        for (const stage of update) {
          if (!stage.$set || Object.keys(stage).length !== 1) throw new Error('Unsupported fixture update stage');
          const values = Object.fromEntries(Object.entries(stage.$set).map(([key, value]) => [key, expression(value, document)]));
          for (const [key, value] of Object.entries(values)) { setField(document, key, value); updatedFields[key] = clone(value); }
        }
      } else {
        for (const [operator, values] of Object.entries(update)) {
          if (operator !== '$set') throw new Error('Unsupported fixture update operator: ' + operator);
          for (const [key, value] of Object.entries(values)) { setField(document, key, value); updatedFields[key] = clone(value); }
        }
      }
      docs.set(document._id, document);
      const modified = !same(before, document);
      if (inserting || modified) changed(name, inserting ? 'insert' : 'update', before, document, updatedFields);
      return { matchedCount: inserting ? 0 : 1, modifiedCount: inserting ? 0 : Number(modified), upsertedCount: Number(inserting) };
    };
    collection.watch = (pipeline, options) => database.watch([{ $match: { 'ns.coll': name } }, ...pipeline], options);
    collections.set(name, collection);
    return collection;
  };
  return { database, calls, collections, streams };
}
