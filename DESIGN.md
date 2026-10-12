# Archiver – Design-System

Stand: App 0.26.1 · Extension 3.20.0

Diese Datei hält fest, wie Archiver aussieht und warum. Sie gilt für die Mac-App
(`app/src`) und die Chrome-Extension (`extension/`). Wer an der Oberfläche
arbeitet, Mensch oder KI, liest sie vorher. Die Werte stammen aus dem Code.
Wo Code und Datei auseinanderlaufen, gilt der Code, und die Datei wird im
selben Commit nachgezogen.

---

## 1. Prinzipien

Die Prinzipien gelten in dieser Reihenfolge. Kommen sie sich in die Quere,
gewinnt das obere.

1. **Das Bild zuerst.** Die Oberfläche tritt hinter die Referenzen zurück.
   Alle Grautöne sind neutral (R = G = B) und haben keinen Farbstich, damit
   Bilder unverfälscht wirken und auch weiße Bilder eine Kante haben.
2. **Slick und minimal, nicht techy.** Keine sichtbare Technik, keine
   Zusatzrahmen und keine Icons, wo ein Wort reicht. Lieber eine Fläche
   weniger als eine mehr.
3. **Eine Entscheidung statt einer Einstellung.** Neue Gestaltungsfragen werden
   entschieden und nicht an die Nutzenden weitergereicht. Bestehende Optionen
   wie Rundung, Outline oder Navigation-Position wachsen nicht weiter.
4. **Eine Sprache für App und Extension.** Was in beiden Oberflächen vorkommt,
   sieht in beiden gleich aus. Beispiele sind die Glasleiste beim Ziehen, die
   Zonenkarten, Geist als Schrift und die Hell- und Dunkel-Werte.
5. **Ein Zustand, ein Zeichen.** Auswahl, Tastaturfokus, Tauschziel,
   Umsortierziel und Ablageziel zeigen alle denselben gestrichelten Ring
   (siehe 4.1). Für diese Zustände gibt es keine zweite Hervorhebung.
6. **Ehrlich zum Dateisystem.** Eine Zone ist ein Ordner und die Bibliothek ein
   normaler Ordner auf dem Mac. Die Oberfläche tut nicht so, als läge etwas
   woanders.

---

## 2. Tokens

Die Tokens sind CSS-Variablen auf `:root`. Schemata überschreiben sie über
Klassen und Attribute auf `html`:

| Schema | Selektor |
|---|---|
| Dunkel (Standard) | `:root` |
| Hell | `html.light` (setzt `app.js` je nach Einstellung) |
| Salbei dunkel / hell | `html[data-scheme="sage"]` / `…[data-scheme="sage"].light` |
| Mac mit Fensterglas | `html.mac` (halbtransparent über der macOS-Unschärfe) |

Bei neuen Regeln gilt:

- Immer Tokens verwenden und keine Hex-Werte im Komponenten-Code.
- Transparente Flächen entstehen über `rgba(var(--ink-rgb), α)`. So drehen sie
  sich mit dem Schema automatisch um.

### 2.1 Farbe

