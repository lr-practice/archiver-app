# Archiver – Design-System

Stand: App 0.39.2 · Extension 3.29.3

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
   wie Rundung oder Outline wachsen nicht weiter. Seit 0.30 fest: Navigation
   oben links, Ordner als Karten, Neu laden ohne Welle. Regler laufen
   immer in 5-%-Schritten.
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
| Mac mit Fensterglas | `html.mac` (halbtransparent über der macOS-Unschärfe) |

Bei neuen Regeln gilt:

- Immer Tokens verwenden und keine Hex-Werte im Komponenten-Code.
- Transparente Flächen entstehen über `rgba(var(--ink-rgb), α)`. So drehen sie
  sich mit dem Schema automatisch um.

### 2.1 Farbe

| Token | Dunkel | Hell (0.25.0) | Zweck |
|---|---|---|---|
| `--bg-solid` | `#1c1c1c` | `#f4f4f4` | Grundfarbe des Fensters, gleich dem Tray (0.28) |
| `--win-alpha` | 0.72 | 0.78 | Deckkraft über dem Mac-Glas, Standard wie im Tray. Regler „Glas“ (Einstellungen › Aussehen, 40–100 % in 5er-Schritten, `archiver.glass`, i18n.js `applyGlass`) für App, Tray und Observer |
| `--bg` | aus `--bg-solid` × `--win-alpha` | dito | Fenster über dem Mac-Glas |
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
| `--accent` / `--accent-rgb` | `#2d5aeb` | dito | Toast, aktive Systemzustände, Smart Guides und Raster im Board (4.24) |
| `--glow-rgb` | `91,124,255` | dito | Glühen der Zielkarte beim Ablegen |
| `--danger` | `#e5484d` | dito | Fehler-Toast, Löschen |

Für die Farbe gilt:

- **Akzent sparsam.** Blau zeigt nur Systemrückmeldung (Toast, Glühen beim
  Ablegen) und seit 0.39.0 die Hilfslinien im Board-Editor (4.24), die nur
  während des Ziehens stehen. Auswahl und Fokus sind nie blau, sondern Ring
  (Prinzip 5).
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
| Rundung „Eckig“ / „Weich“ / „Rund“ / „Sehr rund“ | `--r-lg` 0 / 4 / 8 / 14 px (`data-radius`) | Einstellung, keine weiteren Stufen. Gilt seit 0.30 auch in Tray, Zonenleiste und Extension (über die Bibliothek gemeldet) |
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
| Deckkraft | `--zone-alpha`, eigener Regler „Zonen beim Ziehen“ (30–100 % in 5er-Schritten, `archiver.zoneGlass`, Standard 0.97). App, Zonenleiste und Extension (über `zones.json` „alpha“) | dito |

### 2.5 Bewegung

| Zweck | Dauer | Kurve |
|---|---|---|
| Hover (Farbe, Hintergrund) | 0.12 s | `ease` |
| Ein- und Ausblenden, Toast, Wenden in der Lightbox (je Hälfte) | 0.18 s | `ease` / `ease-out` |
| Seitenblatt, Gleiten | 0.28 s | `cubic-bezier(0.2, 0.7, 0.2, 1)` (`--sheet-ease`) |
| Zonenleiste rein | 0.14 s | `ease-out` |
| Zonenleiste raus | 0.2 s, 0.3 s verzögert | `ease` (Glühen auf dem Ziel bleibt kurz sichtbar). Am ganzen Mac erst, wenn gesichert ist; bei einem Fehler 2.5 s später (4.13) |
| Ring „Umlaufend“ | 1.6 s je Runde | `linear` |

Für die Bewegung gilt:

- Bewegung bestätigt eine Handlung, sie schmückt nicht.
- Alles respektiert `prefers-reduced-motion: reduce`.
- Neue Dauern werden auf diese Stufen gelegt.

---

## 3. Oberflächen

**Observer** (`viewer.*`): seit 0.30 ebenfalls macOS-Glas, Grund
`#1c1c1c`/`#f4f4f4` × `--win-alpha`.

**App** (`app/src`): Fenster mit macOS-Glas, Navigation oben in der Titelzeile
auf Höhe der Fensterknöpfe, Bibliotheks-Reiter oben rechts. Startseite mit den
Zonen als Karten, Active Zones oben in jeder Übersicht. Passen keine vier
Karten nebeneinander, stehen sie 2 × 2 wie der Index (0.28).

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
- **Works (0.38.0):** Ist Works an (4.23), steht es als zweiter Bereich gleich
  nach „Archiver“, im selben Schnitt (600, ohne Gleitfläche beim Hover) und
  aktiv nur auf der Projektliste. Hinter der Trennlinie folgt der Pfad
  „Kunde › Projekt“; auf der Liste entfällt die Linie. Die Suche ist in Works
  ausgeblendet.
- **Boards (0.39.0):** Ist Boards an (4.24), steht es als weiterer Bereich
  nach Works (sonst nach „Archiver“), im selben Schnitt, aktiv nur auf der
  Übersicht. Im offenen Board folgt hinter der Trennlinie sein Name. Die Suche
  ist in Boards ausgeblendet.
- **Nicht:** Keine Icons neben Wörtern und keine zweite Leiste.

### 4.3 Active-Zones-Leiste (`.p-dropbar`, `.p-hot`)
- **Zweck:** Beim Ziehen fahren die vier ersten Zonen (01–04) als Glas ein.
- **Zustände:**
  - Einfahren
  - Ziel unter dem Zeiger (Ring)
  - Herkunftszone (Inhalt auf 45 % zurückgenommen, Glas bleibt)
  - Abgelegt (Ziel glüht kurz in `--glow-rgb`, dann fährt die Leiste aus)
- **Angeschnitten (0.35, Einstellungen › Ansicht, ab Werk „Ganz“):** Wahlweise
  ragen die Karten erst 90 px herein (`.p-dropbar.strip`), genau wie die Leiste
  der Extension (4.13): oben gerundet, unten bündig, ohne Hinweis. Zeiger in
  den Streifen → volle Höhe, mehr als 24 px darüber → wieder Streifen. Höhe mit
  0.22 s Übergang, ohne bei `prefers-reduced-motion`. Die Vorschau beim
  Glas-Regler zeigt immer die ganze Leiste.
- **Nicht:** Sie erscheint nicht ohne Ziehen und zeigt nicht mehr als vier
  Zonen.

### 4.4 Zonenkarte (`.p-card`)
- **Zweck:** Zone in der Übersicht, mit Cover (ein Bild oder drei), Name und
  Anzahl.
- **Form:** 2:1, `--r-lg`, Fläche ink × 0.055, beim Hover × 0.08.
  Umsortieren hebt die Karte an (Schatten, 85 %).
- **Nicht:** Keine Rahmenlinie. Die Karte setzt sich nur über die Fläche ab.
- **Neue Zone (0.39.1):** Die Karte zum Anlegen (Index und freier Platz bei den
  Active Zones) zeigt nur ein Plus in der Mitte, ein Viertel der Kartenhöhe,
  Linien 1 px in `--dash` wie die gestrichelte Outline, beim Hover in
  Textfarbe. Kein Text; „Neue Zone“ steht im Tooltip.
