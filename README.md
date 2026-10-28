# StackFriends – API

Eigenständiges Node.js-Backend für https://github.com/Tom-Gries/MuStack.

## Lokal

Node.js ab Version 22. Im Repository-Hauptordner:

```sh
npm ci
npm start
```

Ohne Datenbank-Konfiguration wird eine lokale Welt in .data/world.json gespeichert. Die API läuft auf http://127.0.0.1:3001; Status: /api/health. .env.example enthält die Konfiguration. Lokale .env.local, .env und atlas-credentials.env werden aus diesem Repository geladen; niemals committen.

## Vercel

- Dieses Repository als eigenes Projekt importieren. Root Directory leer lassen (Repository-Hauptordner), Framework Other.
- vercel.json enthält den Node-/WebSocket-Einstieg api/socket.js. Fluid Compute aktivieren beziehungsweise prüfen.
- MONGODB_URI und MONGODB_DB für MongoDB Atlas setzen. REDIS_URL muss eine native Redis-Verbindungsadresse sein.
- APP_ORIGIN auf die genaue veröffentlichte Frontend-Adresse setzen. Optional API_ORIGIN auf die eigene API-Adresse setzen.
- Auf Vercel sind MongoDB und Redis erforderlich; es gibt dort keinen Dateispeicher-Fallback.

## Prüfen

```sh
npm test
npm run check
```

shared/ enthält die gemeinsamen Spielregeln als lokales npm-Workspace-Paket. Sitzungen bleiben HttpOnly-Cookies der Spielseite; einmal verwendbare, 30 Sekunden gültige Tickets authentifizieren direkte WebSockets. Redis teilt Tickets, Ereignisse und Anwesenheit zwischen API-Instanzen.

## Datenverkehr

MongoDB speichert atomare Feldänderungen mit Revisionsprüfung. Neue Karten und Aktionskennungen werden kompakt angehängt; größere Array-Strukturänderungen ersetzen nur das betroffene Array. Mutationen lesen den aktuellen Weltstand für sichere parallele Änderungen. Authentifizierung und Terminplanung verwenden gezielte Projektionen. Redis-Anwesenheit nutzt atomare, gecachte Lua-Befehle. Native WebSocket-Ping/Pong-Nachrichten reichen als regelmäßiges Lebenszeichen.

Die Modelltests in tests/repository.test.js vergleichen eine Bewegung bei 1.000 Karten und 2.000 Aktionen: 219 Byte JSON-Schreibnutzdaten statt 186.860 Byte für das vollständige Dokument. Echte MongoDB-/Redis-Cloudmessungen stehen noch aus. Lokaler Zwei-Spieler-Benchmark: `node server/benchmark.js --clients=2`. Verbindungstest mit zwei Tabs über 75 Sekunden: `node server/verify-connection.js`. Beide nutzen isolierte lokale Testwelten.