| Token | Dunkel | Hell (0.25.0) | Zweck |
|---|---|---|---|
| `--bg-solid` | `#101010` | `#f4f4f4` | Grundfarbe des Fensters |
| `--bg` | aus `--bg-solid` × `--win-alpha` | dito | Fenster über dem Mac-Glas (Regler in Einstellungen › Aussehen) |
| `--ink` / `--ink-rgb` | `#ffffff` / `255,255,255` | `#111111` / `17,17,17` | Text und Basis aller Alpha-Flächen |
| `--ink-inverse` | `#0f0f0f` | `#f4f4f4` | Text auf `--ink`-Flächen (Primärknopf) |
| `--p-text` | `#ededed` | `#111111` | Haupttext |
| `--p-dim` | `#8c8c8c` | `#5c5c5c` | Sekundärtext, Meta |
| `--p-faint` | `#5e5e5e` | `#8f8f8f` | Tertiärtext, inaktive Chips |
| `--p-rule` | ink × 0.10 | schwarz × 0.10 | Trennlinien |
| `--p-rule-strong` | ink × 0.55 | schwarz × 0.55 | betonte Linien |
| `--p-pill` | `rgba(52,52,52,.82)` | `rgba(255,255,255,.78)` | Pillen und Navigationsglas |
| Karte | ink × 0.055 (Hover 0.08) | schwarz × 0.045 (Hover 0.07) | Zonen- und Ordnerkarten, eine Stufe vom Grund abgesetzt |
| `--thumb-bg` | `#262626` | `#e8e8e8` | Platzhalter hinter Bildern |
| `--menu-bg` | `rgba(40,40,40,.97)` | `rgba(250,250,250,.97)` | Menüs, Zonenglas |
| `--sheet-bg` | `#1c1c1c` | `#f4f4f4` | Seitenblatt (Details) |
| `--lightbox-bg` | `rgba(0,0,0,.9)` | `rgba(244,244,244,.98)` | Lightbox |
| `--accent` / `--accent-rgb` | `#2d5aeb` | dito | Toast, aktive Systemzustände |
| `--glow-rgb` | `91,124,255` | dito | Glühen der Zielkarte beim Ablegen |
| `--danger` | `#e5484d` | dito | Fehler-Toast, Löschen |

Für das Schema Salbei stehen die Werte in `app.css` im Abschnitt
`html[data-scheme="sage"]`. Dessen Akzent ist ein Graublau (`#a6b5d6` dunkel,
`#5f6f94` hell).

Für die Farbe gilt:

- **Akzent sparsam.** Blau zeigt nur Systemrückmeldung (Toast, Glühen beim
  Ablegen). Auswahl und Fokus sind nie blau, sondern Ring (Prinzip 5).
- **Kein reines Weiß als Fläche.** Hell beginnt bei `#f4f4f4`. Reines Weiß
  bleibt Glas (Navigation, Zonenleiste) und Bildern vorbehalten.

### 2.2 Typografie

| Rolle | Schrift | Größe | Gewicht | Laufweite | Beispiel |
|---|---|---|---|---|---|
| Label, Chip | Geist Mono, Versalien | 11 px | 400 | +0.02em | Filter-Chips, Zähler |
| Meta | Geist | 12 px | 400 | 0 | Datum, Quelle |
| UI | Geist | 13–13.5 px | 500 | 0 | Navigation, Menüs |
| Karten-Titel | Geist | 15 px | 500 | −0.01em | Zonenname auf der Karte |
| Überschrift | Geist | 22–24 px | 600 | −0.02em | Zonen-Titel, Onboarding |

Für die Typografie gilt:

- Es gibt nur Geist (variabel, 100–900) und Geist Mono. Beide liegen lokal in
  `fonts/` und haben `font-display: block`.
- Mono ist für Daten und Etiketten da, nicht für Fließtext.
- Gewichte sind nur 400, 500 und 600.
- Neue Größen werden auf diese Stufen gerundet. Im Code stecken heute auch
  10, 14, 16 und 19 px. Diese Größen werden bei Gelegenheit auf die Stufen
  gezogen und nicht neu eingeführt.

### 2.3 Form und Raum

| Token | Wert | Zweck |
|---|---|---|
| `--r-lg` / `--r-md` / `--r-sm` | 8 / 6 / 5 px | Karten, Menüs, kleine Flächen |
| Rundung „Eckig“ / „Weich“ / „Rund“ | 0 / 4 / 14 px (`data-radius`) | Einstellung, keine weiteren Stufen |
| Pille | 999 px | Navigation, Pillen |
| Objekt (Bild) | 0 | Bilder bleiben rechteckig, wie das Original |
| `--p-pad` | 40 px | Seitenrand |
| `--top-h` | 72 px | Höhe Kopfbereich |
| `--nav-h` / `--nav-rim` / `--nav-top` | 36 / 5 / 17 px | Navigationsleiste: Knopfhöhe, Innenrand, Oberkante = Oberkante der Fensterknöpfe |
| Abstand in der Leiste | 3 px | zwischen Navigationsknöpfen |
| `--card-cols` | 6 | Kartenraster der Übersicht |
| Karten-Format | 2:1 | Zonen- und Ordnerkarten (Ordner ein Sechstel breit) |

