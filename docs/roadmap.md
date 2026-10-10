# Archiver – Bestandsaufnahme & Roadmap bis Launch

Stand: 07.10.2026 · Basis: Extension v3.2.0 + Handoff v3.2.0

---

## 1. Kurzfazit

- **Die Extension ist ein starker Kern.** Die Geste (Bild ziehen → Zone → liegt im Ordner) ist schnell, eigenständig und erklärt sich in drei Sekunden. Das ist der USP, nicht die Galerie.
- **Die Galerie gehört in die App.** Overlay und Vollansicht bauen heute eine halbe Desktop-App im Browser nach, mit doppeltem Code und ohne echten Dateizugriff. Mit der App wird die Extension wieder schlank: Sichern. Die App: Sichten und Sortieren.
- **Ein Prinzip trägt das Produkt:** *Deine Referenzen sind Dateien in deinen Ordnern.* Keine Cloud, kein Account, kein Lock-in. Das ist die Abgrenzung zu Pinterest, Are.na, mymind und Cosmos und die direkte Antwort auf Eagle.
- **Größte Lücke heute:** Die Quelle (Seiten-URL, Titel) wird beim Sichern nicht gespeichert. Für Recherche und Credits ist das die wichtigste Metainformation.

---

## 2. Bestandsaufnahme v3.2.0

### Stark
- MV3, Vanilla JS, kein Build-Step, ca. 140 KB. Leicht, wartbar, Review-freundlich.
- Download- und Verschiebe-Logik sauber gelöst: Status abwarten, Original erst nach Erfolg löschen, Index-Warteschlange gegen Race Conditions.
- High-Res-Erkennung (Link, `<picture>`, `srcset`, Lazy-Load-Attribute, `background-image`) ist ein echter Mehrwert gegenüber „Bild speichern unter".
- Klare Designsprache: dunkel, keine Rundungen, gestrichelte Zonen, Monogramme. Gute Basis für eine Identität.
- Handoff und README sind präzise. Architektur-Entscheidungen sind dokumentiert.

### Schwach / offen
| Punkt | Wirkung | Wo |
|---|---|---|
| **Nie im echten Chrome getestet** | Unbekannte Bugs bei Verschieben, Esc-Kaskade, Sync | Handoff „Getestet" |
| Quelle der Seite fehlt | Kein Credit, kein Rückweg zum Kontext | `download-image` sendet nur `{url, folder, suggestedName}` |
| Galerie doppelt (Overlay + Vollansicht) | `content.js` 1371 Zeilen, `dashboard.js` 798 Zeilen, CSS doppelt | Handoff „Offene Baustellen" |
| Verschieben = neu laden | Scheitert bei toten Links, kostet Traffic, ändert Datei-IDs | Extension-API-Grenze |
| Thumbnails aus Original-URL | Galerie bricht offline oder bei abgelaufenen CDN-Links | `listFolder` |
| Nur im Chrome-Downloads-Ordner | Bibliothek mischt sich mit normalen Downloads | `chrome.downloads` |
| Limit 500 Bilder pro Zone | Für ein Archiv zu klein | `MAX_ITEMS_PER_FOLDER` |
| `console.log` auf jeder Seite | Unsauber, Store-Review, Privacy-Eindruck | `content.js:9` u. a. |
| Content-Script auf `<all_urls>` + alle Frames | Nötig für die Geste, braucht im Web Store eine klare Begründung | `manifest.json` |
| Nur Deutsch | Kreativszene ist international | alle UI-Texte |
| Icons sind Platzhalter | Kein Markenauftritt | `icons/` |

---

## 3. Produktbild

```
  BROWSER                         DESKTOP
  ┌─────────────────────┐         ┌──────────────────────────────┐
  │ Archiver Extension  │         │ Archiver App                 │
  │ Sichern             │ ──────▶ │ Sichten · Sortieren · Finden │
  │ Ziehen → Zone       │  Brücke │ Bibliothek = Ordner auf Disk │
  └─────────────────────┘         └──────────────────────────────┘
                                          │
                                          ▼
                                  ~/Archiver/  (Finder, Figma, InDesign …)
```

