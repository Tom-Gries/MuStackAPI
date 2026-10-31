# StackFriends – API

[MuStackAPI](https://github.com/Tom-Gries/MuStackAPI) enthält die Node.js-API. [MuStack](https://github.com/Tom-Gries/MuStack) enthält das Spiel und [MuStackShared](https://github.com/Tom-Gries/MuStackShared) die gemeinsamen Regeln. Jedes Repository wird separat versioniert.

## Lokal entwickeln

Node.js ab Version 22. Im Backend-Ordner:

```sh
npm ci
npm run dev:local
```

Die API läuft auf http://127.0.0.1:3001. Der lokale Modus speichert persönliche Welten in `.data/personal-worlds.json` und ignoriert Cloud-Zugangsdaten. Das Frontend separat mit `npm run dev` starten. `npm run dev` beziehungsweise `npm start` im Backend verwenden dagegen `.env.local` und die konfigurierte MongoDB.

Für die lokale Vorschau zuerst das Frontend bauen und anschließend `npm run preview:local` starten. Das Spiel läuft dann auf http://localhost:3003. `FRONTEND_DIST` kann auf einen anderen fertigen Frontend-Build zeigen.

## Konfiguration und Vercel

Lokale Zugangsdaten gehören in die ignorierte Datei `.env.local`; `.env.example` enthält die Vorlage. Dieses Repository bei Vercel als eigenes Projekt mit Framework **Other** importieren. Root Directory ist der Repository-Hauptordner.

| Pflichtvariable | Wert |
| --- | --- |
| `MONGODB_URI` | Vollständige MongoDB-Atlas-Verbindungsadresse einschließlich Zugangsdaten. |
| `APP_ORIGIN` | Öffentliche Frontend-Adresse einschließlich `https://`. |

Im Frontend-Projekt wird `BACKEND_URL` auf die öffentliche API-Adresse gesetzt. Optional ändern `MONGODB_DB` den Datenbanknamen (Standard `StackFriends-dev`), `PORT` den lokalen Port und `WORLD_FILE` die lokale Speicherdatei. Es gibt keine Redis-, WebSocket- oder Push-Service-Konfiguration. Shared ist eine Bibliothek und braucht kein Vercel-Projekt.

## Persönliche Welten und kurze HTTP-Aufrufe

Jeder Name hat eine eigene Welt mit einer Menschenkarte und neun Goldkarten. Ein HttpOnly-Cookie merkt den Zugang. Die Anmeldung mit einem bestehenden Namen öffnet dessen Welt; Namen sind absichtlich nicht zusätzlich geschützt.

Abgeschlossene Aktionen werden über `/api/command` gespeichert. Ziehbewegungen und Animationen erzeugen keine laufenden Netzwerknachrichten. Laufende Arbeiten und Kämpfe werden an ihren tatsächlichen Ereigniszeitpunkten mit `/api/sync` fortgesetzt. Es gibt keine Server-Timer, Sockets oder MongoDB Change Streams.

Im sichtbaren Spiel erneuert ein kleines `/api/presence`-Lebenszeichen etwa jede Minute den Onlinestatus, ohne die Welt zu lesen. Nur wenn weitere Spieler online sind, läuft der regelmäßige vollständige Abgleich. Ein im Profil vermerkter Geschenkeingang löst ebenfalls einen Abgleich aus, damit der Empfänger das Geschenk erhält, selbst wenn der Absender bereits gegangen ist. Wiederöffnen und Sichtbarwerden gleichen immer einmal ab. Ein geschlossenes Spiel stellt keine Anfragen.

Ein Rathaus wird aus 100 Steinen mit einem Menschen in 60 Sekunden hergestellt. Es öffnet die Spielerliste, Materialansicht und Geschenkfunktion. Die drei Social-Endpunkte prüfen das Rathaus serverseitig. Online-Hinweise erscheinen nur bei geöffnetem Spiel mit eigenem Rathaus.

Geschenke werden serverseitig aus der tatsächlichen Kartenauswahl erzeugt. Eine MongoDB-Transaktion zieht sie ab und legt sie im Empfängerpostfach ab. Eine weitere Transaktion stellt sie mit neuen IDs zu und markiert den Eingang als erledigt. Aktions-IDs verhindern doppelte Verarbeitung nach Wiederholungen. Menschen, Leichen, angreifende Kreaturen und gerade beschäftigte oder ausgerüstete Karten werden abgelehnt.

Die Spielzeit pausiert beim Verlassen. Separate Browser-Tabs besitzen eigene begrenzte Leases; ein geschlossener Tab beendet die anderen nicht. Bei einem abrupten Abbruch läuft höchstens die kurze Aktivitätsfrist aus. Echtzeitwachstum bleibt davon unabhängig.

## Daten und Editor

MongoDB verwendet `personalPlayers`, `personalGifts` und den globalen Inhaltskatalog `gameCatalog`. Der Editor ändert weiterhin Karten, Rezepte und Pakete für alle Welten. Prüfungen berücksichtigen auch offline gespeicherte Welten und ausstehende Geschenke.

Beim ersten Start wird ein vorhandener Inhaltskatalog aus der früheren gemeinsamen Welt übernommen. Spielfortschritt wird nicht in persönliche Welten kopiert. Die Migration löscht den alten Stand nicht automatisch; der einmalige Wechsel mit ausdrücklich gewünschter Löschung wird separat ausgeführt. Bilder liegen im Frontend-Repository.

## Prüfen und Regelversion aktualisieren

```sh
npm test
npm run check
```

Die Tests verwenden isolierte lokale Dateien und MongoDB-Fixtures. Sie benötigen keine Atlas-Zugangsdaten. Die Spielregeltests liegen im Shared-Repository.

Beide Anwendungen installieren dieselbe feste Shared-Version als öffentliches HTTPS-Archiv eines vollständigen Git-Commits. Nach Shared-Änderungen dort testen, committen und pushen; anschließend in beiden Apps installieren:

```sh
npm install '@stackfriends/shared@https://codeload.github.com/Tom-Gries/MuStackShared/tar.gz/<commit-sha>'
```

`package.json` und `package-lock.json` werden mitcommittet. Ein unabhängiger `npm ci` benötigt keine weiteren lokalen Checkouts oder Zugangstoken.
