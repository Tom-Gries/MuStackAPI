# StackFriends – API

[MuStackAPI](https://github.com/Tom-Gries/MuStackAPI) enthält das Node.js-Backend. Das Spiel liegt in [MuStack](https://github.com/Tom-Gries/MuStack), die gemeinsamen Spielregeln in [MuStackShared](https://github.com/Tom-Gries/MuStackShared). Jedes Repository hat seine eigene Git-Historie.

## Lokal entwickeln

Node.js ab Version 22. Im Backend-Ordner:

```sh
npm ci
npm run dev:local
```

Die API läuft auf http://127.0.0.1:3001. Der lokale Modus verwendet `.data/world.json` und ignoriert die Cloud-Zugangsdaten, selbst wenn sie in `.env.local` stehen. Das Frontend separat mit `npm run dev` im Frontend-Ordner starten.

`npm run dev` und `npm start` verwenden die Konfiguration aus `.env.local` beziehungsweise der Umgebung. Für die gemeinsame lokale Vorschau zuerst das Frontend mit `npm run build` bauen und anschließend hier `npm run preview:local` starten. Sie läuft auf http://localhost:3003 mit der lokalen Dateiwelt; `FRONTEND_DIST` kann auf einen anderen fertigen Frontend-Build zeigen.

## Konfiguration

Lokale Einstellungen gehören in die ignorierte Datei `.env.local`; `.env.example` dient als Vorlage. Bei Vercel diese drei Pflichtvariablen im API-Projekt setzen:

| Pflichtvariable | Wert |
| --- | --- |
| `MONGODB_URI` | Vollständige MongoDB-Atlas-Verbindungsadresse einschließlich Zugangsdaten. |
| `REDIS_URL` | Native Redis-Verbindungsadresse (`redis://` oder `rediss://`) für den Austausch zwischen API-Instanzen. |
| `APP_ORIGIN` | Genaue öffentliche Frontend-Adresse einschließlich `https://`. |

MongoDB speichert den dauerhaften Spielstand. Redis koordiniert Nachrichten, Anwesenheit, Reservierungen und Einmaltickets zwischen laufenden API-Instanzen. Für den Betrieb auf Vercel sind beide Dienste erforderlich.

Optional legt `MONGODB_DB` den Datenbanknamen fest; der Standard ist `StackFriends-dev`. `API_ORIGIN` kann die öffentliche API-Adresse für direkte WebSocket-Verbindungen festlegen. Lokal kann `PORT` den Standardport 3001 ersetzen und `WORLD_FILE` den Pfad zur Dateiwelt. Zugangsdaten werden ausschließlich im Backend hinterlegt und nicht in Git eingecheckt.

## Prüfen

```sh
npm test
npm run check
```

Die API-Tests prüfen Speicherung, Sitzung, Echtzeitverbindungen und die Zusammenarbeit mehrerer Instanzen. Installation, Tests und CI benötigen keinen weiteren lokalen Checkout. Die eigentlichen Spielregeltests liegen im Shared-Repository.

## Gemeinsame Spielregeln

Beide Apps beziehen `@stackfriends/shared` als öffentliches HTTPS-Archiv aus dem Shared-Repository. Dieselbe vollständige Commit-SHA mit 40 Zeichen legt ihre gemeinsame Regelversion fest; `package.json` und `package-lock.json` werden mitcommittet. Die Lockdatei enthält auch die Integritätsprüfung des Archivs.

Regeln zuerst im Shared-Repository ändern, mit `npm test` prüfen und committen/pushen. Danach in API und Frontend jeweils die neue SHA einsetzen:

```sh
npm install '@stackfriends/shared@https://codeload.github.com/Tom-Gries/MuStackShared/tar.gz/<commit-sha>'
```

Anschließend beide Apps prüfen und ihre jeweiligen Änderungen committen/pushen. `npm ci` lädt die festgelegte öffentliche Version automatisch. Ein lokaler Shared-Checkout, Kopierschritte und zusätzliche Zugangsdaten werden für Builds nicht benötigt.

## Vercel

Dieses Repository als eigenes Projekt mit Framework **Other** importieren. Root Directory ist der Repository-Hauptordner. `vercel.json` enthält den Node-/WebSocket-Einstieg `api/socket.js`; Fluid Compute muss aktiv sein.

Die drei Pflichtvariablen aus der Konfiguration im API-Projekt setzen. Im Frontend-Projekt wird zusätzlich `BACKEND_URL` auf die API-Adresse gesetzt. Das Shared-Paket ist eine Bibliothek und erhält kein eigenes Vercel-Deployment.