- **Bibliotheken (0.36.0):** vier Plätze in Einstellungen › Bibliothek, ⌘1–4.
  Ein leerer Platz bietet „Ordner wählen…“ und „Neue Bibliothek…“ (Ort und Name
  im Sichern-Dialog des Finders, der Ordner wird angelegt und gleich geöffnet).
- **Externe Zone (0.30.1):** Ordner außerhalb der Bibliothek, angelegt nur in
  Einstellungen › Bibliothek (Verknüpfung im Bibliotheksordner). Sieht aus wie
  jede Zone; ✕ löst nur die Verknüpfung. Seit 0.39.1 heißt das überall
  „Trennen“ (⋯-Menü, Einstellungen, Rückfrage mit `.btn primary` statt rot),
  und Ordner oder Unterzonen in einer externen Zone haben kein Löschen: Archiver
  löscht nie etwas außerhalb der Bibliothek. Seit 0.31.0 gelten dieselben Schranken
  wie für eine Bibliothek (kein Benutzer- oder Systemordner, höchstens 20.000
  Dateien), und verschachtelte Ziele werden abgelehnt. Ist das Ziel nicht
  erreichbar, bleibt die Zone mit ihren Vorschauen stehen; in den Einstellungen
  steht hinter dem Namen „· offline“.

### 4.5 Ordnerkarte (`.p-folder-card`)
- **Zweck:** Unterordner neben dem Zonen-Titel als Karten (3/6, die Liste
  entfällt seit 0.30). Klick betritt den Ordner (Titel wird zum Pfad), die Chips
  links filtern nur und lassen Titel und Karten stehen.
- **Form:** Wie die Zonenkarte, ein Sechstel breit. Aktiv zeigt sie den Ring.
  Auch leere Ordner haben eine Karte (0 Objekte).
- **Ablageziel (0.27):** Objekte und Ordner lassen sich auf die Karte ziehen,
  sie zeigt dabei den Ring (4.1).
- **⋯ und Ziehen (0.28):** ⋯ und Rechtsklick öffnen Umbenennen, Im Finder
  zeigen und Löschen wie bei Zonen. Eine Ordnerkarte auf eine andere gezogen
  legt den Ordner hinein (gleiches Anheben wie 4.4, Ziel mit Ring).
- **Titel:** Steht oben im Kopf (`align-self: start`) und springt nicht, wenn
  sich die Zahl der Karten beim Wechsel der Ebene ändert.
- **Segmente (0.39.1):** Rechts im Kopf steht nur noch ein Chip „(Segmente)“,
  der an- und ausgeklickt wird; aus ist das Mosaik. Das Wort „Mosaik“ entfällt.
- **Segmente als Ablageziel (0.35):** In „(Segmente)“ ist jeder Abschnitt
  (`.p-folder-section`) Ziel für seinen Ordner, auch im Unterordner; der Abschnitt
  der losen Objekte legt direkt in die offene Ebene. Ziel zeigt den Ring (4.1,
  `--ring-lg`, 8 px Abstand) ohne Fläche, der eigene Abschnitt ist kein Ziel.

### 4.6 Objekt (`.card`)
- **Zweck:** Ein gesichertes Bild, Video, PDF oder eine Text- bzw. Seitenkarte
  im Raster.
- **Form:** Eckig, ohne Fläche. Solange es lädt, steht ein Glasplatzhalter da.
- **Video beim Hover (0.27):** Nach 250 ms Verweilen zeigt `.card-scrub` acht
  Standbilder aus dem ganzen Clip nacheinander (alle 320 ms), ohne Ton. Mit
  `prefers-reduced-motion` bleibt das Standbild.
- **Unsorted (0.33):** Die letzten zwei Tage vor „Zuletzt gelöscht“ steht oben
  links „noch n T.“ (`.card-days`, Marke wie `.card-media`, Schrift `--danger`).
  Gezählt ab dem ersten Sehen (`inboxSeen` im Snapshot). Die Kopfzeile von
  Unsorted sagt nur „Nach 7 Tagen gelöscht.“, ohne Anzahl, Datum und Quellen.
  Dieselben Worte stehen im Index hinter dem Namen (dim) und auf der Zonenkarte
  hinter der Anzahl statt des Datums (0.33.1). Es ist immer Unsorted (0.35, vorher
  wählbar); Einstellungen › Bibliothek „Unsorted nach 7 Tagen gelöscht“ schaltet
  nur an (ab Werk) oder aus. Seit 0.36.0 zählt jeder Ordner namens Unsorted, auch
  selbst angelegt, klein geschrieben, mit Nummer davor oder als Unterzone
  (`library.rs is_unsorted`). Unsorted lässt sich nicht umbenennen. Unsorted entsteht mit jeder eigenen Bibliothek, auch in einem
  bestehenden Ordnersystem, und steht vorn als erste Active Zone; in einer
  Bibliothek mit eigener Reihenfolge, sobald sie neu dazukommt (0.33.2). Wer sie
  danach verschiebt, behält seinen Platz. Geteilte
  Bibliotheken räumen ab Werk nicht auf und zeigen nichts davon; wer dort in den
  Einstellungen „An“ wählt (0.36.1), bekommt dieselben Hinweise und dasselbe
  Aufräumen wie in einer eigenen Bibliothek.
- **Liste (0.34):** dritte Ansicht neben Raster und Original, Chip
  „(Liste)“. Zeilen wie im Finder: Bild, Name, Format, Maße, Größe, Quelle,
  Gesichert. Dateiname in Geist 13 px/500 (`--p-text`), Angaben in 12 px
  `--p-dim`, Format als Label (Mono), Spaltenköpfe als Label (Mono,
  Versalien), Zeilen mit `--p-rule` getrennt, Auswahl mit `--ring-0` um die
  ganze Zeile. Die Größenstufen setzen die Bildhöhe (`--lt`, 24–96 px).
  In „Zuletzt gelöscht“ steht als Quelle die Zone und die Resttage.
  Text- und Notizkarten (0.34.2) stehen als Blatt in der Bildspalte, quadratisch
  wie im Raster, ohne Kennung und Fuß; im Namen steht der Anfang des Texts
  (Notiz: Titel · Text). Spaltenköpfe sind Knöpfe (Label faint → dim beim
  Hover, aktiv in `--p-text` mit ↑/↓): sortieren aufsteigend, absteigend, dann
  wieder nach der Reihenfolge der Zone. Maße, Größe und Datum beginnen mit dem
  Größten bzw. Neuesten, leere Werte stehen immer unten. Sortiert ist Ziehen
  zum Umstellen aus.
- **Nicht:** Keine Rundung, kein Schatten und keine Bildunterschrift im Raster.
  Die Info gibt es per `I` oder im Seitenblatt.

### 4.7 Chip (`.p-chip`)
- **Zweck:** Filter und Ansichtswahl.
- **Form:** Geist Mono, 11 px, Versalien, ohne Fläche. Die Zustände laufen nur
  über die Textfarbe: faint → dim (Hover) → text (aktiv).
- **Hinweis in der Filterzeile (0.31.2):** Solange die Bilderkennung läuft,
  steht am Ende der Filterzeile „(Bilderkennung: noch n von m)“ als Mono-Text in
  dim, ohne Klick. Er zählt mit und verschwindet, wenn alles erkannt ist.
