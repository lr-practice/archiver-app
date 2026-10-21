# Archiver – Design-System

Stand: App 0.40.19 · Extension 3.29.7

Diese Datei hält fest, wie Archiver aussieht und warum. Sie gilt für die Mac-App
(`app/src`) und die Extension (`extension/`, in Chrome und in Safari). Wer an der Oberfläche
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
| `--win-alpha` | 0.72 | 0.78 | Deckkraft über dem Mac-Glas, Standard wie im Tray. Regler „Glas“ (Einstellungen › Darstellung, 40–100 % in 5er-Schritten, `archiver.glass`, i18n.js `applyGlass`) für App, Tray und Observer |
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
| `--accent` / `--accent-rgb` | `#2d5aeb` | dito | Toast, aktive Systemzustände |
| `--glow-rgb` | `91,124,255` | dito | Glühen der Zielkarte beim Ablegen |
| `--danger` | `#e5484d` | dito | Fehler-Toast, Löschen |

Für die Farbe gilt:

- **Akzent sparsam.** Blau zeigt nur Systemrückmeldung (Toast, Glühen beim
  Ablegen). Auswahl und Fokus sind nie blau, sondern Ring
  (Prinzip 5).
- **Kein reines Weiß als Fläche.** Hell beginnt bei `#f4f4f4`. Reines Weiß
  bleibt Glas (Navigation, Zonenleiste) und Bildern vorbehalten.

### 2.2 Typografie

| Rolle | Schrift | Größe | Gewicht | Laufweite | Beispiel |
|---|---|---|---|---|---|
| Label, Chip | Geist Mono, Versalien | 11 px | 400 | +0.02em | Filter-Chips, Zähler |
| Meta | Geist | 12 px | 400 | 0 | Datum, Quelle |
| UI | Geist | 13–13.5 px | 500 | 0 | Navigation, Menüs |
| Karten-Titel | Geist | 15 px | 500 | 0 | Zonenname auf der Karte |
| Seitenkopf | Geist | 28–42 px (3vw) / 1.1, Übersicht 34–56 px (4vw) | je nach Labor-Variante | 0 | Übersicht, Zone, Alle Objekte, Suche, Zuletzt gelöscht (`.p-page > .p-head`, seit 0.40.10). Mechanik, Größe und Farbe aus Labor › Kopf (4.24c), ab Werk 05 |
| Satz | Geist | 34 px / 1.14 | 500 | 0 | Konto, Sperre, Lese-Modus (`.p-say`) |
| Überschrift | Geist | 22–24 px | 600 | 0 | Kopf in Einstellungen und Handbuch (`.p-sheet`), Onboarding |

Für die Typografie gilt:

- Grundschrift ist wieder Geist (seit 0.40.18, `--sans`), Mono bleibt Geist
  Mono. Melange lässt sich unter Einstellungen › Labor › Kopf › Schrift
  zurückholen (`html[data-font="melange"]`). Tray und Observer setzen fest
  Geist.
- Melange ist kommerziell (kimera, Freigabe für den internen Gebrauch) und
  liegt nicht in diesem Repo. Der Build holt die woff2-Schnitte 100, 300, 400,
  400 kursiv, 500, 600 und 700 aus dem privaten Repo `lr-practice/archiver`
  (`fonts/melange/`) nach `app/src/fonts/melange/` und
  `extension/fonts/melange/` (beide in `.gitignore`). Fehlen sie, springt
  Geist ein. Text-Karten und Bildbeschriftungen der Extension behalten ihre
  eigenen Stapel.
- Die Grundschrift läuft mit Standard-Laufweite (`letter-spacing: 0`), auch in
  Köpfen und Sätzen. Nur Geist Mono in Versalien bekommt +0.02em, die
  Notiz-Blätter in Systemschrift behalten ihre eigenen Werte.
- Mono ist für Daten und Etiketten da, nicht für Fließtext.
- Gewichte sind nur 400, 500 und 600.
- Neue Größen werden auf diese Stufen gerundet. Im Code stecken heute auch
  10, 14, 16 und 19 px. Diese Größen werden bei Gelegenheit auf die Stufen
  gezogen und nicht neu eingeführt.