- **Extension:** Drop-Zonen, High-Res-Erkennung, Toast. Kein Galerie-Code mehr (optional ein Mini-„Zuletzt gesichert"-Streifen).
- **App:** die Bibliothek. Raster, Lightbox, Verschieben, Tags, Suche, Quelle, Export.
- **Ordner:** die Wahrheit. Alles, was die App weiß, lässt sich aus Dateien plus einer Metadaten-Datei rekonstruieren.

---

## 4. Architektur Desktop-App

### 4.1 Stack: Tauri 2 (Empfehlung)
| | Tauri 2 | Electron |
|---|---|---|
| App-Größe | ca. 10 MB | ca. 100 MB+ |
| UI | Web (Vanilla JS/CSS weiterverwendbar) | Web |
| Dateisystem, Watcher, SQLite | Rust, nativ und schnell | Node |
| Native Messaging Host | als Sidecar mitlieferbar | als Script mitlieferbar |
| Risiko | Rust-Teil (übernehme ich) | schwer, wirkt „billig" in der Szene |

Tauri passt zum Produktcharakter: klein, schnell, ehrlich. Die bestehende Vanilla-Galerie wird zur gemeinsamen Web-Komponente.

### 4.2 Bibliothek auf Disk
```
~/Archiver/                    frei wählbarer Ort
  Inbox/                       Default-Zone: alles ohne Ziel landet hier
  Projekt A/
  Kunden/Projekt-B/            verschachtelte Zonen bleiben möglich
  .archiver/
    library.db                 SQLite: Items, Quellen, Tags, Farben, Notizen
    thumbs/                    eigene Vorschaubilder (offline-fest)
```
- **Ordner = Zone.** Was im Finder angelegt, verschoben oder gelöscht wird, sieht die App über einen Dateisystem-Watcher.
- **Datenbank ist Cache plus Metadaten.** Fehlt sie, baut die App den Bestand aus den Ordnern neu auf. Metadaten zusätzlich als Export (`.archiver/metadata.json`), damit nichts an der DB hängt.
- **Identität per Content-Hash.** Damit erkennt die App Duplikate und verliert keine Metadaten, wenn Dateien im Finder umbenannt oder verschoben werden.

### 4.3 Datenmodell (Kern)
```
item     id, hash, path, filename, width, height, format, bytes, created_at
source   item_id, image_url, page_url, page_title, domain, captured_at
tag      id, name          item_tag  item_id, tag_id
meta     item_id, note, rating, colors[5]
```

### 4.4 Brücke Extension ↔ App
**Empfehlung: Chrome Native Messaging.**
1. Die App installiert einen kleinen Host (`app.archiver.bridge`). Chrome startet ihn bei Bedarf selbst, auch wenn die App geschlossen ist.
2. Drop in der Extension: Die Extension lädt das Bild mit den Cookies und Rechten des Browsers per `fetch` (wichtig bei geschützten Bildern) und schickt Bytes und Metadaten an den Host: `{zone, imageUrl, pageUrl, pageTitle, bytes}`.
3. Der Host schreibt die Datei in den Zonen-Ordner und den Eintrag in die DB. Die App aktualisiert sich live.
4. **Zonen kommen aus der App.** Die Extension fragt beim Host die Zonenliste ab; Ordner der Bibliothek erscheinen als Zonen.

**Fallback ohne App (Standalone-Modus):** Die Extension funktioniert weiter wie heute über `chrome.downloads` in `Downloads/Archiver/…` und merkt sich die Quelle im eigenen Index. Beim ersten App-Start bietet die App an, diesen Ordner samt Quellen zu importieren.

Damit entfallen: Verschieben per Neu-Laden, Thumbnail-Abhängigkeit von Original-URLs, die 500er-Grenze und die Bindung an den Downloads-Ordner.

Alternative lokaler HTTP-Server (wie Eagle): funktioniert nur bei laufender App und öffnet einen Port. Native Messaging ist robuster und für die Store-Review sauberer.

### 4.5 Funktionsumfang App v1
**Sichten**
- Raster mit Größenregler; Umschalter quadratisch (`cover`) vs. Originalformat (Masonry)
- Lightbox mit ←/→, Zoom, Vergleich von zwei Bildern nebeneinander
- Infopanel: Quelle (klickbar), Maße, Format, Datum, Tags, Notiz, Farbpalette

**Sortieren**
- Ziehen zwischen Zonen = echtes Verschieben im Dateisystem
- Mehrfachauswahl, Tastatur-Workflow für die Inbox (1–9 = Zone, T = Tag)
- Zonen anlegen, umbenennen, sortieren (wirkt auch in der Extension)

**Finden**
- Suche über Dateiname, Domain, Seitentitel, Tags, Notiz
- Filter nach Farbe, Format, Ausrichtung, Zeitraum

**Rausbringen**
- Bilder aus der App direkt in Figma, InDesign oder den Finder ziehen
- Export einer Auswahl als Ordner oder als Kontaktabzug-PDF (v1.1)

**Bewusst nicht in v1:** Cloud-Sync, Teilen, Kollaboration, KI-Tagging, Video.

---

## 5. Roadmap

Phasen sind nach Abhängigkeit geordnet, nicht nach Datum. Größe: S / M / L.

### Phase 0 · Fundament (S)
- Git-Repository anlegen (siehe Abschnitt 9), v3.2.0 als erster Commit
- Realer Test in Chrome nach Handoff-Checkliste, Bugs fixen
- `console.log` entfernen bzw. hinter Debug-Flag
- **Quelle mitsichern:** `pageUrl` und `pageTitle` in `download-image` und im Index, damit ab sofort keine Quelle mehr verloren geht

### Phase 1 · Extension schlank machen (M)
- Galerie-Code aus Overlay entfernen oder auf „Zuletzt gesichert" reduzieren; Vollansicht nur noch im Standalone-Modus
- Overlay in Shadow DOM, CSS-Präfixe entfallen
- i18n (`_locales/en`, `_locales/de`), Englisch als Default
- Shortcut zusätzlich über `chrome.commands` (wirkt auch ohne Seitenfokus)
- Test in Chromium-Browsern: Chrome, Arc, Brave, Edge

### Phase 2 · Desktop-App MVP, macOS (L)
- Tauri-Projekt, Bibliotheksordner wählen, Watcher, SQLite, Thumbnails
- Raster, Lightbox, Infopanel, Verschieben, Inbox, Suche
- Import aus der Extension per `archiver-export.json` (Zonen, Speicherort, Quellen), alternativ aus beliebigem Ordner
- Drag-out in andere Apps

### Phase 3 · Brücke (M) · umgesetzt in Extension 3.6.0 / App 0.2.0
- Native Messaging Host, Installation durch die App
- Extension erkennt die App automatisch und schaltet um; ohne App bleibt Standalone
- Zonen kommen aus der Bibliothek
- Ende-zu-Ende-Test: Seite → Drop → Datei im Ordner → sichtbar in der App

### Phase 4 · Produkt & Marke (M)
- Name final, Wortmarke, App-Icon, Extension-Icons (16/32/48/128), Favicon
- Typografie und UI-System für App, Extension und Website vereinheitlichen
- Onboarding: erster Start der App, erster Drop, Bibliothek wählen
- macOS: Code-Signing, Notarisierung, DMG, Auto-Update
- Chrome Web Store: Listing, Screenshots, Promo-Kacheln, Begründung für `<all_urls>`
- Datenschutzerklärung (kurz, ehrlich: keine Daten verlassen das Gerät)

### Phase 5 · Beta & Launch (M)
- Geschlossene Beta mit 15–30 Designer:innen, Feedback-Formular
- Website und Case live (Abschnitt 7)
- Launch-Kanäle: eigenes Netzwerk und Instagram, Are.na-Kanal, Product Hunt, Designer News, Show HN, Newsletter wie Sidebar oder Typewolf
- Nach Launch: Windows-Version, Firefox, Kontaktabzug-Export, Video/GIF

---

## 6. Release-Checkliste (vor öffentlichem Launch)
- [ ] Realer Chrome-Test bestanden, keine Konsolen-Logs
- [ ] Quelle wird bei jedem Bild gesichert
- [ ] Englisch und Deutsch komplett
- [ ] Extension funktioniert standalone und mit App
- [ ] App signiert, notarisiert, Auto-Update getestet
- [ ] Import aus Standalone-Modus getestet
- [ ] Web-Store-Listing und Datenschutzerklärung
- [ ] Name und Domain gesichert, Markenrecherche gemacht
- [ ] Website, Case, Launch-Film fertig
- [ ] Support-Kanal (Mail oder GitHub Issues)

---

## 7. Case & Website

### Website: ein One-Pager
1. **Hero:** die Geste als Loop-Video. Bild ziehen, Zone leuchtet, Datei liegt im Ordner. Eine Zeile Claim, zwei Buttons: *Add to Chrome* · *Download for Mac*.
2. **Prinzip:** „Your references. Your folders." Keine Cloud, kein Account, kein Abo.
3. **So funktioniert's:** Sichern → Sichten → Benutzen, drei Spalten.
4. **App:** Screens von Raster, Lightbox, Infopanel mit Quelle.
5. **Details für Nerds:** High-Res-Erkennung, Shortcuts, Ordnerstruktur.
6. **Privacy, Changelog, Kolophon** (Schrift, Credits).

Technik: statisch (Astro oder plain HTML), Hosting auf Vercel/Netlify, eigene Domain. Gestalterisch aus demselben System wie die App: gestrichelte Outline als wiederkehrendes Element, keine Rundungen, dunkel.

### Case (für dein Portfolio)
- **Problem:** Recherche zerfällt in Screenshots, Tabs und Downloads. Quellen gehen verloren.
- **Einsicht:** Designer:innen denken in Projekten und Ordnern. Sichern muss so schnell sein wie Wegschauen.
- **Idee:** Die Zone. Ein gestrichelter Rahmen am Bildschirmrand als Interface, Logo und Leitmotiv.
- **System:** Typo, Raster, Monogramme, Farblogik (Blau = aktiv, Grau = Root), Motion.
- **Produkt:** Extension, App, Website als ein System.
- **Wirkung:** Beta-Zahlen, Zitate.

Formate: Case-Seite, 30–45 s Film, Instagram-Carousel, ein Plakat oder Spec-Sheet als Print-Moment.

### Marke, erste Richtung
- **Die Zone als Marke:** Das gestrichelte Rechteck ist bereits das stärkste visuelle Element. Logo, App-Icon und Website-Layout leiten sich daraus ab.
- **Typografie:** System-Font raus. Eine Grotesk für UI plus eine Mono für Metadaten (Quelle, Maße, Datum). Option: eine eigene Display-Schrift für Wortmarke und Website, die zum Case beiträgt.
- **Farbe:** Schwarz/Weiß plus genau ein Akzent. Heute sind es zwei (Blau `#2d5aeb`, Lila `#7c86ff`); auf einen reduzieren schärft das System.
- **Hellmodus:** prüfen. Bilder wirken auf Dunkel besser, aber eine helle Website kann als Kontrast zur dunklen App funktionieren.

---

## 8. Entscheidungen für dich

| # | Frage | Optionen | Empfehlung |
|---|---|---|---|
| 1 | **Name** | „Archiver" behalten · umbenennen | **Umbenennen prüfen.** Auf dem Mac gibt es bereits eine bekannte App „Archiver" (Zip/Archiv-Tool von Incredible Bee). Kollision bei Suche, App-Name und Marke. Markenrecherche vor Phase 4. |
| 2 | **Plattform v1** | nur macOS · macOS + Windows | **Nur macOS.** Kreativszene ist Mac-lastig, Signing/Test halbiert sich. |
| 3 | **Speicherort** | eigener Bibliotheksordner · Downloads bleibt | **Eigener Ordner.** Trennt Archiv von Downloads, ermöglicht echtes Verschieben. |
| 4 | **Geschäftsmodell** | kostenlos · Einmalkauf · Pay what you want · Open Source | **Extension kostenlos, App nach Beta als Einmalkauf.** Kein Abo, passt zum Prinzip „deine Dateien". Open Source als Variante, wenn Reichweite und Glaubwürdigkeit wichtiger sind als Umsatz. |
| 5 | **Sprache** | EN · DE · beides | **EN zuerst, DE zusätzlich.** |
| 6 | **Medien v1** | nur Bilder · plus GIF/Video | **Nur Bilder** (GIF als Datei geht ohnehin). |
| 7 | **Inbox** | alles landet in Inbox · nur Zonen | **Beides:** Zonen bleiben, „Inbox" ist die Default-Zone für schnelles Sichern. |
| 8 | **Rolle der Vollansicht** | bleibt in Extension · entfällt mit App | **Nur noch im Standalone-Modus,** schrittweise auslaufen lassen. |

---

## 9. Repository-Vorschlag

Ein privates GitHub-Repo als Monorepo:
```
archiver/
  extension/     Chrome-Extension (heutiger Stand v3.2.0)
  app/           Tauri-Desktop-App
  web/           Website
  brand/         Logo, Icons, Typo, Farben (Quelldateien und Exporte)
  docs/          Handoff, Roadmap, Entscheidungen
```
Ablauf: Du legst auf GitHub ein leeres privates Repo an und verbindest es mit dem Projekt. Danach committe ich v3.2.0 unverändert als Ausgangsstand und arbeite ab Phase 0 in Branches mit Pull Requests.