- **Filter in Alle Objekte (0.39.1, Variante C):** Eine Zeile mit Art, Farbe
  und Zeit, dahinter „(Mehr)“. Das öffnet darunter eine Tabelle (Label 96 px
  in Mono dim, Chips rechts) mit Form, Format, Doppelt, Motive, Quellen und
  bei geteilten Bibliotheken Von. Der Zustand bleibt (`archiver.filtersMore`).
  Ist sie zu, stehen gesetzte Filter daraus als Pille in der ersten Zeile:
  Mono 11 px, Fläche ink × 0.08 (Hover 0.14), `--r-md`, „×“ in dim, Klick
  entfernt den Filter. „(Zurücksetzen)“ steht rechts außen.

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
- **Lightbox:** Das Bild steht groß auf `--lightbox-bg`, das Raster dahinter
  verschwimmt (`blur(24px)`, 0.30.1), damit kein Text durchscheint. Leertaste öffnet sie,
  Pfeile blättern, `I` zeigt die Info. Klick neben das Objekt schließt sie
  (offene Zonen klappen erst zu, vergrößert schließt nichts).
- **Leiste der Lightbox (0.28):** dieselben Maße wie die Navigation (4.2):
  Innenrand `--nav-rim`, Knöpfe `--nav-h`, 13,5 px, Abstand 3 px, Ecke `--r-md`.
  Knopf „Gesichert“ (0.30.1) nur bei Linkkarten mit gesicherter Seite, neben „Quelle“.
  Feste Breite `min(960px, 100% − 32px)` (0.37.1, vorher 600 px), bei offener
  Info abzüglich der Info-Spalte; sie springt beim Blättern nicht. Passt der
  Dateiname nicht, kürzt `fitLbName` ihn in der Mitte („Anfang … Ende.png“),
  damit Anfang und Endung sichtbar bleiben. Der volle Name steht im Tooltip.
- **Seitenblatt:** Details von rechts, `--sheet-w` = min(560 px, 46 vw).
- **Wolke (0.39.1):** Knopf „Wolke“ in der Leiste und Taste W öffnen die
  Wolke (4.25) über der Lightbox.

### 4.11a Bildtext (`.card-cap`, `.lb-caption`, 0.29)
- **Zweck:** Credits oder Unterschrift zu einem Bild, wie unter einem Bild im
  Magazin. Kommt nur aus Text, den man beim Sichern auf der Seite markiert hat,
  aus dem Feld „Bildtext“ in der Info oder per ⌘V auf ein gewähltes Bild.
  Seit 0.30 ist das frühere Studio-Feld „Notiz“ darin aufgegangen (wird beim
  Öffnen der Bibliothek angehängt). Durchsuchbar, im PDF „Mit Bildtext“.
- **Form:** Drei Zeilen: Kennung in Geist Mono 10/11 px, Versalien, `--p-dim`
  (Zone—Nummer Position/Anzahl, etwa TYPO—02 3/7), Text in Geist 17 px
  (Lightbox).
- **Raster (0.33):** Kein Textauszug mehr unter dem Bild, der Chip „(+ Text)“
  ist entfallen. Ein Punkt 10 px, 6 px vom Rand unten rechts, in der Farbe der
  Textkarte (`.card-dot`, 0.33.1 statt Eselsohr) zeigt an, dass das Bild Text
  hat. Feine dunkle Kante, damit er auf gleichfarbigen Bildern stehen bleibt.
  Bilder ohne Text bleiben stumm.
- **Farbe (0.33):** In ⌘D unter „Bildtext“ wählbar, dieselbe Reihe wie bei
  Textkarten und Notizen (`tonePicker`). Ohne Wahl gilt die Farbe aus dem Hash.
- **Lightbox (0.30.1):** Karte im Ton des Bildes wie eine Textkarte
  (`quoteTone`, `.text-sheet.lb-cap-card`): Kennung BILDTEXT · Zone—Nummer,
  Text in Geist 500 nach Länge 7 / 5 / 3,6 `cqmin` (mind. 15 px), Fuß Quelle ·
  Datum. Zwei Formen, Einstellungen › Aussehen „Bildtext in der Lightbox“:
  - **Rückseite** (Standard): Die Karte hat genau das Maß des Bildes. Ein
    Eselsohr 22 px in der Kartenfarbe unten rechts zeigt sie an (Hover 30 px).
    `T`, Knopf „Text“ oder das Eselsohr wenden um die senkrechte Mitte,
    2 × 0.18 s (`ease-in` auf die Kante, `ease-out` zurück). Blättern zeigt
    wieder die Vorderseite.
  - **Doppelseite:** Karte 3:4 (mind. 260 px) 24 px links neben dem Bild,
    gleich hoch, beide zusammen mittig. Vergrößert ist die Karte aus.
  Video, PDF und Audio: Karte 300 × 400 px unten links. Der Text ist auf der
  Karte editierbar (Esc oder ⌘↩ beendet, Sichern beim Verlassen), ebenso der
  Text einer Textkarte; deren PNG bleibt unverändert.

### 4.11b Notiz-Objekt (`.note-sheet`, `.note-paper`, `.note-links`, 0.29)
- **Datei:** Eine Notiz ist eine `.md`-Datei in der Zone. Erste Zeile = Titel
  (als `# Titel` gespeichert), beim Verlassen der Notiz auch Dateiname.
  Anlegen per Rechtsklick in den Hintergrund einer Zone („Neue Notiz“) oder
  ⌘⇧N; sie öffnet sich gleich in der Lightbox, der Titel ist markiert.
- **Raster:** Ein Blatt wie die Textkarte (4.6): Kennung NOTIZ · Datum in Mono,
  Titel fett (6,4 cqw, höchstens drei Zeilen), Text darunter normal, Fuß mit
  „n verknüpft“. Grundton Weiß (`white`), keine Zufallsfarbe. In „Original“
  steht das Blatt hochkant 3 : 4.
- **Lightbox:** Papier max. 620 × 760 px, Innenrand 48/52 px. Kennung NOTIZ ·
  Zone · Datum (Mono 11 px), Titel 30 px/600, Text 17 px/1,45, Fuß mit Wörtern
  und „Gesichert“. Geschrieben wird direkt auf dem Blatt, gesichert nach 0,6 s
  Pause und beim Verlassen. Die Farbpunkte stehen in der Leiste: eine Reihe
  für Notizen und Textkarten (0.30) aus den bestehenden Farben Rot, Grün,
  Violett, Cyan, Gelb, Weiß (`#ffffff`, kein Papierton mehr) und Schwarz. Die
  Extension wählt beim Markieren zufällig aus den fünf Buntfarben. Schwarzes Blatt bekommt eine feine helle Kante.
- **Verknüpfungen:** Spalte 40 px links neben dem Blatt, oben bündig, 150 px
  breit: Mono-Kennung „Verknüpft (n)“, Kacheln 72 px in zwei Reihen, „+“ als
  Rahmenkachel. „+“ öffnet eine Auswahl (Menüfläche 430 px, Suchfeld). Erst
  stehen die Zonen als kleine Tray-Karten da (drei Spalten, Cover 58 px mit
  einem großen und zwei kleinen Bildern, Name 12 px, Anzahl in Mono). Klick
  öffnet die Zone: Raster mit sechs Spalten, gewählte gestrichelt, „‹ Zonen“
  bzw. Esc führt zurück. Suchen durchsucht die ganze Bibliothek (0.29.1). Klick auf eine Kachel öffnet das Objekt; die Lightbox
  blättert dann durch Notiz und Verknüpfte. Fenster schmaler als 1080 px: die
  Kacheln (48 px) stehen auf dem Blatt über dem Fuß.