### 2.4 Glas

Glas ist das einzige Material neben der Fläche. Es kommt nur bei schwebenden
Ebenen vor: Navigation, Active-Zones-Leiste, Menüs und Ladeplatzhalter.

| | Dunkel | Hell |
|---|---|---|
| Unschärfe | `blur(24px) saturate(1.4)` | `blur(28px) saturate(0)` |
| Schatten | `0 14px 44px rgba(0,0,0,.5)` | `0 14px 44px rgba(0,0,0,.16)` |
| Kante | `inset 0 0 0 1px` ink × 0.07 | `inset 0 0 0 1px` weiß × 0.7 + schwarz × 0.08 auf 0.5 px |
| Deckkraft | Regler `--zone-alpha` (Standard 0.97) | dito |

### 2.5 Bewegung

| Zweck | Dauer | Kurve |
|---|---|---|
| Hover (Farbe, Hintergrund) | 0.12 s | `ease` |
| Ein- und Ausblenden, Toast | 0.18 s | `ease` / `ease-out` |
| Seitenblatt, Gleiten | 0.28 s | `cubic-bezier(0.2, 0.7, 0.2, 1)` (`--sheet-ease`) |
| Zonenleiste rein | 0.14 s | `ease-out` |
| Zonenleiste raus | 0.2 s, 0.3 s verzögert | `ease` (Glühen auf dem Ziel bleibt kurz sichtbar) |
| Ring „Umlaufend“ | 1.6 s je Runde | `linear` |

Für die Bewegung gilt:

- Bewegung bestätigt eine Handlung, sie schmückt nicht.
- Alles respektiert `prefers-reduced-motion: reduce`.
- Neue Dauern werden auf diese Stufen gelegt.

---

## 3. Oberflächen

**App** (`app/src`): Fenster mit macOS-Glas, Navigation oben in der Titelzeile
auf Höhe der Fensterknöpfe, Bibliotheks-Reiter oben rechts. Startseite mit den
Zonen als Karten, Active Zones oben in jeder Übersicht.

**Extension** (`extension/`): Overlay im Shadow DOM auf fremden Seiten
(`overlay.css`, `:host`), Galerie im App-Layout (`gallery.css`), Panel
(`panel.css`). Sie folgt der App 1:1. Seit 3.20.0 gilt das für die Übersicht,
die Zone, die Glasleiste beim Ziehen, Geist und die Bibliothek oben rechts.

**Am ganzen Mac** (`palette.*`, `dropbar.*`, `src-tauri/src/system.rs`):
schwebende Fenster über anderen Programmen, auch wenn das Archiver-Fenster zu
ist. Sie nutzen dieselben Karten, Ringe und Glaswerte wie die App (4.12, 4.13).

---

## 4. Komponenten

Alle Angaben sind Klassen in `app.css`. Die Extension hat ihre eigenen Namen
(`zone-card`, `nav-btn` …), soll aber gleich aussehen.

### 4.1 Fokus-Ring (`::after` mit `--ring`)
- **Zweck:** Er ist das einzige Zeichen für Auswahl, Tastaturfokus,
  Tauschziel, Umsortierziel und Ablageziel.
- **Form:** Der Ring ist eine 1 px gestrichelte Linie (4/4), als SVG-Maske
  gezeichnet. Er folgt der Rundung:
  - `--ring-lg` für Karten mit Abstand (3 px)
  - `--ring-in` für bündige Karten
  - `--ring-0` für Objekte und Zeilen
