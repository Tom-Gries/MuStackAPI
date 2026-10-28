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