### 4.12 Tray (`palette.css`)
- **Name (0.28):** In der Oberfläche heißt sie „Tray“, im Code weiter `palette`.
- **Zweck:** Per Kürzel (Standard ⌥ Space, Einstellungen › Tray) über
  jedem Programm Zonen und Objekte holen, etwa in einen InDesign-Rahmen.
- **Form:** 860 × 620 px, macOS-Glas, Suchfeld 17 px oben. Grund `--pal-bg`
  (Dunkel rgb 28 × `--win-alpha` 0.72, Hell rgb 244 × 0.78) ist seit 0.28 auch
  der Standard des App-Fensters und folgt seit 0.30 dem Glas-Regler (2.1). Hell/Dunkel und Ecken folgen Einstellungen › Aussehen;
  die Fensterecke ist eckig 0, klein 6, mittel 12 (Standard), groß 18 px.
  Start: Active Zones als Zonenkarten (4.4) mit 01–04 und „Active Zone“,
  darunter der Index; seit 0.32 haben alle Karten dieselbe Höhe (Cover 8:3).
  Zone: Active Zones als Reiter, darüber ihre Unterordner als Karten
  („(Ordner)“, Klick oder ↵ öffnet, ⌫ eine Ebene hoch, Kopf „Zone / Ordner“),
  darunter die Objekte eckig in sechs Spalten (4.6). Der Inhalt hat oben 4 px
  Luft, damit der Ring (4.1) der ersten Reihe nicht abgeschnitten wird. Suche: passende Zonen als Karten,
  darunter Objekte. Fußzeile: links „Tray“, rechts die Tasten als
  Mono-Etiketten, esc am Ende.
- **Verhalten:** Aus InDesign geöffnet heißt ↵ „Platzieren“ (markierter
  Rahmen oder Platzieren-Cursor), sonst „Kopieren“. Beim Herausziehen (0.37.2, Variante V4) klappt der Tray
  in 0.22 s ease-out nach oben auf das Suchfeld zusammen (Fenster 72 px hoch,
  Oberkante bleibt, `panel_ghost` in macos.rs) und lässt Klicks durch. Im
  Suchfeld steht dann die Leiste: „Tray“ mono, Vorschau 30 px mit Ring (4.1),
  Name 15 px (bei mehreren „3 Bilder“), Zone gedimmt, rechts „Loslassen, um
  abzulegen“ (aus InDesign: „zu platzieren“) und esc · Abbrechen. Der übrige
  Inhalt blendet in 0.12 s aus. Nach dem Ziehen geht der Tray auf den
  gemerkten Rahmen zurück. Mit „Bewegung reduzieren“ ohne Animation. Klick in ein anderes Programm
  blendet sie aus.
- **Textkarten (0.27):** wie in der App in ihrer Grundfarbe (`.pal-text`).
- **Leertaste (0.27):** zeigt das gewählte Objekt groß, innerhalb der Palette
  (`.pal-preview` ersetzt den Inhalt, Suchfeld und Fußzeile bleiben). ←→
  blättern, Leertaste oder esc schließen. Im Suchfeld mit Text tippt die
  Leertaste weiter.
- **⌘1–4:** wechselt die Bibliothek wie in der App.
- **⌘C, ⌘V (0.32):** ⌘C kopiert das gewählte Objekt, ⌘V legt die
  Zwischenablage in die offene Zone. Steht etwas im Suchfeld, gehören beide
  dem Suchfeld.
- **Mehrere Objekte (0.37.2):** ⌘-Klick nimmt einzeln dazu oder heraus,
  ⇧-Klick und ⇧ + Pfeile wählen einen Bereich. Jedes gewählte Objekt trägt
  den Ring (4.1). Ziehen und ⌘C nehmen alle gewählten mit, esc hebt die Wahl
  zuerst auf, ein Pfeil ohne ⇧ ebenso.
- **Nicht:** Sie aktiviert Archiver nicht und holt das Hauptfenster nicht nach vorne.
  Liegt Archiver hinten, wird das Hauptfenster beim Öffnen weggelegt und beim
  Schließen hinter alle Fenster zurückgelegt (0.28).

### 4.13 Zonenleiste am ganzen Mac (`dropbar.css`)
- **Zweck:** Wie 4.3, aber beim Ziehen von Dateien in jedem Programm.
- **Form:** Volle Breite unten auf dem Bildschirm mit dem Zeiger, 280 px hoch,
  dieselben vier Glaskarten, Ring und Glühen wie 4.3.
- **Streifen (0.32, 90 px seit 0.32.1 / 3.25.2):** Beim Ziehen ragen die
  Karten erst nur 90 px herein (`.strip`): dieselbe Karte, oben gerundet, unten
  bündig, ohne Hinweis. Darüber
  bleibt alles frei, etwa das Eingabefeld eines Chats. Fährt der Zeiger in den
  Streifen, wird das Fenster mit macOS-Animation 280 px hoch; steht er mehr
  als 24 px darüber, wird es wieder Streifen. Gleiches gilt für die Leiste der
  Extension im Browser (3.25.0, `overlay.css` `.zones-bar.strip`, Höhe mit
  0.22 s Übergang, ohne bei `prefers-reduced-motion`). Die Leiste der Extension hat
  seit 3.25.2 genau die Karten der Leiste in der App (4.3, `.p-hot`): Glas mit
  Unschärfe und Schatten, Nummer oben, Name in der Mitte, Ziel mit
  gestricheltem Ring (`--ring-lg`, 3 px) statt Outline. Sie nimmt
  den Zeiger an (3.25.1), damit Chrome am unteren Rand die Seite nicht
  darunter wegscrollt; Text- und Instagram-Ziehen nutzen denselben Streifen. Die Karten
  am ganzen Mac haben keine eigene Unschärfe (das Fenster ist durchsichtig),
  deshalb gilt dort nur `--zone-alpha`.
- **Ablauf (0.31.0):** Nach dem Loslassen zeigt das Ziel „Wird gesichert …“
  (`.busy`, kein Glühen). Erst wenn Import oder Verschieben fertig ist, kommt
  „Gesichert in …“ mit Glühen (`.landed`). Scheitert es, steht „Nicht
  gesichert: …“ in `--danger` (`.failed`, kein Glühen) 2.5 s lang, dann
  blendet die Leiste aus. Die Leiste bleibt so lange stehen (`dropbar_hold`).
- **Ab Werk aus (0.32.1):** Einschalten unter Einstellungen › Tray. Erst die
  eigene Wahl zählt (`dropbarChosen`); ein `dropbar: true` aus älteren
  Versionen ohne Wahl gilt als aus. Im Browser übernimmt die Extension.
- **Nicht:** Erscheint nicht, wenn Archiver selbst vorne ist, und nicht bei
  Text oder Links ohne Datei. Zeigt nie „Gesichert“, bevor es gesichert ist.

### 4.14 Zuletzt gelöscht (`.p-deleted`, `.card.del`)
- **Zweck:** Gelöschte Objekte und Zonen liegen 7 Tage unter
  `.archiver/deleted/<Zeit>/<alter Pfad>` in der Bibliothek, dann gehen sie in
  den Papierkorb des Macs. Erreichbar über die letzte Zeile im Index und ≡.