- **Varianten:** „Ruhig“ (Standard) steht still. „Umlaufend“ dreht sich
  langsam im Uhrzeigersinn.
- **Nicht:** Keine `outline`, keine Akzentfarbe und kein zweiter Rahmen.

### 4.2 Navigation (`.p-nav`)
- **Zweck:** Wechsel zwischen Archiver (Start), Zonen, Alle Objekte und Suche,
  dazu das Menü ≡.
- **Form:** Eine Glas-Pille oben, auf der Mittellinie der Fensterknöpfe.
  Aktive Knöpfe sind gefüllt.
- **Nicht:** Keine Icons neben Wörtern und keine zweite Leiste.

### 4.3 Active-Zones-Leiste (`.p-dropbar`, `.p-hot`)
- **Zweck:** Beim Ziehen fahren die vier ersten Zonen (01–04) als Glas ein.
- **Zustände:**
  - Einfahren
  - Ziel unter dem Zeiger (Ring)
  - Herkunftszone (Inhalt auf 45 % zurückgenommen, Glas bleibt)
  - Abgelegt (Ziel glüht kurz in `--glow-rgb`, dann fährt die Leiste aus)
- **Nicht:** Sie erscheint nicht ohne Ziehen und zeigt nicht mehr als vier
  Zonen.

### 4.4 Zonenkarte (`.p-card`)
- **Zweck:** Zone in der Übersicht, mit Cover (ein Bild oder drei), Name und
  Anzahl.
- **Form:** 2:1, `--r-lg`, Fläche ink × 0.055, beim Hover × 0.08.
  Umsortieren hebt die Karte an (Schatten, 85 %).
- **Nicht:** Keine Rahmenlinie. Die Karte setzt sich nur über die Fläche ab.

### 4.5 Ordnerkarte (`.p-folder-card`)
- **Zweck:** Unterordner neben dem Zonen-Titel, als Karten (3/6) oder als
  Liste (2/6).
- **Form:** Wie die Zonenkarte, ein Sechstel breit. Aktiv zeigt sie den Ring.

### 4.6 Objekt (`.card`)
- **Zweck:** Ein gesichertes Bild, Video, PDF oder eine Text- bzw. Seitenkarte
  im Raster.
- **Form:** Eckig, ohne Fläche. Solange es lädt, steht ein Glasplatzhalter da.
- **Nicht:** Keine Rundung, kein Schatten und keine Bildunterschrift im Raster.
  Die Info gibt es per `I` oder im Seitenblatt.

### 4.7 Chip (`.p-chip`)
- **Zweck:** Filter und Ansichtswahl.
- **Form:** Geist Mono, 11 px, Versalien, ohne Fläche. Die Zustände laufen nur
  über die Textfarbe: faint → dim (Hover) → text (aktiv).

### 4.8 Knopf (`.btn`)
- **Zweck:** Handlungen in Dialogen und Einstellungen.
- **Form:**
  - Standard: 1 px Linie `--dash`, beim Hover `--ink`.
  - Primär: Fläche `--ink` mit Text `--ink-inverse`.
- **Nicht:** Höchstens ein Primärknopf pro Dialog.

### 4.9 Menü (`.p-more-menu`)
- **Zweck:** Kontextmenüs, ≡-Menü und Zonenwahl.
- **Form:** `--menu-bg`, `--menu-shadow`, `--r-md`. Zonen erscheinen als
  Kästchen in zwei Spalten.

### 4.10 Toast (`.toast`)
- **Zweck:** Kurze Rückmeldung, etwa „gesichert“ oder „verschoben“.
- **Form:** Akzentfläche, 12 px, Gewicht 600, blendet in 0.18 s ein.
  Fehler erscheinen in `--danger`.

### 4.11 Lightbox und Seitenblatt
- **Lightbox:** Das Bild steht groß auf `--lightbox-bg`. Leertaste öffnet sie,
  Pfeile blättern, `I` zeigt die Info.
- **Seitenblatt:** Details von rechts, `--sheet-w` = min(560 px, 46 vw).

