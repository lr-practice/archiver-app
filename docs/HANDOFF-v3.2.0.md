# Archiver – Übergabe (Stand v3.2.0, 07.10.2026)

Vollständiger Projektstand zum Weiterarbeiten in einer neuen Umgebung
(neuer Chat, Claude Code o. Ä.). Nutzer-Doku steht in README.md.

## Idee

Chrome-Extension zum Sammeln von Bildern aus dem Web: Bild ziehen, in eine
„Zone" am unteren Bildschirmrand fallen lassen, landet als Datei im
passenden Unterordner des Downloads-Ordners. Zielgruppe: Recherche,
Moodboards, Projektablage für Design-Arbeit.

## Technik

- Manifest V3, Vanilla JS/CSS, keine Frameworks, kein Build-Step
- Permissions: `downloads`, `storage`, host_permissions `<all_urls>`
- Content-Scripts `shared.js` + `content.js` auf allen Seiten und Frames
- ca. 130 KB Code, `content.js` (~45 KB) ist der größte Brocken

## Drei Oberflächen (Namen bitte genau so verwenden)

1. **Toolbar-Popup** (`popup.*`): nur Einstellungen – Zonenliste,
   Tastenkombination, Info-Umschalter, Button zur Vollansicht. Keine
   Galerie, keine Drops.
2. **Seiten-Overlay** (`content.*`): automatisch beim Ziehen (nur Zonen)
   oder per Tastenkombination (Zonen + Vollgalerie + Einstellungen/Info).
3. **Vollansicht** (`dashboard.*`): eigener Tab, gleiche Galerie-Funktionen
   wie das Overlay, mehr Platz.

Galerie-Funktionen in Overlay und Vollansicht: alle Zonen gleichzeitig,
Verschieben per Ziehen, Mehrfachauswahl (Shift/Strg/Cmd-Klick), Filter
nach Dateiname, Größenregler (48–180 px), Lightbox mit ←/→, Klick = im
Finder anzeigen, Zonen per ⋮⋮ sortieren, gestuftes Esc.

## Datenmodell

- `chrome.storage.sync`
  - `zones`: String-Array, Reihenfolge = links→rechts.
    Default „Projekt 1/2/3", „Downloads". Fallback auf alten Key `projects`.
  - `shortcut`: `{alt, shift, ctrl, meta, key}`, Default Alt+Shift+A
- `chrome.storage.local`
  - `archiveIndex`: `{ [folderKey]: [{ id, url, filename, ts }] }`,
    neueste zuerst, max. 500 pro Zone. `url` ist `null` bei Data-URLs.
  - `dashboardThumbSize`: Thumbnail-Größe der Vollansicht
- Zone „Downloads" (case-insensitive) = folderKey `""` (kein Unterordner)
- Pfade bereinigt (`..` raus, Sonderzeichen → `_`, max. 150 Zeichen/Segment)
- Sync zwischen allen Oberflächen über `storage.onChanged`

## Message-Typen (an background.js)

| Typ | Zweck |
|---|---|
| `download-image` | `{url, folder, suggestedName?}` → Download, Toast-Feedback an den Tab |
| `list-folder-downloads` | `{folder}` → `{items: [{id, url, filename, inHistory}]}` |
| `move-download` | `{id, sourceFolder, targetFolder}` → `{ok, newId}` oder `{ok:false, error}` |
| `show-download` | `{id}` → im Finder zeigen (sonst Downloads-Ordner öffnen) |
| `open-dashboard` | Vollansicht-Tab öffnen |

## Architektur-Entscheidungen (nicht versehentlich rückgängig machen)

- **Verschieben** = neu aus Quell-URL laden, auf `complete` warten, dann
  Original löschen. Keine native Move-API in Extensions. Scheitert der neue
  Download, bleibt das Original.
- **Index-Warteschlange** (`withIndex` in background.js): alle Lese- und
  Schreibzugriffe auf den Index laufen nacheinander, sonst verlieren
  parallele Verschiebungen Einträge.
- **Download-Status abwarten**: `chrome.downloads.download` meldet nur den
  Start. Erst `onChanged` → `complete`/`interrupted` ist verlässlich.
- **Eigene Maus-Events** statt HTML5-Drag für Verschieben/Sortieren in der
  Galerie (native Drags mit Zusatzdaten waren unzuverlässig). Für externe
  Bild-Drops bleibt die native Drag-API.
- **CSS im Overlay präfixiert** (`__dd_`, `__dd_fg_`) und mit maximalem
  z-index. `gallery.css` ist bewusst NICHT als Content-Script-CSS gelistet
  (generische Klassennamen würden mit Websites kollidieren); die nötigen
  Regeln sind präfixiert in `content.css` dupliziert.