### 2.3 Form und Raum

| Token | Wert | Zweck |
|---|---|---|
| `--r-lg` / `--r-md` / `--r-sm` | 8 / 6 / 5 px | Karten, Menüs, kleine Flächen |
| Rundung „Eckig“ / „Weich“ / „Rund“ / „Sehr rund“ | `--r-lg` 0 / 4 / 8 / 14 px (`data-radius`) | Einstellung, keine weiteren Stufen. Gilt seit 0.30 auch in Tray, Zonenleiste und Extension (über die Bibliothek gemeldet). Ab Werk „Weich“ (0.40.4, vorher „Rund“); neue Entwürfe werden mit „Weich“ gestaltet (4 / 3 / 3 px) |
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
Safari nutzt denselben Code und sieht gleich aus (4.27).

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
- **Angeschnitten (0.35, Einstellungen › Darstellung, ab Werk „Ganz“):** Wahlweise
  ragen die Karten erst 90 px herein (`.p-dropbar.strip`), wie früher die Leiste
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
  - Ecke `--r-md` überall (18.10., vorher eckig), folgt also der Rundung
    aus Einstellungen › Darstellung. Das gilt auch für Sperrbild (Feld und
    „Freischalten“) und die Felder im PDF-Ersteller.
- **Nicht:** Höchstens ein Primärknopf pro Dialog.

### 4.8a Rückfrage (`.dialog.confirm`)
- **Zweck:** Kleine Dialoge über der Fläche: Löschen, Installieren,
  Umbenennen. Dieselbe Form haben Importieren
  (`.dialog`), die Willkommen-Schritte (`.welcome-inner`), Schritt 3
  (`.onb-drop`) und die Tour-Karten (18.10., vorher gestrichelte, eckige
  Rahmen).
- **Form (18.10.):** Glas wie Menüs (2.4: `--menu-bg`, `--menu-shadow`,
  `blur(24px) saturate(1.4)`, hell `blur(28px) saturate(0)`), Ecke `--r-lg`,
  Knöpfe `--r-md`. Beide folgen der Rundung aus Einstellungen › Darstellung.
  Eingabefelder haben 20 px Luft zu den Knöpfen.
- **Nicht:** Keine feste Rundung und keine Pillen-Knöpfe (bis 0.40.1 waren es
  14 px und 999 px, Lukas 18.10.: „rundungen passen nicht mit den
  einstellungen“).

### 4.9 Menü (`.p-more-menu`)
- **Zweck:** Kontextmenüs, ≡-Menü und Zonenwahl.
- **Form:** `--menu-bg`, `--menu-shadow`, `--r-md`. Zonen erscheinen als
  Kästchen in zwei Spalten.
- **≡-Menü (18.10.):** hängt bündig an der Kante der Navigation, ist aber so
  breit wie sein Inhalt (mindestens 240 px, höchstens 360 px) und richtet sich
  nicht nach der Breite der Leiste.

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
  Datum. Zwei Formen, Einstellungen › Darstellung „Bildtext in der Lightbox“:
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
- **Zweck:** Per Kürzel (Standard ⌥ Space, Einstellungen › Mac & Browser) über
  jedem Programm Zonen und Objekte holen, etwa in einen InDesign-Rahmen.
- **Form:** 860 × 620 px, macOS-Glas, Suchfeld 17 px oben. Grund `--pal-bg`
  (Dunkel rgb 28 × `--win-alpha` 0.72, Hell rgb 244 × 0.78) ist seit 0.28 auch
  der Standard des App-Fensters und folgt seit 0.30 dem Glas-Regler (2.1). Hell/Dunkel und Ecken folgen Einstellungen › Darstellung;
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
  dieselben vier Glaskarten, Ring und Glühen wie 4.3. Rand 10 px zu den
  Bildschirmkanten, 8 px zwischen den Karten (18.10., vorher 14 und 10),
  gleich in der App (4.3) und der Extension.
