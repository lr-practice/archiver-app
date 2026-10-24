# Archiver

Referenzen aus dem Web sichern, sichten und sortieren.

- `extension/` – Chrome-Extension (Sichern per Drag & Drop in Zonen)
- `app/` – Desktop-App für den Mac (Tauri 2: Sichten und Sortieren)
- `docs/` – Handoff, Roadmap

Geplant: `web/` (Website), `brand/` (Identität).

## App bauen

Die Mac-Version baut GitHub Actions bei jedem Push auf `app/` (Workflow „App macOS") und legt sie unter Releases als Vorabversion `app-latest` ab.

Lokal (Rust und Node nötig):

```sh
cd app
npm install
npx tauri dev      # starten
npx tauri build    # .app und .dmg bauen
cd src-tauri && cargo test --lib   # Tests der Bibliothek
```

## Demo-App (Testlandschaft)

Größere Umbauten erst als „Archiver Demo“ ausprobieren: Workflow „App macOS“ auf
dem Branch des Experiments mit Haken bei `demo` starten. Die Demo hat eine eigene
Kennung (`app.archiver.demo`) und eigene Einstellungen, schlägt `~/Archiver Demo`
als Bibliothek vor, sucht keine Updates und meldet sich nicht als Brücke für
Chrome oder Safari an. Das DMG liegt nur als Artefakt am Actions-Lauf, nichts
geht in die Releases. Im Code: `DEMO` in `lib.rs`, in der Oberfläche
`html[data-demo]`.

## Brücke Extension ↔ App

Die App registriert sich bei jedem Start als Native-Messaging-Host `app.archiver.bridge` (Manifest in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`). Chrome startet dann dasselbe Programm mit `chrome-extension://…` als Argument; es öffnet kein Fenster, sondern beantwortet Anfragen der Extension (`app/src-tauri/src/bridge.rs`). Erlaubt ist nur die Extension mit der festen ID aus `extension/manifest.json` (`key`). Die Chrome-Web-Store-ID kommt in Phase 4 in `EXTENSION_IDS` dazu.