- **Form (0.28):** Dasselbe Raster und dieselbe Karte wie in jeder Zone (4.6),
  mit Größenstufen. Das Badge zeigt Zone und Resttage. Auswahl zeigt den Ring
  (4.1). Wiederherstellen und Sofort löschen stehen als Chips rechts.
- **Dateien ohne Vorschau (0.37.0):** PSD, AI, ZIP … aus einer gelöschten Zone
  erscheinen als Karte mit dem Format-Platzhalter (wie ein Video ohne Vorschau)
  und lassen sich ebenso zurückholen. Die Rückfrage beim Zone-Löschen nennt sie:
  „12 Objekte und 3 Dateien ohne Vorschau“.
- **Lightbox (0.29.1):** Doppelklick, Leertaste oder Enter öffnen sie wie in
  jeder Zone. In der Leiste stehen statt Zone und Info „Wiederherstellen“ und
  „Sofort löschen“ (rot beim Überfahren). Notizen sind hier nur lesbar.
- **Endgültig löschen fragt immer nach** (⌫, Chip, Menü, Lightbox): Dialog mit
  „Abbrechen“ und rotem „Sofort löschen“, Enter bestätigt.
- **Nicht:** Kein eigener Zonenplatz unter den Active Zones, keine Zeile, wenn
  nichts gelöscht ist.

### 4.15 Handbuch (`.p-manual`, `manual.js`)
- **Zweck:** Alle Funktionen samt Tasten, erreichbar über ≡ › Handbuch. Der
  Inhalt steht in `app/src/manual.js` (Deutsch und Englisch) und ist dieselbe
  Quelle wie archiver-app.com/manual. Neue Funktionen dort nachziehen.
- **Form:** Seite wie Information und Einstellungen: Seitenblatt von rechts,
  Blöcke (`.p-block`) je Abschnitt, Zeile mit Titel und grauem Text links,
  Tasten rechts (`.p-keys`, höchstens 140 px breit, umbrechend).
- **Taste (`kbd` im Seitenblatt):** Geist Mono 11 px, `--p-text`, Rand als
  `inset 0 0 0 1px` ink × 0.25, Ecke `--r-sm`.
- **Nicht:** Keine Bilder, keine Akzentfarbe, kein eigenes Inhaltsverzeichnis.

### 4.16 Hinweisleiste (`.p-update`, `.p-ext`)
- **Zweck:** Ein Hinweis, der bleibt, bis man handelt: „Archiver X ist da“
  und seit 0.30 „Extension X ist da“ bzw. „Keine Extension verbunden“.
- **Form:** Glas-Pille oben rechts (12 px vom Rand), `--p-pill`, Text 13 px,
  danach Handlung in Mono 12 px in Klammern („(Laden)“) und ×. Immer nur
  eine Leiste; das App-Update verdrängt den Extension-Hinweis.
- **Extension:** Der Host notiert bei jedem Kontakt die Version
  (`extension.json` neben den Einstellungen). Älter als `EXTENSION_MIN`
  (`bridge.rs`) oder ohne Version = veraltet. Hat sich nie eine gemeldet,
  kommt der Hinweis erst nach zwei Tagen. × blendet ihn aus, bis sich Zustand
  oder Mindestversion ändern. Einstellungen › Extension zeigt den Stand.
- **Nicht:** Kein Toast, keine Akzentfarbe, kein Dialog beim Start.

### 4.17 Mehrfachmarkierung (Extension 3.27.0, `content.js`)
- **Zweck:** Mit ⌥ (seit Extension 3.29.1, vorher ⌘) mehrere Stellen einer
  Seite sammeln und in einem Zug in eine Zone ziehen. ⌘-Klick gehört dem
  Browser (Link im neuen Tab). ⌥-Klicks bekommt die Seite nicht: kein
  Weiterspringen, kein Download (3.29.3). ⌥ + Markieren nimmt Text dazu, ⌥-Klick nimmt ein Bild
  (ab 80 px) dazu oder wieder heraus. Klick daneben oder Esc hebt alles auf.
  Liegt das Bild in einem Link, öffnet ⌘-Klick wie gewohnt einen neuen Tab,
  solange noch nichts markiert ist (Extension 3.29.1); erst während einer
  Sammlung nimmt er das Bild dazu.
- **Form:** Text behält die Farbe der Markierung, also die Farbe der späteren
  Textkarte (`::highlight(archiver-marks)`, gleiche Werte wie `::selection`).
  Alle Stücke einer Runde teilen eine Farbe. Bilder tragen den Ring aus 4.1:
  1 px gestrichelt 4/4, 3 px Abstand, eckig, weiß mit feinem dunklen Schatten,
  weil die Extension auf fremden Seiten keinen eigenen Grund hat. Einblenden
  0.18 s `ease-out`, ohne bei `prefers-reduced-motion`.
- **Ablegen:** nur Text → eine Textkarte, Stücke als Absätze in
  Markierreihenfolge. Text und Bild → jedes Bild mit allem Text als Bildtext.
  Nur Bilder → jedes Bild einzeln.
- **Nicht:** Kein Zähler, kein zweiter Rahmen um Text, keine Akzentfarbe.

### 4.18 Ziehbild (Extension 3.28.0, `content.js`)
- **Zweck:** Am Zeiger hängt beim Ziehen das Motiv selbst.
- **Form:** Bild oder Video im eigenen Seitenverhältnis, höchstens 220 px an
  der langen Seite, eckig (ohne Rundung), Schatten `0 12px 32px` 40 %, 92 %
  Deckkraft. Video zeigt das gerade sichtbare Bild, sonst das Poster. Liegt in
  der Überlagerung über den Zonen. Gilt für das eigene Ziehen (Instagram) und
  für Videos beim Browser-Ziehen.
- **Nicht:** Kein Quadrat, kein grauer Kasten mit „Video“.

### 4.19 Dateinamen (App 0.36.0, `.nm-*`, `.rn-*`, `.lb-info-sugg`)
- **Zweck:** Einheitliche Namen auf Wunsch, nie ungefragt. Ab Werk „Original
  behalten“. Seit 0.36.4 benennt nichts mehr beim Sichern oder Importieren um,
  auch nicht über die Extension: Umbenannt wird nur im Blatt.
- **Einstellungen › Dateinamen:** Blöcke „Schema“ (sechs Zeilen mit Punkt und
  Beispiel in Geist Mono, gewählt = gefüllter Punkt, Text `--p-text`, sonst
  `--p-dim`), „Eigenes Schema“ (Bausteine als Kästchen mit ‹ und ×, nicht
  benutzte als „+ Baustein“, darunter die Vorschau; jede Änderung dort wählt
  das eigene Schema) und „Aufräumen“ (Wörter statt Schalter, 4.7).