- **shared.js** hält Helfer, die alle drei Oberflächen brauchen
  (`DEFAULT_ZONES`, `DEFAULT_SHORTCUT`, `isRootZoneName`, `folderKeyForName`,
  `monogram`, `loadZones`, `formatShortcutLabel`, `attachSortable`,
  `moveErrorText`) über das globale Objekt `ArchiverShared`.

## Design-System

- Durchgehend dunkel, System-Font (-apple-system, Segoe UI, Roboto)
- Hintergründe: `#141414` (Tab), `#1c1c1c` (Panels), Popup
  `rgba(22,22,22,.82)` + 18 px Blur, Karten `rgba(20,20,20,.85)`,
  Thumb-Platzhalter `#262626`
- Text: `#ffffff`, sekundär `#cfcfcf`, gedämpft `#8a8a8e`, sehr gedämpft `#6b6b6f`
- Akzent Blau `#2d5aeb` (Hover `#4169f0`): Drop-aktiv, Auswahl, Speichern
- Akzent Lila `#7c86ff`: Links, Shortcut-Aufnahme, Reorder-Ziel
- Flächen über weiße Transparenzen (.06 / .08 / .1 / .12 / .14)
- Keine Rundungen, keine Schatten (außer schwebendem Panel)
- Zonen/Karten: 1 px gestrichelte weiße Outline, ohne Abstand aneinander;
  Downloads-Zone abgesetzt (durchgezogene Linie, grau statt blau)
- Thumbnails quadratisch, `object-fit: cover`, 6 px Rasterabstand
- Monogramme: 26 × 26 px Kachel mit zwei Initialen
- Section-Labels: 11 px, Versalien, leichtes Letterspacing
- Transitions 0,12–0,15 s

## Änderungen in v3.2.0

- Verschieben löscht das Original erst nach vollständigem neuen Download;
  bei Fehler bleibt es erhalten, das UI zeigt den Grund.
- Eigener Bild-Index mit Metadaten statt nur Download-IDs, Limit 60 → 500;
  Galerie übersteht gelöschten Download-Verlauf. Alter Index wird beim
  ersten Zugriff automatisch übernommen.
- Gescheiterte Downloads (z. B. 403) werden wieder aus der Galerie entfernt
  und als Fehler gemeldet.
- Im Finder gelöschte Dateien verschwinden aus der Galerie.
- Parallele Verschiebungen verlieren keine Einträge mehr (Warteschlange).
- Doppelte Helfer aus content.js, popup.js, dashboard.js in shared.js
  zusammengeführt.
- Kaputter CSS-Rest in content.css entfernt. Er hat die nachfolgende Regel
  verschluckt, dadurch hatten benachbarte Zonen eine doppelte Trennlinie.
- README korrigiert (Popup zeigt keine Galerie; Verschieben ehrlich beschrieben).

## Getestet

- Logik von background.js mit simulierten Chrome-APIs (Download, Abbruch,
  Verschieben ok/fehlgeschlagen, 5 parallele Verschiebungen, gelöschter
  Verlauf, gelöschte Datei, Migration, Data-URLs)
- Alle drei Oberflächen in simuliertem Browser: laden fehlerfrei, Zonen,
  Galerie und Einstellungen rendern
- **Noch nicht im echten Chrome getestet.** Beim ersten Test besonders
  prüfen: Verschieben (inkl. Mehrfachauswahl), Zonen-Sortieren im Overlay,
  Lightbox-Navigation, Esc-Kaskade, Sync zwischen den Oberflächen.

## Offene Baustellen / Ideen für einen Neuaufbau

- Galerie-Code (Rendern, Verschieben, Lightbox, Auswahl) existiert weiter
  doppelt in content.js und dashboard.js, das Galerie-CSS doppelt
  (präfixiert/unpräfixiert). Sauber lösbar mit Shadow DOM im Overlay, dann
  eine gemeinsame Galerie-Komponente für beide.
- Thumbnails kommen aus der Original-URL; eigene kleine Vorschaubilder
  (z. B. in IndexedDB) würden die Galerie offline-fest machen.
- Verschieben hängt an der Quell-URL. Echte Unabhängigkeit ginge nur über
  eine native Begleit-App oder die File System Access API in der Vollansicht.
- Shortcut wirkt nur bei fokussierter Seite (bewusst ohne `chrome.commands`).

## Testen

`chrome://extensions` → Entwicklermodus → „Entpackte Erweiterung laden" →
diesen Ordner wählen. Nach jeder Änderung dort ⟳.