- **Streifen (0.32, 90 px seit 0.32.1 / 3.25.2):** Beim Ziehen ragen die
  Karten erst nur 90 px herein (`.strip`): dieselbe Karte, oben gerundet, unten
  bündig, ohne Hinweis. Darüber
  bleibt alles frei, etwa das Eingabefeld eines Chats. Fährt der Zeiger in den
  Streifen, wird das Fenster mit macOS-Animation 280 px hoch; steht er mehr
  als 24 px darüber, wird es wieder Streifen. Die Extension im Browser zeigt
  seit 3.29.7 keinen Streifen mehr: Ihre Leiste steht beim Ziehen gleich in
  voller Höhe (`overlay.css` `.zones-bar`, 30vh, höchstens 260 px), mit Hinweis
  unten auf der Karte. Die Leiste der Extension hat
  seit 3.25.2 genau die Karten der Leiste in der App (4.3, `.p-hot`): Glas mit
  Unschärfe und Schatten, Nummer oben, Name in der Mitte, Ziel mit
  gestricheltem Ring (`--ring-lg`, 3 px) statt Outline. Sie nimmt
  den Zeiger an (3.25.1), damit Chrome am unteren Rand die Seite nicht
  darunter wegscrollt; Text- und Instagram-Ziehen nutzen dieselbe Leiste. Die Karten
  am ganzen Mac haben keine eigene Unschärfe (das Fenster ist durchsichtig),
  deshalb gilt dort nur `--zone-alpha`.
- **Ablauf (0.31.0):** Nach dem Loslassen zeigt das Ziel „Wird gesichert …“
  (`.busy`, kein Glühen). Erst wenn Import oder Verschieben fertig ist, kommt
  „Gesichert in …“ mit Glühen (`.landed`). Scheitert es, steht „Nicht
  gesichert: …“ in `--danger` (`.failed`, kein Glühen) 2.5 s lang, dann
  blendet die Leiste aus. Die Leiste bleibt so lange stehen (`dropbar_hold`).
- **Ab Werk aus (0.32.1):** Einschalten unter Einstellungen › Mac & Browser. Erst die
  eigene Wahl zählt (`dropbarChosen`); ein `dropbar: true` aus älteren
  Versionen ohne Wahl gilt als aus. Im Browser übernimmt die Extension.
- **Nicht:** Erscheint nicht, wenn Archiver selbst vorne ist, und nicht bei
  Text oder Links ohne Datei. Zeigt nie „Gesichert“, bevor es gesichert ist.
  Im Browser (Extension 3.29.5) erscheint sie nur, wenn das Ziehen auf der
  Seite beginnt, nicht bei Dateien von außen. Regler, Links und kleine
  Bedienelemente über Bildern und Videos bleiben Bedienelemente.

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
  oder Mindestversion ändern. Einstellungen › Mac & Browser zeigt den Stand,
  am Mac darunter eine Zeile für Safari (4.27).
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
  aktive Bibliothek ist gefüllt (ink × 0.1 / schwarz × 0.08). Steht
  `min(30vh, 260px) + 22px` über dem unteren Rand, also gleich über der
  vollen Leiste (3.29.7, vorher erst über dem Streifen).