- **Umbenennen-Blatt:** Rechtsklick auf die Auswahl › „Umbenennen …“. Blatt in
  `--menu-bg`/`--menu-shadow`, `--r-lg`, 760 px, blendet in 0.18 s ein, Grund
  abgedunkelt. Zeilen: Häkchen, Vorschaubild 40 px eckig, alter Name (Geist
  Mono, `--p-dim`, „uneinheitlich“ als Kästchen mit Linie), Pfeil, neuer Name
  (Fläche ink × 0.06, Klick = bearbeiten, gestrichelter Ring wie 4.1). Ein
  Primärknopf „n umbenennen“ (4.8). Gilt seit 0.36.4 auch in geteilten
  Bibliotheken. Im Blatt wählen die Chips ein anderes Schema, ohne die
  Einstellung zu ändern. Das Blatt liegt über der Lightbox (z-index 90).
- **Rechtsklick in der Lightbox (0.36.4):** dasselbe Menü wie 4.7
  (`zone-menu p-ctx-menu`, `--menu-bg`, `--menu-shadow`), nur mit
  „Umbenennen …“, Trennlinie, „Öffnen“, „Quelle“ (bei Seitenadresse),
  „Im Finder zeigen“, „Kopieren ⌘C“. Gilt für das gezeigte Objekt. Nicht für
  Notizen und nicht in „Zuletzt gelöscht“. Über Eingabefeldern, der Leiste und
  der Info-Spalte bleibt das Systemmenü.
- **Namensvorschlag (Info-Spalte, Details und Lightbox):** Kasten ink × 0.055
  über „Bildtext“, Überschrift Geist Mono 11 px, Name in Geist Mono 12.5 px,
  Begründung `--p-dim`, „Übernehmen“ (Primär) und „Ändern“. Erscheint, wenn
  Seitentitel, Motiv oder Farbe einen Namen ergeben, der vom jetzigen
  abweicht. Beim Einblenden läuft einmal ein Lichtstreif über den Namen.
- **Ausnahme zur Tabelle 2.5:** Der Lichtstreif braucht 1.1 s, einmal, auf
  ausdrücklichen Wunsch (F11). Mit `prefers-reduced-motion` entfällt er.
- **Nicht:** Kein Umbenennen ohne Bestätigung im Blatt oder auf „Übernehmen“,
  kein Dienst im Netz: Vorschlag und Schema nutzen nur vorhandene Daten
  (`naming.rs`).

### 4.20 Bibliotheken beim Ziehen (Extension 3.29.0, `.lib-bar`)
- **Zweck:** Beim Ziehen im Browser die Bibliothek wechseln, ohne ⇧ mehrfach
  zu drücken. Erscheint nur, wenn es mehr als eine Bibliothek gibt.
- **Form:** Eine Glas-Pille mittig über der Zonenleiste (4.13), Werte wie die
  Navigation (4.2): 10 px Rundung, 5 px Innenabstand, Namen 14 px Geist. Die
  aktive Bibliothek ist gefüllt (ink × 0.1 / schwarz × 0.08). Steht 104 px
  über dem unteren Rand, solange die Leiste Streifen ist, und rückt mit
  0.22 s auf `min(30vh, 260px) + 22px`, wenn sie die volle Höhe hat (`.high`).
- **Ablauf:** Zeiger auf einen Namen → Ring aus 4.1 (`--ring-md`, rx 9, 3 px
  Abstand). Nach 0.4 s Verweilen wechselt die Bibliothek, die Karten bleiben
  stehen und tauschen nur ihre Namen. Solange der Zeiger auf der Pille ist,
  bleibt die Leiste in ihrer Höhe; zurück zum Streifen erst 70 px über der
  vollen Leiste. ⇧ springt weiter zur nächsten (dragover liest nur
  Modifier-Tasten).
- **Nicht:** Kein ⇧-Zeichen in der Pille, keine Zahlen, keine zweite
  Hervorhebung neben Ring und Füllung. Ablegen auf der Pille legt nichts ab.

### 4.21 PDF-Ersteller, Plakat-Anordnung (App 0.37.2, `.pdf-page.flow`)
- **Zweck:** Plakat hat drei Anordnungen: Raster (bisher, angeschnitten,
  Beschriftung im Bild), Index und Paar (nach den Sort-Office-Vorlagen).
  Feld „(Anordnung)“ erscheint nur beim Stil Plakat; bei Index und Paar
  fällt „(Pro Seite)“ weg und „(Beschreibung)“ kommt unter den Titel.
- **Seite:** weiß, 14 pt Rand, Helvetica bzw. Geist 6.4 pt. Kopfzeile in vier
  gleichen Spalten (Titel · Anzahl · Datum · Seite), darunter Nummer [01],
  Titel, Beschreibung (nur Seite 1, höchstens 2 Zeilen, 230 pt breit) und Jahr
  rechts. Bilder ab 58 pt, ungeschnitten, oben bündig, 12er-Raster mit 6 pt
  Abstand. Index wechselt die Reihen (z. B. 5·4·3, 3·_·3, 4·3·5, _·4·_·4),
  Paar setzt zwei Bilder (5·7, 7·5; hoch 12, 7·5). Zu hohe Reihen schrumpfen
  oder gehen auf die nächste Seite. Bildunterschrift 12 pt: Name links, Quelle
  grau rechts.
- **Gleich in Vorschau und PDF:** `flowPages` (app.js) rechnet die Felder in
  Punkten, `flow_sheet` (pdf.rs) setzt genau diese Felder.
- **Nicht:** kein Anschnitt, keine Schrift im Bild, keine Notizen.
- **Knöpfe unten links (K2, gilt für alle Stile):** „PDF sichern“ über die
  ganze Breite, 40 px hoch, `--r-md`, ⌘↩ rechts in Mono 11 px (0.55).
  Darunter „Abbrechen“ als Mono-Etikett 11 px, Großbuchstaben, gedimmt.

### 4.22 Name zum Testen (App 0.37.3, Information › App)
- **Zweck:** Andere Namen statt „Archiver“ ausprobieren, ohne Build.
- **Form:** Zeile wie „Dein Name“ (Titel, gedimmter Satz, Eingabe rechts,
  `p-input note-field`), Platzhalter „Archiver“. Greift beim Tippen.
- **Gilt für:** Navigation (`#navBrand`), Startbild, Sperrbild, Kopf von
  Information, Fenstertitel. Nicht: Tray, Extension, PDF, Dateinamen.

### 4.22a Updates (App 0.38.1, Information › Updates)
- **Zweck:** Kanal wählen (Beta oder Vorab) und jede veröffentlichte Version
  installieren, auch eine ältere.
- **Form:** Eigener Block unter „App“. Kanal als `p-choice` (wie alle
  Schalter), „Version wählen“ mit `p-link` rechts; die Liste darunter sind
  normale Blockzeilen (Version, Datum gedimmt, rechts „Installieren“ oder
  gedimmt „installiert“). Vor dem Installieren ein `dialog confirm`, bei
  älteren Versionen mit Hinweis, dass Späteres dort fehlt.
- **Sichtbar:** nur mit Vorab-Kanal oder nach ⌥-Klick auf die Versionsnummer.
- **Kürzel:** ⌘I öffnet Information, auch in Works.

### 4.23 Works (App 0.38.0, `works.css`, `works.js`)
- **Zweck:** Laufende Kundenprojekte als eigener Bereich neben der
  Bibliothek. Liest eine eigene Wurzel (Kunde/Projekt, Phasenordner 00–05,
  `_Assets` beim Kunden) und verschiebt nie eine Arbeitsdatei. Schalter unter
  Einstellungen › Studio, ab Werk aus, nur in Vorabversionen sichtbar.
