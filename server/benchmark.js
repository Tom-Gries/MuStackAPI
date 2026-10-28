// Reproducible local measurement. Never uses Atlas or the normal local world.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from './app.js';

const directory = await mkdtemp(path.join(tmpdir(), 'stackfriends-benchmark-'));
const clients = [];
const clientCount = Number(process.argv.find((argument) => argument.startsWith('--clients='))?.split('=')[1] || 2);
let game;
try {
  if (!Number.isInteger(clientCount) || clientCount < 2 || clientCount > 16) throw new Error('Bitte 2 bis 16 Testspieler wählen.');
  game = await createGameServer({ config: { mode: 'local', worldFile: path.join(directory, 'world.json'), secureCookie: false }, rng: () => 0.1 });
  await new Promise((resolve) => game.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${game.server.address().port}`;
  const online = async (name) => {
    const response = await fetch(`${address}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const session = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/socket', { headers: { Cookie: cookie } });
    const pending = new Set();
    const wait = (predicate, timeout = 15_000) => new Promise((resolve, reject) => {
      const entry = { predicate, resolve, timer: setTimeout(() => { pending.delete(entry); reject(new Error('Benchmark-Verbindung hat nicht rechtzeitig geantwortet.')); }, timeout) };
      pending.add(entry);
    });
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      for (const entry of [...pending]) if (entry.predicate(message)) { clearTimeout(entry.timer); pending.delete(entry); entry.resolve(message); }
    });
    socket.on('error', () => {});
    const send = (message) => socket.send(JSON.stringify(message));
    const command = async (value) => {
      const commandId = randomUUID();
      const reply = wait((event) => event.commandId === commandId && ['ack', 'error'].includes(event.type));
      send({ type: 'command', commandId, command: value });
      const result = await reply;
      if (result.type === 'error') throw new Error(result.message);
      return result;
    };
    clients.push({ socket });
    await wait((message) => message.type === 'state');
    return { socket, session, send, wait, command };
  };
  const first = await online('Messung A');
  for (let index = 1; index < clientCount; index++) await online(`Messung ${index + 1}`);
  await delay(50);

  const counters = () => ({
    applicationMessagesSent: game.metrics.messagesSent, applicationBytesSent: game.metrics.bytesSent,
    applicationMessagesReceived: game.metrics.messagesReceived, applicationBytesReceived: game.metrics.bytesReceived,
    databaseReads: game.service.repository.metrics.reads, databaseWrites: game.service.repository.metrics.writes,
    databaseReadBytes: game.service.repository.metrics.readBytes, databaseWriteBytes: game.service.repository.metrics.writeBytes,
    dragPreviews: game.service.realtime.metrics.dragPreviews,
  });
  const measure = async (action) => {
    const before = counters();
    const cpu = process.cpuUsage();
    const start = performance.now();
    await action();
    const after = counters();
    return {
      durationMs: Math.round(performance.now() - start),
      ...Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]])),
      processCpuMicroseconds: process.cpuUsage(cpu),
    };
  };
  const idle = await measure(() => delay(6_100));
  const humanId = first.session.player.cardId;
  const dragging = await measure(async () => {
    const reserved = first.wait((message) => message.type === 'lock' && message.cardId === humanId);
    first.send({ type: 'drag-start', cardId: humanId, split: true });
    await reserved;
    for (let index = 0; index < 50; index++) {
      first.send({ type: 'drag', cardId: humanId, x: 300 + index, y: 450 });
      await delay(101);
    }
    await first.command({ type: 'move', cardId: humanId, x: 350, y: 450, split: true });
  });

  let world = (await game.service.snapshot()).world;
  const gold = world.cards.find((card) => card.type === 'gold');
  await first.command({ type: 'move', cardId: gold.id, zone: 'shop', x: 600, y: 450 });
  world = (await game.service.snapshot()).world;
  const pack = world.cards.find((card) => card.type === 'pack');
  await first.command({ type: 'move', cardId: pack.id, zone: 'open', x: 650, y: 450 });
  world = (await game.service.snapshot()).world;
  const tree = world.cards.find((card) => card.type === 'tree');
  await first.command({ type: 'move', cardId: humanId, targetId: tree.id, split: true, x: tree.x, y: tree.y });
  await delay(20);
  const working = await measure(() => first.wait((message) => message.type === 'patch' && message.upsert.some((card) => card.type === 'wood')));
  console.log(JSON.stringify({
    clients: clientCount, storage: 'isolated local file',
    notes: 'Application payload counters exclude native WebSocket ping/pong frames. Database bytes describe the local file adapter, not MongoDB wire traffic. CPU includes the server and test clients. Atlas/Redis/Vercel runtime consumption must be measured in the deployed environment.',
    idle, dragging, working,
  }, null, 2));
} finally {
  for (const { socket } of clients) socket.terminate();
  if (game) await game.close();
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('stackfriends-benchmark-')) await rm(directory, { recursive: true, force: true });
}
