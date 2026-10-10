# Archiver

Chrome-Extension (Manifest V3): Bild auf einer Webseite ziehen und in eine frei konfigurierbare Ablage-Zone am unteren Bildschirmrand fallen lassen. Jede Zone ist ein Unterordner im Chrome-Downloads-Ordner. Funktioniert auch bei Bildern, die per JavaScript vor Rechtsklick/„Speichern unter" geschützt sind.

## Installation (Entwicklermodus)

1. `chrome://extensions` öffnen, oben rechts **Entwicklermodus** aktivieren.
2. **„Entpackte Erweiterung laden"** → diesen Ordner wählen.
3. Nach Änderungen am Code dort auf ⟳ klicken.

## Benutzung

1. Bild anklicken und ziehen → die Zonen erscheinen unten (32 % der Bildschirmhöhe).
2. Zone unter dem Mauszeiger färbt sich blau (bzw. grau bei der „Downloads"-Zone).
3. Loslassen in einer Zone → Download + kurze Bestätigung („Gespeichert in …").
4. Loslassen außerhalb → nichts passiert.

Auch Dateien vom Desktop lassen sich in die Zonen ziehen.

## Zonen

Standard: „Projekt 1", „Projekt 2", „Projekt 3", „Downloads". Bearbeiten im Toolbar-Popup oder über „Einstellungen" im Seiten-Overlay bzw. in der Vollansicht.

- Beliebig viele Zonen, praktikabel sind etwa 2–6.
- Per ⋮⋮-Griff sortierbar; Reihenfolge = links → rechts am Bildschirmrand.
- Verschachtelte Pfade möglich: `Kunden/Projekt-A` → `Downloads/Kunden/Projekt-A/`.
- Eine Zone, die **genau** „Downloads" heißt (Groß-/Kleinschreibung egal), speichert ohne Unterordner.
- Anderer Speicherort für alle Zonen: Link „Downloads-Ordner ändern" → `chrome://settings/downloads`.

## High-Res-Erkennung

Beim Start des Ziehens sucht Archiver die hochauflösendste Quelle, in dieser Reihenfolge:

1. Umschließender Link, der direkt auf eine Bilddatei zeigt (Lightbox-Pattern)
2. `<picture>`: größte `<source srcset>`-Variante
3. `srcset` des `<img>` (größter `w`- oder `x`-Deskriptor)
4. Lazy-Load-Attribute (`data-src`, `data-original`, `data-full`, `data-large`, `data-hi-res`, `data-zoom-image`, `data-large-src`, `data-lazy-src`)
5. CSS `background-image` (bis zu 6 Elternebenen)
6. Fallback: sichtbare `src`

Die erkannte Quelle steht in der Konsole (F12).

## Die drei Oberflächen

### Toolbar-Popup (Klick aufs Icon)

Kompaktes Einstellungsfenster: Zonenliste (bearbeiten, hinzufügen, entfernen, sortieren), Tastenkombination, „Information" als Umschalter, „Vollansicht" öffnet den eigenen Tab. Zeigt **keine** Galerie und nimmt keine Drops an (ein Chrome-Popup schließt sich, sobald es den Fokus verliert).

### Seiten-Overlay (auf der Webseite)

- **Automatisch beim Ziehen:** nur die Zonenleiste.
- **Per Tastenkombination** (Standard Alt+Shift+A, im Popup frei einstellbar): Zonen im Frosted-Glass-Look plus Vollgalerie darüber.
  - alle Zonen mit ihren Bildern gleichzeitig
  - Bilder per Ziehen zwischen Zonen verschieben, Mehrfachauswahl per Shift-/Strg-/Cmd-Klick
  - Filter nach Dateiname, Größenregler
  - Klick aufs Bild → Lightbox mit ←/→; „+" beim Hovern → im Finder/Explorer anzeigen
  - Zonen per ⋮⋮ umsortieren
  - „Einstellungen" und „Information" oben rechts (ersetzen vorübergehend die Galerie)
- **Schließen:** Tastenkombination erneut, `Esc` (gestuft: Lightbox → Auswahl → Panel → Overlay) oder ein Bild ablegen.

Die Tastenkombination wird direkt im Content-Script erkannt und wirkt nur, wenn die Seite den Fokus hat.

### Vollansicht (eigener Tab)

Gleiche Galerie-Funktionen wie im Overlay, mit mehr Platz. Die Thumbnail-Größe wird gespeichert. Die Zonen sind auch echte Drop-Ziele, wenn man das Fenster neben die Quellseite legt (dann ohne High-Res-Erkennung).

## Verschieben zwischen Zonen

Chrome-Extensions können Dateien nicht direkt verschieben. Archiver legt die Datei deshalb im Zielordner **neu aus derselben Quelle** an, wartet, bis sie vollständig geladen ist, und löscht erst dann das Original.

- Ist die Quelle nicht mehr erreichbar (Seite offline, Link abgelaufen), bleibt das Original unangetastet und eine Meldung nennt den Grund.
- Bilder, die nicht mehr im Chrome-Download-Verlauf stehen, lassen sich nicht verschieben (bitte im Finder verschieben).

## Galerie-Daten

Archiver führt einen eigenen Index (`chrome.storage.local` → `archiveIndex`, bis zu 500 Bilder pro Zone) mit Bildquelle, Quellseite (URL und Titel), Dateiname und Zeitpunkt. Die Lightbox zeigt die Domain der Quellseite als Link. Dadurch bleibt die Galerie auch erhalten, wenn der Chrome-Download-Verlauf gelöscht wird. Im Finder gelöschte Dateien verschwinden beim nächsten Öffnen aus der Galerie.

## Dateien

- `manifest.json` – Konfiguration (MV3)
- `shared.js` – gemeinsame Helfer aller Oberflächen (Zonen laden, Monogramm, Shortcut-Anzeige, Sortieren per Ziehen)
- `background.js` – Downloads, Verschieben, Bild-Index, Galerie-Anfragen
- `content.js` / `content.css` – Seiten-Overlay (Drag-Erkennung, High-Res, Zonen, Galerie, Einstellungen, Feedback)
- `popup.html` / `popup.js` / `popup.css` – Toolbar-Popup
- `dashboard.html` / `dashboard.js` / `dashboard.css` – Vollansicht
- `panel.css` – geteilte Styles für Einstellungen/Information (Popup + Vollansicht)
- `gallery.css` – geteilte Galerie-Styles (Vollansicht)
- `icons/` – Toolbar-Icons

## Bekannte Grenzen

- Speichern nur innerhalb des Chrome-Downloads-Ordners.
- High-Res-Erkennung ist heuristisch.
- Verschieben braucht eine noch erreichbare Quelle (siehe oben).
- Thumbnails werden aus der Original-URL geladen; ist sie offline, zeigt die Galerie den Dateinamen als Platzhalter.