- **Liste:** Projekte als Karten (4.4) mit Cover 3:2 (neuester Stand, sonst
  Recherche), darunter die Phasenleiste, dann Name mit Termin rechts (Mono,
  ≤ 3 Tage `--p-text`, überfällig `--danger`) und Kunde · Phase. Letzte Karte
  „Neues Projekt“: Fläche ink × 0.03 (Hover 0.055), Text faint → dim. Chips
  filtern nach Laufend/Abgeschlossen/Alle und nach Kunde.
- **Phasenleiste (`.w-phasebar`, `.w-phase`):** Fünf Striche, 2 px, Abstand
  2–3 px: offen `--p-rule`, erledigt `--p-rule-strong`, aktuell `--p-text`.
  Im Projekt sind die Striche zugleich die Reiter, Beschriftung als Label
  (faint, aktuelle Phase dim, gewählter Reiter text). Übersicht, Post und
  Assets sind Chips daneben.
- **Kopf:** Kunde als Label über dem Titel (Klick filtert die Liste), Titel
  wie `.p-head` mit dem nächsten Schritt als gedimmtem Satz (aus `brief.md`,
  sonst offene Rechnung oder Korrektur), rechts Termin und ⋯.
- **Stände-Reihe (`.w-stand`):** Je Arbeit (Ordner + Stamm des Namens) eine
  Zeile, alt → neu. Bilder in ihrer eigenen Form, alle gleich hoch (200 px,
  der neueste 320 px; Übersicht 280, Recherche 200, Leiste 110). Darunter
  Kennung als Label (KORR in `--p-text`) und Datum 12 px dim. Ohne Vorschau
  steht die Endung als Label auf `--thumb-bg`.
- **Auswahl und Ablegen:** Ring (4.1): Kachel und Zeile `--ring-0`, die
  Fläche beim Ablegen `--ring-lg` mit 12 px Abstand, ein Phasen-Reiter unter
  dem Zeiger `--ring-0`. Ablegen kopiert in den Phasenordner, nie verschieben.
- **Post:** Summen (Angeboten, Offen, Bezahlt) als Label über 22 px/500,
  darunter eine Tabelle mit Linien `--p-rule` wie die Liste (4.6). Status
  einer Rechnung ist ein Chip „(offen n T.)“, ab 30 Tagen `--danger`, Klick
  schaltet „(bezahlt)“.
- **Brief:** Eckdaten als Zeilen (Label links, Wert rechts), darunter der
  Text 13,5 px/1,6, höchstens 68 Zeichen breit. Bearbeiten in einer Fläche
  ink × 0.055, `--r-md`, Geist Mono 12 px; ⌘S sichert, Esc verwirft.
- **Groß ansehen (`.w-lb`):** wie die Lightbox (4.11) mit `--lightbox-bg`
  und Unschärfe, Leiste `.lb-bar`. Vergleich: zwei Stände übereinander, eine
  1-px-Linie in `--p-text` folgt dem Zeiger, Kennungen oben links und rechts.
- **Nicht:** Keine Akzentfarbe, keine Icons, kein Verschieben von Dateien,
  keine Suche, kein zweiter Rahmen um Karten.

### 4.24 Boards (App 0.39.0, `boards.css`, `boards.js`)
- **Zweck:** Präsentationen aus Bildern der Bibliothek, als eigener Bereich.
  Ein Board ist eine lesbare JSON-Datei `Bibliothek/Boards/Name.board`
  (`boards.rs`), Bilder darin sind Verweise (Hash, Pfad), keine Kopien. Der
  Ordner `Boards` ist keine Zone. Schalter unter Einstellungen › Studio, ab
  Werk aus, nur in Vorabversionen sichtbar.
- **Übersicht:** Boards als Karten (4.4), Cover 16:10 mit der ersten Folie,
  darunter Name, Anzahl der Folien (Mono) und Datum 12 px dim. Letzte Karte
  „Neues Board“ wie in Works (4.23). Rechtsklick: Öffnen, Umbenennen, Im
  Finder zeigen, Löschen (Papierkorb des Macs, mit Rückfrage).
- **Aus einer Zone:** Rechtsklick auf die Auswahl › „Aufs Board …“ öffnet ein
  Menü (4.9) mit den Boards, zuletzt geändert zuerst, und „Neues Board …“.
  Die Auswahl kommt als neue Folie mit der Vorlage Index ans Ende.
- **Editor, Grundsatz:** Nur die Folie und eine Leiste unten sind sichtbar
  (Lukas 16.10.: „more minimal versteckt“). Folien (F), Bilder (B) und
  Gestalten (E) öffnen sich als Glas (2.4: `--menu-bg`, `--menu-shadow`,
  `blur(24px) saturate(1.4)`, `--r-lg`) links, unten und rechts, 12 px vom
  Rand, und blenden in 0.18 s ein. Esc schließt erst alle Flächen, dann die
  Auswahl.
- **Leiste unten (`.b-bar`):** Maße der Lightbox-Leiste (4.11): Innenrand
  `--nav-rim`, Knöpfe `--nav-h`, 13,5 px/500, Abstand 3 px, Ecke `--r-md`.
  Inhalt: ‹ 02 / 08 › (Mono 11 px dim), Folien, Bilder, Gestalten, + Text,
  bei Auswahl „Vom Board“, ▶ Präsentieren. Offene Fläche = gefüllter Knopf.
- **Folie (`.b-slide`):** 1600 × 1000 Einheiten (16:10), per CSS-Transform
  eingepasst. Eigene Farben und Schrift je Folie (`--s-bg`, `--s-fg`,
  `--s-dim`, `--s-font`), unabhängig vom Schema der App. Kopf in zwei Zeilen
  wie Sort Office (Kunde · Board · Folientitel · Seite, darunter [Nr] · Titel
  · Beschreibung · Stichworte · Jahr), Spalten auf Drittel. Bilder ungeschnitten
  und oben bündig, solange nichts anderes gewählt ist. `‹…›` in Texten setzt
  die zweite Farbe. Schriften: Geist, Geist Mono und Mac-Systemschriften
  (Helvetica Neue, Avenir Next, Futura, Didot, Baskerville), keine aus dem Netz.
- **Vorlagen:** Index, Paar, Aussage, Raster, Einzel, Farbe, Titel, Streifen,
  Kontaktbogen, Diptychon, Zitat, Index-Liste. Eine Vorlage ordnet nur die
  erste Lage; Ziehen schaltet die Folie auf „frei“. Raster und Weißraum
  (Spalten 4–24, Rand 0–160, Abstand 0–80) ordnen eine Folie mit Vorlage
  beim Schieben der Regler neu.
- **Auswahl:** Ring aus 4.1 (`--ring-0`, 6 px Abstand) in Text- oder
  Flächenfarbe der Folie (`--s-ring`, je nach Helligkeit), Griff unten rechts
  14 px. Keine zweite Hervorhebung.
- **Smart Guides (`.b-guide`):** 2 px in `--accent`, nur während des Ziehens,
  an Kanten, Mitten, Spalten und Rand. Eingeblendetes Raster (G) als Spalten
  in `--accent-rgb` × 0.07. Das ist die einzige Akzentstelle im Editor; sie
  zeigt Hilfslinien, keinen Zustand (Prinzip 5 bleibt beim Ring).
