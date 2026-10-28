// Two real WebSocket tabs of the same player. Isolated file state, no Atlas writes.
// Default: 75 seconds idle with both tabs, then five seconds with one tab closed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from './app.js';

const directory = await mkdtemp(path.join(tmpdir(), 'stackfriends-connection-'));
const clients = [];
const duration = Number(process.argv.find((argument) => argument.startsWith('--duration='))?.split('=')[1] || 75_000);
let game;
let cleanup = false;
try {
  assert.ok(Number.isFinite(duration) && duration >= 70_000 && duration <= 90_000, 'Die Ruhephase muss zwischen 70000 und 90000 Millisekunden liegen.');
  game = await createGameServer({ config: { mode: 'local', worldFile: path.join(directory, 'world.json'), secureCookie: false } });
  await new Promise((resolve) => game.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${game.server.address().port}`;
  const joined = await fetch(`${address}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Verbindungstest' }) });
  assert.equal(joined.status, 200);
  const cookie = joined.headers.get('set-cookie').split(';')[0];
  const connect = async () => {
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/socket', { headers: { Cookie: cookie } });
    const client = { socket, unexpectedCloses: 0, nativePings: 0, applicationPongs: 0, initialStates: 0, errors: 0 };
    clients.push(client);
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Initialer Weltstand fehlt.')), 5_000);
      socket.on('message', (buffer) => {
        const message = JSON.parse(buffer);
        if (message.type === 'state') { client.initialStates++; clearTimeout(timeout); resolve(); }
        if (message.type === 'pong') client.applicationPongs++;
        if (message.type === 'error') client.errors++;
      });
      socket.on('error', () => { client.errors++; clearTimeout(timeout); reject(new Error('WebSocket-Verbindungsfehler.')); });
    });
    // ws automatically answers these control frames, just as a browser does.
    socket.on('ping', () => client.nativePings++);
    socket.on('close', () => { if (!cleanup && !client.expectedClose) client.unexpectedCloses++; });
    client.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, 5_000);
    await ready;
    return client;
  };
  await connect();
  await connect();
  await delay(100);
  const before = { ...game.service.repository.metrics };
  const start = performance.now();
  let presenceChecks = 0;
  while (performance.now() - start < duration) {
    await delay(Math.min(5_000, Math.max(1, duration - (performance.now() - start))));
    const online = await game.service.realtime.online();
    presenceChecks++;
    assert.equal(online.players.length, 1, 'Zwei Tabs desselben Spielers zählen als eine anwesende Person.');
    for (const client of clients) assert.equal(client.socket.readyState, WebSocket.OPEN, 'Ein ruhender Tab wurde unerwartet getrennt.');
  }
  const quiet = {
    durationMs: Math.round(performance.now() - start),
    databaseReads: game.service.repository.metrics.reads - before.reads,
    databaseWrites: game.service.repository.metrics.writes - before.writes,
  };
  assert.equal(quiet.databaseReads, 0, 'Die ruhende Welt benötigt keine Zustandsabfragen.');
  assert.equal(quiet.databaseWrites, 0, 'Die ruhende Welt benötigt keine Zustandsänderungen.');
  for (const client of clients) {
    assert.equal(client.unexpectedCloses, 0);
    assert.equal(client.errors, 0);
    assert.ok(client.nativePings >= 10 && client.applicationPongs >= 10, 'Beide Heartbeat-Wege wurden ausreichend lange geprüft.');
  }
  clients[0].expectedClose = true;
  clients[0].socket.close();
  clearInterval(clients[0].heartbeat);
  await delay(5_500);
  assert.equal((await game.service.realtime.online()).players.length, 1, 'Schließen eines Tabs darf den anderen nicht abmelden.');
  assert.equal(clients[1].socket.readyState, WebSocket.OPEN);
  console.log(JSON.stringify({
    ok: true, clients: 2, samePlayer: true, quiet, presenceChecks,
    unexpectedCloses: clients.reduce((sum, client) => sum + client.unexpectedCloses, 0),
    nativePingCounts: clients.map((client) => client.nativePings),
    applicationPongCounts: clients.map((client) => client.applicationPongs),
    remainingTabOnlineAfterOtherClosed: true,
    isolatedLocalFile: true,
    notes: 'Tests transport/presence without a Vite or Node watch restart. The normal npm run dev intentionally restarts the backend after changes to imported server or shared game modules.',
  }, null, 2));
} catch (error) {
  console.error(`Verbindungsprüfung fehlgeschlagen: ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup = true;
  for (const client of clients) { clearInterval(client.heartbeat); client.socket.terminate(); }
  if (game) await game.close();
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('stackfriends-connection-')) await rm(directory, { recursive: true, force: true });
}