### 4.12 Palette (`palette.css`)
- **Zweck:** Per Kürzel (Standard ⌥ Space, Einstellungen › Extension & Observer) über
  jedem Programm Zonen und Objekte holen, etwa in einen InDesign-Rahmen.
- **Form:** 860 × 620 px, macOS-Glas mit 12 px Rundung, Suchfeld 17 px oben.
  Start: Active Zones als Zonenkarten (4.4) mit 01–04 und „Active Zone“,
  darunter der Index als flachere Karten (8:3). Zone: Active Zones als Reiter,
  Objekte eckig in sechs Spalten (4.6). Suche: passende Zonen als Karten,
  darunter Objekte. Tasten stehen als Mono-Etiketten in der Fußzeile.
- **Verhalten:** Aus InDesign geöffnet heißt ↵ „Platzieren“ (markierter
  Rahmen oder Platzieren-Cursor), sonst „Kopieren“. Beim Herausziehen eines Objekts wird die Palette auf 6 %
  Deckkraft gesetzt und lässt Klicks durch. Klick in ein anderes Programm
  blendet sie aus.
- **Nicht:** Sie aktiviert Archiver nicht und holt das Hauptfenster nicht nach vorne.

### 4.13 Zonenleiste am ganzen Mac (`dropbar.css`)
- **Zweck:** Wie 4.3, aber beim Ziehen von Dateien in jedem Programm.
- **Form:** Volle Breite unten auf dem Bildschirm mit dem Zeiger, 280 px hoch,
  dieselben vier Glaskarten, Ring und Glühen wie 4.3. Die Karten haben keine
  eigene Unschärfe (das Fenster ist durchsichtig), deshalb gilt `--zone-alpha`.
- **Nicht:** Erscheint nicht, wenn Archiver selbst vorne ist, und nicht bei
  Text oder Links ohne Datei.

---

## 5. Bekannte Abweichungen

Diese Punkte stehen hier, damit niemand sie für Absicht hält. Behoben werden
sie nur auf ausdrückliches Go.

- **Die Extension hat ihre Farben fest im Code und nutzt keine Tokens.**
  Folgende Werte weichen von der App ab:
  - Hellgrund der Extension `#f5f5f5` statt `#f4f4f4`
  - Sekundärtext hell `#707070` (`gallery.css`, `:host(.light)`) statt `#5c5c5c`
  - Akzentlinie `#7c86ff` statt `--glow-rgb` (`#5b7cff`)

  Ziel: Die Tabellen in Abschnitt 2 werden als Variablen in `overlay.css` und
  `gallery.css` auf `:host` gespiegelt.
- **`app.css` ist nach Versionen geschichtet.** Komponenten wie `.p-nav` oder
  `.p-dropbar` sind mehrfach definiert, und weiter unten überschreibt. Bei
  Änderungen gilt deshalb immer der letzte Block. Abschnitte sind mit
  `/* ---- <Version>: … ---- */` markiert.
- **`--muted` (`#8a8a8e`) und `--p-dim` (`#8c8c8c`)** sind fast gleich und
  sollen zu einem Token werden.
- **`.btn.primary:hover`** nutzt fest `#dcdcdc` statt eines Tokens.

---

## 6. Prüfen vor dem Commit

- [ ] Die neue Regel nutzt Tokens und keine festen Farben, Dauern oder Radien
      außerhalb der Stufen.
- [ ] Sie funktioniert in Dunkel, Hell und Salbei sowie mit und ohne `html.mac`.
- [ ] Hervorhebungen laufen über den Ring (4.1) und nicht über Farbe.
- [ ] Wenn die Komponente auch in der Extension vorkommt, ist sie dort gleich
      oder als Abweichung in Abschnitt 5 notiert.
- [ ] `prefers-reduced-motion` wird respektiert.
- [ ] Diese Datei ist nachgezogen, wenn sich ein Wert oder eine Regel geändert
      hat.