- **Inspektor:** Reiter wie Chips (4.7, Mono 11 px, faint → dim → text).
  Abschnitte mit Label in Mono, Zeilen Label 12 px dim links, Regler mit
  `accent-color: --p-text`, Werte in Mono rechts. Felder ink × 0.055,
  `--r-sm`. Farbfelder 24 px, gewählt mit `--ring-lg`. Knöpfe `.btn` (4.8).
- **Bilder:** Suchfeld, Zonen als Chips, darunter ein Streifen 88 px hoch,
  neueste zuerst. Klick legt auf die Folie, Ziehen legt an die Stelle; am
  Zeiger hängt das Motiv (4.18, höchstens 120 px).
- **Präsentieren (P):** Vollbild auf `--present-bg` (`#0b0b0b`, in beiden
  Schemata), Fuß in Mono 11 px `--present-ink` (`#777777`): „esc · zurück zum
  Board“ links, Nummer rechts. ← → und Klick links/rechts blättern.
- **Nicht:** Kein Export im Editor (PDF und Bild folgen), keine Icons, keine
  Akzentfarbe außer den Hilfslinien, keine zweite Leiste, keine Kopien der
  Bilder.

### 4.25 Wolke (App 0.39.1, `cloud.css`, `cloud.js`)
- **Zweck:** Am offenen Objekt weitere Referenzen andocken. Sie ziehen sich
  per Physik an und bilden ein Moodboard für genau dieses Objekt (Lukas
  17.10.: „eine Wolke an Referenzen, die als Mood-Strang agieren“). Zum
  Ausprobieren, Vorabversion.
- **Fläche:** wie die Lightbox (`--lightbox-bg`, `blur(24px)`), darüber
  zwei Leisten im Maß der Lightbox-Leiste (4.11): oben die Modi und der
  Abstand, unten „+ Referenz“, „+5 ähnliche“, Größe S M L XL, Anzahl,
  Entfernen und Schließen. Aktiv = gefüllter Knopf (ink × 0.15).
- **Modi:** Wolke (alles zur Mitte), Orbit (Nähe nach Farbähnlichkeit, kreist
  langsam), Strang (jede Referenz hängt an der gewählten, Fäden gestrichelt
  in `--dash`), Farbe (gruppiert nach Farbanteilen der Bildanalyse),
  Konstellation (gewähltes Objekt wird Anker, Fäden zwischen Unterwolken),
  Raster (Plätze in einem unsichtbaren Raster). Tab wechselt.
- **Abstand:** Eng 12, Mittel 26, Weit 44 px. Kein Objekt überlappt ein
  anderes, auch nicht beim Ändern der Größe.
- **Größe:** vier Stufen (0.62, 1, 1.45, 2.05 × Grundmaß = kürzere
  Fensterseite / 8, 56–140 px), Fläche je Seitenverhältnis gleich. Klick
  wählt (Ring 4.1, `--ring-0`, 4 px Abstand), 1–4 oder − + ändern die Größe;
  ohne Auswahl gilt sie für das offene Objekt.
- **Hinzufügen:** Glas über der Leiste (2.4) mit Suchfeld und Streifen 88 px,
  ähnlichste Bilder zuerst (Farbanteile, gleiche Zone). Klick dockt an.
  Doppelklick auf eine Referenz macht sie zur Mitte ihrer eigenen Wolke.
- **Bewegung:** Federn mit Dämpfung, Ziehen wirft. Bei
  `prefers-reduced-motion` ist die Lage sofort fertig, Orbit kreist nicht,
  Ein- und Aufpoppen entfallen.
- **Speichern:** nur Mitglieder, Größe und Anker je Objekt, lokal unter
  `archiver.clouds` (höchstens 300 Wolken). Keine Datei, keine Kopien.
- **Nicht:** Keine Rundung an Objekten, keine Akzentfarbe, keine Schatten an
  den Objekten. Die Extension kennt die Wolke nicht.

### 4.26 Form (App 0.39.2, `forms.css`, `forms.js`)
- **Zweck:** Alle gezeigten Objekte einer Zone, Suche oder Übersicht als
  eine Figur, zum Zeigen und Werben (Lukas 17.10., Vorbild Whispers-Kreis).
  Vierter Ansichts-Chip „(Form)“ neben Raster, Original, Liste; statt der
  Größe stehen dann die Figuren als Chips: Ring, Sonnenblume, Karussell,
  Fächer (`archiver.formShape`).
- **Ring:** Kreis mit Radius 41 % der kürzeren Seite, Objekte so groß, dass
  sie sich nicht berühren (höchstens 9 %). In der Mitte Zonenname 22 px/600
  und Anzahl als Label. Höchstens 160 Objekte.
- **Sonnenblume:** goldener Winkel, das erste Objekt 20 % groß in der Mitte,
  nach außen kleiner. Höchstens 400.
- **Karussell:** gekippter Ring (Höhe halb so groß wie die Breite), hinten
  kleiner und blasser (Deckkraft 0.4–1). Dreht langsam, hält beim Überfahren
  an, steht bei `prefers-reduced-motion`. Höchstens 72.
- **Fächer:** bis 30 Objekte, Drehpunkt unten, Spreizung bis 140°.
- **Objekte:** rechteckig, Format aus dem Original (0.5–2), Fläche
  `--thumb-bg`. Überfahren vergrößert 1,5-fach (0.18 s), Klick öffnet die
  Lightbox, Tastaturfokus mit `--ring-0`. Sind es mehr als die Figur fasst,
  steht unten „n von m gezeigt“ als Label in faint.
- **Nicht:** keine Rundung, keine Schatten, keine Akzentfarbe.

---

## 5. Bekannte Abweichungen

Diese Punkte stehen hier, damit niemand sie für Absicht hält. Behoben werden
sie nur auf ausdrückliches Go.

- **Die Extension hat ihre Farben fest im Code und nutzt keine Tokens.**
  Seit 3.22.0 stimmen die Werte mit der App überein (Hellgrund `#f4f4f4`,
  Sekundärtext `#5c5c5c`, Tertiär `#8f8f8f`, Karte schwarz × 0.045/0.07,
  Navigation weißes Glas, Menü `rgba(250,250,250,.97)`, Akzent `#5b7cff`).
  Ecken laufen über `--r-lg/--r-md/--r-sm` mit `data-radius` wie in der App.
  Ziel bleibt: Die Tabellen in Abschnitt 2 werden als Variablen in
  `overlay.css` und `gallery.css` auf `:host` gespiegelt.
- **Tote Regeln nach 0.30:** In `app.css` stehen noch Regeln für
  `data-nav` (Navigation-Positionen), `.p-head-row.is-list` (Ordner als
  Liste) und die Welle beim Neu laden. Sie greifen nicht mehr und können beim
  nächsten Aufräumen weg.
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
- [ ] Sie funktioniert in Dunkel und Hell sowie mit und ohne `html.mac`.
- [ ] Hervorhebungen laufen über den Ring (4.1) und nicht über Farbe.
- [ ] Wenn die Komponente auch in der Extension vorkommt, ist sie dort gleich
      oder als Abweichung in Abschnitt 5 notiert.
- [ ] `prefers-reduced-motion` wird respektiert.
- [ ] Diese Datei ist nachgezogen, wenn sich ein Wert oder eine Regel geändert
      hat.
