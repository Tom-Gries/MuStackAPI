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

Die laufende Welt wird im Browser berechnet: Kartenaktionen, Paketinhalt, Abbau, Bau, Kampf und Tierbewegungen reagieren ohne HTTP-Anfrage. Ein reproduzierbarer Zufallszustand gehört zum Spielstand. Der Browser sammelt die tatsächlich ausgeführten Spielaktionen und Ereignisschritte in einem lokalen Journal und sendet sie etwa alle 60 Sekunden gebündelt an `/api/save`. Der Server prüft dieses Paket mit denselben Regeln und speichert es in einer Transaktion. Er führt keine laufende Simulation und keine Timer, Sockets oder MongoDB Change Streams aus. Globale Katalogänderungen bleiben eine gesonderte Serveraktion.

Im sichtbaren Spiel gibt es gewöhnlich ungefähr einen Hintergrundkontakt pro Minute: ein Speicherpaket bei Änderungen oder ein kleines `/api/presence`-Lebenszeichen bei unverändertem Stand. Speicherantworten erneuern ebenfalls die Anwesenheit. Ein zusätzliches `/api/sync` wird nur für einen bekannten Geschenkeingang oder bewusstes Aktualisieren benötigt; Ereignistermine lösen keine HTTP-Anfragen aus. Große Journale werden früher in begrenzten Paketen gesichert. Öffnen, Verlassen, Geschenke, Spielerliste und Editoraktionen können weitere kurze Aufrufe auslösen. Ein geschlossenes Spiel stellt keine laufenden Anfragen.

Ein Rathaus wird aus 100 Steinen mit einem Menschen in 60 Sekunden hergestellt. Es öffnet die Spielerliste, Materialansicht und Geschenkfunktion. Die drei Social-Endpunkte prüfen das Rathaus serverseitig. Online-Hinweise erscheinen nur bei geöffnetem Spiel mit eigenem Rathaus.

Geschenke werden serverseitig aus der tatsächlichen Kartenauswahl erzeugt. Eine MongoDB-Transaktion zieht sie ab und legt sie im Empfängerpostfach ab. Eine weitere Transaktion stellt sie mit neuen IDs zu und markiert den Eingang als erledigt. Aktions-IDs verhindern doppelte Verarbeitung nach Wiederholungen. Menschen, Leichen, angreifende Kreaturen und gerade beschäftigte oder ausgerüstete Karten werden abgelehnt.

Beim Wiederöffnen werden begonnene Abbau- und Herstellungsarbeiten anhand der vergangenen Zeit nachgeholt. Mehrere Quellen werden nacheinander verarbeitet, Werkzeugboni gelten auch offline, und verbrauchte Quellen verschwinden. Der Browser holt dies beim Laden einmal nach und sichert das Ergebnis mit dem nächsten Journalpaket, ohne laufenden Serverprozess während der Abwesenheit. Kämpfe und Kreaturbewegungen bleiben in der abwesenden Zeit pausiert; Erdbeerwachstum verwendet weiterhin Echtzeit. Separate Browser-Tabs besitzen eigene begrenzte Anwesenheits-Leases; ein geschlossener Tab beendet die anderen nicht.

Noch nicht bestätigte Aktionen liegen zusätzlich im Browser-Speicher. Ein Speicherpaket behält bei Wiederholungen dieselbe ID; Bestätigungen entfernen nur den bestätigten Journalanfang. Nach verlorener Antwort kann der verbleibende Teil wiederhergestellt werden. Basisrevisionen verhindern, dass eine alte Sitzung neuere Welten oder versandte Geschenke überschreibt. Ein fremder Versionskonflikt bewahrt die lokale Sicherung, statt sie still zu verwerfen.

Neue Speicherpakete geben mit `catalogContentVersion` die Regelversion des Browsers an. Bei abweichenden Regeln fordert die API einen neuen Spielstand an, bevor sie das Journal verarbeitet; bereits bestätigte Speicher-IDs bleiben abrufbar. So werden ältere Browseraktionen nach einem Inhaltsupdate nicht unter geänderten Rezepten nachgerechnet.

Kisten enthalten ihre eingelagerten Ressourcen und Nahrung als Teil des gespeicherten Weltstands. Die Materialübersicht zählt den Inhalt mit. Eine gefüllte Kiste muss vor dem Verschenken geleert werden; Katalogänderungen dürfen eingelagerte Kartentypen nicht entfernen.

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