- **Ablauf:** Zeiger auf einen Namen → Ring aus 4.1 (`--ring-md`, rx 9, 3 px
  Abstand). Nach 0.4 s Verweilen wechselt die Bibliothek, die Karten bleiben
  stehen und tauschen nur ihre Namen. ⇧ springt weiter zur nächsten (dragover liest nur
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

### 4.22a Updates (App 0.38.1, seit 0.40.8 Einstellungen › App)
- **Zweck:** Kanal wählen (Beta oder Vorab) und jede veröffentlichte Version
  installieren, auch eine ältere.
- **Form:** Block „Version“ (Installiert, rechts Nummer und „Nach Updates
  suchen“), darunter der Block „Updates“. Kanal als `p-choice` (wie alle
  Schalter), „Version wählen“ mit `p-link` rechts; die Liste darunter sind
  normale Blockzeilen (Version, Datum gedimmt, rechts „Installieren“ oder
  gedimmt „installiert“). Vor dem Installieren ein `dialog confirm`, bei
  älteren Versionen mit Hinweis, dass Späteres dort fehlt.
- **Sichtbar:** nur mit Vorab-Kanal oder nach ⌥-Klick auf die Versionsnummer.
- **Kürzel:** ⌘I öffnet Information.

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

### 4.24c Labor › Kopf (App 0.40.18, `html[data-head]`)
- **Wozu:** Vierzehn Mechaniken für den Seitenkopf zum Ausprobieren, nur auf
  diesem Mac (`archiver.lab`). Ab Werk 05 (Satz im Fluss) in M, Titel Voll, Satz Hell.
- **Varianten:** 01 Geist-Original (24 px, 600, Satz klein daneben), 02 Plakat
  (7.2vw, 600, zwei Zeilen), 03 Kontaktbogen (3vw, 500), 04 Regular L (4vw,
  400, +0.01em), 05 Satz im Fluss, 06 Satz als Mono-Etikett über dem Titel,
  07 Zeile mit Linie, 08 zweispaltig, 09 großer leichter Satz unter kleinem
  Titel, 10 Wortreihe aller Zonen, 11 Schnitt 300 mit „·“, 12 kein Kopf (eine
  Zeile 14 px), 13 Pfad hell, Ort voll, 14 hochkant an der linken Kante.
- **Stellschrauben:** Größe S / M / L / XL (`--hk` 0.8 / 1 / 1.25 / 1.5),
  Farbe von Titel und Satz je Voll, Grau, Hell oder Blau (`--head-title`,
  `--head-text`), Schrift Geist oder Melange.

### 4.24a Übersicht mit Kontaktbogen, ein Kopf für alle Seiten (App 0.40.11, `.p-sheetlist`, `.p-home-hero`)
- **Kopf (alle Seiten):** Übersicht, Zone, Alle Objekte, Suche und Zuletzt
  gelöscht tragen denselben Kopf. Titel in voller Farbe, darunter auf eigener
  Zeile der Satz in `--p-dim`. Regular (400), Zeilenhöhe 1.1, Laufweite 0,
  höchstens 20em breit. Größe M 28–42 px (3vw), nur die Übersicht
  eine Stufe größer: L 34–56 px (4vw). Oben 24–72 px (6vh), unten 40–96 px
  (9vh) Raum. In der Übersicht ohne Punkt und ohne „seit …“. Ordnerkarten
  einer Zone stehen rechts oben neben dem Kopf.
- **Übersicht:** Oben immer die vier Active Zones als Karten (2:1, vierspaltig
  ab 200 px Kartenbreite, sonst 2 × 2). Darunter „Index (N)“ und die übrigen
  Zonen als Kontaktbogen.
- **Kontaktbogen:** Je übrige Zone eine Zeile als Karte (`.p-card`, gleiche
  Fläche wie die Active Zones, 10 px Abstand). Die Zeile ist ein einziges
  Klickziel: Klick öffnet die Zone, Ziehen tauscht mit einer Active Zone,
  Fokus legt den Ring um die ganze Zeile. Einzelne Bilder sind nicht
  anklickbar. Die Zeile nutzt das Raster der Active Zones: Name und
  Mono-Anzahl in Spalte 1, die Bilder beginnen genau auf der linken Kante der
  zweiten Active-Karte. Bilder in Höhe der Zeilen-Miniatur (mind. 40 px),
  13:10, 4 px Abstand, Rundung `--r-sm`, höchstens 24, danach „+N“ in Mono.
- **Ansichten der Startseite:** Übersicht, Karten, Index. Die geteilte
  Vorschau-Ansicht (Liste links, Mosaik rechts) ist seit 0.40.11 entfernt.
- **Fokus:** Ring (4.1) um die ganze Zeile, keine Farbe.
- **Schmal (< 700 px):** Name über den Bildern, eine Spalte.

### 4.24b Labor (App 0.40.12, Einstellungen › Labor, `.p-lab-*`)
- **Zweck:** Varianten ausprobieren, bevor sie Regel werden. Gespeichert nur
  lokal (`archiver.lab`), an der Bibliothek ändert sich nichts.
- **Active-Zone-Karte A–H:** A Heute (1 groß, 2 klein), B Skim (Zeiger
  waagerecht durch bis zu 12 Bilder, unten Striche), C Streifen (5 Bilder),
  D Kontaktbogen (8 × 4, „+N“), E Stapel (3 Bilder, fächern beim Hover auf),
  F Aufklappen (Titelbild rutscht 34 % hoch, 6 Bilder darunter), G Lauf
  (Überblendung alle 2,6 s, Anzahl unten rechts), H Blättern (seitlich
  scrollen, Pfeile beim Hover). Eine Zone mit nur einem Bild bleibt A.
- **Video-Vorschau:** Daumenkino (Standard, 8 Standbilder), Skim (Zeiger
  waagerecht = Zeit im Clip), Abspielen (stumm, Schleife), Aus.
- **Bewegung:** Bei `prefers-reduced-motion` laufen G, Daumenkino und
  Abspielen nicht. Skim bleibt, weil es der Hand folgt.
- **Regel:** Eine Variante, die bleibt, wandert aus dem Labor in die normale
  Darstellung und bekommt hier ihren eigenen Abschnitt.

### 4.25a Einstellungen (App 0.40.8, `.p-settings-nav`)
- **Aufbau:** Seitenkopf, darunter die Konto-Liste (4.26), darunter fünf
  Bereiche als ruhige Liste: Bibliothek, Darstellung, Mac & Browser (ohne Mac
  nur „Extension“), Studio, App, Labor (4.24b). Rechts je eine Zusammenfassung in
  `--p-dim` und ›.
- **Bereiche:** Bibliothek = Plätze, verknüpfte Ordner, Standardzone,
  Struktur, Zonen, Dateinamen. Darstellung = Ansicht, Aussehen, Glas, Start,
  Startton. Mac & Browser = Extension, Tray und Zonenleiste, Vorschau-Formate.
  App = Version und Updates (4.22a), Sprache, Feedback, Tasten.
- **Regel:** Ein neuer Schalter kommt in einen dieser Bereiche, nicht in
  einen neuen. Jeder Block trägt seinen Titel, auch wenn er allein steht.

### 4.26 Konto, Sperre und Lese-Modus als Liste (App 0.40.6, `.p-say`, `.p-list`, `.p-lock-*`)
- **Ansatz (Lukas 20.10.: „3 aber ohne Highlight“):** Wie die Einstellungen.
  Ein Satz als Überschrift, darunter eine Mono-Zeile und gruppierte Zeilen auf
  einer Fläche. Keine farbigen Highlights mehr (das `.p-hl` aus 0.40.4 ist
  entfernt).
- **Satz (`.p-say`):** 34 px, Zeilenhöhe 1.14, 500, Laufweite 0, `balance`, der
  Rest in `--p-dim`. 34 px, kleiner als der Seitenkopf, kein Titelblatt.
  Auf der Webseite entspricht das 40 px.
- **Mono-Zeile (`.p-group-label`):** 11 px Mono, Versalien, `--p-dim`, links
  der Name in Klammern, rechts ein Zusatz.
- **Liste (`.p-list`):** Fläche ink × 0.045, `--r-lg`, Innenabstand
  2 / 16 px. Zeilen 12 px hoch gepolstert mit Linie `--p-rule`, Schlüssel
  132 px in `--p-dim`, Wert, Zusatz in `--p-faint`. Als Knopf Hover ink × 0.07.
- **Sperre (Anmelden, 0.40.9, Variante B „Satz“):** Eine Spalte von höchstens
  640 px in der Mitte. Satz (`.p-say`) „Dein Archiv. Melde dich mit deiner
  E-Mail an.“, 28 px Abstand, dann eine Linie (`.p-lock-line`, Unterkante
  ink × 0.22, im Fokus × 0.5, bei Fehler `--danger`): das Feld in Satzgröße
  (34 px, 500, Laufweite 0), rechts ein runder Pfeil 44 px (Pille, ink auf
  `--ink-inverse`). Darunter 14 px Abstand und eine Mono-Zeile 11 px: Hinweis
  „(Wir schicken einen Code, kein Passwort)“ bzw. „(Neuer Code) (Andere
  E-Mail)“, rechts die Meldung. Schritt Code: Satz „Code aus der Mail.
  Gesendet an …“, Ziffern mit 0.06em Laufweite, 6 bis 8 Ziffern. Keine
  Fläche, keine Zeilen „Weg“ und „Beta“. In der Vorschau steht oben rechts
  „(Vorschau beenden)“. Den alten Freischalt-Code gibt es nicht mehr zum
  Eingeben; wer ihn schon hat, bleibt frei (Übergang, `archiver.unlock`) und
  sieht unter Konto „(Beta-Code)“ mit „Anmelden“. Abmelden vergisst Konto und
  alten Code.
- **Konto (Einstellungen):** Oben über der Liste der Bereiche: „(Konto)“ und
  eine Liste als Knopf mit Status und Danach (Abonnent: Läuft bis). Öffnet
  Einstellungen › Konto. Dort ist der Kopf ein Satz zum Zustand (Beta-Bonus,
  „Jahr, aktiv.“ oder „Kein Abo.“).
- **Vorschau (0.40.5):** Einstellungen › Konto › Ansicht wählt zwischen Beta,
  Abonnent, Lese-Modus und Anmelden (zeigt die Sperre auch freigeschaltet, oben
  rechts „(Vorschau beenden)“), `archiver.accountPreview`. Es wird nichts
  gebucht. „Abmelden“ vergisst den Freischalt-Code.
- **Lese-Modus (Vorschau):** Auf der Startseite statt des Kopfs der Satz
  „Lese-Modus.“ und eine Liste Lesen, Suchen, Ablegen, Extension mit ● und ○.
  In der Filterzeile steht „(Vorschau beenden)“. Es wird nichts gesperrt.
- **Nicht:** Keine Highlights, keine Eingabekästen mit Rahmen, keine großen
  Titelblätter.

### 4.27 Safari-Extension (in Arbeit, `safari/`, `http_bridge.rs`)
- **Zweck:** Dieselbe Extension in Safari am Mac. Sie steckt als
  App-Erweiterung in Archiver.app (`Contents/PlugIns`) und wird nur in Safari
  eingeschaltet, nicht geladen.
- **Form:** Kein eigener Look. Overlay, Galerie, Zonenleiste, Toasts und
  Panels sind die aus `extension/`, Byte für Byte. Was in Chrome gilt, gilt
  hier (4.17, 4.18, 4.20).
- **Unterschiede:** Ohne laufende App versucht die Extension, Archiver zu
  starten. Klappt das nicht, kommt ein Toast („Archiver läuft nicht …“) statt
  eines Sicherns in Downloads. ⇧ nach Downloads gibt es nicht (Toast). Die
  Linkkarte hat kein Seitenarchiv (Safari kennt kein pageCapture). Links auf
  `chrome://`-Seiten im Panel tun in Safari nichts.
- **App:** Einstellungen › Mac & Browser › Extension zeigt unter dem
  Chrome-Stand eine Zeile in `.p-block-text`: „Safari: Extension verbunden“
  oder der Weg zum Einschalten (Safari › Einstellungen › Erweiterungen, ohne
  Apple-Signatur vorher Entwickler › „Unsignierte Erweiterungen erlauben“).
  Kein neuer Block, kein Knopf.
- **Nicht:** Keine Safari-eigenen Farben, Icons oder Abstände. Was nur in
  Safari anders sein muss, regelt `background.js` (`IS_SAFARI`), nie CSS.

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
- [ ] Hervorhebungen laufen über den Ring (4.1) und nicht über Farbe. Es gibt
      keine farbigen Highlights im Text (4.26).
- [ ] Entwürfe und neue Flächen sind mit der Rundung „Weich“ gestaltet.
- [ ] Wenn die Komponente auch in der Extension vorkommt, ist sie dort gleich
      oder als Abweichung in Abschnitt 5 notiert.
- [ ] `prefers-reduced-motion` wird respektiert.
- [ ] Diese Datei ist nachgezogen, wenn sich ein Wert oder eine Regel geändert
      hat.
