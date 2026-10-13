// app.js — Oberfläche der Archiver-App (Vanilla JS, kein Build-Schritt).
//
// Aufbau: Startseite mit allen Zonen (Index, Vorschau oder Karten), darunter
// die Zonenansicht, „Alle Bilder“, Suche, Einstellungen und Info. Unten
// schwebt die Navigation mit dem Pfad; „Archiver“ ganz links ist Home.
//
// Daten kommen aus Rust (lib.rs): snapshot() liefert Zonen und Einträge, die
// Ereignisse "library-changed" und "thumbs-ready" halten die Ansicht aktuell.
//
// Ziehen läuft immer nativ (Drag-Plugin): Bilder lassen sich so direkt in den
// Finder, nach Figma oder InDesign ziehen. Landet der Drag wieder im eigenen
// Fenster, meldet Tauri die Dateipfade plus Position. Liegt die Position über
// einer Zone (Zeile, Karte oder Leiste beim Ziehen), wird verschoben (Datei aus der Bibliothek) bzw.
// importiert (Datei von außerhalb).

(function () {
  const { t, lang } = window.ArchiverI18n;
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
  const fileSrc = (path) => TAURI.core.convertFileSrc(path);

  const isMac = /Mac/.test(navigator.userAgent);
  document.documentElement.classList.toggle("mac", isMac);
  // Im echten Vollbild fehlen die Fensterknöpfe, die Titelzeile rückt nach links.
  if (isMac && TAURI.window && TAURI.window.getCurrentWindow) {
    const win = TAURI.window.getCurrentWindow();
    let pending = 0;
    const syncFullscreen = () =>
      Promise.resolve()
        .then(() => win.isFullscreen())
        .then((on) => document.documentElement.classList.toggle("fullscreen", on))
        .catch(() => {});
    addEventListener("resize", () => {
      clearTimeout(pending);
      pending = setTimeout(syncFullscreen, 150);
    });
    syncFullscreen();
  }
  document.documentElement.lang = lang;

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    const b = el("button", className, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // ---- Einstellungen pro Gerät (nur Komfort, darf fehlen) ----

  // Eckenrundung vor dem ersten Zeichnen setzen (Einstellungen › Anzeige)
  function applyRadius(id) {
    if (id && id !== "round") document.documentElement.dataset.radius = id;
    else delete document.documentElement.dataset.radius;
  }

  // Oben beim Scrollen: Inhalt läuft unter der Leiste aus, als Verlauf (Standard) oder Glas
  function applyTopFade(id) {
    document.documentElement.dataset.topfade = id === "glass" ? "glass" : "fade";
  }

  // Auswahl: ruhige gestrichelte Outline oder eine, die langsam um das Objekt läuft
  // Fensterhintergrund (Mac): --win-alpha deckt die macOS-Unschärfe. Den Wert setzt
  // seit 0.30 der Glas-Regler (i18n.js applyGlass), Standard wie der Tray.
  function applyWinAlpha() {
    document.documentElement.dataset.winalpha = "on";
  }

  function applyFocusAnim(on) {
    if (on) document.documentElement.dataset.focusanim = "on";
    else delete document.documentElement.dataset.focusanim;
  }

  function pref(key, fallback) {
    try {
      const v = localStorage.getItem("archiver." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function setPref(key, value) {
    try {
      localStorage.setItem("archiver." + key, JSON.stringify(value));
    } catch {}
  }

  // Studio-Funktionen (Einstellungen › Studio): jede einzeln abschaltbar, Standard an.
  // Die geteilte Bibliothek ist kein Schalter hier, sie hängt an der Bibliothek selbst.
  // Schaltbare Studio-Werkzeuge. Moodboard und eigene Reihenfolge sind seit 0.24.6 immer an.
  const FEATURES = ["rights", "package"]; // „notes“ (Feld Notiz) ist seit 0.30 Teil des Bildtexts
  function feat(id) {
    if (!FEATURES.includes(id)) return true;
    return pref("feat." + id, true) !== false;
  }

  // ---- Freischalten: ein gemeinsamer Code, nur sein Hash steht im Code ----

  // Gültige Codes (nur Hashes): der aktuelle und der bisherige, damit niemand gesperrt wird
  const UNLOCK_HASHES = ["12004fa6495855edcff5595961e8da1e62e9eed6502338060283a8bb0efa5646", "4ffbc1224a6cd30617b443e4665695d19c63d76ba51f6b16bdcdc8b28a2d1e13"];

  function isUnlocked() {
    return UNLOCK_HASHES.includes(pref("unlock", null));
  }

  async function unlockHash(code) {
    const clean = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const data = new TextEncoder().encode("archiver-unlock:" + clean);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function applyLock() {
    const locked = !isUnlocked();
    document.body.classList.toggle("locked", locked);
    $("lock").hidden = !locked;
    if (locked && !$("lockForm").firstChild) {
      $("lockForm").appendChild(unlockForm());
      setTimeout(() => $("lockForm").querySelector("input")?.focus(), 60);
    }
  }

  // ---- Zustand ----

  const SIZES = [72, 96, 120, 160, 220, 300];
  const ALL = "\u0000all";
  const DELETED = "\u0000deleted"; // „Zuletzt gelöscht“ (0.27)
  const isZone = (f) => f != null && !String(f).startsWith("\u0000");
  // Startseite: Vorschaubilder im Index, Spalten im Mosaik, Titelbild der Karten
  const HOME_SIZES = [
    { thumb: 26, cols: 6, cover: 120 },
    { thumb: 40, cols: 4, cover: 170 },
    { thumb: 64, cols: 3, cover: 240 },
    { thumb: 96, cols: 2, cover: 320 },
  ]; // state.focus für „Alle Bilder“

  applyRadius(pref("radius", "round"));
  applyTopFade(pref("topFade", "fade"));
  applyFocusAnim(pref("focusAnim", false));
  applyWinAlpha();

  const state = {
    root: "",
    name: "",
    zones: [], // nur die angezeigten Zonen, in Anzeige-Reihenfolge
    items: [],
    byPath: new Map(),
    // Pfad der allein gezeigten Zone, sonst null (alte Seiten-Werte "\u0000…" verwerfen)
    focus: null, // jeder Start beginnt auf der Startseite (Zonen als Karten)
    page: null, // Seite, die von rechts hereingleitet: null | "settings" | "about" | "manual"
    home: "overview", // Startseite: "overview" | "index" | "preview" | "cards"; jeder Start beginnt mit der Übersicht
    hover: null, // Zone in der Vorschau (Layout "preview")
    // Bildgröße auf der Startseite, Stufe 0–3, je Ansicht getrennt
    homeSizes: pref("homeSizes", null) || { index: pref("homeSize", 1), preview: pref("homeSize", 1), cards: pref("homeSize", 1) },
    // (Übersicht: Größe wie die Karten, solange nichts eigenes gespeichert ist)
    query: "",
    filters: { kind: null, color: null, orient: null, format: null, period: null, dup: false, label: null, site: null, by: null, fresh: false },
    found: null, // Seite „Finden“: Treffer nach Rangfolge, null ohne Suche und Filter
    view: pref("view", "grid"),
    size: pref("size", 120),
    infoOpen: pref("infoOpen", false),
    selection: new Set(),
    anchor: null,
    lead: null, // bewegliches Ende einer Shift-Auswahl
    lists: new Map(), // Zone → sichtbare Einträge (nach Suche)
    lightbox: null, // { zone, index }
    order: {}, // Zone → Hashes in eigener Reihenfolge (zones.json, Schlüssel "sort")
    shared: false, // geteilte Bibliothek (studio.rs)
    user: "", // Name für „abgelegt von“
    folder: null, // Filter in der offenen Zone (Chips), null = alle
    level: null, // betretener Ordner (Karten, Pfad), null = oberste Ebene der Zone
  };

  // ---- Helfer ----

  // Kürzel wie „JP“: kurze Eingaben bleiben, wie sie sind, sonst Anfangsbuchstaben
  function byInitials(name) {
    const v = String(name).trim();
    return v.length <= 3 && !/\s/.test(v) ? v.toUpperCase() : monogram(v);
  }

  function monogram(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return String(name || "?").slice(0, 2).toUpperCase();
  }

  function zoneLabel(path) {
    if (path === "") return state.name;
    return path.split("/").join(" / ");
  }

  // Liegt das Objekt tiefer als seine Zone (bestehende Ordner): der Rest des Pfads
  function subfolderOf(item) {
    const dir = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    return item.zone && dir.startsWith(item.zone + "/") ? dir.slice(item.zone.length + 1) : "";
  }

  function lastSegment(path) {
    return path === "" ? state.name : path.split("/").pop();
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatDate(ms) {
    if (!ms) return "–";
    return new Date(ms).toLocaleString(lang === "de" ? "de-DE" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  const Media = window.ArchiverMedia;
  const kindOf = (item) => Media.kind(item.format || item.filename);

  // PDF und Video ohne Vorschaubild: Platzhalter mit dem Format statt der Datei
  function thumbSrc(item) {
    if (item.thumb) return fileSrc(item.thumb);
    if (kindOf(item) === "audio") return Media.audioPlaceholder();
    if (kindOf(item) !== "image") return Media.placeholder(item.format.toUpperCase());
    return fileSrc(item.abs);
  }

  // Quelle öffnen. Bei Textkarten springt der Browser zur zitierten Stelle und
  // markiert sie (Text-Fragment #:~:text=Anfang,Ende; Chrome, Safari, Edge).
  function sourceUrl(item) {
    const url = item.pageUrl;
    const quote = (item.quote || "").replace(/\s+/g, " ").trim();
    if (!url || !quote || /#:~:/.test(url)) return url;
    const enc = (t) => encodeURIComponent(t).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
    const words = quote.split(" ");
    const frag = words.length <= 10 ? enc(quote) : enc(words.slice(0, 5).join(" ")) + "," + enc(words.slice(-5).join(" "));
    return url.replace(/#.*$/, "") + "#:~:text=" + frag;
  }

  // Textkarte: der gespeicherte Text. Ältere Karten (vor 0.9.0) haben ihn
  // nur als Bild; dann aus der Texterkennung („TEXT … domain · Datum“).
  function quoteOf(item) {
    if (item.quote) return item.quote;
    if (isNote(item)) return " "; // leere Notiz bleibt ein Blatt
    if (item.width !== 1400 || item.imageUrl || !item.text || item.format !== "png") return "";
    const m = /^TEXT\s+([\s\S]+?)(?:\s+(?:[\w.-]+\.[a-z]{2,}\s+·\s+)?[\d./-]+)?\s*$/i.exec(item.text.trim());
    return m ? m[1].trim() : "";
  }

  // Naive Grundfarben (Rot, Grün, Violett, Cyan, Gelb), Schrift Ton in Ton.
  // Die Farbe hängt am Hash: dieselbe Karte bleibt immer gleich.
  // Farben der Textkarten: Hintergrund, Schrift Ton in Ton, Deckkraft für Kennung und Fuß.
  // Gleiche Werte in der Extension (content.js CARD_TONES).
  const QUOTE_TONES = {
    red: ["#ff0000", "#5c0000", 0.7],
    green: ["#00b050", "#003d1c", 0.7],
    violet: ["#7030a0", "#e2c8f5", 0.75],
    cyan: ["#00b0f0", "#003d54", 0.7],
    yellow: ["#ffff00", "#5c5c00", 0.75],
    white: ["#ffffff", "#141414", 0.5],
    black: ["#141414", "#ededed", 0.5],
  };
  // 0.30: eine Farbreihe für Textkarten und Notizen, aus den bestehenden Farben
  const TONES = ["red", "green", "violet", "cyan", "yellow", "white", "black"];
  const RANDOM_TONES = ["red", "green", "violet", "cyan", "yellow"];
  // Eigene Farbe (beim Markieren im Web bestimmt oder in den Details gewählt),
  // sonst fest aus dem Inhalt abgeleitet
  function quoteTone(item) {
    if (QUOTE_TONES[item.tone]) return QUOTE_TONES[item.tone];
    if (isNote(item)) return QUOTE_TONES.white; // Notizen: Weiß, bis eine Farbe gewählt ist
    const key = String(item.hash || item.path || "");
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return QUOTE_TONES[RANDOM_TONES[h % RANDOM_TONES.length]];
  }
  function toneKey(item) {
    if (QUOTE_TONES[item.tone]) return item.tone;
    if (isNote(item)) return "white";
    return RANDOM_TONES.find((k) => QUOTE_TONES[k] === quoteTone(item));
  }

  // Textkarte als Text statt Bild: Kennung, Zitat, Quelle und Datum
  function textSheet(item, cls) {
    if (isNote(item)) return noteSheet(item, cls);
    const len = quoteOf(item).length;
    const sheet = el("div", cls + (len < 140 ? " short" : len < 400 ? " medium" : " long"));
    const [bg, fg, dim] = quoteTone(item);
    sheet.style.setProperty("--ts-bg", bg);
    sheet.style.setProperty("--ts-fg", fg);
    sheet.style.setProperty("--ts-dim", dim);
    sheet.appendChild(el("div", "ts-label", "TEXT"));
    sheet.appendChild(el("div", "ts-body", quoteOf(item)));
    const date = new Date(item.capturedAt || item.addedAt || 0).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB");
    sheet.appendChild(el("div", "ts-foot", [domainOf(item.pageUrl), item.capturedAt || item.addedAt ? date : ""].filter(Boolean).join("  ·  ")));
    return sheet;
  }

  // Kleines Etikett auf der Karte: „12 S.“, „▶ 1:23“ bzw. „♪ 3:12“
  function mediaLabel(item) {
    const k = kindOf(item);
    if (k === "pdf") return item.pages ? t("pdfPages", { n: item.pages }) : "PDF";
    if (k === "video") return "▶ " + (Media.duration(item.duration) || item.format.toUpperCase());
    if (k === "audio") return "♪ " + (Media.duration(item.duration) || item.format.toUpperCase());
    return "";
  }

  // Audio: Titel, Interpret, Album und Format als Zeilen [Bezeichnung, Wert]
  function audioRows(item) {
    if (kindOf(item) !== "audio") return [];
    return [
      [t("trackTitle"), item.title],
      [t("artist"), item.artist],
      [t("album"), item.album],
      [t("audioFormat"), Media.audioFormat(item.sampleRate, item.bitDepth, item.channels)],
    ].filter(([, v]) => v);
  }

  function toast(text, ok = true, ms = 2600) {
    const node = el("div", "toast" + (ok ? "" : " error"), text);
    $("toasts").appendChild(node);
    requestAnimationFrame(() => node.classList.add("visible"));
    setTimeout(() => {
      node.classList.remove("visible");
      setTimeout(() => node.remove(), 250);
    }, ms);
  }

  function fail(e) {
    const msg = String(e && e.message ? e.message : e);
    toast(t("error", { msg }), false);
    invoke("log_error", { area: "app", msg }).catch(() => {});
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // ---- Laden ----

  // Leere Elternordner (z. B. "Kunden", wenn nur "Kunden/Studio B" Bilder hat)
  // bekommen keine eigene Kachel.
  function displayZones(zones) {
    return zones.filter((z) => z.count > 0 || !zones.some((o) => o.path.startsWith(z.path + "/")));
  }

  // Eigene Reihenfolge der Zonen (Einstellungen › Zonen). Neue Zonen hinten.
  // Der Betrachter liest denselben Eintrag.
  function orderZones(zones) {
    const order = pref("zoneOrder", []);
    if (!order.length) return zones;
    // Zone, die früher in Unterzonen geteilt war: Platz ihrer ersten Unterzone
    const rank = (z) => {
      let i = order.indexOf(z.path);
      if (i < 0 && z.path) i = order.findIndex((p) => p.startsWith(z.path + "/"));
      return i < 0 ? order.length : i;
    };
    return zones.map((z, i) => [z, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([z]) => z);
  }

  function setZoneOrder(paths) {
    setPref("zoneOrder", paths);
    state.zones = orderZones(state.zones);
    syncZoneOrder();
  }

  // Hot Zones: die ersten vier Zonen der Reihenfolge (Übersicht oben). Sie
  // erscheinen beim Ziehen in der App und in der Extension; die Bibliothek
  // merkt sie sich, damit die Extension dieselben zeigt.
  const HOT_ZONES = 4;
  let syncedOrder = "";
  function syncZoneOrder() {
    const order = state.zones.map((z) => z.path);
    const key = JSON.stringify(order);
    if (!state.root || key === syncedOrder) return;
    syncedOrder = key;
    invoke("set_zone_order", { order, hot: order.slice(0, HOT_ZONES) }).catch(() => (syncedOrder = ""));
  }

  function renameInOrder(oldPath, newPath) {
    const order = pref("zoneOrder", []);
    if (!order.length) return;
    setPref(
      "zoneOrder",
      order.map((p) => (p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p))
    );
  }

  async function refresh() {
    let snap;
    try {
      snap = await invoke("snapshot");
    } catch (e) {
      return fail(e);
    }
    state.root = snap.root;
    state.name = snap.name;
    state.zones = orderZones(displayZones(snap.zones));
    syncZoneOrder();
    state.items = snap.items;
    state.byPath = new Map(snap.items.map((i) => [i.path, i]));
    state.order = snap.order || {};
    state.shared = !!snap.shared;
    state.defaultZone = snap.defaultZone || "Unsorted";
    state.structure = snap.structure || { depth: 2, skip: [], subzones: false };
    state.user = snap.user || "";
    state.folders = snap.folders || [];
    state.deletedCount = snap.deleted || 0;
    if (state.focus === DELETED) state.deletedItems = await invoke("deleted_items").catch(() => []);
    if (isZone(state.focus) && !state.zones.some((z) => z.path === state.focus)) state.focus = null;
    for (const p of [...state.selection]) if (!state.byPath.has(p)) state.selection.delete(p);
    // Offenes Menü nicht unter der Maus wegzeichnen (z. B. während „Wirklich löschen?“)
    if (document.querySelector(".zone-menu")) pendingRender = true;
    else render();
  }

  let pendingRender = false;

  // ⌘R: Bibliothek neu einlesen
  async function reloadObjects() {
    await refresh();
  }

  function applyThumbs(list) {
    let media = false;
    const byHash = new Map(list.map((x) => [x.hash, x.thumb]));
    for (const item of state.items) {
      const thumb = byHash.get(item.hash);
      if (!thumb) continue;
      item.thumb = thumb;
      const card = cardCache.get(item.path);
      if (card) card.querySelector("img").src = fileSrc(thumb);
      // PDF/Video: Seitenzahl, Dauer und Maße stehen erst jetzt in der Datenbank
      if (kindOf(item) !== "image") media = true;
    }
    if (media) refreshSoon();
    // Startseite zeigt Vorschaubilder außerhalb des Caches: einmal neu zeichnen
    if (document.body.classList.contains("at-home")) rerenderHome();
  }

  const refreshSoon = debounce(() => refresh(), 600);

  const rerenderHome = debounce(() => {
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;
    if (document.querySelector(".zone-menu")) return void (pendingRender = true);
    renderZones();
  }, 300);

  // ---- Darstellung ----

  const cardCache = new Map(); // Pfad → Bild-Element (bleibt beim Neuzeichnen erhalten)

  // Suche: Dateiname, Quelle, Zone, dazu Bildinhalt, Text im Bild und Farben
  // (Analyse im Hintergrund, lib.rs). Deutsche Begriffe werden mitübersetzt.
  const SEARCH_DE = {
    rot: "red", orange: "orange", gelb: "yellow", grün: "green", gruen: "green", türkis: "teal", blau: "blue",
    lila: "purple", violett: "purple", rosa: "pink", pink: "pink", braun: "brown", schwarz: "black", grau: "gray",
    weiß: "white", weiss: "white", mensch: "people", menschen: "people", person: "people", personen: "people",
    frau: "woman", mann: "man", kind: "child", gesicht: "face", porträt: "portrait", portrait: "portrait",
    tier: "animal", hund: "dog", katze: "cat", vogel: "bird", pferd: "horse", fisch: "fish",
    pflanze: "plant", blume: "flower", blumen: "flower", baum: "tree", wald: "forest", gras: "grass",
    himmel: "sky", wolke: "cloud", wolken: "cloud", wasser: "water", meer: "ocean", see: "lake", strand: "beach",
    berg: "mountain", berge: "mountain", landschaft: "landscape", natur: "nature", schnee: "snow", sonne: "sun",
    stadt: "city", straße: "street", strasse: "street", gebäude: "building", haus: "house", architektur: "architecture",
    innenraum: "interior", raum: "room", zimmer: "room", küche: "kitchen", möbel: "furniture", stuhl: "chair",
    tisch: "table", sofa: "sofa", lampe: "lamp", licht: "light", fenster: "window", tür: "door", treppe: "stairs",
    auto: "car", fahrzeug: "vehicle", fahrrad: "bicycle", flugzeug: "airplane", boot: "boat", schiff: "ship",
    essen: "food", getränk: "drink", obst: "fruit", gemüse: "vegetable", brot: "bread", kaffee: "coffee",
    kleidung: "clothing", mode: "fashion", schuh: "shoe", schuhe: "shoe", tasche: "bag", hut: "hat",
    buch: "book", bücher: "book", papier: "paper", zeitschrift: "magazine", plakat: "poster", poster: "poster",
    schrift: "text", typografie: "typography", text: "text", dokument: "document", zeichnung: "drawing",
    illustration: "illustration", gemälde: "painting", malerei: "painting", kunst: "art", skulptur: "sculpture",
    foto: "photo", muster: "pattern", textur: "texture", logo: "logo", bildschirm: "screen", computer: "computer",
    telefon: "phone", uhr: "clock", musik: "music", instrument: "instrument", sport: "sport", nacht: "night",
    erwachsener: "adult", leute: "people", gruppe: "group", hand: "hand", hände: "hand", auge: "eye", haar: "hair",
    körper: "body", tanz: "dance", bühne: "stage", konzert: "concert", kamera: "camera", film: "film",
    draußen: "outdoor", aussen: "outdoor", außen: "outdoor", drinnen: "indoor", innen: "indoor", büro: "office",
    wohnzimmer: "living room", schlafzimmer: "bedroom", bad: "bathroom", badezimmer: "bathroom", bett: "bed",
    regal: "shelf", teppich: "rug", vorhang: "curtain", spiegel: "mirror", vase: "vase", keramik: "ceramic",
    holz: "wood", stein: "stone", beton: "concrete", metall: "metal", glas: "glass", stoff: "textile",
    textil: "textile", leder: "leather", ziegel: "brick", marmor: "marble", wand: "wall", boden: "floor",
    decke: "ceiling", dach: "roof", brücke: "bridge", turm: "tower", kirche: "church", fassade: "facade",
    garten: "garden", park: "park", feld: "field", wüste: "desert", fluss: "river", insel: "island",
    küste: "coast", hügel: "hill", felsen: "rock", sand: "sand", eis: "ice", feuer: "fire", rauch: "smoke",
    sonnenuntergang: "sunset", mond: "moon", stern: "star", regen: "rain", nebel: "fog",
    blatt: "leaf", blätter: "leaf", kaktus: "cactus", palme: "palm tree", frucht: "fruit", wein: "wine",
    flasche: "bottle", tasse: "cup", teller: "plate", besteck: "cutlery", kuchen: "cake", pizza: "pizza",
    schild: "sign", grafik: "graphic", diagramm: "diagram", karte: "map", landkarte: "map", tabelle: "chart",
    form: "shape", kreis: "circle", linie: "line", streifen: "stripes", punkt: "dot", punkte: "polka dots",
    raster: "grid", geometrie: "geometric", abstrakt: "abstract", collage: "collage", skizze: "sketch",
    bildschirmfoto: "screenshot", website: "website", verpackung: "packaging", etikett: "label", flyer: "flyer",
    broschüre: "brochure", magazin: "magazine", zeitung: "newspaper", cover: "cover", album: "album",
    möbelstück: "furniture", sessel: "armchair", leuchte: "lamp", kerze: "candle", schmuck: "jewelry",
    uhrwerk: "watch", brille: "glasses", kleid: "dress", jacke: "jacket", hemd: "shirt", hose: "pants",
    zug: "train", bahn: "train", bus: "bus", motorrad: "motorcycle", lkw: "truck", straßenbahn: "tram",
    vogelperspektive: "aerial", luftbild: "aerial", schwarzweiß: "monochrome", monochrom: "monochrome",
    struktur: "structure", konstruktion: "structure", wohnraum: "interior room", ausstellung: "exhibition",
    galerie: "gallery", museum: "museum", produkt: "product", werkzeug: "tool", spielzeug: "toy",
  };

  // Rückweg Englisch → Deutsch für die Motiv-Chips (erster deutscher Begriff gewinnt)
  const LABEL_DE = {};
  for (const [de, en] of Object.entries(SEARCH_DE)) if (!LABEL_DE[en]) LABEL_DE[en] = de;
  Object.assign(LABEL_DE, { "interior room": "innenraum", adult: "erwachsene", people: "menschen", outdoor: "draußen", indoor: "drinnen" });
  const COLOR_NAMES = new Set(["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "black", "gray", "white"]);
  const COLOR_SHARE = 0.12; // ab diesem Anteil zählt eine Farbe für Suche und Filter

  const tokens = (text) => String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const stem = (name) => String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "");

  // Suchindex pro Objekt, wird bei neuen Analyse-Ergebnissen verworfen
  function searchIndex(item) {
    if (item._idx) return item._idx;
    const colors = new Map();
    for (const part of String(item.colors || "").split(" ")) {
      const [name, share] = part.split(":");
      if (name) colors.set(name, Number(share) || 0);
    }
    item._idx = {
      name: tokens([stem(item.filename), item.pageTitle, item.title, item.artist, item.album].join(" ")),
      zone: tokens(item.zone),
      site: tokens(domainOf(item.pageUrl) + " " + domainOf(item.imageUrl)),
      labels: String(item.labels || "").toLowerCase().split(",").map((l) => l.trim()).filter(Boolean),
      text: tokens([item.text, item.quote, item.caption, feat("rights") ? item.credit : "", item.addedBy].join(" ")),
      colors,
    };
    return item._idx;
  }

  // Punkte für ein Suchwort: ganzes Wort zählt mehr als ein Wortanfang,
  // Titel mehr als Bildinhalt, Bildinhalt mehr als Text im Bild.
  function wordScore(idx, w) {
    const en = SEARCH_DE[w];
    const hit = (list, exact, prefix) =>
      list.some((x) => x === w || (en && x === en)) ? exact : prefix && w.length >= 3 && list.some((x) => x.startsWith(w)) ? prefix : 0;
    let best = Math.max(hit(idx.name, 6, 5), hit(idx.zone, 4, 3.5), hit(idx.site, 4, 3.5), hit(idx.text, 2, w.length >= 4 ? 1.5 : 0));
    idx.labels.forEach((label, i) => {
      const words = label.split(" ");
      const rank = Math.max(1, 4 - i * 0.25); // Apple sortiert nach Sicherheit
      if (label === w || label === en || words.includes(w) || (en && words.includes(en))) best = Math.max(best, rank);
      else if (w.length >= 4 && words.some((x) => x.startsWith(w))) best = Math.max(best, rank - 1);
    });
    const color = en && COLOR_NAMES.has(en) ? en : COLOR_NAMES.has(w) ? w : null;
    const share = color ? idx.colors.get(color) || 0 : 0;
    if (share >= COLOR_SHARE) best = Math.max(best, 2 + share * 4);
    return best;
  }

  // 0 = kein Treffer; jedes Wort muss irgendwo passen
  function searchScore(item, words) {
    if (!words.length) return 1;
    const idx = searchIndex(item);
    let total = 0;
    for (const w of words) {
      const score = wordScore(idx, w);
      if (!score) return 0;
      total += score;
    }
    return total;
  }

  function matches(item, words) {
    return searchScore(item, words) > 0;
  }

  // ---- Filter: Farbe, Ausrichtung, Format, Zeitraum, Doppelte ----

  const COLORS = [
    ["red", "#d9363e"], ["orange", "#f08a24"], ["yellow", "#f2c94c"], ["green", "#3f9b4f"],
    ["teal", "#2bb0a6"], ["blue", "#2d5aeb"], ["purple", "#7b4fd6"], ["pink", "#e66aa8"],
    ["brown", "#8a5a3b"], ["black", "#111111"], ["gray", "#8c8c8c"], ["white", "#f5f5f5"],
  ];
  const PERIODS = { week: 7, month: 30, year: 365 };

  // Seite „Finden“: „Alle Objekte“ oder eine laufende Suche
  function filtersShown() {
    return state.focus === ALL || !!state.query.trim();
  }

  function filtersActive() {
    const f = state.filters;
    return filtersShown() && !!(f.kind || f.color || f.orient || f.format || f.period || f.dup || f.label || f.site || f.by || f.fresh);
  }

  function orientation(item) {
    if (!item.width || !item.height) return null;
    const r = item.width / item.height;
    return r > 1.05 ? "landscape" : r < 0.95 ? "portrait" : "square";
  }

  function passesFilters(item, dupes) {
    const f = state.filters;
    if (f.kind && kindOf(item) !== f.kind) return false;
    if (f.color && !((searchIndex(item).colors.get(f.color) || 0) >= COLOR_SHARE)) return false;
    if (f.label && !searchIndex(item).labels.includes(f.label)) return false;
    if (f.site && domainOf(item.pageUrl) !== f.site) return false;
    if (f.orient && orientation(item) !== f.orient) return false;
    if (f.format && formatKey(item) !== f.format) return false;
    if (f.period && Date.now() - itemTime(item) > PERIODS[f.period] * 864e5) return false;
    if (f.dup && !dupes.has(item.hash)) return false;
    if (f.by && item.addedBy !== f.by) return false;
    if (f.fresh && !isFresh(item)) return false;
    return true;
  }

  // ---- Geteilte Bibliothek: „neu von anderen“ bis zum ersten Ansehen ----
  // Gesehen gilt ein Objekt, sobald man seine Zone wieder verlässt oder es groß öffnet.
  // Beim ersten Mal zählt alles Vorhandene als gesehen, damit nicht alles leuchtet.
  let seenHashes = null;
  function seenSet() {
    if (seenHashes) return seenHashes;
    const stored = pref("seenOthers", null);
    if (Array.isArray(stored)) seenHashes = new Set(stored);
    else {
      seenHashes = new Set(state.items.filter(byOther).map((i) => i.hash));
      setPref("seenOthers", [...seenHashes]);
    }
    return seenHashes;
  }

  function byOther(item) {
    return !!(item.addedBy && state.user && item.addedBy !== state.user);
  }

  function isFresh(item) {
    return state.shared && byOther(item) && !seenSet().has(item.hash);
  }

  function zoneHasFresh(path) {
    return state.shared && state.items.some((i) => i.zone === path && isFresh(i));
  }

  function markSeen(items) {
    const seen = seenSet();
    let changed = false;
    for (const i of items) {
      if (byOther(i) && !seen.has(i.hash)) {
        seen.add(i.hash);
        changed = true;
      }
    }
    if (changed) setPref("seenOthers", [...seen]);
  }

  function formatKey(item) {
    const f = String(item.format || "").toLowerCase();
    return f === "jpeg" ? "jpg" : f === "tif" ? "tiff" : f;
  }

  function duplicateHashes() {
    const seen = new Map();
    for (const item of state.items) seen.set(item.hash, (seen.get(item.hash) || 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([h]) => h));
  }

  function setFilter(key, value) {
    state.filters = { ...state.filters, [key]: state.filters[key] === value ? (key === "dup" ? false : null) : value };
    renderZones();
  }

  function filterRow() {
    const f = state.filters;
    const bar = el("div", "p-bar p-filters");
    bar.appendChild(mono("(" + t("filterTitle") + ")", "dim p-facet-title"));
    // Art zuerst: Bilder, Tracks, Video, PDF, Notizen
    for (const k of ["image", "audio", "video", "pdf", "note"])
      bar.appendChild(chip("(" + t("kind_" + k) + ")", f.kind === k, () => setFilter("kind", k)));
    bar.appendChild(el("span", "p-filter-gap"));
    const dots = el("span", "p-colors");
    for (const [name, hex] of COLORS) {
      const b = button("p-color" + (f.color === name ? " active" : ""), "", () => setFilter("color", name));
      b.style.setProperty("--dot", hex);
      b.title = t("color_" + name);
      dots.appendChild(b);
    }
    bar.appendChild(dots);
    bar.appendChild(el("span", "p-filter-gap"));
    for (const o of ["landscape", "portrait", "square"])
      bar.appendChild(chip("(" + t("orient_" + o) + ")", f.orient === o, () => setFilter("orient", o)));
    bar.appendChild(el("span", "p-filter-gap"));
    const formats = [...new Set(state.items.map(formatKey))].filter(Boolean).sort();
    for (const fmt of formats) bar.appendChild(chip("(" + fmt + ")", f.format === fmt, () => setFilter("format", fmt)));
    bar.appendChild(el("span", "p-filter-gap"));
    for (const p of Object.keys(PERIODS))
      bar.appendChild(chip("(" + t("period_" + p) + ")", f.period === p, () => setFilter("period", p)));
    bar.appendChild(el("span", "p-filter-gap"));
    bar.appendChild(chip("(" + t("filterDup") + ")", f.dup, () => setFilter("dup", true)));
    if (state.shared) {
      const fresh = state.items.filter(isFresh).length;
      if (fresh || f.fresh) {
        bar.appendChild(el("span", "p-filter-gap"));
        bar.appendChild(chip("(" + t("filterFresh") + " " + fresh + ")", f.fresh, () => setFilter("fresh", true)));
      }
    }
    if (filtersActive()) {
      bar.appendChild(el("span", "p-flex"));
      bar.appendChild(
        chip("(" + t("filterReset") + ")", false, () => {
          state.filters = { kind: null, color: null, orient: null, format: null, period: null, dup: false, label: null, site: null, by: null, fresh: false };
          renderZones();
        })
      );
    }
    return bar;
  }

  // Motive und Quellen: was in den aktuellen Treffern am häufigsten vorkommt
  function facetCounts(words) {
    const labels = new Map();
    const sites = new Map();
    for (const item of state.items) {
      if (!matches(item, words)) continue;
      searchIndex(item).labels.slice(0, 6).forEach((l) => labels.set(l, (labels.get(l) || 0) + 1));
      const site = domainOf(item.pageUrl);
      if (site) sites.set(site, (sites.get(site) || 0) + 1);
    }
    const top = (map, n) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
    return { labels: top(labels, 16), sites: top(sites, 10) };
  }

  function facetRow(title, entries, key, label) {
    const row = el("div", "p-bar p-facets");
    row.appendChild(mono("(" + t(title) + ")", "dim p-facet-title"));
    const chips = el("span", "p-facet-chips");
    const current = state.filters[key];
    if (current && !entries.some(([v]) => v === current)) entries = [[current, 0], ...entries];
    for (const [value, n] of entries) {
      const c = chip("(" + label(value) + (n ? " " + n : "") + ")", current === value, () => setFilter(key, value));
      chips.appendChild(c);
    }
    row.appendChild(chips);
    return row;
  }

  function filterBar() {
    const wrap = el("div", "p-find-facets");
    wrap.appendChild(filterRow());
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const { labels, sites } = facetCounts(words);
    const motif = (l) => (lang === "de" && LABEL_DE[l] ? LABEL_DE[l][0].toUpperCase() + LABEL_DE[l].slice(1) : l);
    if (labels.length || state.filters.label) wrap.appendChild(facetRow("facetMotif", labels, "label", motif));
    if (sites.length || state.filters.site) wrap.appendChild(facetRow("facetSource", sites, "site", (x) => x));
    // Geteilte Bibliothek: „Von: JP“, wer abgelegt hat
    if (state.shared) {
      const people = new Map();
      for (const item of state.items) if (item.addedBy && matches(item, words)) people.set(item.addedBy, (people.get(item.addedBy) || 0) + 1);
      if (people.size > 1 || state.filters.by) {
        const list = [...people].sort((a, b) => b[1] - a[1]);
        wrap.appendChild(facetRow("facetBy", list, "by", (x) => (x === state.user ? t("byMe") : byInitials(x))));
      }
    }
    return wrap;
  }

  // Analyse-Ergebnisse (Inhalt, Text, Farben) kommen nach und nach
  function applyAnalysis(list) {
    const byHash = new Map(list.map((a) => [a.hash, a]));
    for (const item of state.items) {
      const a = byHash.get(item.hash);
      if (!a) continue;
      item.labels = a.labels;
      item.text = a.text;
      item.colors = a.colors;
      item._idx = null;
    }
    if (state.query.trim() || filtersActive()) rerenderSearch();
  }

  const rerenderSearch = debounce(() => {
    if (document.querySelector(".zone-menu")) return void (pendingRender = true);
    renderZones();
  }, 800);

  // Während eines Zeichendurchgangs werden Objekte je Zone und „zuletzt
  // gesichert“ nur einmal ausgerechnet statt für jede Zeile neu über die ganze
  // Bibliothek (0.31.0). Außerhalb von render() rechnet alles frisch.
  let pass = null;
  function render() {
    pass = { byZone: null, saved: null };
    try {
      renderZones();
      renderToolbar();
      renderInfo();
      renderLibTab();
    } finally {
      pass = null;
    }
  }

  // Prototyp: keine Toolbar mehr. Die Navigation schwebt unten in der Mitte,
  // links Zonen (Startseite) bzw. „← Zonen“ in einer Zone, dann Suche und ⋯.
  function renderToolbar() {
    document.documentElement.style.setProperty("--thumb", state.size + "px");
    const main = $("navMain");
    const btns = [];
    const inZone = isZone(state.focus) && !state.query;
    // Zur Übersicht führt „Archiver“ links; in einer Zone folgt hier der Pfad.
    if (inZone) {
      const parts = state.focus.split("/");
      parts.forEach((part, i) => {
        if (i) btns.push(el("span", "p-nav-sep", "›"));
        const path = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        const exists = state.zones.some((z) => z.path === path);
        const b = last || !exists ? navButton(part, last) : navButton(part, false, () => setFocus(path));
        b.classList.add("p-nav-zone");
        if (!last && !exists) b.classList.add("dim");
        btns.push(b);
      });
    } else if (state.focus === DELETED && !state.query.trim()) {
      btns.push(navButton(t("navAll"), false, () => setFocus(ALL)));
      btns.push(el("span", "p-nav-sep", "›"));
      btns.push(navButton(t("deletedTitle"), true));
    } else {
      btns.push(navButton(t("navAll"), state.focus === ALL || !!state.query.trim(), () => setFocus(ALL)));
    }
    if (state.page) {
      btns.push(el("span", "p-nav-sep", "›"));
      btns.push(navButton(t(state.page), true, closePage));
    }
    main.replaceChildren(...btns);
    const searchOpen = !!state.query || document.activeElement === $("search");
    $("navSearch").classList.toggle("open", searchOpen);
    $("navMore").classList.toggle("active", !!document.querySelector(".p-more-menu"));
    $("navBrand").classList.toggle("active", state.focus == null && !state.query.trim() && !state.page);
  }

  // Hover in der Navigation: eine Fläche gleitet unter den Button unter der Maus.
  // „Archiver“ hat keinen Hover, nur den Aktiv-Zustand auf der Startseite.
  function setupNavGlide() {
    const nav = $("nav");
    const glide = el("span", "p-nav-glide");
    nav.prepend(glide);
    nav.classList.add("has-glide");
    let shown = false;
    const moveTo = (target) => {
      const n = nav.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      glide.classList.toggle("jump", !shown);
      glide.style.width = r.width + "px";
      glide.style.height = r.height + "px";
      glide.style.transform = `translate(${r.left - n.left}px, ${r.top - n.top}px)`;
      if (!shown) void glide.offsetWidth;
      glide.classList.remove("jump");
      glide.classList.add("on");
      shown = true;
    };
    const hide = () => {
      glide.classList.remove("on");
      shown = false;
    };
    nav.addEventListener("pointerover", (e) => {
      const target = e.target.closest(".p-nav-btn, .p-nav-search");
      if (!target || !nav.contains(target) || target.classList.contains("p-nav-brand") || target.tabIndex === -1) {
        if (!e.target.closest(".p-more-menu")) hide();
        return;
      }
      moveTo(target);
    });
    nav.addEventListener("pointerleave", hide);
  }

  function navButton(text, active, onClick) {
    const b = button("p-nav-btn" + (active ? " active" : ""), text, onClick);
    if (!onClick) b.tabIndex = -1;
    return b;
  }

  function recentDate(ms) {
    if (!ms) return "–";
    const d = new Date(ms);
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (ms >= start) return t("today");
    if (ms >= start - 864e5) return t("yesterday");
    const opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", opts);
  }

  function countText(n) {
    return n === 1 ? t("countImage") : t("countImages", { n });
  }

  function zonesText(n) {
    return n === 1 ? t("zoneCount1") : t("zonesCount", { n });
  }

  function itemTime(item) {
    return item.capturedAt || item.addedAt || 0;
  }

  // Meistgenutzte Quellen einer Zone („Meist von are.na und fontsinuse.com.“)
  function topDomains(items, max = 2) {
    const counts = new Map();
    for (const i of items) {
      const d = domainOf(i.pageUrl);
      if (d) counts.set(d, (counts.get(d) || 0) + 1);
    }
    const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([d]) => d);
    if (!list.length) return "";
    const and = lang === "de" ? " und " : " and ";
    return t("headSources", { list: list.join(and) });
  }

  function zoneItems(path) {
    if (!pass) return state.items.filter((i) => i.zone === path); // neueste zuerst (Reihenfolge aus Rust)
    if (!pass.byZone) {
      pass.byZone = new Map();
      for (const i of state.items) {
        const list = pass.byZone.get(i.zone);
        if (list) list.push(i);
        else pass.byZone.set(i.zone, [i]);
      }
    }
    return (pass.byZone.get(path) || []).slice();
  }

  // Für Übersichten (Karten-Cover, Index-Thumbs, Vorschau): in der eigenen Reihenfolge der Zone
  function orderedItems(path) {
    const list = zoneItems(path);
    return feat("order") ? applyItemOrder(path, list) : list;
  }

  // Ordnerpfad eines Objekts innerhalb seiner Zone ("" = direkt in der Zone)
  function subdirOf(item) {
    const d = item.path.slice(0, Math.max(0, item.path.lastIndexOf("/")));
    const z = item.zone || "";
    if (!z) return d;
    return d === z ? "" : d.startsWith(z + "/") ? d.slice(z.length + 1) : "";
  }

  // Liegt das Objekt im Ordner (samt Unterordnern)? "" = lose, direkt in der Zone
  function inFolder(item, folder) {
    if (folder == null) return true;
    const d = subdirOf(item);
    return folder === "" ? d === "" : d === folder || d.startsWith(folder + "/");
  }

  // Unterordner der Ebene `base`, in dem das Objekt liegt ("" = direkt auf dieser Ebene)
  function childFolder(item, base) {
    const d = subdirOf(item);
    const pre = base ? base + "/" : "";
    if (base && !d.startsWith(pre)) return "";
    const rest = d.slice(pre.length);
    return rest ? pre + rest.split("/")[0] : "";
  }

  function parentFolder(folder) {
    const i = folder ? folder.lastIndexOf("/") : -1;
    return i > 0 ? folder.slice(0, i) : null;
  }

  // Ordner einer Ebene mit Anzahl (samt Unterordnern). Oben in der Zone kommen
  // lose Dateien ("") zuletzt; im Ordner zählen nur seine eigenen Unterordner.
  function zoneFolders(items, base, zone) {
    const counts = new Map();
    for (const i of items) {
      if (base && !inFolder(i, base)) continue;
      const f = childFolder(i, base);
      counts.set(f, (counts.get(f) || 0) + 1);
    }
    // 0.27: auch leere Ordner (gerade angelegt) zeigen
    if (zone != null) {
      const pre = (zone ? zone + "/" : "") + (base ? base + "/" : "");
      for (const d of state.folders || []) {
        if (!d.startsWith(pre)) continue;
        const f = (base ? base + "/" : "") + d.slice(pre.length).split("/")[0];
        if (!counts.has(f)) counts.set(f, 0);
      }
    }
    const named = [...counts].filter(([f]) => f).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    return counts.has("") && !base ? [...named, ["", counts.get("")]] : named;
  }

  // Darstellung einer Zone mit Ordnern: "mosaic" (ein Raster) oder "sections", je Zone gemerkt
  function zoneLayout(path) {
    return (pref("zoneLayouts", {}) || {})[path] === "sections" ? "sections" : "mosaic";
  }

  function setZoneLayout(path, layout) {
    setPref("zoneLayouts", { ...(pref("zoneLayouts", {}) || {}), [path]: layout });
    renderZones();
  }

  // Ordner-Chips unter dem Zonentitel: (All 282) (Typefaces 165) (Loose 3).
  // Im Ordner: (Alle n) für diese Ebene, dahinter nur seine Unterordner.
  // 0.27: Chips filtern nur, die Ebene (Titel, Pfad, Karten) bleibt stehen.
  function folderChips(zone, folders, total) {
    const wrap = el("span", "p-folder-chips");
    const base = state.level || null;
    const pick = (f) => {
      state.folder = f;
      renderZones();
    };
    wrap.appendChild(chip("(" + t("folderAll") + " " + total + ")", state.folder == null || state.folder === base, () => pick(base)));
    for (const [f, n] of folders) wrap.appendChild(chip("(" + (f ? lastSegment(f) : t("folderLoose")) + " " + n + ")", state.folder === f, () => pick(f)));
    return wrap;
  }

  // Ordner betreten bzw. eine Ebene zurück (Esc, ⌘↑, Klick im Pfad)
  function openFolder(f) {
    state.level = f;
    state.folder = f;
    state.folderKbd = null;
    renderZones();
  }

  // Neuer Unterordner auf der aktuellen Ebene, auf Wunsch mit der Auswahl darin.
  // Er heißt erst „Neuer Ordner“ und lässt sich gleich umbenennen (wie im Finder).
  async function newFolder(withSelection) {
    if (!isZone(state.focus)) return;
    const parent = state.focus + (state.level ? "/" + state.level : "");
    const items = withSelection ? selectedItems() : [];
    try {
      const rel = await invoke("create_folder", { parent, name: t("newFolderName") });
      if (items.length) await invoke("move_items", { paths: items.map((i) => i.path), zone: rel, exact: true });
      await refresh();
      renameFolder(rel);
    } catch (e) {
      fail(e);
    }
  }

  function renameFolder(rel) {
    const card = [...document.querySelectorAll(".p-folder-card")].find((c) => c.dataset.zone === rel);
    const name = card && card.querySelector(".zone-card-name");
    if (!name) return;
    inlineInput(
      name,
      lastSegment(rel),
      async (value) => {
        try {
          const next = await invoke("rename_zone", { zone: rel, name: value });
          const inZone = (p) => p.slice(state.focus.length + 1);
          for (const key of ["level", "folder"]) if (state[key] === inZone(rel)) state[key] = inZone(next);
          await refresh();
        } catch (e) {
          fail(e);
          renderZones();
        }
      },
      renderZones
    );
  }

  function openZoneBackgroundMenu(x, y) {
    closeMenus();
    closeMoreMenu();
    const menu = el("div", "zone-menu p-ctx-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    const noteBtn = button("zone-menu-item", t("noteNew"), () => {
      closeMenus();
      newNote();
    });
    noteBtn.appendChild(el("span", "p-ctx-key", "⌘⇧N"));
    menu.appendChild(noteBtn);
    menu.appendChild(button("zone-menu-item", t("newFolder"), () => {
      closeMenus();
      newFolder(false);
    }));
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }

  function folderUp() {
    // Erst den Chip-Filter lösen, dann eine Ebene hoch
    if (state.folder != null && state.folder !== state.level) {
      state.folder = state.level;
      renderZones();
      return true;
    }
    if (state.level == null) return false;
    openFolder(parentFolder(state.level));
    return true;
  }

  // Ordner als Karten oben in der Zone: Vorschau, Name, Anzahl. Klick filtert wie die Chips.
  function folderCards(zone, folders, items) {
    const named = folders.filter(([f]) => f);
    const wrap = el("div", "p-cards p-cards-grid p-folder-cards");
    for (const [f, n] of named) {
      const idx = wrap.children.length;
      const card = el("article", "p-card p-folder-card" + (state.folder === f ? " active" : "") + (state.folderKbd === idx ? " kbd-focus" : ""));
      card.appendChild(cardCover(applyItemOrder(zone.path, items.filter((i) => inFolder(i, f)))));
      const body = el("div", "p-card-body");
      const text = el("div");
      text.appendChild(el("div", "zone-card-name", lastSegment(f)));
      text.appendChild(el("div", "p-card-meta", n === 1 ? t("countImage") : t("countImages", { n })));
      body.appendChild(text);
      card.appendChild(body);
      const rel = zone.path + "/" + f;
      // 0.28: ⋯ wie bei Zonen (Umbenennen, im Finder zeigen, löschen)
      const menuWrap = el("span", "zone-menu-wrap");
      menuWrap.appendChild(zoneMenuButton({ path: rel, count: n }, () => folderMenu(rel, n)));
      body.appendChild(menuWrap);
      card.addEventListener("click", (e) => {
        if (cardDragged || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
        openFolder(f);
      });
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenus();
        const menu = folderMenu(rel, n);
        menu.classList.add("p-ctx-menu");
        document.body.appendChild(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - r.width - 8)) + "px";
        menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - r.height - 8)) + "px";
      });
      // 0.28: Ordner auf einen anderen Ordner ziehen legt ihn hinein
      card.addEventListener("pointerdown", (e) => dragFolder(e, card));
      card.addEventListener("dragstart", (e) => e.preventDefault());
      card.dataset.folder = f;
      card.dataset.zone = rel; // Ablageziel beim Ziehen (0.27)
      wrap.appendChild(card);
    }
    return wrap;
  }

  // ⋯-Menü eines Unterordners: dieselben Einträge wie bei einer Zone
  function folderMenu(rel, count) {
    const menu = el("div", "zone-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    menu.appendChild(button("zone-menu-item", t("rename"), () => {
      closeMenus();
      renameFolder(rel);
    }));
    menu.appendChild(button("zone-menu-item", t("reveal"), () => {
      closeMenus();
      invoke("reveal_zone", { zone: rel }).catch(fail);
    }));
    const del = button("zone-menu-item danger", t("trashZone"));
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        del.textContent = t("trashZoneConfirm", { count: count === 1 ? t("countImage") : t("countImages", { n: count }) });
        del.classList.add("armed");
        return;
      }
      closeMenus();
      const inZone = rel.slice(state.focus.length + 1);
      for (const key of ["level", "folder"]) if (state[key] === inZone || (state[key] || "").startsWith(inZone + "/")) state[key] = parentFolder(inZone);
      trashZone({ path: rel, count });
    });
    menu.appendChild(del);
    return menu;
  }

  function dragFolder(e, card) {
    if (e.button !== 0 || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
    card.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let lifted = false;
    let target = null;
    const onMove = (ev) => {
      if (!lifted) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        lifted = true;
        card.classList.add("lifted");
        document.body.classList.add("sorting");
      }
      card.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
      target = null;
      for (const other of document.querySelectorAll(".p-folder-card")) {
        if (other === card) continue;
        const r = other.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) target = other;
      }
      for (const other of document.querySelectorAll(".p-folder-card")) other.classList.toggle("drop-target", other === target);
    };
    const onUp = async () => {
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      if (!lifted) return;
      cardDragged = true;
      setTimeout(() => (cardDragged = false), 0);
      document.body.classList.remove("sorting");
      card.classList.remove("lifted");
      card.style.transform = "";
      for (const n of document.querySelectorAll(".drop-target")) n.classList.remove("drop-target");
      if (!target) return;
      try {
        await invoke("move_folder", { from: card.dataset.zone, into: target.dataset.zone });
        await refresh();
        toast(t("folderMoved", { folder: lastSegment(card.dataset.zone), into: lastSegment(target.dataset.zone) }));
      } catch (err) {
        fail(err);
      }
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  }

  // Vorschaubild für Startseite und Karten; fehlt das Thumbnail noch, das Original nehmen.
  function previewImg(item) {
    if (quoteOf(item)) return textSheet(item, "text-sheet mini");
    const img = el("img");
    img.alt = "";
    img.decoding = "async";
    img.src = thumbSrc(item);
    img.onerror = () => {
      img.onerror = null;
      img.src = kindOf(item) === "image" ? fileSrc(item.abs) : Media.placeholder(item.format.toUpperCase());
    };
    return img;
  }

  function headline(title, sentence) {
    const h = el("h1", "p-head");
    if (title) h.appendChild(el("span", "p-head-title", title));
    if (sentence) h.appendChild(el("span", "p-head-text", (title ? " " : "") + sentence));
    return h;
  }

  function mono(text, className) {
    return el("span", "p-mono" + (className ? " " + className : ""), text);
  }

  function chip(text, active, onClick) {
    const b = button("p-chip" + (active ? " active" : ""), text, onClick);
    return b;
  }

  let lastViewKey = "";

  function renderZones() {
    document.body.classList.toggle("has-selection", state.selection.size > 0);
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const filtering = filtersActive();
    const dupes = state.filters.dup ? duplicateHashes() : null;
    state.lists = new Map(state.zones.map((z) => [z.path, []]));
    const found = [];
    for (const item of state.items) {
      const list = state.lists.get(item.zone);
      const score = list ? searchScore(item, words) : 0;
      if (score && (!filtering || passesFilters(item, dupes))) {
        list.push(item);
        found.push([score, itemTime(item) || 0, item]);
      }
    }
    // Eigene Reihenfolge je Zone (per Ziehen gesetzt); Neues ohne Platz steht vorn
    if (feat("order")) for (const [zone, list] of state.lists) applyItemOrder(zone, list);
    // Ordner der offenen Zone: Chip filtert, „Sections“ ordnet nach Ordnern
    if (isZone(state.focus) && !words.length && state.lists.has(state.focus)) {
      let list = state.lists.get(state.focus);
      if (state.folder != null) list = list.filter((i) => inFolder(i, state.folder));
      if (zoneLayout(state.focus) === "sections") {
        const base = state.folder || null;
        const rank = new Map(zoneFolders(list, base).map(([f], i) => [f, i]));
        const at = (item) => rank.get(childFolder(item, base)) ?? rank.size;
        list = list.map((item, i) => [item, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([item]) => item);
      }
      state.lists.set(state.focus, list);
    }
    // Finden: eine Liste nach Relevanz, bei gleicher Punktzahl das Neueste zuerst
    state.found = words.length || filtering ? found.sort((a, b) => b[0] - a[0] || b[1] - a[1]).map((x) => x[2]) : null;

    const grid = $("zones");
    const home = state.focus == null && !words.length && !filtering;
    document.body.classList.toggle("at-home", home);
    grid.classList.toggle("original", state.view === "original");
    const key = home ? "home:" + state.home : words.length || filtering ? "search" : "zone:" + state.focus;
    const scroll = key === lastViewKey ? grid.scrollTop : 0;
    lastViewKey = key;

    grid.replaceChildren(home ? renderHome() : state.focus === DELETED && !words.length && !filtering ? renderDeleted() : renderGallery(words.length > 0 || filtering));
    if (home) applyHomeCursor(false);
    layoutMasonry(true);
    grid.scrollTop = scroll;
    for (const path of [...cardCache.keys()]) if (!state.byPath.has(path)) cardCache.delete(path);
  }

  function applyItemOrder(zone, list) {
    const order = state.order && state.order[zone];
    if (!order || !order.length) return list;
    const pos = new Map(order.map((h, i) => [h, i]));
    const at = (item) => (pos.has(item.hash) ? pos.get(item.hash) : -1);
    return list.sort((a, b) => at(a) - at(b));
  }

  // Objekte in einer Zone umstellen: `moved` (Pfade) vor bzw. hinter `ref` (Pfad)
  async function reorderInZone(zone, moved, ref, after) {
    const list = (state.lists.get(zone) || []).slice();
    const movedSet = new Set(moved);
    const picked = list.filter((i) => movedSet.has(i.path));
    const rest = list.filter((i) => !movedSet.has(i.path));
    let at = rest.findIndex((i) => i.path === ref);
    if (at < 0) return;
    if (after) at++;
    rest.splice(at, 0, ...picked);
    const hashes = [];
    for (const i of rest) if (!hashes.includes(i.hash)) hashes.push(i.hash);
    state.order = { ...state.order, [zone]: hashes };
    renderZones();
    try {
      await invoke("set_item_order", { zone, hashes });
    } catch (e) {
      fail(e);
    }
  }

  // ---- Startseite: Index (D), Index mit Vorschau (E) oder Karten (F) ----

  function renderHome() {
    const wrap = el("div", "p-page p-home p-home-" + state.home);
    const first = state.items.length ? Math.min(...state.items.map(itemTime).filter(Boolean)) : 0;
    const since = first
      ? new Date(first).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { month: "long", year: "numeric" })
      : "";
    wrap.appendChild(
      headline(
        null,
        state.items.length
          ? t("headHome", { zones: zonesText(state.zones.length), images: countText(state.items.length), since })
          : t("headHomeEmpty")
      )
    );

    const bar = el("div", "p-bar");
    bar.appendChild(mono(t("allZonesLabel") + " (" + state.zones.length + ")", "strong"));
    bar.appendChild(el("span", "p-flex"));
    for (const [id, label] of [
      ["overview", "layoutOverview"],
      ["cards", "layoutCards"],
      ["preview", "layoutPreview"],
      ["index", "layoutIndex"],
    ]) {
      bar.appendChild(
        chip("(" + t(label) + ")", state.home === id, () => {
          state.home = id;
          renderZones();
        })
      );
    }
    bar.appendChild(sizeChips(homeStep(), HOME_SIZES.length, (step) => {
      state.homeSizes = { ...state.homeSizes, [state.home]: step };
      setPref("homeSizes", state.homeSizes);
      renderZones();
    }));
    wrap.appendChild(bar);
    wrap.style.setProperty("--row-thumb", HOME_SIZES[homeStep()].thumb + "px");
    wrap.style.setProperty("--mosaic-cols", String(HOME_SIZES[homeStep()].cols));
    wrap.style.setProperty("--cover", HOME_SIZES[homeStep()].cover + "px");

    if (state.home === "overview") wrap.appendChild(overviewLayout());
    else if (state.home === "cards") {
      // Active Zones stehen in jeder Ansicht oben, je nach Darstellung als Karten oder Zeilen
      wrap.appendChild(hotRow());
      wrap.appendChild(restBar(state.zones.length - HOT_ZONES));
      wrap.appendChild(cardsLayout());
    } else if (state.home === "preview") {
      const split = el("div", "p-split");
      const lists = el("div", "p-split-lists");
      lists.appendChild(hotLabel());
      lists.appendChild(hotList(true));
      lists.appendChild(restBar(state.zones.length - HOT_ZONES));
      lists.appendChild(indexList(true, state.zones.slice(HOT_ZONES), HOT_ZONES));
      split.appendChild(lists);
      split.appendChild(previewPanel());
      wrap.appendChild(split);
    } else {
      wrap.appendChild(hotLabel());
      wrap.appendChild(hotList(false));
      wrap.appendChild(restBar(state.zones.length - HOT_ZONES));
      wrap.appendChild(indexList(false, state.zones.slice(HOT_ZONES), HOT_ZONES));
    }
    return wrap;
  }

  // ---- Startseite per Tastatur: ← → wählen Zonen nacheinander, ↑ ↓ nach
  // Lage auf dem Bildschirm, Enter öffnet, Esc in der Zone kehrt zurück. ----

  function homeTargets() {
    const rank = new Map(state.zones.map((z, i) => [z.path, i]));
    return [...document.querySelectorAll(".p-home [data-zone]")]
      .filter((n) => rank.has(n.dataset.zone) && n.offsetParent)
      .sort((a, b) => rank.get(a.dataset.zone) - rank.get(b.dataset.zone));
  }

  function applyHomeCursor(scroll) {
    const targets = homeTargets();
    let current = null;
    for (const n of targets) {
      const on = !!state.homeKbd && n.dataset.zone === state.homeCursor;
      n.classList.toggle("kbd-focus", on);
      if (on) current = n;
    }
    if (current && scroll) current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function homeKey(e) {
    const targets = homeTargets();
    if (!targets.length) return false;
    const index = targets.findIndex((n) => n.dataset.zone === state.homeCursor);
    const active = state.homeKbd && index >= 0;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const d = e.key === "ArrowRight" ? 1 : -1;
      next = !active ? targets[d > 0 ? 0 : targets.length - 1] : targets[Math.max(0, Math.min(targets.length - 1, index + d))];
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!active) next = targets[0];
      else {
        // nächste Karte darunter bzw. darüber, bevorzugt in derselben Spalte
        const down = e.key === "ArrowDown";
        const r = targets[index].getBoundingClientRect();
        const cx = r.left + r.width / 2;
        let best = Infinity;
        for (const n of targets) {
          const o = n.getBoundingClientRect();
          const dy = down ? o.top - r.bottom : r.top - o.bottom;
          if (dy < -2) continue;
          if (n === targets[index]) continue;
          const score = dy + Math.abs(o.left + o.width / 2 - cx) * 3;
          if (score < best) {
            best = score;
            next = n;
          }
        }
        if (!next) next = targets[index];
      }
    } else if (e.key === "Enter" && active) {
      setFocus(state.homeCursor);
      return true;
    } else if (e.key === " " && active) {
      // Einblick: Lightbox mit den Bildern der gewählten Karte, ←→ blättert darin
      openLightbox((state.lists.get(state.homeCursor) || [])[0]);
      return true;
    } else if (e.key === "Backspace" || e.key === "Delete") {
      const hovered = document.querySelector(".p-home [data-zone]:hover");
      const path = active ? state.homeCursor : hovered?.dataset.zone;
      return path ? askTrashZone(path) : false;
    } else if (e.key === "Escape" && active) {
      state.homeKbd = false;
      applyHomeCursor(false);
      return true;
    } else return false;
    state.homeKbd = true;
    state.homeCursor = next.dataset.zone;
    applyHomeCursor(true);
    return true;
  }

  function homeStep() {
    const step = state.homeSizes[state.home] ?? (state.home === "overview" ? state.homeSizes.cards : undefined);
    return Number.isInteger(step) ? Math.max(0, Math.min(HOME_SIZES.length - 1, step)) : 1;
  }

  function indexList(compact, zones = state.zones, offset = 0, swap = offset > 0) {
    const list = el("div", "p-index" + (compact ? " compact" : ""));
    const head = el("div", "p-row p-row-head");
    head.appendChild(mono(t("colNo")));
    head.appendChild(mono(t("colZone")));
    head.appendChild(mono(t("colImages")));
    if (!compact) {
      head.appendChild(mono(t("colLast")));
      head.appendChild(mono(t("colPreview"), "right"));
    }
    head.appendChild(el("span"));
    list.appendChild(head);

    const current = compact ? previewZone() : null;
    zones.forEach((zone, i) => {
      const index = offset + i;
      const row = el("div", "p-row p-zone");
      row.dataset.zone = zone.path;
      if (swap) {
        // Übersicht: Zeile per Ziehen mit einer Hot Zone tauschen
        row.dataset.swap = zone.path;
        row.addEventListener("pointerdown", (e) => dragSwap(e, row));
      }
      if (compact && zone.path === current) row.classList.add("current");
      const no = mono(String(index + 1).padStart(2, "0"), "dim");
      if (index < HOT_ZONES) no.title = t("keyHint", { n: index + 1 });
      row.appendChild(no);
      const name = zoneNameEl(zone);
      row.appendChild(name);
      row.appendChild(el("span", "p-num", String(zone.count)));
      if (!compact) {
        row.appendChild(el("span", "p-num", recentDate(lastSaved(zone.path))));
        const thumbs = el("span", "p-thumbs");
        for (const item of orderedItems(zone.path).slice(0, 6)) {
          thumbs.appendChild(previewImg(item));
        }
        row.appendChild(thumbs);
      }
      const menuWrap = el("span", "zone-menu-wrap");
      menuWrap.appendChild(zoneMenuButton(zone));
      row.appendChild(menuWrap);

      row.addEventListener("click", (e) => {
        if (cardDragged || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
        setFocus(zone.path);
      });
      if (compact) {
        row.addEventListener("mouseenter", () => {
          if (state.hover === zone.path) return;
          state.hover = zone.path;
          for (const r of list.querySelectorAll(".p-zone")) r.classList.toggle("current", r === row);
          const old = document.querySelector(".p-preview");
          if (old) old.replaceWith(previewPanel());
        });
      }
      if (canEdit(zone.path)) {
        name.title = t("renameHint");
        name.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          startRename(name, zone.path);
        });
      }
      list.appendChild(row);
    });

    const add = el("div", "p-row p-new");
    add.appendChild(mono("+", "dim"));
    add.appendChild(el("span", "zone-card-name", t("newZone")));
    // leere Spalten wie in den Zonen-Zeilen, damit die Zeile gleich hoch ist
    add.appendChild(el("span", "p-num"));
    if (!compact) {
      add.appendChild(el("span", "p-num"));
      add.appendChild(el("span", "p-thumbs"));
    }
    add.appendChild(el("span"));
    add.addEventListener("click", startNewZone);
    list.appendChild(add);
    // Zuletzt gelöscht: letzte Zeile, nur wenn etwas darin liegt
    if (!compact && state.deletedCount) {
      const del = el("div", "p-row p-deleted-row");
      del.appendChild(mono("", "dim"));
      del.appendChild(el("span", "zone-card-name", t("deletedTitle")));
      del.appendChild(el("span", "p-num", String(state.deletedCount)));
      del.appendChild(el("span", "p-num", t("deletedRow", { days: DELETED_DAYS })));
      del.appendChild(el("span", "p-thumbs"));
      del.appendChild(el("span"));
      del.addEventListener("click", openDeleted);
      list.appendChild(del);
    }
    return list;
  }

  // ---- Übersicht: oben die vier Hot Zones als Karten, darunter der Index ----

  function hotList(compact) {
    const list = indexList(compact, state.zones.slice(0, HOT_ZONES), 0, true);
    list.querySelector(".p-new")?.remove();
    return list;
  }

  function hotLabel() {
    const label = el("div", "p-bar p-overview-bar p-hot-label");
    label.appendChild(mono(t("hotLabel") + " (" + Math.min(HOT_ZONES, state.zones.length) + ")", "strong"));
    label.appendChild(el("span", "p-flex"));
    label.appendChild(mono(t("hotHintRow"), "dim"));
    return label;
  }

  function restBar(n) {
    const label = el("div", "p-bar p-overview-bar");
    label.appendChild(mono(t("indexLabel") + " (" + Math.max(0, n) + ")", "strong"));
    return label;
  }

  // 0.28: Active Zones brechen wie der Index um; passen keine vier Karten, dann 2 × 2
  function hotRow() {
    const row = el("div", "p-hotrow");
    const width = $("zones").clientWidth - 80;
    row.style.setProperty("--hot-cols", Math.floor((width + 10) / 280) >= 4 ? "4" : "2");
    for (let i = 0; i < HOT_ZONES; i++) row.appendChild(state.zones[i] ? hotCard(state.zones[i], i) : hotSlot(i));
    return row;
  }

  function overviewLayout() {
    const wrap = el("div", "p-overview");
    wrap.appendChild(hotRow());
    const rest = state.zones.slice(HOT_ZONES);
    const label = el("div", "p-bar p-overview-bar");
    label.appendChild(mono(t("indexLabel") + " (" + rest.length + ")", "strong"));
    label.appendChild(el("span", "p-flex"));
    label.appendChild(mono(t("hotHint"), "dim"));
    wrap.appendChild(label);
    wrap.appendChild(indexList(false, rest, HOT_ZONES));
    return wrap;
  }

  function hotKey(i) {
    const key = el("div", "p-hot-key");
    key.appendChild(mono(String(i + 1).padStart(2, "0")));
    key.appendChild(mono(t("hotZone"), "dim"));
    return key;
  }

  function hotCard(zone, i) {
    const card = el("article", "p-card p-hot-card");
    card.dataset.zone = zone.path;
    card.dataset.swap = zone.path;
    card.title = t("keyHint", { n: i + 1 });
    const items = orderedItems(zone.path);
    const cover = el("div", "p-card-cover" + (items.length >= 3 ? " trio" : "") + (items.length ? "" : " empty"));
    for (const item of items.slice(0, items.length >= 3 ? 3 : 1)) cover.appendChild(previewImg(item));
    card.appendChild(cover);
    card.appendChild(hotKey(i));
    const body = el("div", "p-card-body");
    const text = el("div");
    const name = zoneNameEl(zone);
    text.appendChild(name);
    text.appendChild(el("div", "p-card-meta", cardMeta(zone)));
    body.appendChild(text);
    const menuWrap = el("span", "zone-menu-wrap");
    menuWrap.appendChild(zoneMenuButton(zone));
    body.appendChild(menuWrap);
    card.appendChild(body);
    card.addEventListener("click", (e) => {
      if (cardDragged || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
      setFocus(zone.path);
    });
    if (canEdit(zone.path)) {
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(name, zone.path);
      });
    }
    card.addEventListener("pointerdown", (e) => dragSwap(e, card));
    card.addEventListener("dragstart", (e) => e.preventDefault());
    return card;
  }

  // Freier Platz (weniger als vier Zonen): neue Zone anlegen
  function hotSlot(i) {
    const card = el("article", "p-card p-hot-card p-hot-free p-new");
    card.appendChild(el("div", "p-card-cover empty"));
    card.appendChild(hotKey(i));
    const body = el("div", "p-card-body");
    body.appendChild(el("div", "zone-card-name", "+ " + t("newZone")));
    card.appendChild(body);
    card.addEventListener("click", startNewZone);
    return card;
  }

  // Ziehen in der Übersicht: Karte oder Zeile auf eine andere legen, dann
  // tauschen beide ihren Platz. So wird eine Zone aus dem Index zur Hot Zone.
  function dragSwap(e, node) {
    if (e.button !== 0 || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
    const start = { x: e.clientX, y: e.clientY };
    let lifted = false;
    let target = null;
    let targetRect = null;
    let home = null;
    // Vorschau des Tauschs: die Zielkarte rückt schon an den Platz, der frei wird
    const preview = (n, on) => {
      if (!n) return;
      // Karte und Zeile haben verschiedene Formen: dann tritt das Ziel nur zurück
      if (n.classList.contains("p-row") !== node.classList.contains("p-row")) return void n.classList.toggle("swap-out", on);
      n.style.transition = "transform 0.22s cubic-bezier(.2,.7,.2,1)";
      if (!on) return void (n.style.transform = "");
      const r = n.getBoundingClientRect();
      const cur = new DOMMatrixReadOnly(getComputedStyle(n).transform);
      n.style.transform = `translate(${home.left - (r.left - cur.m41)}px, ${home.top - (r.top - cur.m42)}px)`;
    };
    const onMove = (ev) => {
      if (!lifted) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        lifted = true;
        home = node.getBoundingClientRect();
        node.classList.add("lifted");
        node.style.pointerEvents = "none";
        document.body.classList.add("sorting");
        window.getSelection().removeAllRanges();
      }
      ev.preventDefault();
      node.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
      // Das Ziel bleibt gewählt, solange der Zeiger über seinem alten Platz ist,
      // auch wenn es für die Vorschau schon weggerückt ist
      const inside = (r) => r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (target && inside(targetRect)) return;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const next = hit && hit.closest("[data-swap]");
      const found = next && next !== node && next !== target ? next : null;
      if (found === target) return;
      preview(target, false);
      target?.classList.remove("swap-target");
      target = found;
      targetRect = target ? target.getBoundingClientRect() : null;
      if (target) {
        target.classList.add("swap-target");
        preview(target, true);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!lifted) return;
      cardDragged = true;
      setTimeout(() => (cardDragged = false), 0);
      document.body.classList.remove("sorting");
      const from = new Map();
      if (target) {
        from.set(node.dataset.swap, node.getBoundingClientRect());
        from.set(target.dataset.swap, target.getBoundingClientRect());
      }
      node.classList.remove("lifted");
      node.style.transform = "";
      node.style.pointerEvents = "";
      for (const n of document.querySelectorAll(".swap-target, .swap-out")) n.classList.remove("swap-target", "swap-out");
      if (!target) return;
      const order = state.zones.map((z) => z.path);
      const a = order.indexOf(node.dataset.swap);
      const b = order.indexOf(target.dataset.swap);
      if (a < 0 || b < 0) return preview(target, false);
      [order[a], order[b]] = [order[b], order[a]];
      setZoneOrder(order);
      renderZones();
      // Beide gleiten von dort, wo man sie zuletzt gesehen hat, an ihren neuen Platz
      for (const [path, r] of from) {
        const n = [...document.querySelectorAll("[data-swap]")].find((x) => x.dataset.swap === path);
        if (!n) continue;
        const to = n.getBoundingClientRect();
        n.animate(
          [{ transform: `translate(${r.left - to.left}px, ${r.top - to.top}px)` }, { transform: "none" }],
          { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" }
        );
      }
      if (a < HOT_ZONES || b < HOT_ZONES) toast(t("hotSwapped", { zone: zoneLabel(order[Math.min(a, b)]) }));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }


  function previewZone() {
    if (state.hover && state.zones.some((z) => z.path === state.hover)) return state.hover;
    let best = state.zones[0];
    for (const z of state.zones) if (lastSaved(z.path) > lastSaved(best.path)) best = z;
    return best ? best.path : null;
  }

  function previewPanel() {
    const path = previewZone();
    const panel = el("section", "p-preview");
    if (path == null) return panel;
    panel.dataset.zone = path;
    const items = orderedItems(path);
    const head = el("div", "p-preview-head");
    const title = el("div", "p-preview-title");
    title.appendChild(document.createTextNode(lastSegment(path)));
    const latest = lastSaved(path);
    title.appendChild(
      el("span", "p-head-text", " · " + countText(items.length) + (latest ? " · " + t("lastSaved", { date: recentDate(latest) }) : ""))
    );
    head.appendChild(title);
    head.appendChild(button("p-link", t("openZoneArrow"), () => setFocus(path)));
    panel.appendChild(head);
    const mosaic = el("div", "p-mosaic" + (HOME_SIZES[homeStep()].cols < 4 ? " even" : ""));
    for (const item of items.slice(0, 9)) {
      const cell = el("div", "p-mosaic-cell");
      cell.appendChild(previewImg(item));
      cell.addEventListener("dblclick", () => openLightbox(item));
      mosaic.appendChild(cell);
    }
    if (!items.length) mosaic.appendChild(el("div", "p-empty", t("headZoneEmpty")));
    panel.appendChild(mosaic);
    return panel;
  }

  // Karten: Zonen ohne Unterzonen als Karte mit Titelbild, Unterzonen
  // (z. B. Kunden / Studio B) gesammelt in einer Karte als Liste.
  function cardsLayout() {
    const groups = new Map();
    for (const zone of state.zones.slice(HOT_ZONES)) {
      const top = zone.path === "" ? "" : zone.path.split("/")[0];
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(zone);
    }
    const cards = [];
    for (const [top, zones] of groups) {
      const card = zones.length === 1 && !zones[0].path.includes("/") ? zoneCardTile(zones[0]) : groupCard(top, zones);
      card.dataset.group = top;
      // eine einzelne Zone lässt sich auch mit einer Active Zone oben tauschen (0.27)
      if (zones.length === 1) card.dataset.single = card.dataset.swap = zones[0].path;
      card.addEventListener("pointerdown", (e) => dragCard(e, card, [...groups.keys()]));
      card.addEventListener("dragstart", (e) => e.preventDefault());
      cards.push(card);
    }
    // „+ Neue Zone“ im selben Format wie die übrigen Karten
    const add = el("article", "p-card p-new p-new-card");
    add.appendChild(el("div", "p-card-cover empty"));
    const addBody = el("div", "p-card-body");
    const addText = el("div");
    addText.appendChild(el("div", "zone-card-name", "+ " + t("newZone")));
    addText.appendChild(el("div", "p-card-meta", "\u00a0"));
    addBody.appendChild(addText);
    add.appendChild(addBody);
    add.addEventListener("click", startNewZone);
    cards.push(add);

    // Raster mit gleich hohen Karten je Reihe
    const width = $("zones").clientWidth - 80;
    const count = Math.max(1, Math.min(4, Math.floor((width + 10) / 280)));
    const wrap = el("div", "p-cards p-cards-grid");
    wrap.style.setProperty("--card-cols", String(count));
    for (const card of cards) wrap.appendChild(card);
    return wrap;
  }

  // Karten per Ziehen umsortieren. Die Karte wandert beim Ziehen mit; beim
  // Loslassen gilt die neue Reihenfolge (dieselbe wie in Einstellungen › Zonen).
  let cardDragged = false;

  function dragCard(e, card, order) {
    if (e.button !== 0 || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
    e.preventDefault();
    card.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let lifted = false;
    let target = null;
    let hot = null;
    let after = false;
    const onMove = (ev) => {
      if (!lifted) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        lifted = true;
        card.classList.add("lifted");
        document.body.classList.add("sorting");
      }
      card.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
      target = null;
      hot = null;
      if (card.dataset.single != null) {
        for (const other of document.querySelectorAll(".p-hotrow .p-hot-card[data-swap]")) {
          const r = other.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) hot = other;
        }
      }
      for (const other of document.querySelectorAll(".p-hotrow .p-hot-card[data-swap]")) other.classList.toggle("swap-target", other === hot);
      for (const other of document.querySelectorAll(".p-cards .p-card[data-group]")) {
        if (other === card) continue;
        const r = other.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          target = other;
          // Die gezogene Karte nimmt den Platz des Ziels ein: nach vorn davor, nach hinten dahinter
          after = order.indexOf(card.dataset.group) < order.indexOf(other.dataset.group);
        }
      }
      for (const other of document.querySelectorAll(".p-cards .p-card[data-group]")) {
        other.classList.toggle("drop-target", other === target);
      }
    };
    const onUp = () => {
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      if (!lifted) return;
      cardDragged = true;
      setTimeout(() => (cardDragged = false), 0);
      document.body.classList.remove("sorting");
      card.classList.remove("lifted");
      card.style.transform = "";
      for (const n of document.querySelectorAll(".drop-target, .swap-target")) n.classList.remove("drop-target", "swap-target");
      if (hot) {
        // Mit der Active Zone tauschen: die Zone rückt nach oben, die Active Zone an ihren Platz
        const zones = state.zones.map((z) => z.path);
        const a = zones.indexOf(card.dataset.single);
        const b = zones.indexOf(hot.dataset.swap);
        if (a < 0 || b < 0) return;
        [zones[a], zones[b]] = [zones[b], zones[a]];
        setZoneOrder(zones);
        renderZones();
        toast(t("hotSwapped", { zone: zoneLabel(zones[b]) }));
        return;
      }
      if (!target) return;
      const tops = order.filter((top) => top !== card.dataset.group);
      tops.splice(tops.indexOf(target.dataset.group) + (after ? 1 : 0), 0, card.dataset.group);
      const rank = new Map(tops.map((top, i) => [top, i]));
      const topOf = (path) => (path === "" ? "" : path.split("/")[0]);
      // Die Active Zones oben bleiben stehen, sortiert wird der Rest
      const paths = state.zones.slice(HOT_ZONES).map((z, i) => [z.path, i]);
      paths.sort((a, b) => rank.get(topOf(a[0])) - rank.get(topOf(b[0])) || a[1] - b[1]);
      setZoneOrder([...state.zones.slice(0, HOT_ZONES).map((z) => z.path), ...paths.map(([path]) => path)]);
      renderZones();
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  }

  function cardMeta(zone) {
    const latest = lastSaved(zone.path);
    const folders = zoneFolders(zoneItems(zone.path)).filter(([f]) => f).length;
    const inside = folders ? " · " + t(folders === 1 ? "folderCount1" : "folderCount", { n: folders }) : "";
    return zone.count ? countText(zone.count) + inside + (latest ? " · " + recentDate(latest) : "") : t("emptyShort");
  }

  function zoneCardTile(zone) {
    const card = el("article", "p-card");
    card.dataset.zone = zone.path;
    card.appendChild(cardCover(orderedItems(zone.path)));
    const body = el("div", "p-card-body");
    const text = el("div");
    const name = zoneNameEl(zone);
    text.appendChild(name);
    text.appendChild(el("div", "p-card-meta", cardMeta(zone)));
    body.appendChild(text);
    const menuWrap = el("span", "zone-menu-wrap");
    menuWrap.appendChild(zoneMenuButton(zone));
    body.appendChild(menuWrap);
    card.appendChild(body);
    card.addEventListener("click", (e) => {
      if (cardDragged || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
      setFocus(zone.path);
    });
    if (canEdit(zone.path)) {
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(name, zone.path);
      });
    }
    return card;
  }

  // Titelbild einer Karte: ein Bild oder drei, leer als ruhige Fläche
  function cardCover(items) {
    const cover = el("div", "p-card-cover" + (items.length >= 3 ? " trio" : "") + (items.length ? "" : " empty"));
    for (const item of items.slice(0, items.length >= 3 ? 3 : 1)) cover.appendChild(previewImg(item));
    return cover;
  }

  function groupCard(top, zones) {
    const card = el("article", "p-card p-card-group");
    const paths = new Set(zones.map((z) => z.path));
    card.appendChild(cardCover(state.items.filter((i) => paths.has(i.zone))));
    card.appendChild(el("div", "p-card-group-title", top));
    for (const zone of zones) {
      const row = el("div", "p-card-row");
      row.dataset.zone = zone.path;
      const text = el("div", "p-card-row-text");
      const name = el("div", "zone-card-name", zone.path === top ? top : zone.path.slice(top.length + 1).split("/").join(" / "));
      name.title = zoneLabel(zone.path);
      text.appendChild(name);
      text.appendChild(el("div", "p-card-meta", zone.count ? countText(zone.count) : t("emptyShort")));
      row.appendChild(text);
      const right = el("div", "p-card-row-right");
      right.appendChild(el("span", "p-card-meta", recentDate(lastSaved(zone.path)).replace("–", "")));
      const menuWrap = el("span", "zone-menu-wrap");
      menuWrap.appendChild(zoneMenuButton(zone));
      right.appendChild(menuWrap);
      row.appendChild(right);
      row.addEventListener("click", (e) => {
        if (cardDragged || e.target.closest(".zone-menu-btn, .zone-menu, input")) return;
        setFocus(zone.path);
      });
      if (canEdit(zone.path)) {
        name.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          startRename(name, zone.path);
        });
      }
      card.appendChild(row);
    }
    return card;
  }

  // ---- Einstellungen und Info: eigene Seiten im selben Raster ----

  // ---- Seiten (Einstellungen, Info): gleiten von rechts herein ----
  // Typografisch reduziert wie in der Extension: Blöcke mit grauem Titel,
  // Zeilen mit feinen Linien, links der Inhalt, rechts Wert oder Aktionen.

  function togglePage(name) {
    state.page = state.page === name ? null : name;
    state.settingsSub = null;
    renderPage();
  }

  function closePage() {
    previewDropbar(false);
    if (!state.page) return;
    state.page = null;
    renderPage();
  }

  function renderPage(keepScroll) {
    const sheet = $("sheet");
    const wasOpen = document.body.classList.contains("page-open");
    const top = sheet.scrollTop;
    if (state.page)
      sheet.replaceChildren(
        state.page === "settings" ? renderSettings() : state.page === "manual" ? renderManual() : renderAbout()
      );
    sheet.scrollTop = keepScroll ? top : 0;
    document.body.classList.toggle("page-open", !!state.page);
    renderToolbar();
    // Die Übersicht wird schmaler oder breiter: Karten-Spalten neu verteilen
    if (wasOpen !== !!state.page) setTimeout(() => renderZones(), 280);
  }

  function block(title) {
    const b = el("section", "p-block");
    if (title) b.appendChild(el("div", "p-block-title", title));
    return b;
  }

  function blockRow(main, side) {
    const row = el("div", "p-block-row");
    const left = el("div", "p-block-main");
    for (const node of [].concat(main)) left.appendChild(node instanceof Node ? node : el("div", null, node));
    row.appendChild(left);
    if (side != null) {
      const right = el("div", "p-block-side");
      for (const node of [].concat(side)) right.appendChild(node instanceof Node ? node : el("span", null, node));
      row.appendChild(right);
    }
    return row;
  }

  function choice(options, current, onPick) {
    const wrap = el("span", "p-choice");
    for (const [id, label] of options) wrap.appendChild(chip("(" + label + ")", current === id, () => onPick(id)));
    return wrap;
  }

  function shortPath(path) {
    return String(path || "").replace(/^\/(Users|home)\/[^/]+/, "~");
  }

  // Langer Pfad als eine Zeile: Anfang … die letzten Ordner, voller Pfad im Tooltip
  function pathEl(path, extra) {
    const full = shortPath(path);
    const parts = full.split("/");
    let text = full;
    if (full.length > 44 && parts.length > 4) {
      // Cloud-Ordner: „GoogleDrive-name@…/Meine Ablage“ wird zu „Google Drive“
      const cloud = full.match(/Library\/CloudStorage\/([A-Za-z]+)/);
      const head = cloud ? "~/" + cloud[1].replace(/([a-z])([A-Z])/g, "$1 $2") : parts[0];
      text = head + "/…/" + parts.slice(-2).join("/");
    }
    const span = el(extra ? "div" : "span", "p-path" + (extra ? " " + extra : ""), text);
    span.title = full;
    return span;
  }

  // Einklappbare Blöcke in den Einstellungen; der Zustand bleibt gemerkt.
  function collapsible(id, title) {
    return block(title);
  }

  // Ordnerstruktur: wie tief Unterordner eigene Zonen werden, welche Ordner Archiver überspringt
  function renderStructure() {
    const b = block(t("setStructure"));
    const st = state.structure || { depth: 2, skip: [], subzones: false };
    const save = async (next) => {
      try {
        await invoke("set_structure", { structure: { ...st, ...next } });
        await refresh();
      } catch (e) {
        fail(e);
      }
      renderPage(true);
    };
    const input = el("input", "p-skip-input");
    input.value = st.skip.join(", ");
    input.spellcheck = false;
    input.placeholder = "Links, Backup …";
    const commit = () => {
      const skip = input.value.split(",").map((x) => x.trim()).filter(Boolean);
      if (skip.join(",") !== st.skip.join(",")) save({ skip });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);
    b.appendChild(blockRow(t("setSkip"), input));
    b.appendChild(el("p", "p-block-hint", t("setStructureHint")));
    return b;
  }

  // Standard-Zone: wohin alles kommt, was ohne Ziel gesammelt wird (sonst Unsorted)
  function renderDefaultZone() {
    const b = block(t("setDefaultZone"));
    const select = el("select", "p-select");
    for (const z of state.zones.filter((z) => z.path !== "")) {
      const opt = el("option", null, zoneLabel(z.path));
      opt.value = z.path;
      if (z.path === state.defaultZone) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", async () => {
      try {
        await invoke("set_default_zone", { zone: select.value });
        await refresh();
        renderPage(true);
      } catch (e) {
        fail(e);
      }
    });
    b.appendChild(blockRow(t("setDefaultZoneLabel"), select));
    b.appendChild(el("p", "p-block-hint", t("setDefaultZoneHint")));
    return b;
  }

  // Zonen: umbenennen, neu anlegen (die ersten vier sind die Hot Zones, Tasten 1–4)
  // Einstellungen › Zonen: Zeile greifen und an neuen Platz schieben, die anderen rücken nach.
  // Die ersten vier sind die Active Zones.
  function dragZoneRow(e, row, list) {
    if (e.button !== 0 || e.target.closest("button, input")) return;
    const start = e.clientY;
    let lifted = false;
    const onMove = (ev) => {
      if (!lifted) {
        if (Math.abs(ev.clientY - start) < DRAG_THRESHOLD) return;
        lifted = true;
        row.classList.add("lifted");
        document.body.classList.add("sorting");
        window.getSelection().removeAllRanges();
      }
      ev.preventDefault();
      const rows = [...list.children].filter((r) => r !== row);
      const before = rows.find((r) => {
        const b = r.getBoundingClientRect();
        return ev.clientY < b.top + b.height / 2;
      });
      if (before !== row.nextSibling) {
        const old = new Map([...list.children].map((r) => [r, r.getBoundingClientRect().top]));
        list.insertBefore(row, before || null);
        // Nachrückende Zeilen gleiten an ihren Platz
        for (const r of list.children) {
          if (r === row) continue;
          const dy = old.get(r) - r.getBoundingClientRect().top;
          if (!dy) continue;
          r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 160, easing: "ease-out" });
        }
        [...list.children].forEach((r, i) => {
          const no = r.querySelector(".p-zone-main .p-mono");
          if (no) {
            no.textContent = String(i + 1).padStart(2, "0");
            no.classList.toggle("p-zone-hot", i < HOT_ZONES);
          }
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!lifted) return;
      document.body.classList.remove("sorting");
      row.classList.remove("lifted");
      // Der Klick nach dem Loslassen soll nicht umbenennen
      const swallow = (ev) => ev.stopPropagation();
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
            setZoneOrder([...list.children].map((r) => r.dataset.zone));
      renderZones();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function renderZoneSettings() {
    const b = collapsible("zones", t("setZones"));
    const list = el("div", "p-zone-list");
    state.zones.forEach((zone, i) => {
      const row = el("div", "p-block-row p-zone-row");
      row.dataset.zone = zone.path;
      const handle = mono(String(i + 1).padStart(2, "0"), "dim" + (i < HOT_ZONES ? " p-zone-hot" : ""));
      const name = el("span", "p-zone-name" + (canEdit(zone.path) ? " editable" : ""), zoneLabel(zone.path));
      if (canEdit(zone.path))
        name.addEventListener("click", () =>
          inlineInput(
            name,
            lastSegment(zone.path),
            async (value) => {
              try {
                const newPath = await invoke("rename_zone", { zone: zone.path, name: value });
                undoRename(zone.path, newPath);
                renameInOrder(zone.path, newPath);
                if (state.focus === zone.path) state.focus = newPath;
                await refresh();
              } catch (e) {
                fail(e);
              }
              renderPage(true);
            },
            () => renderPage(true)
          )
        );
      row.append(el("span", "p-zone-main"), el("span", "p-block-side"));
      row.firstChild.append(handle, name);
      // Löschen in zwei Schritten: erst fragen, dann in den Papierkorb
      const del = button("p-arrow p-zone-del", "✕");
      del.title = t("trashZone");
      if (!canEdit(zone.path)) del.style.visibility = "hidden";
      let armed = false;
      del.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          del.textContent = t("trashZoneConfirm", { count: zone.count === 1 ? t("countImage") : t("countImages", { n: zone.count }) });
          del.classList.add("armed");
          return;
        }
        try {
          await invoke("trash_zone", { zone: zone.path });
          if (state.focus === zone.path) state.focus = null;
          await refresh();
          toast(t("zoneTrashed", { zone: zoneLabel(zone.path) }));
        } catch (e) {
          fail(e);
        }
        renderPage(true);
      });
      del.addEventListener("blur", () => {
        if (!armed) return;
        armed = false;
        del.textContent = "✕";
        del.classList.remove("armed");
      });
      row.lastChild.append(del);
      row.addEventListener("pointerdown", (e) => dragZoneRow(e, row, list));
      list.appendChild(row);
    });
    b.appendChild(list);

    const add = button("p-link p-zone-add", t("zoneAdd"));
    add.addEventListener("click", () => {
      const slot = el("div", "p-zone-new");
      add.replaceWith(slot);
      inlineInput(
        slot,
        "",
        async (value) => {
          try {
            await invoke("create_zone", { name: value });
            await refresh();
          } catch (e) {
            fail(e);
          }
          renderPage(true);
        },
        () => renderPage(true)
      );
    });
    b.appendChild(add);
    b.appendChild(el("p", "p-block-hint", t("setZonesHint")));
    return b;
  }

  // Zeile am Griff ziehen: wandert live mit, beim Loslassen wird gespeichert
  // Einstellungen: oben eine ruhige Liste der Bereiche, jeder öffnet sein Untermenü.
  // Ganz unten steht immer der Freischalt-Code.
  // 0.28: Tray, Observer und Extension je ein eigener Bereich (Tray und Observer nur am Mac)
  const SETTINGS_SECTIONS = ["library", "view", "look", "start", "tray", "observer", "extension", "studio", "general"].filter(
    (id) => isMac || (id !== "tray" && id !== "observer")
  );

  function sectionTitle(id) {
    return t({ library: "setLibrary", view: "setSecView", look: "setLook", start: "setSecStart", tray: "setTray", observer: "setViewer", extension: "setExtension", studio: "setStudio", general: "setGeneral" }[id]);
  }

  function sectionSummary(id) {
    if (id === "library") {
      const slots = state.libraries || [];
      const i = slots.findIndex((l) => l.active);
      return i >= 0 ? libraryName(slots[i], i) : shortPath(state.root);
    }
    if (id === "look") {
      const th = window.ArchiverI18n.theme();
      return t({ system: "themeSystem", light: "themeLight", dark: "themeDark" }[th]);
    }
    if (id === "tray") {
      const p = state.sysPrefs;
      if (!p) return "";
      const key = PALETTE_KEYS.find(([k]) => k === p.shortcut);
      return (p.shortcut ? (key && key[1]) || p.shortcut : t("setOff")) + " · " + t("setTrayBar") + " " + (p.dropbar ? t("setOn") : t("setOff")).toLowerCase();
    }
    if (id === "observer") return t("setObserverSummary");
    if (id === "extension") return t("setExtensionSummary");
    if (id === "studio") {
      const on = FEATURES.filter(feat).length;
      return on + " / " + FEATURES.length + (state.shared ? " · " + t("featSharedOn") : "");
    }
    if (id === "view")
      return t(state.view === "original" ? "viewOriginal" : "viewGrid");
    if (id === "start")
      return t(pref("revealForm", "wave") === "lid" ? "revealLid" : "revealWave") + " · " + t("setSound") + " " + (pref("startSound", false) ? t("setOn") : t("setOff")).toLowerCase();
    return lang === "de" ? "Deutsch" : "English";
  }

  // Am ganzen Mac (system.rs): Kürzel der Palette und Zonenleiste beim Ziehen.
  // Feste Auswahl statt Tastenrekorder; ⌥⌘ Space ist die Finder-Suche.
  const PALETTE_KEYS = [
    ["Alt+Space", "⌥ Space"],
    ["Control+Alt+Space", "⌃⌥ Space"],
    ["Shift+Alt+Space", "⇧⌥ Space"],
    ["", null],
  ];
  function renderSystemSettings() {
    const sys = block(t("setSystem"));
    sys.appendChild(blockRow(el("div", "p-block-text", t("setSystemText"))));
    const rows = el("div");
    const show = (prefs) => {
      const save = (next) =>
        invoke("set_system_prefs", { prefs: next })
          .then(() => {
            state.sysPrefs = next;
            show(next);
          })
          .catch((e) => {
            const key = PALETTE_KEYS.find(([id]) => id === next.shortcut);
            if (String(e) === "shortcut-taken") toast(t("setKeyTaken", { key: key ? key[1] : next.shortcut }), false, 6000);
            else fail(e);
          });
      rows.replaceChildren(
        blockRow(
          t("setPaletteKey"),
          choice(
            PALETTE_KEYS.map(([id, label]) => [id || "off", label || t("setOff")]),
            prefs.shortcut || "off",
            (id) => save({ ...prefs, shortcut: id === "off" ? "" : id })
          )
        ),
        blockRow(
          t("setDropbarSys"),
          choice([["on", t("setOn")], ["off", t("setOff")]], prefs.dropbar ? "on" : "off", (id) => save({ ...prefs, dropbar: id === "on" }))
        )
      );
    };
    invoke("system_prefs")
      .then((p) => {
        state.sysPrefs = p;
        show(p);
      })
      .catch(fail);
    sys.appendChild(rows);
    return sys;
  }

  function openSettingsSection(id) {
    previewDropbar(false);
    state.settingsSub = id;
    renderPage();
  }

  function renderSettings() {
    const wrap = el("div", "p-sheet-inner");
    const sub = state.settingsSub;
    if (!sub) {
      if (isMac && !state.sysPrefs)
        invoke("system_prefs")
          .then((p) => {
            state.sysPrefs = p;
            if (state.page === "settings" && !state.settingsSub) renderPage(true);
          })
          .catch(() => {});
      wrap.appendChild(headline(t("settings"), t("settingsText")));
      const list = el("section", "p-block p-settings-nav");
      for (const id of SETTINGS_SECTIONS) {
        const row = button("p-settings-link", null, () => openSettingsSection(id));
        row.appendChild(el("span", "p-settings-link-title", sectionTitle(id)));
        row.appendChild(el("span", "p-settings-link-sum", sectionSummary(id)));
        row.appendChild(el("span", "p-settings-link-arrow", "›"));
        list.appendChild(row);
      }
      wrap.appendChild(list);
      wrap.appendChild(renderUnlock());
      return wrap;
    }
    wrap.appendChild(button("p-settings-back", "‹ " + t("settings"), () => openSettingsSection(null)));
    wrap.appendChild(headline(sectionTitle(sub)));
    const rerender = () => {
      renderZones();
      renderPage(true);
    };

    if (sub === "library") {
      wrap.appendChild(renderLibrarySlots());
      wrap.appendChild(renderExternalZones());
      wrap.appendChild(renderDefaultZone());
      wrap.appendChild(renderStructure());
      wrap.appendChild(renderZoneSettings());
    }

    if (sub === "view") {
      const view = block(null);
      view.appendChild(
        blockRow(
          t("setImages"),
          choice([["grid", t("viewGrid")], ["original", t("viewOriginal")]], state.view, (id) => {
            state.view = id;
            setPref("view", id);
            rerender();
          })
        )
      );
      view.appendChild(
        blockRow(
          t("sizeLabel"),
          sizeChips(Math.max(0, SIZES.indexOf(state.size)), SIZES.length, (step) => {
            state.size = SIZES[step];
            setPref("size", state.size);
            rerender();
          })
        )
      );
      // 0.30: ein Schalter für Video und Audio (media.js liest "autoplay")
      view.appendChild(
        blockRow(
          t("setAutoplay"),
          choice([["on", t("setOn")], ["off", t("setOff")]], Media.autoplayOn() ? "on" : "off", (id) => {
            setPref("autoplay", id === "on");
            rerender();
          })
        )
      );
      view.appendChild(
        blockRow(
          t("setInfoPanel"),
          choice([["on", t("setOn")], ["off", t("setOff")]], state.infoOpen ? "on" : "off", (id) => {
            if ((id === "on") !== state.infoOpen) toggleInfo();
            rerender();
          })
        )
      );
      wrap.appendChild(view);
    }

    if (sub === "look") {
      const look = block(null);
      look.appendChild(
        blockRow(
          t("setTheme"),
          choice(
            [["system", t("themeSystem")], ["light", t("themeLight")], ["dark", t("themeDark")]],
            window.ArchiverI18n.theme(),
            (id) => {
              window.ArchiverI18n.setTheme(id);
              rerender();
            }
          )
        )
      );
      look.appendChild(
        blockRow(
          t("setRadius"),
          choice(
            [["square", t("radiusSquare")], ["soft", t("radiusSoft")], ["round", t("radiusRound")], ["xl", t("radiusXl")]],
            pref("radius", "round"),
            (id) => {
              setPref("radius", id);
              applyRadius(id);
              lookToLibrary();
              rerender();
            }
          )
        )
      );
      look.appendChild(
        blockRow(
          t("setLbText"),
          choice([["back", t("setLbTextBack")], ["spread", t("setLbTextSpread")]], lbTextStyle(), (id) => {
            setPref("lbTextStyle", id);
            rerender();
          })
        )
      );
      look.appendChild(blockRow(el("div", "p-block-text", t("setLbTextText"))));
      look.appendChild(
        blockRow(
          t("setTopFade"),
          choice([["fade", t("setTopFadeFade")], ["glass", t("setTopFadeGlass")]], pref("topFade", "fade"), (id) => {
            setPref("topFade", id);
            applyTopFade(id);
            rerender();
          })
        )
      );
      look.appendChild(
        blockRow(
          t("setFocusAnim"),
          choice([["off", t("setFocusStill")], ["on", t("setFocusRun")]], pref("focusAnim", false) ? "on" : "off", (id) => {
            setPref("focusAnim", id === "on");
            applyFocusAnim(id === "on");
            rerender();
          })
        )
      );
      wrap.appendChild(look);
      wrap.appendChild(renderGlassSettings());
    }

    // Start: Öffnung und Startton gehören zum selben Moment
    if (sub === "start") {
      const open = block(t("setReveal"));
      // Licht-Öffnung nach Getting Started: Welle oder Lid, zum Vergleich abspielbar
      const reveal = choice([["wave", t("revealWave")], ["lid", t("revealLid")]], pref("revealForm", "wave"), (id) => {
        setPref("revealForm", id);
        rerender();
      });
      reveal.appendChild(
        button("p-link", t("revealPlay"), () => {
          closePage();
          setTimeout(() => playReveal(null), 350);
        })
      );
      open.appendChild(blockRow(t("setReveal"), reveal));
      wrap.appendChild(open);
      wrap.appendChild(renderSoundSettings());
    }

    if (sub === "extension") {
      const extBlock = block(t("setExtension"));
      const ext = el("div", null, "…");
      const get = button("p-link", t("extGet"), openExtensionDownload);
      get.hidden = true;
      Promise.all([invoke("bridge_browsers").catch(() => []), extensionState()]).then(([list, s]) => {
        if (!list.length) return (ext.textContent = t("setBridgeOff"));
        const kind = s ? s.kind : "missing";
        get.hidden = kind === "ok";
        if (kind === "ok") ext.textContent = t("extStatusOk", { version: s.version, list: list.join(", ") });
        else if (kind === "old") ext.textContent = t("extStatusOld", { version: s.version || "", min: s.min }).replace("  ", " ");
        else ext.textContent = t("extStatusMissing");
      });
      extBlock.appendChild(blockRow(ext, [get, button("p-link", t("import"), openImportDialog)]));
      wrap.appendChild(extBlock);
    }

    if (sub === "tray" && isMac) wrap.appendChild(renderSystemSettings());

    if (sub === "observer" && isMac) {
      {
        const viewerBlock = block(t("setViewer"));
        viewerBlock.appendChild(blockRow(el("div", "p-block-text", t("setViewerText"))));
        const rows = el("div");
        const showFormats = (list) =>
          rows.replaceChildren(
            ...list.map((f) =>
              blockRow(
                f.name,
                choice([["on", t("setOn")], ["off", t("setOff")]], f.active ? "on" : "off", (id) => {
                  if (id === "off" && f.active) return toast(t("setViewerOff", { format: f.name }), true, 8000);
                  if (id === "on" && !f.active)
                    invoke("viewer_make_default", { format: f.name })
                      .then(() => invoke("viewer_defaults"))
                      .then(showFormats)
                      .catch(fail);
                })
              )
            )
          );
        invoke("viewer_defaults").then(showFormats).catch(fail);
        viewerBlock.appendChild(rows);
        wrap.appendChild(viewerBlock);
      }
    }

    if (sub === "studio") renderStudioSettings(wrap, rerender);

    if (sub === "general") {
      const general = block(t("setLanguage"));
      general.appendChild(
        blockRow(
          t("setLanguage"),
          choice([["de", "Deutsch"], ["en", "English"]], lang, (id) => {
            if (id === lang) return;
            setPref("lang", id);
            sessionStorage.setItem("archiver.reopen", "settings:general");
            location.reload();
          })
        )
      );
      wrap.appendChild(general);

      const feedback = block(t("feedback"));
      feedback.appendChild(blockRow(el("div", "p-block-text", t("feedbackText")), [button("p-link", t("feedback"), sendFeedback)]));
      wrap.appendChild(feedback);

      const keys = block(t("setKeys"));
      for (const [k, v] of [
        ["Space", t("keyPreview")],
        ["1–4", t("keyMove")],
        ["⇧ ← →", t("keyExtend")],
        ["Del", t("trash")],
        ["⌘F", t("navSearch")],
        ["⌘D", t("infoPanel")],
        ["⌘N", t("newZone")],
        ["⌘P", t("pdfExport")],
        ["⌘,", t("settings")],
        ["Esc", t("keyBack")],
      ]) {
        keys.appendChild(blockRow(v, k));
      }
      wrap.appendChild(keys);
    }
    return wrap;
  }

  // Studio: Schalter je Funktion, dazu Name und geteilte Bibliothek
  function renderStudioSettings(wrap, rerender) {
    wrap.appendChild(el("p", "p-block-hint p-studio-lead", t("setStudioText")));
    const tools = block(t("featTools"));
    for (const [id, title, text] of [
      ["rights", "featRights", "featRightsText"],
      ["package", "featPackage", "featPackageText"],
    ]) {
      tools.appendChild(
        blockRow(
          [el("div", null, t(title)), el("div", "p-block-text dim", t(text))],
          choice([["on", t("setOn")], ["off", t("setOff")]], feat(id) ? "on" : "off", (v) => {
            setPref("feat." + id, v === "on");
            for (const item of state.items) item._idx = null;
            cardCache.clear();
            rerender();
            renderInfo();
          })
        )
      );
    }

    const team = block(t("featShared"));
    team.appendChild(blockRow(el("div", "p-block-text", t("featSharedText"))));
    const name = el("input", "p-input note-field");
    name.value = state.user || "";
    name.placeholder = t("featUserPlaceholder");
    name.spellcheck = false;
    const saveName = () => {
      const v = name.value.trim();
      if (v === (state.user || "")) return;
      state.user = v;
      invoke("set_sharing", { shared: state.shared, user: v || null }).catch(fail);
    };
    name.addEventListener("blur", saveName);
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Escape") name.blur();
    });
    team.appendChild(blockRow([el("div", null, t("featUser")), el("div", "p-block-text dim", t("featUserText"))], name));
    team.appendChild(
      blockRow(
        t("featShared"),
        choice([["off", t("featSharedOff")], ["on", t("featSharedOn")]], state.shared ? "on" : "off", async (v) => {
          const shared = v === "on";
          if (shared === state.shared) return;
          const user = name.value.trim();
          if (shared && !user) {
            name.focus();
            return toast(t("featSharedNeedsName"), false);
          }
          try {
            await invoke("set_sharing", { shared, user: user || null });
            state.user = user;
            await refresh();
            toast(t(shared ? "featSharedDone" : "featSharedOffDone"));
          } catch (e) {
            fail(e);
          }
          rerender();
        })
      )
    );
    wrap.appendChild(team);
    wrap.appendChild(tools);
  }

  // Zonen beim Ziehen: Deckkraft, gilt in der App und (über die Bibliothek) in der Extension
  // Glas: Fenster und Zonen beim Ziehen, je ein Regler in 5-%-Schritten (i18n.js)
  function glassSlider(title, text, min, get, set, standard, onLive) {
    const b = block(t(title));
    b.appendChild(blockRow(el("div", "p-block-text", t(text))));
    const value = mono("", "p-alpha-value");
    const slider = el("input", "p-volume p-alpha");
    slider.type = "range";
    slider.min = String(min);
    slider.max = "100";
    slider.step = "5";
    const show = () => {
      const v = get() ?? standard();
      slider.value = String(Math.round(v * 100));
      value.textContent = Math.round(v * 100) + " %";
    };
    show();
    slider.addEventListener("input", () => {
      set(Number(slider.value) / 100);
      show();
      if (onLive) onLive(true);
    });
    slider.addEventListener("change", () => {
      lookToLibrary();
      if (onLive) setTimeout(() => onLive(false), 900);
    });
    const reset = button("p-link", t("setGlassReset"), () => {
      set(null);
      show();
      lookToLibrary();
    });
    b.appendChild(blockRow(t("setDragAlpha"), [slider, value, reset]));
    return b;
  }

  function renderGlassSettings() {
    const I = window.ArchiverI18n;
    const frag = document.createDocumentFragment();
    frag.appendChild(glassSlider("setGlass", "setGlassText", 40, I.glass, I.setGlass, () => (document.documentElement.classList.contains("light") ? 0.78 : 0.72)));
    frag.appendChild(glassSlider("setZoneGlass", "setZoneGlassText", 30, I.zoneGlass, I.setZoneGlass, () => 0.97, previewDropbar));
    return frag;
  }

  // Ganz unten: Freischalt-Code eingeben, danach nur noch ein ruhiges „Freigeschaltet“
  function renderUnlock() {
    const b = block(t("unlockTitle"));
    b.classList.add("p-unlock");
    if (isUnlocked()) {
      b.appendChild(blockRow(el("div", "p-block-text", t("unlockDone")), mono("●", "p-unlock-dot")));
      return b;
    }
    b.appendChild(el("div", "p-block-text p-unlock-text", t("unlockText")));
    b.appendChild(unlockForm());
    return b;
  }

  // Eingabe für den Code: in den Einstellungen und direkt im Sperr-Hinweis
  function unlockForm() {
    const form = el("form", "p-unlock-form");
    const input = el("input", "p-unlock-input");
    input.placeholder = t("unlockPlaceholder");
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "characters");
    const go = el("button", "p-unlock-go", t("unlockButton"));
    go.type = "submit";
    form.append(input, go);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const hash = await unlockHash(input.value);
      if (!UNLOCK_HASHES.includes(hash)) {
        form.classList.remove("wrong");
        void form.offsetWidth;
        form.classList.add("wrong");
        input.select();
        return;
      }
      setPref("unlock", hash);
      applyLock();
      if (state.page) renderPage(true);
      toast(t("unlockOk"));
    });
    input.addEventListener("input", () => form.classList.remove("wrong"));
    input.addEventListener("keydown", (e) => e.stopPropagation());
    return form;
  }

  // Startton: Ein/Aus, Lautstärke mit Probehören, eigene Datei oder der Standard
  function renderSoundSettings() {
    const b = collapsible("sound", t("setSound"));
    b.appendChild(
      blockRow(
        t("setSoundPlay"),
        choice([["on", t("setOn")], ["off", t("setOff")]], pref("startSound", false) ? "on" : "off", (id) => {
          setPref("startSound", id === "on");
          renderPage(true);
        })
      )
    );
    const slider = el("input", "p-volume");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(Math.round(pref("startSoundVolume", 0.35) * 100));
    slider.addEventListener("change", () => {
      setPref("startSoundVolume", Number(slider.value) / 100);
      playStartSound(true);
    });
    b.appendChild(blockRow(t("setSoundVolume"), [slider]));
    const name = el("span", null, t("setSoundGlass"));
    invoke("startup_sound_name")
      .then((n) => (name.textContent = n || t("setSoundGlass")))
      .catch(() => {});
    b.appendChild(
      blockRow(name, [
        button("p-link", t("setSoundTest"), () => playStartSound(true)),
        button("p-link", t("setSoundPick"), () =>
          invoke("pick_startup_sound")
            .then((n) => {
              if (!n) return;
              name.textContent = n;
              playStartSound(true);
            })
            .catch(fail)
        ),
        button("p-link", t("setSoundReset"), () =>
          invoke("reset_startup_sound")
            .then(() => {
              name.textContent = t("setSoundGlass");
              playStartSound(true);
            })
            .catch(fail)
        ),
      ])
    );
    return b;
  }

  function playStartSound(force) {
    if (!force && !pref("startSound", false)) return;
    invoke("play_startup_sound", { volume: pref("startSoundVolume", 0.35) }).catch(() => {});
  }

  // Info: Wortmarke mit Claim, dann Zahlen zur Sammlung und das Kleingedruckte
  function renderAbout() {
    const wrap = el("div", "p-sheet-inner");
    wrap.appendChild(headline("Archiver", t("aboutClaim")));

    const how = block(t("aboutHow"));
    for (const key of ["Collect", "Library", "Sort", "View", "Share", "Viewer"]) {
      const text = el("div", "p-block-text", t("how" + key + "Text"));
      how.appendChild(blockRow([el("div", null, t("how" + key + "Title")), text]));
    }
    wrap.appendChild(how);

    const stats = block(t("aboutCollection"));
    const first = state.items.length ? Math.min(...state.items.map(itemTime).filter(Boolean)) : 0;
    stats.appendChild(blockRow(t("aboutImages"), String(state.items.length)));
    stats.appendChild(blockRow(t("aboutZones"), String(state.zones.length)));
    if (first)
      stats.appendChild(
        blockRow(
          t("aboutSince"),
          new Date(first).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { month: "long", year: "numeric" })
        )
      );
    const counts = new Map();
    for (const i of state.items) {
      const d = domainOf(i.pageUrl);
      if (d) counts.set(d, (counts.get(d) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) stats.appendChild(blockRow(t("aboutSource"), top[0]));
    wrap.appendChild(stats);

    const meta = block(t("aboutApp"));
    const version = el("span", null, "–");
    if (TAURI.app && TAURI.app.getVersion) TAURI.app.getVersion().then((v) => (version.textContent = v)).catch(() => {});
    meta.appendChild(blockRow(t("aboutVersion"), version));
    meta.appendChild(blockRow(t("setLibrary"), pathEl(state.root)));
    meta.appendChild(blockRow(t("aboutFont"), "SIL OFL"));
    wrap.appendChild(meta);

    wrap.appendChild(el("div", "p-sheet-foot", "© 2026 Lukas Rudolph"));
    return wrap;
  }

  // ---- Handbuch (manual.js): dieselben Blöcke wie Information ----
  // Links Titel und Text, rechts die Tasten. `x` im Text wird zur Taste.

  function manualText(text) {
    const node = el("div", "p-block-text");
    String(text || "")
      .split("`")
      .forEach((part, i) => part && node.appendChild(i % 2 ? el("kbd", null, part) : document.createTextNode(part)));
    return node;
  }

  function manualKeys(keys) {
    if (!keys || !keys.length) return null;
    const wrap = el("span", "p-keys");
    for (const k of keys) wrap.appendChild(el("kbd", null, k));
    return wrap;
  }

  function renderManual() {
    const m = MANUAL[lang] || MANUAL.en;
    const wrap = el("div", "p-sheet-inner p-manual");
    wrap.appendChild(headline(m.title, m.lead));
    for (const sec of m.sections) {
      const b = block(sec.title);
      if (sec.lead) b.appendChild(blockRow(manualText(sec.lead)));
      for (const row of sec.rows) {
        const main = sec.keys ? [el("div", null, row.t)] : [el("div", null, row.t), manualText(row.d)];
        b.appendChild(blockRow(main, manualKeys(row.k)));
      }
      wrap.appendChild(b);
    }
    wrap.appendChild(el("div", "p-sheet-foot", "archiver-app.com/manual"));
    return wrap;
  }

  // ---- In einer Zone (G), Alle Bilder und Suche ----

  function renderGallery(searching) {
    const single = !state.query.trim() && isZone(state.focus);
    const shown = single ? state.zones.filter((z) => z.path === state.focus) : state.zones;
    const wrap = el("div", "p-page p-gallery");

    const all = single && shown[0] ? zoneItems(shown[0].path) : [];
    const zonePath = single && shown[0] ? shown[0].path : null;
    const hasFolders = zoneFolders(all, null, zonePath).some(([f]) => f);
    // Ebenenweise: im Ordner nur seine eigenen Unterordner
    const folders = zoneFolders(all, state.level || null, zonePath);
    const here = state.level ? all.filter((i) => inFolder(i, state.level)) : all;
    if (single && shown[0]) {
      const zone = shown[0];
      const items = all;
      const latest = lastSaved(zone.path);
      const named = zoneFolders(all, null, zone.path).filter(([f]) => f).length;
      const sentence = items.length
        ? [t("headZone", { count: countText(items.length), date: recentDate(latest) }).replace(/\.\.$/, "."), hasFolders ? t(named === 1 ? "headFolder1" : "headFolders", { n: named }) : "", topDomains(items)].filter(Boolean).join(" ")
        : t("headZoneEmpty");
      const h = headline(lastSegment(zone.path), sentence);
      if (canEdit(zone.path)) {
        const title = h.querySelector(".p-head-title");
        title.classList.add("zone-card-name");
        title.title = t("renameHint");
        title.addEventListener("dblclick", () => startRename(title, zone.path));
      }
      if (hasFolders && state.level != null) {
        // Im Unterordner: Pfad „Zone / Ordner / Unterordner“, jeder Teil führt auf seine Ebene
        const title = h.querySelector(".p-head-title");
        const back = (node, target) => {
          node.classList.add("p-head-back");
          node.title = t("folderBack");
          node.addEventListener("click", () => openFolder(target));
        };
        back(title, null);
        const parts = state.level ? state.level.split("/") : [""];
        let after = title;
        parts.forEach((part, i) => {
          const span = el("span", "p-head-title p-head-folder", " / " + (part || t("folderLoose")));
          if (i < parts.length - 1) back(span, parts.slice(0, i + 1).join("/"));
          after.after(span);
          after = span;
        });
      }
      if (hasFolders) {
        // Kopfzeile am Bildraster: Titel links, Ordner rechts als Karten (3/6)
        const row = el("div", "p-head-row is-cards");
        row.append(h, folderCards(zone, folders, here));
        wrap.appendChild(row);
      } else wrap.appendChild(h);
    } else if (searching) {
      wrap.classList.add("p-find");
      const n = state.found ? state.found.length : 0;
      const q = state.query.trim();
      wrap.appendChild(headline(t("navAll"), q ? t("headSearch", { q, n }) : t("headFilter", { n: countText(n) })));
    } else {
      wrap.classList.add("p-find");
      wrap.appendChild(
        headline(t("navAll"), t("headAll", { images: countText(state.items.length), zones: zonesText(state.zones.length) }))
      );
    }

    const bar = el("div", "p-bar");
    if (single && shown[0] && hasFolders) bar.appendChild(folderChips(shown[0], folders, here.length));
    else if (single && shown[0]) bar.appendChild(mono(t("allLabel") + " (" + shown[0].count + ")", "strong"));
    else if (state.found) bar.appendChild(mono(t("foundLabel") + " (" + state.found.length + ")", "strong"));
    else bar.appendChild(mono(t("allZonesLabel") + " (" + state.zones.length + ")", "strong"));
    bar.appendChild(el("span", "p-flex"));
    if (single && shown[0]) {
      const copies = cloudCopies(all);
      if (copies.length) {
        const c = chip("(" + t("cloudCopies", { n: copies.length }) + ")", false, () => mergeCloudCopies(copies));
        c.classList.add("p-cloud-copies");
        c.title = t("cloudCopiesHint");
        bar.appendChild(c);
        bar.appendChild(el("span", "p-filter-gap"));
      }
    }
    if (single && shown[0] && hasFolders) {
      for (const l of ["mosaic", "sections"])
        bar.appendChild(chip("(" + t(l === "mosaic" ? "layoutMosaic" : "layoutSections") + ")", zoneLayout(shown[0].path) === l, () => setZoneLayout(shown[0].path, l)));
      bar.appendChild(el("span", "p-filter-gap"));
    }
    for (const v of ["grid", "original"]) {
      const c = chip("(" + t(v === "grid" ? "viewGrid" : "viewOriginal") + ")", state.view === v, () => {
        state.view = v;
        setPref("view", v);
        render();
      });
      c.title = t(v === "grid" ? "viewGridTitle" : "viewOriginalTitle");
      bar.appendChild(c);
    }
    // 0.29: Bildtext unter den Bildern (nur in „Original“)
    if (state.view === "original") {
      const c = chip("(+ " + t("captionChip") + ")", captionsOn(), () => {
        setPref("captions", !captionsOn());
        renderToolbar();
        renderZones();
      });
      c.title = t("captionChipTitle");
      bar.appendChild(c);
    }
    bar.appendChild(sizeChips(Math.max(0, SIZES.indexOf(state.size)), SIZES.length, (step) => {
      state.size = SIZES[step];
      setPref("size", state.size);
      renderToolbar();
      renderZones();
    }));
    wrap.appendChild(bar);
    if (filtersShown()) wrap.insertBefore(filterBar(), bar);

    // Suche oder Filter: eine Liste nach Relevanz statt nach Zonen
    if (state.found) {
      wrap.appendChild(foundSection(state.found));
      return wrap;
    }
    if (single && shown[0] && hasFolders && zoneLayout(shown[0].path) === "sections") {
      wrap.appendChild(folderSections(shown[0]));
      return wrap;
    }
    shown.forEach((zone) => {
      const list = state.lists.get(zone.path) || [];
      if (searching && !list.length) return;
      wrap.appendChild(gallerySection(zone, state.zones.indexOf(zone), !single, searching));
    });
    return wrap;
  }

  // Größe als Stufenleiste: (−) ▪▪▪▫ (+), Klick auf eine Stufe springt direkt hin
  function sizeChips(step, count, onChange) {
    const wrap = el("span", "p-sizes");
    wrap.title = t("sizeLabel");
    const go = (n) => onChange(Math.max(0, Math.min(count - 1, n)));
    wrap.appendChild(chip("(−)", false, () => go(step - 1)));
    const steps = el("span", "p-steps");
    for (let i = 0; i < count; i++) {
      const b = button("p-step" + (i <= step ? " on" : ""), "", () => go(i));
      steps.appendChild(b);
    }
    wrap.appendChild(steps);
    wrap.appendChild(chip("(+)", false, () => go(step + 1)));
    return wrap;
  }

  // + / − auf der Tastatur: dieselben Stufen wie die Leiste (−) ▪▪▪ (+)
  function resize(dir) {
    if (state.page) return;
    if (document.body.classList.contains("at-home")) {
      const step = Math.max(0, Math.min(HOME_SIZES.length - 1, homeStep() + dir));
      state.homeSizes = { ...state.homeSizes, [state.home]: step };
      setPref("homeSizes", state.homeSizes);
    } else {
      const i = SIZES.findIndex((s) => s >= state.size);
      state.size = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? SIZES.length - 1 : i) + dir))];
      setPref("size", state.size);
      renderToolbar();
    }
    renderZones();
  }

  function gallerySection(zone, index, withHeader, searching) {
    const list = state.lists.get(zone.path) || [];
    const card = el("section", "zone-card p-section");
    card.dataset.zone = zone.path;
    if (withHeader) {
      const header = el("div", "p-section-head");
      header.appendChild(mono(String(index + 1).padStart(2, "0"), "dim"));
      const name = zoneNameEl(zone);
      header.appendChild(name);
      header.appendChild(mono(searching ? `${list.length} / ${zone.count}` : String(zone.count), "dim"));
      header.addEventListener("click", () => setFocus(zone.path));
      card.appendChild(header);
    }
    const body = el("div", "zone-card-grid");
    body.tabIndex = -1;
    const items = el("div", "zone-card-items");
    if (state.view === "original") {
      items.classList.add("p-masonry");
      masonryLists.set(items, list);
    } else for (const item of list) items.appendChild(itemCard(item));
    body.appendChild(items);
    if (!list.length) body.appendChild(el("div", "zone-card-empty", searching ? t("emptySearch") : t("emptyZone")));
    card.appendChild(body);
    return card;
  }

  // „Sections“: je Ordner eine Kopfzeile, darunter sein Raster
  function folderSections(zone) {
    const list = state.lists.get(zone.path) || [];
    const wrap = el("div", "p-folder-sections");
    const base = state.folder || null;
    for (const [folder, n] of zoneFolders(list, base).concat(base && list.some((i) => childFolder(i, base) === "") ? [["", 0]] : [])) {
      const part = list.filter((i) => childFolder(i, base) === folder);
      const card = el("section", "zone-card p-section p-folder-section");
      card.dataset.zone = zone.path;
      const head = el("h2", "p-head p-folder-head");
      head.appendChild(el("span", "p-head-title", folder ? lastSegment(folder) : base ? lastSegment(base) : t("folderLoose")));
      head.appendChild(el("span", "p-head-text", " " + countText(part.length)));
      card.appendChild(head);
      const body = el("div", "zone-card-grid");
      body.tabIndex = -1;
      const items = el("div", "zone-card-items");
      if (state.view === "original") {
        items.classList.add("p-masonry");
        masonryLists.set(items, part);
      } else for (const item of part) items.appendChild(itemCard(item));
      body.appendChild(items);
      card.appendChild(body);
      wrap.appendChild(card);
    }
    return wrap;
  }

  function foundSection(list) {
    const card = el("section", "zone-card p-section p-found");
    const body = el("div", "zone-card-grid");
    body.tabIndex = -1;
    const items = el("div", "zone-card-items");
    if (state.view === "original") {
      items.classList.add("p-masonry");
      masonryLists.set(items, list);
    } else for (const item of list) items.appendChild(itemCard(item));
    body.appendChild(items);
    if (!list.length) body.appendChild(el("div", "zone-card-empty", t("emptySearch")));
    card.appendChild(body);
    return card;
  }

  function zoneNameEl(zone) {
    const name = el("span", "zone-card-name");
    if (zone.path.includes("/")) {
      const parts = zone.path.split("/");
      name.appendChild(el("span", "parent", parts.slice(0, -1).join(" / ") + " / "));
      name.appendChild(document.createTextNode(parts[parts.length - 1]));
    } else {
      name.textContent = lastSegment(zone.path);
    }
    if (zoneHasFresh(zone.path)) {
      const dot = el("span", "p-fresh-dot");
      dot.title = t("freshHint");
      name.appendChild(dot);
    }
    return name;
  }

  function lastSaved(zonePath) {
    if (pass) {
      if (!pass.saved) {
        pass.saved = new Map();
        for (const item of state.items) pass.saved.set(item.zone, Math.max(pass.saved.get(item.zone) || 0, item.capturedAt || item.addedAt || 0));
      }
      return pass.saved.get(zonePath) || 0;
    }
    let latest = 0;
    for (const item of state.items) {
      if (item.zone === zonePath) latest = Math.max(latest, item.capturedAt || item.addedAt || 0);
    }
    return latest;
  }

  function canEdit(path) {
    return path !== "" && path !== (state.defaultZone || "Unsorted");
  }

  // ---- Zonen-Menü (⋯): Umbenennen, im Finder zeigen, löschen ----

  function closeMenus() {
    for (const m of document.querySelectorAll(".zone-menu")) m.remove();
    for (const b of document.querySelectorAll(".zone-menu-btn.open")) b.classList.remove("open");
    const lib = $("libTabBtn");
    if (lib) lib.classList.remove("active");
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  }

  function zoneMenuButton(zone, makeMenu) {
    const btn = button("zone-menu-btn", "⋯");
    btn.title = t("zoneOptions");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = btn.classList.contains("open");
      closeMenus();
      if (open) return;
      // Schwebt über allem: Karten schneiden ihren Inhalt ab
      const menu = makeMenu ? makeMenu() : zoneMenu(zone);
      menu.classList.add("floating");
      document.body.appendChild(menu);
      const r = btn.getBoundingClientRect();
      const h = menu.offsetHeight;
      const w = menu.offsetWidth;
      const below = r.bottom + 4 + h <= window.innerHeight - 8;
      menu.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)) + "px";
      menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
      btn.classList.add("open");
    });
    return btn;
  }

  function zoneMenu(zone) {
    const menu = el("div", "zone-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    const card = () => document.querySelector(`[data-zone="${CSS.escape(zone.path)}"]`);
    if (canEdit(zone.path)) {
      menu.appendChild(
        button("zone-menu-item", t("rename"), () => {
          closeMenus();
          const name = (card() && card().querySelector(".zone-card-name")) || document.querySelector(".p-head-title.zone-card-name");
          if (name) startRename(name, zone.path);
        })
      );
    }
    menu.appendChild(
      button("zone-menu-item", t("reveal"), () => {
        closeMenus();
        invoke("reveal_zone", { zone: zone.path }).catch(fail);
      })
    );
    if (feat("package") && zone.count) {
      menu.appendChild(
        button("zone-menu-item", t("packageExport"), () => {
          closeMenus();
          exportPackage(applyItemOrder(zone.path, state.items.filter((i) => i.zone === zone.path)), lastSegment(zone.path) || state.name);
        })
      );
    }
    if (feat("order") && state.order[zone.path]) {
      menu.appendChild(
        button("zone-menu-item", t("orderReset"), () => {
          closeMenus();
          const { [zone.path]: _, ...rest } = state.order;
          state.order = rest;
          renderZones();
          invoke("set_item_order", { zone: zone.path, hashes: [] }).catch(fail);
        })
      );
    }
    if (canEdit(zone.path)) {
      const del = button("zone-menu-item danger", t("trashZone"));
      let armed = false;
      del.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          del.textContent = t("trashZoneConfirm", { count: zone.count === 1 ? t("countImage") : t("countImages", { n: zone.count }) });
          del.classList.add("armed");
          return;
        }
        closeMenus();
        trashZone(zone);
      });
      menu.appendChild(del);
    }
    return menu;
  }

  // Rechtsklick auf eine Zone der Übersicht (Karte oder Index-Zeile): Öffnen,
  // Active Zone, PDF und dieselben Einträge wie im ⋯-Menü
  function openZoneContext(path, x, y) {
    const zone = state.zones.find((z) => z.path === path);
    if (!zone) return;
    closeMenus();
    const menu = zoneMenu(zone);
    menu.classList.add("floating", "p-zone-ctx");
    const first = menu.firstChild;
    const add = (label, fn) => menu.insertBefore(button("zone-menu-item", label, () => (closeMenus(), fn())), first);
    add(t("openFile"), () => setFocus(zone.path));
    const order = state.zones.map((z) => z.path);
    const at = order.indexOf(zone.path);
    if (at >= HOT_ZONES && order.length > HOT_ZONES) {
      add(t("makeHot"), () => {
        const slot = HOT_ZONES - 1;
        [order[at], order[slot]] = [order[slot], order[at]];
        setZoneOrder(order);
        renderZones();
        toast(t("hotSwapped", { zone: zoneLabel(zone.path) }));
      });
    }
    if (zone.count) {
      add(t("zonePdf"), () => openPdfMaker(applyItemOrder(zone.path, state.items.filter((i) => i.zone === zone.path)), zoneLabel(zone.path)));
    }
    document.body.appendChild(menu);
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x)) + "px";
    menu.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y)) + "px";
  }

  async function trashZone(zone) {
    try {
      await invoke("trash_zone", { zone: zone.path });
      if (state.focus === zone.path) state.focus = null;
      await refresh();
      toast(t("zoneTrashed", { zone: zoneLabel(zone.path) }));
    } catch (e) {
      fail(e);
    }
  }

  // ⌫ auf der Startseite: gewählte oder überfahrene Zone löschen, nach Rückfrage.
  function askTrashZone(path) {
    const zone = state.zones.find((z) => z.path === path);
    if (!zone || !canEdit(zone.path)) return false;
    const dialog = el("div", "dialog confirm");
    dialog.appendChild(el("h3", null, t("trashZoneAsk", { zone: zoneLabel(zone.path) })));
    const count = zone.count === 1 ? t("countImage") : t("countImages", { n: zone.count });
    dialog.appendChild(el("p", null, zone.count ? t("trashZoneAskText", { count }) : t("trashZoneAskEmpty")));
    const foot = el("div", "confirm-foot");
    const go = () => {
      closeModal();
      trashZone(zone);
    };
    foot.appendChild(button("btn", t("cancel"), closeModal));
    const ok = button("btn danger-fill", t("trashZoneDo"), go);
    foot.appendChild(ok);
    dialog.appendChild(foot);
    const modal = $("modal");
    modal.replaceChildren(dialog);
    modal.hidden = false;
    modal.onEnter = go;
    ok.focus();
    return true;
  }

  // Originalansicht wie ein Moodboard: Bild 1 in Spalte 1, Bild 2 in Spalte 2 …
  // und dann wieder links. So bleibt die Reihenfolge fest: ← → gehen immer eine
  // Spalte weiter (CSS-Spalten füllten erst die ganze linke Spalte).
  const masonryLists = new WeakMap();

  function layoutMasonry(force) {
    const thumb = state.size;
    for (const node of document.querySelectorAll(".p-masonry")) {
      const list = masonryLists.get(node);
      if (!list) continue;
      const count = Math.max(1, Math.floor((node.clientWidth + 1) / thumb));
      if (!force && node.dataset.cols === String(count)) continue;
      node.dataset.cols = String(count);
      const cols = Array.from({ length: count }, () => el("div", "p-masonry-col"));
      list.forEach((item, i) => {
        cols[i % count].appendChild(itemCard(item));
        if (captionsOn() && hasCaption(item)) cols[i % count].appendChild(captionBlock(item, i, list.length, "card-cap"));
      });
      node.replaceChildren(...cols);
    }
  }

  // ---- Bildtext (0.29): Kennung, Text, Notiz – unter dem Bild und in der Lightbox ----
  function captionsOn() {
    return pref("captions", true) !== false;
  }
  function hasCaption(item) {
    return !!(item && item.caption);
  }

  // Kennung wie im Magazin: Zone—Nummer Position/Anzahl, etwa TYPO—02 3/7
  function captionId(item, i, total) {
    const n = state.zones.findIndex((z) => z.path === item.zone);
    return zoneLabel(item.zone) + "—" + String(n + 1).padStart(2, "0") + (total ? " " + (i + 1) + "/" + total : "");
  }

  function captionBlock(item, i, total, cls) {
    const box = el("div", cls);
    box.appendChild(el("div", "cap-id", captionId(item, i, total)));
    if (item.caption) box.appendChild(el("div", "cap-text", item.caption));
    return box;
  }

  function itemCard(item) {
    let card = cardCache.get(item.path);
    if (!card) {
      card = el("div", "card");
      card.dataset.path = item.path;
      const img = el("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      // Noch nicht geladen: Glasfläche wie die Zonenleiste, beim Laden blendet sie weich aus
      const done = () => card.classList.remove("loading");
      img.addEventListener("load", done);
      img.addEventListener("error", done);
      card.appendChild(img);
      card.appendChild(el("div", "card-badge"));
      card.appendChild(el("div", "card-media"));
      card.appendChild(el("span", "card-fresh"));
      cardCache.set(item.path, card);
    }
    const label = mediaLabel(item);
    const media = card.querySelector(".card-media");
    media.textContent = label;
    media.hidden = !label;
    const img = card.querySelector("img");
    const quote = quoteOf(item);
    card.classList.toggle("card-text", !!quote);
    card.classList.toggle("card-note", isNote(item));
    let sheet = card.querySelector(".text-sheet");
    if (quote) {
      const tone = toneKey(item);
      const key = quote + "|" + (item.links || []).length;
      if (!sheet || sheet.dataset.quote !== key || sheet.dataset.tone !== tone) {
        if (sheet) sheet.remove();
        sheet = textSheet(item, "text-sheet");
        sheet.dataset.quote = key;
        sheet.dataset.tone = tone;
        card.insertBefore(sheet, img);
      }
      img.hidden = true;
    } else {
      if (sheet) sheet.remove();
      img.hidden = false;
      const src = thumbSrc(item);
      if (img.getAttribute("src") !== src) {
        card.classList.add("loading");
        img.src = src;
        if (img.complete && img.naturalWidth) card.classList.remove("loading");
      }
    }
    // Geteilte Bibliothek: Kürzel der Person, die abgelegt hat, nur bei Objekten anderer
    const by = item.addedBy && item.addedBy !== state.user ? byInitials(item.addedBy) + " · " : "";
    card.querySelector(".card-badge").textContent =
      (feat("rights") && item.internal ? t("internalBadge") + " · " : "") + by + (domainOf(item.pageUrl) || item.filename);
    card.classList.toggle("card-internal", feat("rights") && !!item.internal);
    // Seitenverhältnis fürs Bild, damit die Spalten vor dem Laden stehen
    if (state.view === "original" && item.width && item.height) card.style.setProperty("--ar", `${item.width} / ${item.height}`);
    else card.style.removeProperty("--ar");
    card.classList.toggle("selected", state.selection.has(item.path));
    card.classList.toggle("fresh", isFresh(item));
    return card;
  }

  // Kurzversion eines Videos: acht Standbilder aus dem ganzen Clip, nacheinander
  // (wie ein Daumenkino), solange der Zeiger auf der Karte liegt. Ohne Ton.
  const SCRUB_FRAMES = 8;
  const SCRUB_MS = 320;
  function videoScrub(card) {
    const item = state.byPath.get(card.dataset.path);
    if (!item || kindOf(item) !== "video" || card.querySelector(".card-scrub")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    let video = null;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(timer);
      card.removeEventListener("pointerleave", stop);
      if (video) {
        video.removeAttribute("src");
        video.load();
        video.remove();
      }
    };
    card.addEventListener("pointerleave", stop);
    // kurz verweilen, damit Überfahren keine Videos lädt
    timer = setTimeout(() => {
      video = document.createElement("video");
      video.className = "card-scrub";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = fileSrc(item.abs);
      card.appendChild(video);
      let k = 0;
      let at = [];
      const step = () => {
        if (!at.length) return;
        video.currentTime = at[k++ % at.length];
      };
      video.addEventListener("loadedmetadata", () => {
        const d = video.duration;
        if (!isFinite(d) || d <= 0) return stop();
        at = Array.from({ length: SCRUB_FRAMES }, (_, i) => ((i + 0.5) / SCRUB_FRAMES) * d);
        step();
        timer = setInterval(step, SCRUB_MS);
      });
      video.addEventListener("seeked", () => video.classList.add("on"), { once: true });
      video.addEventListener("error", stop);
    }, 250);
  }

  function setFocus(path) {
    // Zone verlassen: was darin neu von anderen war, gilt als gesehen
    if (path !== state.focus && isZone(state.focus) && state.shared) markSeen(zoneItems(state.focus));
    if (path !== state.focus) {
      state.folder = null;
      state.level = null;
      state.folderKbd = null;
    }
    state.focus = path;
    setPref("focus", path);
    if (state.query) {
      state.query = "";
      $("search").value = "";
    }
    closeMenus();
    renderZones();
    renderToolbar();
    $("zones").scrollTop = 0;
  }

  function updateSelectionClasses() {
    for (const [path, card] of cardCache) card.classList.toggle("selected", state.selection.has(path));
    // Auswahl im Fokus: die übrigen Bilder treten zurück
    document.body.classList.toggle("has-selection", state.selection.size > 0);
    renderInfo();
  }

  // ---- Infopanel ----

  function allVisible() {
    if (state.found) return state.found;
    const shown = state.focus != null && state.focus !== ALL && !state.query.trim() ? [state.focus] : state.zones.map((z) => z.path);
    return shown.flatMap((z) => state.lists.get(z) || []);
  }

  function selectedItems() {
    return allVisible().filter((i) => state.selection.has(i.path));
  }

  function zoneSelect(currentZone, onPick) {
    const select = el("select");
    const placeholder = el("option", null, t("moveTo"));
    placeholder.value = "\u0000";
    select.appendChild(placeholder);
    for (const z of state.zones) {
      const opt = el("option", null, zoneLabel(z.path));
      opt.value = z.path;
      if (z.path === currentZone) opt.selected = true;
      select.appendChild(opt);
    }
    if (currentZone != null) placeholder.hidden = true;
    select.addEventListener("change", () => {
      if (select.value !== "\u0000" && select.value !== currentZone) onPick(select.value);
    });
    return select;
  }

  function renderInfo() {
    const panel = $("info");
    panel.hidden = !state.infoOpen;
    if (!state.infoOpen) return;
    // Nicht unter den Fingern neu zeichnen, solange Notiz oder Rechte bearbeitet werden
    const active = document.activeElement;
    if (active && panel.contains(active) && active.matches("textarea, input")) return;
    panel.innerHTML = "";
    const items = selectedItems();

    if (items.length === 0) {
      panel.appendChild(el("p", "info-hint muted", t("shortcuts")));
      return;
    }

    if (items.length > 1) {
      panel.appendChild(el("div", "info-multi", t("selected", { n: items.length })));
      panel.appendChild(zoneSelect(null, (zone) => moveSelection(zone)));
      const actions = el("div", "info-actions");
      if (feat("package")) actions.appendChild(button("btn", t("packageExport"), () => exportPackage(items, t("pdfSelection"))));
      actions.appendChild(button("btn danger", t("trash"), trashSelection));
      panel.appendChild(actions);
      return;
    }

    panel.appendChild(infoContent(items[0], true));
  }

  function toggleInfo() {
    state.infoOpen = !state.infoOpen;
    setPref("infoOpen", state.infoOpen);
    renderToolbar();
    renderInfo();
  }

  // ---- Auswahl ----

  function selectOnly(path) {
    state.selection = new Set(path ? [path] : []);
    state.anchor = path;
    state.lead = path;
    updateSelectionClasses();
  }

  // Shift: alles zwischen Anker und Ziel in sichtbarer Reihenfolge auswählen.
  function extendTo(path, keep) {
    const flat = allVisible().map((i) => i.path);
    const a = flat.indexOf(state.anchor);
    const b = flat.indexOf(path);
    if (a < 0 || b < 0) return selectOnly(path);
    const [from, to] = a < b ? [a, b] : [b, a];
    if (!keep) state.selection.clear();
    for (let i = from; i <= to; i++) state.selection.add(flat[i]);
    state.lead = path;
    updateSelectionClasses();
  }

  function clickCard(path, e) {
    if (e.shiftKey && state.anchor && state.byPath.has(state.anchor)) {
      extendTo(path, e.metaKey || e.ctrlKey);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if (state.selection.has(path)) state.selection.delete(path);
      else state.selection.add(path);
      state.anchor = path;
      state.lead = path;
      updateSelectionClasses();
      return;
    }
    selectOnly(path);
  }

  function scrollIntoView(path) {
    const card = cardCache.get(path);
    if (card) card.scrollIntoView({ block: "nearest" });
  }

  function columnsOf(zone) {
    if (state.view === "original") return 1;
    const node = document.querySelector(`.zone-card[data-zone="${CSS.escape(zone)}"] .zone-card-items`);
    return node ? getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length || 1 : 1;
  }

  // Pfeiltasten: ←/→ durch alle sichtbaren Bilder, ↑/↓ innerhalb einer Kachel.
  // Mit Shift wächst die Auswahl vom Anker aus mit.
  function moveCursor(dir, extend) {
    const cur = (extend && state.lead) || state.anchor;
    const anchor = cur && state.byPath.get(cur);
    const go = (p) => (extend && state.anchor ? (extendTo(p), scrollIntoView(p)) : selectAndShow(p));
    const flat = allVisible();
    if (!flat.length) return;
    if (!anchor) return selectAndShow(flat[0].path);
    if (dir === "left" || dir === "right") {
      const i = flat.findIndex((x) => x.path === anchor.path);
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (dir === "right" ? 1 : -1)))];
      return go(next.path);
    }
    const col = cardCache.get(anchor.path)?.parentElement;
    if (col && col.classList.contains("p-masonry-col")) {
      const card = cardCache.get(anchor.path);
      const next = dir === "down" ? card.nextElementSibling : card.previousElementSibling;
      if (next) go(next.dataset.path);
      return;
    }
    const list = state.lists.get(anchor.zone) || [];
    const i = list.findIndex((x) => x.path === anchor.path);
    const step = columnsOf(anchor.zone) * (dir === "down" ? 1 : -1);
    const next = list[Math.max(0, Math.min(list.length - 1, i + step))];
    if (next) go(next.path);
  }

  // Ordnerkarten per Tastatur: ↑ aus der obersten Bildreihe springt auf die Karten,
  // ←→ wechselt, Enter/Leertaste filtert, ↓ und Esc führen zurück zu den Bildern.
  function folderKey(e) {
    const cards = [...document.querySelectorAll(".p-folder-card")];
    if (!cards.length) return false;
    const list = !!document.querySelector(".p-head-row.is-list");
    const mark = (i) => {
      state.folderKbd = i;
      cards.forEach((c, n) => c.classList.toggle("kbd-focus", n === i));
      if (i != null) cards[i].scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    if (state.folderKbd != null && cards[state.folderKbd]) {
      const i = state.folderKbd;
      // Liste: ↑↓ wandern durch die Einträge, ↓ vom letzten zurück zu den Bildern
      if (list && (e.key === "ArrowUp" || (e.key === "ArrowDown" && i < cards.length - 1))) {
        mark(Math.max(0, i + (e.key === "ArrowUp" ? -1 : 1)));
        return true;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") mark(Math.max(0, Math.min(cards.length - 1, i + (e.key === "ArrowRight" ? 1 : -1))));
      else if (e.key === "Enter" || e.key === " ") cards[i].click();
      else if (e.key === "ArrowDown" || e.key === "Escape") {
        mark(null);
        const first = allVisible()[0];
        if (e.key === "ArrowDown" && first) selectAndShow(first.path);
      } else return false;
      return true;
    }
    if (e.key !== "ArrowUp" || e.shiftKey) return false;
    const flat = allVisible();
    const anchor = state.anchor && cardCache.get(state.anchor);
    const top = flat[0] && cardCache.get(flat[0].path);
    if (anchor && top && anchor.getBoundingClientRect().top > top.getBoundingClientRect().top + 4) return false;
    const x = anchor ? anchor.getBoundingClientRect().left + anchor.offsetWidth / 2 : 0;
    let best = 0;
    cards.forEach((c, n) => {
      const r = c.getBoundingClientRect();
      if (Math.abs(r.left + r.width / 2 - x) < Math.abs(cards[best].getBoundingClientRect().left + cards[best].offsetWidth / 2 - x)) best = n;
    });
    selectOnly(null);
    mark(list ? cards.length - 1 : best);
    return true;
  }

  function selectAndShow(path) {
    selectOnly(path);
    scrollIntoView(path);
  }

  // ---- Aktionen ----

  // Nach Verschieben oder Löschen das nächste Bild derselben Zone auswählen
  // (schneller Inbox-Durchgang mit den Tasten 1–4).
  function rememberPosition(items) {
    const first = items[0];
    const list = state.lists.get(first.zone) || [];
    return { zone: first.zone, index: list.findIndex((i) => i.path === first.path) };
  }

  function selectNextAt(pos) {
    const list = state.lists.get(pos.zone) || [];
    if (!list.length) return selectOnly(null);
    selectAndShow(list[Math.min(pos.index, list.length - 1)].path);
  }

  // ---- ⌘Z: Verschieben, Löschen und Umbenennen rückgängig ----
  const undoStack = [];
  const UNDO_MAX = 30;

  function pushUndo(label, run) {
    undoStack.push({ label, run });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  async function undo() {
    const step = undoStack.pop();
    if (!step) return toast(t("undoNothing"));
    try {
      await step.run();
      await refresh();
      toast(t("undone", { what: step.label }));
    } catch (e) {
      fail(e);
    }
  }

  const dirOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

  async function moveSelection(zone) {
    const items = selectedItems().filter((i) => i.zone !== zone && dirOf(i.path) !== zone);
    if (!items.length) return;
    const pos = rememberPosition(items);
    try {
      const moved = await invoke("move_items", { paths: items.map((i) => i.path), zone });
      if (Array.isArray(moved) && moved.length === items.length) {
        // zurück in den genauen Ordner (auch Unterordner einer Zone)
        const back = items.map((i, k) => [moved[k], i.path.includes("/") ? i.path.slice(0, i.path.lastIndexOf("/")) : i.zone]);
        pushUndo(t("undoMove"), async () => {
          for (const z of new Set(back.map(([, z]) => z))) {
            await invoke("move_items", { paths: back.filter(([, b]) => b === z).map(([p]) => p), zone: z, exact: true });
          }
        });
      }
      await refresh();
      selectNextAt(pos);
      toast(t("moved", { n: items.length, zone: zoneLabel(zone) }));
    } catch (e) {
      fail(e);
    }
  }

  // ⌘C: Bilddaten in die Zwischenablage (für Figma, Photoshop, Keynote …)
  // Textkarten: Text und Bild zusammen – Texteditoren nehmen den Text.
  function copyImages(items) {
    if (!items.length) return;
    const quote = items.length === 1 ? quoteOf(items[0]) : null;
    invoke("copy_images", { paths: items.map((i) => i.abs), text: quote || null })
      .then(() => toast(quote ? t("copiedText") : items.length === 1 ? t("copiedOne") : t("copiedMany", { n: items.length })))
      .catch(fail);
  }

  // Markierter Text (Info-Spalte) geht vor: dann kopiert das System.
  function hasTextSelection() {
    const sel = window.getSelection && window.getSelection();
    return !!sel && !sel.isCollapsed && sel.toString().trim() !== "";
  }

  // Zitat einer Textkarte, markierbar, mit „Text kopieren“
  function quoteBox(item, cls) {
    const box = el("div", cls);
    box.appendChild(el("div", "quote-text", quoteOf(item)));
    const btn = el("button", "lb-link quote-copy", t("copyText"));
    btn.type = "button";
    btn.addEventListener("click", () => copyImages([item]));
    box.appendChild(btn);
    return box;
  }

  async function trashSelection() {
    const items = selectedItems();
    if (!items.length) return;
    const pos = rememberPosition(items);
    try {
      const trashed = await invoke("trash_items", { paths: items.map((i) => i.path) });
      if (Array.isArray(trashed) && trashed.length) pushUndo(t("undoTrash"), () => invoke("restore_items", { items: trashed }));
      await refresh();
      selectNextAt(pos);
      toast(t("trashed", { n: items.length }));
    } catch (e) {
      fail(e);
    }
  }

  // ---- iCloud-Konfliktkopien („Bild 2.jpg“ neben „Bild.jpg“) ----
  // Nur inhaltsgleiche Kopien zählen; abweichende bleiben unangetastet.
  function cloudCopies(items) {
    const out = [];
    for (const item of items) {
      const m = /^(.*) (\d{1,2})(\.[^./]+)?$/.exec(item.path);
      if (!m) continue;
      const orig = state.byPath.get(m[1] + (m[3] || ""));
      if (orig && orig.hash === item.hash) out.push(item);
    }
    return out;
  }

  async function mergeCloudCopies(copies) {
    if (!copies.length) return;
    try {
      const trashed = await invoke("trash_items", { paths: copies.map((i) => i.path) });
      if (Array.isArray(trashed) && trashed.length) pushUndo(t("undoTrash"), () => invoke("restore_items", { items: trashed }));
      await refresh();
      toast(t("cloudMerged", { n: copies.length }));
    } catch (e) {
      fail(e);
    }
  }

  // ---- Zonen anlegen und umbenennen ----

  function undoRename(oldPath, newPath) {
    if (!newPath || newPath === oldPath) return;
    pushUndo(t("undoRename"), async () => {
      const back = await invoke("rename_zone", { zone: newPath, name: lastSegment(oldPath) });
      renameInOrder(newPath, back);
      if (state.focus === newPath) state.focus = back;
    });
  }

  function inlineInput(container, value, onCommit, onCancel) {
    const input = el("input");
    input.value = value;
    input.placeholder = t("newZonePlaceholder");
    input.spellcheck = false;
    container.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v && v !== value) onCommit(v);
      else onCancel();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    for (const type of ["click", "dblclick", "mousedown"]) input.addEventListener(type, (e) => e.stopPropagation());
  }

  function startRename(nameEl, path) {
    inlineInput(
      nameEl,
      lastSegment(path),
      async (name) => {
        try {
          const newPath = await invoke("rename_zone", { zone: path, name });
          undoRename(path, newPath);
          renameInOrder(path, newPath);
          if (state.focus === path) state.focus = newPath;
          await refresh();
        } catch (e) {
          fail(e);
          renderZones();
        }
      },
      renderZones
    );
  }

  // Neue Zone: auf der Startseite die Zeile bzw. Karte „+ Neue Zone“ zum Eingabefeld machen.
  function startNewZone() {
    if (state.focus != null || state.query) setFocus(null);
    const slot = document.querySelector(".p-new .zone-card-name");
    if (!slot) return;
    slot.closest(".p-new").classList.add("editing");
    inlineInput(
      slot,
      "",
      async (value) => {
        try {
          await invoke("create_zone", { name: value });
          await refresh();
        } catch (e) {
          fail(e);
          renderZones();
        }
      },
      renderZones
    );
  }

  // ---- Lightbox (blättert innerhalb der Zone des Bildes) ----

  // Zoom und Leiste wie im Betrachter (viewer.js): Bild als Ebene mit
  // Verschiebung und Maßstab, Einpassen zwischen Titelzeile und Leiste.
  // Mit offener Info-Spalte rückt die Fläche nach links.
  const LB_PAD = { top: 48, bottom: 84, side: 32 };
  const lbView = { w: 0, h: 0, scale: 1, x: 0, y: 0, fitted: true };
  let lbInfoOpen = false;
  // 0.30.1: Bildtext als farbige Karte im Ton des Bildes, wie die Textkarten.
  // „Rückseite“: das Bild wird gewendet, ein Eselsohr unten rechts zeigt, dass
  // es eine hat. „Doppelseite“: die Karte steht links neben dem Bild, gleich
  // hoch, im Hochformat 3:4. Einstellungen › Aussehen. Der Text ist editierbar.
  // Video, PDF und Audio: Karte unten links.
  const LB_TEXT_W = 300;
  const LB_GAP = 24;
  const LB_CARD_MIN = 260;
  let lbFlipped = false;
  function lbTextStyle() {
    return pref("lbTextStyle", "back") === "spread" ? "spread" : "back";
  }
  function lbCaptionItem() {
    const item = lightboxItem();
    return item && hasCaption(item) && !quoteOf(item) ? item : null;
  }
  function lbBackMode() {
    return lbTextStyle() === "back" && lbMode === "image";
  }
  function lbTextShown() {
    if (lbInfoOpen || !lbCaptionItem()) return false;
    return lbBackMode() ? lbFlipped : pref("lbText", true) !== false;
  }
  function lbSpread() {
    return lbMode === "image" && lbTextStyle() === "spread" && lbView.w > 0 && lbTextShown();
  }
  function lbCardW(h) {
    return Math.max(LB_CARD_MIN, h * 0.75);
  }

  function captionCard(item) {
    const lb = state.lightbox;
    const len = item.caption.length;
    const card = el("div", "text-sheet lb-cap-card " + (len < 140 ? "short" : len < 400 ? "medium" : "long"));
    const [bg, fg, dim] = quoteTone(item);
    card.style.setProperty("--ts-bg", bg);
    card.style.setProperty("--ts-fg", fg);
    card.style.setProperty("--ts-dim", dim);
    card.appendChild(el("div", "ts-label", t("captionTitle").toUpperCase() + "  ·  " + captionId(item, lb.index, lbList(lb).length)));
    const body = el("div", "ts-body", item.caption);
    editableText(body, () => item.caption, (v) => {
      item.caption = v;
      saveNote(item, { caption: v });
      lbRenderText();
    });
    card.appendChild(body);
    const date = new Date(item.capturedAt || item.addedAt || 0).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB");
    card.appendChild(el("div", "ts-foot", [domainOf(item.pageUrl), item.capturedAt || item.addedAt ? date : ""].filter(Boolean).join("  ·  ")));
    return card;
  }

  // 0.30.1: Text auf Karten in der Lightbox direkt ändern (Bildtext, Textkarte).
  // Esc oder ⌘↩ beendet, gesichert wird beim Verlassen.
  function editableText(body, current, save) {
    body.contentEditable = "plaintext-only";
    body.spellcheck = false;
    body.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        body.blur();
      }
    });
    body.addEventListener("blur", () => {
      const v = body.innerText.trim();
      if (v !== current()) save(v);
    });
  }

  function lbRenderText() {
    const item = lightboxItem();
    const box = $("lbText");
    const btn = $("lbTextBtn");
    const cap = lbCaptionItem();
    if (!cap) lbFlipped = false;
    btn.hidden = !cap;
    btn.title = t(lbBackMode() ? "captionFlipTitle" : "captionLbTitle");
    btn.classList.toggle("active", lbTextShown());
    const on = lbTextShown();
    $("lightbox").classList.toggle("text-open", on);
    $("lightbox").classList.toggle("flipped", on && lbBackMode());
    box.hidden = !on;
    // Während geschrieben wird, nicht neu aufbauen (library-changed nach dem Sichern)
    if (on && !box.contains(document.activeElement)) box.replaceChildren(captionCard(item));
    lbPlaceText();
  }

  // Bild-Modus: Rückseite deckt das Bild genau, Doppelseite steht links daneben.
  function lbPlaceText() {
    const box = $("lbText");
    lbPlaceEar();
    if (box.hidden) return;
    let r;
    if (lbMode === "image" && lbView.w) {
      const w = lbView.w * lbView.scale;
      const h = lbView.h * lbView.scale;
      if (lbBackMode()) r = { left: lbView.x, top: lbView.y, width: w, height: h };
      else {
        const cw = lbCardW(h);
        r = { left: lbView.x - LB_GAP - cw, top: lbView.y, width: cw, height: h };
      }
    } else {
      const h = Math.min(LB_TEXT_W * (4 / 3), window.innerHeight - LB_PAD.top - LB_PAD.bottom);
      r = { left: LB_PAD.side, top: window.innerHeight - LB_PAD.bottom - h, width: LB_TEXT_W, height: h };
    }
    box.style.visibility = lbMode === "image" && !lbBackMode() && !lbView.fitted ? "hidden" : "";
    for (const k in r) box.style[k] = Math.round(r[k]) + "px";
  }

  // Eselsohr in der Farbe der Karte: dieses Bild hat eine Rückseite
  function lbPlaceEar() {
    let ear = $("lbEar");
    if (!ear) {
      ear = el("button", "lb-ear");
      ear.id = "lbEar";
      ear.type = "button";
      ear.title = t("captionFlipTitle");
      ear.addEventListener("click", (e) => {
        e.stopPropagation();
        lbToggleText();
      });
      $("lightbox").appendChild(ear);
    }
    const item = lbCaptionItem();
    const show = !!item && lbBackMode() && !lbFlipped && !lbInfoOpen && lbView.w > 0;
    ear.hidden = !show;
    if (!show) return;
    ear.style.setProperty("--ts-bg", quoteTone(item)[0]);
    ear.style.left = Math.round(lbView.x + lbView.w * lbView.scale) + "px";
    ear.style.top = Math.round(lbView.y + lbView.h * lbView.scale) + "px";
  }

  function lbToggleText() {
    if (!lbCaptionItem()) return;
    if (lbInfoOpen) lbToggleInfo();
    if (lbBackMode()) return lbFlip();
    setPref("lbText", !(pref("lbText", true) !== false));
    lbRenderText();
    if (lbView.fitted) lbFit(true);
    else {
      lbClamp();
      lbApply(true);
    }
  }

  // Wenden um die senkrechte Mitte: erst das Bild (bzw. die Karte) auf die
  // Kante, dann die andere Seite von der Kante zurück. 2 × 0.18 s.
  function lbFlip() {
    if (!lbView.fitted) lbFit(false);
    const toBack = !lbFlipped;
    const done = () => {
      lbFlipped = toBack;
      lbRenderText();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
    const stage = $("lightboxStage");
    const cx = lbView.x + (lbView.w * lbView.scale) / 2;
    const cy = lbView.y + (lbView.h * lbView.scale) / 2;
    stage.style.transformOrigin = `${cx}px ${cy}px`;
    const edge = (deg) => [{ transform: "perspective(2400px) rotateY(0deg)" }, { transform: `perspective(2400px) rotateY(${deg}deg)` }];
    const out = toBack ? stage : $("lbText");
    $("lbEar").hidden = true;
    out.animate(edge(90), { duration: 180, easing: "ease-in" }).finished.then(() => {
      done();
      const inn = toBack ? $("lbText") : stage;
      inn.animate(edge(-90).reverse(), { duration: 180, easing: "ease-out" });
    });
  }

  // ---- Notiz-Objekte (0.29): ein Blatt im Raster, geschrieben wird in der Lightbox ----
  // Der Text liegt als .md in der Zone. Erste Zeile = Titel (beim Verlassen auch
  // Dateiname), Verknüpfungen stehen links neben dem Blatt.
  const NOTE_TONES = TONES;
  function isNote(item) {
    return !!item && kindOf(item) === "note";
  }

  function noteParts(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const i = lines.findIndex((l) => l.trim());
    if (i < 0) return { title: "", body: "" };
    return { title: lines[i].replace(/^\s*#+\s*/, "").trim(), body: lines.slice(i + 1).join("\n").replace(/^\n+/, "").trimEnd() };
  }
  function noteText(title, body) {
    title = title.trim();
    body = body.trimEnd();
    return (title ? "# " + title + (body ? "\n\n" : "\n") : "") + body;
  }
  function noteDate(item, year) {
    const d = new Date(item.addedAt || item.mtime || Date.now());
    return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", year ? undefined : { day: "2-digit", month: "2-digit" });
  }
  function noteWords(text) {
    const m = String(text).match(/[^\s#]+/g);
    return m ? m.length : 0;
  }
  function linkedItems(item) {
    const byHash = new Map(state.items.map((i) => [i.hash, i]));
    return (item.links || []).map((h) => byHash.get(h)).filter(Boolean);
  }

  // Blatt im Raster (A1): Kennung, fetter Titel, Text, Fuß mit Verknüpfungen
  function noteSheet(item, cls) {
    const { title, body } = noteParts(item.quote);
    const len = (title + body).length;
    const sheet = el("div", cls + " note-sheet" + (len < 140 ? " short" : len < 400 ? " medium" : " long"));
    const [bg, fg, dim] = quoteTone(item);
    sheet.style.setProperty("--ts-bg", bg);
    sheet.style.setProperty("--ts-fg", fg);
    sheet.style.setProperty("--ts-dim", dim);
    sheet.dataset.tone = toneKey(item);
    sheet.appendChild(el("div", "ts-label", t("noteLabel") + " · " + noteDate(item)));
    sheet.appendChild(el("div", "ts-title", title || t("noteUntitled")));
    sheet.appendChild(el("div", "ts-body", body));
    const n = linkedItems(item).length;
    sheet.appendChild(el("div", "ts-foot", n ? t("noteObjects", { n }) : ""));
    return sheet;
  }

  // Speichern der Reihe nach: der Hash ändert sich mit jedem Text, Farbe und
  // Verknüpfungen müssen den aktuellen treffen.
  let noteQueue = Promise.resolve();
  function noteChain(fn) {
    noteQueue = noteQueue.then(fn, fn).catch(fail);
    return noteQueue;
  }

  let noteEd = null;
  async function noteSave(rename) {
    const ed = noteEd;
    if (!ed) return;
    clearTimeout(ed.timer);
    const text = noteText(ed.title.value, ed.body.value);
    if (!ed.dirty && !(rename && ed.renameDue)) return false;
    ed.dirty = false;
    if (!rename) ed.renameDue = true;
    else ed.renameDue = false;
    ed.status.textContent = t("noteSaving");
    const item = ed.item;
    await noteChain(async () => {
      let r;
      try {
        r = await invoke("write_note", { path: item.path, text, rename: !!rename });
      } catch (e) {
        // Nicht gesichert: Text bleibt „ungespeichert“, der nächste Anlauf
        // (Tippen, ⌘S, Schließen) versucht es erneut (0.31.0)
        ed.dirty = true;
        if (rename) ed.renameDue = true;
        if (noteEd === ed) ed.status.textContent = t("noteSaveFailed");
        throw e;
      }
      const old = item.path;
      Object.assign(item, { hash: r.hash, quote: text.trim() || null, path: r.path, mtime: Date.now() });
      if (r.path !== old) {
        item.abs = item.abs.slice(0, item.abs.length - old.length) + r.path;
        item.filename = r.path.split("/").pop();
        state.byPath.delete(old);
        state.byPath.set(r.path, item);
        cardCache.delete(old);
      }
      if (noteEd === ed) {
        ed.status.textContent = t("noteSaved");
        $("lbName").textContent = item.filename;
      }
    });
    return true;
  }

  function noteLeave() {
    if (!noteEd) return;
    const ed = noteEd;
    noteSave(true).then((saved) => saved && render());
    noteEd = null;
    closeNoteChooser();
    return ed;
  }

  // Lightbox (A2): Papier zum Schreiben, Verknüpfungen links daneben
  function lbNoteEditor(item, box) {
    const { title, body } = noteParts(item.quote);
    const wrap = el("div", "lb-note");
    const paper = el("div", "note-paper");
    lbNoteTone(paper, item);
    paper.appendChild(el("div", "np-label", [t("noteLabel"), zoneLabel(item.zone), noteDate(item, true)].join(" · ")));
    const titleIn = el("input", "np-title");
    titleIn.value = title;
    titleIn.placeholder = t("noteTitlePh");
    titleIn.spellcheck = false;
    const bodyIn = el("textarea", "np-body");
    bodyIn.value = body;
    bodyIn.placeholder = t("noteBodyPh");
    const foot = el("div", "np-foot");
    const words = el("span", null, t("noteWords", { n: noteWords(title + " " + body) }));
    const status = el("span", null, t("noteSaved"));
    foot.append(words, status);
    paper.append(titleIn, bodyIn, noteLinks(item), foot);
    wrap.appendChild(paper);
    box.appendChild(wrap);
    noteEd = { item, title: titleIn, body: bodyIn, status, paper, dirty: false, renameDue: false, timer: null };
    const ed = noteEd;
    const changed = () => {
      ed.dirty = true;
      words.textContent = t("noteWords", { n: noteWords(titleIn.value + " " + bodyIn.value) });
      status.textContent = "";
      clearTimeout(ed.timer);
      ed.timer = setTimeout(() => noteEd === ed && noteSave(false), 600);
    };
    for (const f of [titleIn, bodyIn]) {
      f.addEventListener("input", changed);
      f.addEventListener("keydown", (e) => {
        e.stopPropagation(); // Pfeile, Leertaste, 1–4 gehören hier dem Text
        if (e.key === "Escape") {
          e.preventDefault();
          f.blur();
        } else if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          noteSave(false);
        } else if (f === titleIn && (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey))) {
          e.preventDefault();
          bodyIn.focus();
          bodyIn.setSelectionRange(0, 0);
        } else if (f === bodyIn && e.key === "ArrowUp" && bodyIn.selectionStart === 0 && bodyIn.selectionEnd === 0) {
          e.preventDefault();
          titleIn.focus();
        } else if (f === bodyIn && e.key === "Backspace" && bodyIn.selectionStart === 0 && bodyIn.selectionEnd === 0) {
          e.preventDefault();
          titleIn.focus();
          titleIn.setSelectionRange(titleIn.value.length, titleIn.value.length);
        }
      });
    }
    // Ohne Schreibrechte (geteilte Zone eines anderen) nur lesen
    if (!canEdit(item.zone)) {
      titleIn.readOnly = bodyIn.readOnly = true;
      status.textContent = "";
    }
    $("lightboxZoom").textContent = "";
    lbRenderTones(item);
    return ed;
  }

  function lbNoteTone(node, item) {
    node.dataset.tone = toneKey(item);
    const [bg, fg, dim] = quoteTone(item);
    node.style.setProperty("--ts-bg", bg);
    node.style.setProperty("--ts-fg", fg);
    node.style.setProperty("--ts-dim", dim);
  }

  // Farbpunkte in der Leiste, nur bei Notizen
  function lbRenderTones(item) {
    const box = $("lbTones");
    box.hidden = !isNote(item);
    if (box.hidden) return box.replaceChildren();
    const current = toneKey(item);
    box.replaceChildren(
      ...NOTE_TONES.map((key) => {
        const b = el("button", "tone-dot" + (key === current ? " active" : ""));
        b.type = "button";
        b.title = t("tone_" + key);
        b.style.setProperty("--dot", QUOTE_TONES[key][0]);
        b.addEventListener("click", () => setNoteTone(item, key));
        return b;
      })
    );
  }

  function setNoteTone(item, key) {
    if (key === toneKey(item)) return;
    item.tone = key;
    saveNote(item, { tone: key });
    if (noteEd && noteEd.item === item) lbNoteTone(noteEd.paper, item);
    lbRenderTones(item);
    render();
  }

  // Verknüpfungen: Vorschauen in zwei Spalten, „+“ wählt weitere aus der Bibliothek
  function noteLinks(item) {
    const col = el("aside", "note-links");
    const fill = () => {
      const list = linkedItems(item);
      const grid = el("div", "nl-grid");
      list.forEach((it, i) => {
        const tile = el("button", "nl-tile");
        tile.type = "button";
        tile.title = it.filename;
        tile.appendChild(quoteOf(it) ? (isNote(it) ? noteSheet(it, "text-sheet mini") : textSheet(it, "text-sheet mini")) : Object.assign(el("img"), { src: thumbSrc(it), alt: "", loading: "lazy" }));
        const x = el("span", "nl-remove", "×");
        x.title = t("noteLinkRemove");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          setNoteLinks(item, (item.links || []).filter((h) => h !== it.hash));
          fill();
        });
        tile.appendChild(x);
        tile.addEventListener("click", () => openNoteLink(item, i));
        grid.appendChild(tile);
      });
      if (canEdit(item.zone)) {
        const add = el("button", "nl-tile nl-add", "+");
        add.type = "button";
        add.title = t("noteLinkAdd");
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          openNoteChooser(item, add, fill);
        });
        grid.appendChild(add);
      }
      col.replaceChildren(el("div", "nl-label", t("noteLinks") + (list.length ? " (" + list.length + ")" : "")), grid);
    };
    fill();
    return col;
  }

  function setNoteLinks(item, links) {
    item.links = links.length ? links : null;
    saveNote(item, { links });
  }

  // Verknüpftes Objekt groß: die Lightbox blättert dann durch Notiz und Verknüpfte
  function openNoteLink(item, i) {
    const list = [item, ...linkedItems(item)];
    noteLeave();
    state.lightbox = { zone: null, list, index: i + 1 };
    showLightboxItem();
  }

  let noteChooser = null;
  function closeNoteChooser() {
    if (!noteChooser) return;
    noteChooser.remove();
    noteChooser = null;
  }

  // Auswahl (0.29.1, Variante A): erst die Zonen als kleine Karten wie im Tray,
  // Klick öffnet die Zone mit ihren Objekten. Das Suchfeld durchsucht alles.
  function openNoteChooser(item, anchor, onChange) {
    closeNoteChooser();
    const pop = el("div", "note-chooser zone-menu p-ctx-menu");
    noteChooser = pop;
    pop.addEventListener("click", (e) => e.stopPropagation());
    pop.addEventListener("pointerdown", (e) => e.stopPropagation());
    const input = el("input", "nc-search");
    input.placeholder = t("noteLinkSearch");
    const head = el("div", "nc-head");
    const body = el("div", "nc-body");
    const foot = el("div", "nc-foot");
    let zone = null;
    const tile = (it, linked) => {
      const b = el("button", "nc-tile" + (linked.has(it.hash) ? " on" : ""));
      b.type = "button";
      b.title = it.filename;
      b.appendChild(quoteOf(it) ? textSheet(it, "text-sheet mini") : Object.assign(el("img"), { src: thumbSrc(it), alt: "", loading: "lazy" }));
      b.addEventListener("click", () => {
        const now = new Set(item.links || []);
        if (now.has(it.hash)) now.delete(it.hash);
        else now.add(it.hash);
        setNoteLinks(item, [...now]);
        b.classList.toggle("on", now.has(it.hash));
        onChange();
        footer();
      });
      return b;
    };
    const zoneCard = (z) => {
      const list = orderedItems(z.path).filter((i) => i !== item);
      const c = el("button", "nc-zone");
      c.type = "button";
      const cover = el("div", "nc-cover" + (list.length >= 3 ? " trio" : "") + (list.length ? "" : " empty"));
      for (const it of list.slice(0, list.length >= 3 ? 3 : 1)) cover.appendChild(quoteOf(it) ? textSheet(it, "text-sheet mini") : Object.assign(el("img"), { src: thumbSrc(it), alt: "", loading: "lazy" }));
      const name = el("div", "nc-zone-name");
      name.append(el("span", null, lastSegment(z.path) || z.name), el("span", "nc-count", String(list.length)));
      c.append(cover, name);
      c.title = zoneLabel(z.path);
      c.addEventListener("click", () => {
        zone = z.path;
        fill();
      });
      return c;
    };
    const footer = () => {
      const n = (item.links || []).length;
      foot.replaceChildren(el("span", null, zone || input.value.trim() ? t("noteLinkHintPick") : t("noteLinkHintZone")), el("span", null, n ? t("noteObjects", { n }) : ""));
    };
    const fill = () => {
      const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const linked = new Set(item.links || []);
      const pool = state.items.filter((i) => i !== item && i.hash !== item.hash);
      let tiles = null;
      if (words.length) {
        head.replaceChildren(el("span", null, t("noteLinkFound")));
        tiles = pool.filter((i) => matches(i, words));
      } else if (zone != null) {
        const back = el("button", "nc-back", "‹ " + t("noteLinkZones"));
        back.type = "button";
        back.addEventListener("click", () => {
          zone = null;
          fill();
        });
        const list = orderedItems(zone).filter((i) => i !== item && i.hash !== item.hash);
        head.replaceChildren(back, el("span", "nc-crumb", "/ " + zoneLabel(zone) + " (" + list.length + ")"));
        tiles = list;
      } else {
        head.replaceChildren(el("span", null, t("noteLinkZones") + " (" + state.zones.length + ")"));
        body.className = "nc-body nc-zones";
        body.replaceChildren(...state.zones.map(zoneCard));
      }
      if (tiles) {
        body.className = "nc-body nc-grid";
        const shown = tiles.slice(0, 120).map((it) => tile(it, linked));
        body.replaceChildren(...(shown.length ? shown : [el("div", "nc-empty", t("noteLinkEmpty"))]));
      }
      footer();
    };
    input.addEventListener("input", debounce(fill, 120));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (input.value) {
          input.value = "";
          fill();
        } else if (zone != null) {
          zone = null;
          fill();
        } else closeNoteChooser();
      }
    });
    pop.append(input, head, body, foot);
    document.body.appendChild(pop);
    fill();
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8)) + "px";
    pop.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - pr.height - 8)) + "px";
    input.focus();
    setTimeout(() => document.addEventListener("pointerdown", closeNoteChooser, { once: true }), 0);
  }

  // Neue Notiz auf der aktuellen Ebene, öffnet gleich zum Schreiben
  async function newNote() {
    if (!isZone(state.focus) || !canEdit(state.focus)) return toast(t("noteNeedsZone"));
    const dir = state.focus + (state.level ? "/" + state.level : "");
    try {
      const rel = await invoke("create_note", { dir, title: t("noteNew") });
      await refresh();
      const item = state.byPath.get(rel);
      if (!item) return;
      openLightbox(item);
      if (noteEd && noteEd.item === item) {
        noteEd.title.focus();
        noteEd.title.select();
      }
    } catch (e) {
      fail(e);
    }
  }

  function lbArea() {
    const right = lbInfoOpen ? $("lbInfo").offsetWidth : 0;
    return { width: window.innerWidth - right, height: window.innerHeight };
  }

  function lbCenter() {
    const a = lbArea();
    return [a.width / 2, a.height / 2];
  }

  function lbBox() {
    const a = lbArea();
    const box = {
      left: LB_PAD.side,
      top: LB_PAD.top,
      width: Math.max(1, a.width - LB_PAD.side * 2),
      height: Math.max(1, a.height - LB_PAD.top - LB_PAD.bottom),
    };
    // Doppelseite: Karte und Bild gleich hoch, zusammen mittig
    if (lbSpread()) {
      const ar = lbView.w / lbView.h;
      const hd = Math.min(box.height, lbView.h, (box.width - LB_GAP) / (ar + 0.75));
      const cw = lbCardW(hd);
      const iw = Math.max(1, Math.min(hd * ar, box.width - cw - LB_GAP));
      box.left += (box.width - (cw + LB_GAP + iw)) / 2 + cw + LB_GAP;
      box.width = iw;
    }
    return box;
  }

  function lbFitScale() {
    if (!lbView.w || !lbView.h) return 1;
    const box = lbBox();
    return Math.min(box.width / lbView.w, box.height / lbView.h, 1);
  }

  function lbApply(animate) {
    const img = $("lightboxImg");
    img.classList.toggle("anim", !!animate);
    img.style.transform = `translate(${lbView.x}px, ${lbView.y}px) scale(${lbView.scale})`;
    $("lightbox").classList.toggle("zoomed", !lbView.fitted);
    lbPlaceText();
    // PDF, Video und Audio führen ihr eigenes Etikett (Seite bzw. Dauer)
    if (lbMode === "image") $("lightboxZoom").textContent = "(" + (lbView.fitted ? t("viewerFit") : `${Math.round(lbView.scale * 100)} %`) + ")";
  }

  // Kleiner als das Fenster: mittig. Größer: Ränder nicht ins Fenster ziehen.
  function lbClamp() {
    const a = lbArea();
    const box = lbBox();
    const w = lbView.w * lbView.scale;
    const h = lbView.h * lbView.scale;
    lbView.x = w <= a.width ? box.left + (box.width - w) / 2 : Math.min(0, Math.max(a.width - w, lbView.x));
    lbView.y = h <= a.height ? box.top + (box.height - h) / 2 : Math.min(0, Math.max(a.height - h, lbView.y));
  }

  function lbFit(animate) {
    lbView.scale = lbFitScale();
    lbView.fitted = true;
    lbClamp();
    lbApply(animate);
  }

  // Rauszoomen bis auf ein Fünftel der eingepassten Größe; nahe „Einpassen“ rastet es ein.
  function lbZoomAt(scale, cx, cy, animate) {
    const fitS = lbFitScale();
    const next = Math.min(16, Math.max(fitS * 0.2, scale));
    if (Math.abs(next - fitS) / fitS < 0.03) return lbFit(animate);
    lbView.x = cx - (cx - lbView.x) * (next / lbView.scale);
    lbView.y = cy - (cy - lbView.y) * (next / lbView.scale);
    lbView.scale = next;
    lbView.fitted = false;
    lbClamp();
    lbApply(animate);
  }

  // Einpassen ↔ Originalgröße (bei kleinen Bildern doppelt)
  function lbToggleZoom(cx, cy) {
    if (lbMode === "pdf" && lbPdf) return lbPdf.setZoom(lbPdf.fitted() ? 2 : 1);
    if (lbMode === "video" && lbVZoom) return lbVZoom.toggle(cx, cy);
    if (lbMode !== "image") return;
    if (!lbView.fitted) return lbFit(true);
    const [mx, my] = lbCenter();
    lbZoomAt(lbFitScale() >= 1 ? 2 : 1, cx ?? mx, cy ?? my, true);
  }

  // Finden: die Lightbox blättert durch die Treffer in ihrer Rangfolge, sonst durch die Zone
  const FOUND = "\u0000found";
  function lbList(lb) {
    if (lb.list) return lb.list; // Notiz und ihre Verknüpfungen
    return lb.zone === FOUND ? state.found || [] : state.lists.get(lb.zone) || [];
  }

  function openLightbox(item) {
    if (item && state.shared) markSeen([item]);
    if (!item) return;
    const zone = state.found && state.found.includes(item) ? FOUND : item.zone;
    const list = lbList({ zone });
    state.lightbox = { zone, index: Math.max(0, list.indexOf(item)) };
    $("lightbox").hidden = false;
    document.body.classList.add("lightbox-open");
    lbView.fitted = true;
    showLightboxItem();
  }

  function lightboxItem() {
    const lb = state.lightbox;
    const list = lb ? lbList(lb) : [];
    return list[Math.min(lb ? lb.index : 0, list.length - 1)];
  }

  function showLightboxItem() {
    const lb = state.lightbox;
    const list = lbList(lb);
    const item = list[Math.min(lb.index, list.length - 1)];
    if (!item) return closeLightbox();
    noteLeave();
    lbRenderTones(item);
    if (lb.shown !== item) lbFlipped = false;
    lb.shown = item;
    lb.index = list.indexOf(item);
    $("lbName").textContent = item.filename;
    $("lbName").title = item.filename;
    // Quelle nur, wenn es eine gibt; der blaue Knopf zeigt die Zone
    $("lbSourceBtn").hidden = !item.pageUrl;
    $("lbSourceBtn").title = item.pageUrl || "";
    // 0.30.1: Linkkarte mit gesicherter Seite (Extension, aus der Adressleiste gezogen)
    $("lbOfflineBtn").hidden = true;
    if (item.pageUrl && item.hash)
      invoke("web_archive", { hash: item.hash })
        .then((p) => lightboxItem() === item && ($("lbOfflineBtn").hidden = !p))
        .catch(() => {});
    const zoneName = $("lbAction").querySelector(".lb-action-zone");
    if (zoneName) zoneName.textContent = zoneLabel(item.zone);
    $("lbBrowse").hidden = list.length < 2;
    $("lbCount").textContent = `${lb.index + 1} / ${list.length}`;
    lbCloseZones();
    // Zuletzt gelöscht: nur ansehen, zurückholen oder endgültig löschen
    const gone = !!lb.deleted;
    $("lightbox").classList.toggle("is-deleted", gone);
    $("lbAction").hidden = gone;
    $("lbInfoBtn").hidden = gone;
    $("lbRestoreBtn").hidden = !gone;
    $("lbRemoveBtn").hidden = !gone;
    if (gone && lbInfoOpen) lbToggleInfo();
    if (lbInfoOpen) lbRenderInfo(item);
    lbRenderText();
    if (gone) {
      state.delSel = new Set([item.abs]);
      const card = document.querySelector(`.card.del[data-del="${CSS.escape(item.abs)}"]`);
      document.querySelectorAll(".card.del.selected").forEach((c) => c !== card && c.classList.remove("selected"));
      if (card) {
        card.classList.add("selected");
        card.scrollIntoView({ block: "nearest" });
      }
    } else selectAndShow(item.path);
    if (lbShowMedia(item)) return;
    const img = $("lightboxImg");
    const src = fileSrc(item.abs);
    img.classList.add("loading");
    img.onload = () => {
      if (img.getAttribute("src") !== src) return;
      lbView.w = img.naturalWidth;
      lbView.h = img.naturalHeight;
      img.style.width = lbView.w + "px";
      img.style.height = lbView.h + "px";
      // Beim Blättern bleibt die Zoomstufe; das neue Bild steht mittig.
      if (lbView.fitted) lbFit(false);
      else {
        const [mx, my] = lbCenter();
        lbView.x = mx - (lbView.w * lbView.scale) / 2;
        lbView.y = my - (lbView.h * lbView.scale) / 2;
        lbClamp();
        lbApply(false);
      }
      img.classList.remove("loading");
    };
    img.src = src;
  }

  // ---- Lightbox: PDF (Seiten untereinander) und Video ----

  let lbPdf = null;

  let lbMode = "image";

  // Eigener Player für Audio und Video: obere Reihe der Navigationsleiste
  let lbPlayer = null;
  function lbSetPlayer(media) {
    if (lbPlayer) lbPlayer.destroy();
    lbPlayer = media ? Media.player(media) : null;
    if (lbPlayer) document.querySelector(".lb-nav").prepend(lbPlayer.row);
    $("lightbox").classList.toggle("has-player", !!lbPlayer);
  }

  // Video: Zoom-Knopf zeigt „Einpassen“ bzw. die Stufe, wie bei Bildern
  let lbVZoom = null;
  function lbVideoZoomed(scale) {
    $("lightboxZoom").textContent = "(" + (scale > 1 ? `${Math.round(scale * 100)} %` : t("viewerFit")) + ")";
    $("lightbox").classList.toggle("zoomed", scale > 1);
  }

  // Zeigt PDF oder Video statt des Bildes. false = normales Bild.
  function lbShowMedia(item) {
    const gone = state.lightbox && state.lightbox.deleted;
    const k = isNote(item) && !gone ? "note" : quoteOf(item) ? "text" : kindOf(item);
    const box = $("lbMedia");
    const img = $("lightboxImg");
    lbMode = k;
    lbVZoom = null;
    $("lightbox").classList.remove("zoomed");
    lbSetPlayer(null);
    $("lightbox").classList.toggle("media", k !== "image");
    $("lightbox").classList.toggle("is-video", k === "video");
    if (k === "image") {
      box.hidden = true;
      box.replaceChildren();
      if (lbPdf) lbPdf.destroy();
      lbPdf = null;
      img.hidden = false;
      return false;
    }
    img.hidden = true;
    img.removeAttribute("src");
    box.hidden = false;
    if (lbPdf) lbPdf.destroy();
    lbPdf = null;
    box.replaceChildren();
    if (k === "note") {
      lbNoteEditor(item, box);
      return true;
    }
    if (k === "text") {
      const wrap = el("div", "lb-text");
      const sheet = textSheet(item, "text-sheet large");
      // Das PNG bleibt, wie es gesichert wurde; die App zeigt den geänderten Text
      const body = sheet.querySelector(".ts-body");
      if (item.quote) editableText(body, () => item.quote, (v) => {
        if (!v) return (body.textContent = item.quote);
        item.quote = v;
        invoke("set_quote", { hash: item.hash, quote: v }).catch(fail);
      });
      wrap.appendChild(sheet);
      box.appendChild(wrap);
      $("lightboxZoom").textContent = "";
      return true;
    }
    if (k === "audio") {
      const sub = [item.artist, item.album].filter(Boolean).join(" · ");
      const wrap = Media.audioEl(fileSrc(item.abs), item.thumb ? fileSrc(item.thumb) : null, item.title || item.filename, sub);
      box.appendChild(wrap);
      lbSetPlayer(wrap.querySelector("audio"));
      Media.autoplay(wrap.querySelector("audio"), "audio");
      $("lightboxZoom").textContent = "";
      return true;
    }
    if (k === "video") {
      const v = Media.videoEl(fileSrc(item.abs), item.thumb ? fileSrc(item.thumb) : null);
      box.appendChild(v);
      lbVZoom = Media.zoomable(v, lbVideoZoomed);
      lbSetPlayer(v);
      lbVideoZoomed(1);
      Media.autoplay(v, "video");
      return true;
    }
    lbPdf = new Media.PdfView(box, { padTop: LB_PAD.top, padBottom: LB_PAD.bottom, onChange: lbPdfChanged });
    lbPdf.open(fileSrc(item.abs)).catch((e) => toast(t("error", { msg: String(e && e.message || e) }), false));
    lbPdfChanged(lbPdf);
    return true;
  }

  // Zoom-Knopf zeigt bei PDFs Seite und Zoomstufe
  function lbPdfChanged(view) {
    const n = view.count();
    const page = n ? t("pdfPageOf", { n: view.current(), total: n }) : "PDF";
    const zoom = view.fitted() ? t("viewerFit") : `${Math.round(view.zoom * 100)} %`;
    $("lightboxZoom").textContent = `(${page} · ${zoom})`;
  }

  // ---- Lightbox: Info-Spalte (wie im Betrachter) ----

  function lbRow(label, value) {
    const r = el("div", "lb-row");
    r.appendChild(el("span", "lb-row-label", label));
    const v = el("span", "lb-row-value");
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value;
    r.appendChild(v);
    return r;
  }

  function lbBlock(title, rows) {
    const block = el("section", "lb-block");
    block.appendChild(el("div", "lb-block-title", title));
    for (const r of rows) if (r) block.appendChild(r);
    return block;
  }

  function lbRenderInfo(item) {
    item = item || lightboxItem();
    if (!item) return;
    $("lbInfo").replaceChildren(infoContent(item, false));
  }

  // Info zu einem Objekt, in der Lightbox und im Details-Panel gleich:
  // Kopf mit Name und Größe, Blöcke „Archiver“ und „Datei“, Links darunter.
  // Im Panel ist die Zone wählbar und „In den Papierkorb“ kommt dazu.
  function infoContent(item, panel) {
    const inner = el("div");
    const head = el("div", "lb-info-head");
    head.appendChild(el("span", null, item.filename + " "));
    const size = mediaSize(item);
    const lead = [size, formatBytes(item.bytes)].filter(Boolean).join(", ");
    head.appendChild(el("span", "lead", lead + "."));
    inner.appendChild(head);
    if (isNote(item)) inner.appendChild(lbBlock(t("noteLabelTitle"), [lbRow(t("noteLinks"), String(linkedItems(item).length)), lbRow(t("toneLabel"), tonePicker(item))]));
    else if (quoteOf(item)) inner.appendChild(lbBlock(t("quote"), [quoteBox(item, "lb-quote"), lbRow(t("toneLabel"), tonePicker(item))]));
    if (!quoteOf(item)) inner.appendChild(lbBlock(t("captionTitle"), [noteField(item, "caption", t("captionPlaceholder"), true)]));

    let source = null;
    if (item.pageUrl) {
      const link = el("button", "lb-link", item.pageTitle || domainOf(item.pageUrl));
      link.type = "button";
      link.title = item.pageUrl;
      link.addEventListener("click", () => invoke("open_url", { url: sourceUrl(item) }).catch(fail));
      source = lbRow(t("source"), link);
    }
    let imageUrl = null;
    if (item.imageUrl) {
      const link = el("button", "lb-link", domainOf(item.imageUrl) || item.imageUrl);
      link.type = "button";
      link.title = item.imageUrl;
      link.addEventListener("click", () => invoke("open_url", { url: item.imageUrl }).catch(fail));
      imageUrl = lbRow(t("imageUrl"), link);
    }
    inner.appendChild(
      lbBlock("Archiver", [
        lbRow(t("zone"), panel ? zoneSelect(item.zone, (zone) => moveSelection(zone)) : zoneLabel(item.zone)),
        subfolderOf(item) ? lbRow(t("subfolder"), subfolderOf(item).split("/").join(" / ")) : null,
        source || lbRow(t("source"), t("noSource")),
        imageUrl,
        lbRow(t("savedAt"), formatDate(item.capturedAt || item.addedAt)),
        item.addedBy ? lbRow(t("addedBy"), item.addedBy) : null,
      ])
    );
    if (feat("rights")) {
      const internal = chip("(" + t("internal") + ")", !!item.internal, () => {
        item.internal = !item.internal;
        internal.classList.toggle("active", item.internal);
        saveNote(item, { internal: item.internal });
      });
      inner.appendChild(
        lbBlock(t("rights"), [
          lbRow(t("credit"), noteField(item, "credit", t("creditPlaceholder"))),
          lbRow(t("license"), noteField(item, "license", t("licensePlaceholder"))),
          lbRow("", internal),
        ])
      );
    }
    inner.appendChild(
      lbBlock(t("viewerFile"), [
        item.pages ? lbRow(t("pages"), String(item.pages)) : null,
        item.duration ? lbRow(t("duration"), Media.duration(item.duration)) : null,
        ...audioRows(item).map(([label, value]) => lbRow(label, value)),
        size ? lbRow(kindOf(item) === "pdf" ? t("pageSize") : t("dimensions"), size) : null,
        lbRow(t("fileSize"), formatBytes(item.bytes)),
        lbRow(t("format"), item.format.toUpperCase() === "JPG" ? "JPEG" : item.format.toUpperCase()),
      ])
    );

    const links = el("div", "lb-links");
    const reveal = el("button", "lb-link", t("reveal"));
    reveal.type = "button";
    reveal.addEventListener("click", () => invoke("reveal", { path: item.abs }).catch(fail));
    const open = el("button", "lb-link", t("openFile"));
    open.type = "button";
    open.addEventListener("click", () => invoke("open_file", { path: item.abs }).catch(fail));
    links.append(reveal, open);
    if (panel) {
      const trash = el("button", "lb-link danger", t("trash"));
      trash.type = "button";
      trash.addEventListener("click", trashSelection);
      links.appendChild(trash);
    }
    inner.appendChild(links);
    return inner;
  }

  // Notiz, Urheber, Lizenz: speichert beim Verlassen des Felds (⌘↩ ebenso)
  function noteField(item, key, placeholder, multi) {
    const f = el(multi ? "textarea" : "input", "note-field" + (multi ? " note-text" : ""));
    f.value = item[key] || "";
    f.placeholder = placeholder;
    f.spellcheck = multi;
    if (multi) {
      f.rows = 1;
      const grow = () => {
        f.style.height = "auto";
        f.style.height = f.scrollHeight + "px";
      };
      f.addEventListener("input", grow);
      requestAnimationFrame(grow);
    }
    const commit = () => {
      const value = f.value.trim();
      if (value === (item[key] || "")) return;
      item[key] = value || null;
      item._idx = null;
      saveNote(item, { [key]: value });
    };
    f.addEventListener("blur", commit);
    f.addEventListener("keydown", (e) => {
      e.stopPropagation(); // Leertaste, Pfeile, 1–4 gehören hier dem Text
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || !multi))) {
        e.preventDefault();
        f.blur();
      }
    });
    return f;
  }

  // Farbe einer Textkarte: fünf Töne und Weiß
  function tonePicker(item) {
    const row = el("div", "tone-picker");
    const current = toneKey(item);
    for (const key of TONES) {
      const b = el("button", "tone-dot" + (key === current ? " active" : ""));
      b.type = "button";
      b.title = t("tone_" + key);
      b.style.setProperty("--dot", QUOTE_TONES[key][0]);
      b.addEventListener("click", () => {
        if (key === toneKey(item)) return;
        item.tone = key;
        saveNote(item, { tone: key });
        for (const d of row.children) d.classList.toggle("active", d === b);
        render();
        if (state.lightbox && lightboxItem() === item) {
          if (noteEd && noteEd.item === item) {
            lbNoteTone(noteEd.paper, item);
            lbRenderTones(item);
          } else showLightboxItem();
        }
      });
      row.appendChild(b);
    }
    return row;
  }

  function saveNote(item, patch) {
    // Notiz-Objekte: nach dem Text, damit der neue Hash getroffen wird
    if (isNote(item)) return noteChain(() => invoke("set_note", { hashes: [item.hash], patch }));
    invoke("set_note", { hashes: [item.hash], patch }).catch(fail);
  }

  // ---- Zone oder Auswahl als Paket (Dateien, Quellen.csv/.md, Kontaktbogen) ----
  async function exportPackage(items, title) {
    if (!items.length) return toast(t("pdfNothing"));
    const date = new Date().toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
    const meta = t(items.length === 1 ? "pdfCount1" : "pdfCount", { n: items.length }) + " · " + date;
    try {
      const r = await invoke("export_package", { paths: items.map((i) => i.path), title, meta, sheet: true });
      if (!r) return;
      toast(t("packageDone", { n: r.count }) + (r.internal ? " " + t("packageInternal", { n: r.internal }) : ""), true, r.internal ? 6000 : 2600);
    } catch (e) {
      fail(e);
    }
  }

  // Maße: Bilder und Videos in Pixeln, PDF-Seiten in Millimetern
  function mediaSize(item) {
    if (!item.width || !item.height) return "";
    if (kindOf(item) === "pdf") {
      const mm = (pt) => Math.round((pt * 25.4) / 72);
      return `${mm(item.width)} × ${mm(item.height)} mm`;
    }
    return `${item.width} × ${item.height} px`;
  }

  function lbToggleInfo() {
    if (!lbInfoOpen && state.lightbox && state.lightbox.deleted) return;
    lbInfoOpen = !lbInfoOpen;
    $("lightbox").classList.toggle("info-open", lbInfoOpen);
    $("lbInfoBtn").classList.toggle("active", lbInfoOpen);
    if (lbInfoOpen) lbRenderInfo();
    lbRenderText();
    if (lbView.fitted) lbFit(true);
    else {
      lbClamp();
      lbApply(true);
    }
  }

  // ---- Lightbox: „● Archiver“ klappt „Ablegen in“ auf ----

  function lbOpenZones() {
    const item = lightboxItem();
    if (!item) return;
    const chips = state.zones.map((zone, i) => {
      const c = el("button", "lb-chip" + (zone.path === item.zone ? " current" : "") + (i < HOT_ZONES ? " hot" : ""));
      c.type = "button";
      c.dataset.zone = zone.path; // Ziel auch beim Ziehen aus der Lightbox
      if (i < HOT_ZONES) c.appendChild(el("span", "lb-key", String(i + 1)));
      c.appendChild(zoneNameEl(zone));
      c.addEventListener("click", () => lbMoveTo(zone.path));
      return c;
    });
    // Hot Zones zuerst, durch eine feine Linie vom Rest abgesetzt
    if (chips.length > HOT_ZONES) chips.splice(HOT_ZONES, 0, el("span", "lb-chip-sep"));
    $("lbZones").replaceChildren(el("span", "lb-mono", t("dropBar")), ...chips);
    $("lbZones").hidden = false;
    $("lbAction").classList.add("active");
    lbBalanceZones();
  }

  // Passen nicht alle Zonen in eine Zeile, werden die Zeilen gleich lang
  // statt eines einzelnen Rests in der letzten Zeile.
  function lbBalanceZones() {
    const bar = $("lbZones");
    bar.style.width = "";
    bar.classList.add("measure");
    const natural = bar.scrollWidth;
    bar.classList.remove("measure");
    const room = bar.getBoundingClientRect().width;
    if (natural <= room + 1) return;
    const rows = Math.ceil(natural / room);
    bar.style.width = Math.min(room, Math.ceil(natural / rows) + 48) + "px";
  }

  function lbCloseZones() {
    $("lbZones").hidden = true;
    $("lbAction").classList.remove("active");
  }

  function lbMoveTo(zone) {
    lbCloseZones();
    const item = lightboxItem();
    if (!item || item.zone === zone) return;
    selectOnly(item.path);
    moveSelection(zone).then(() => (state.lightbox ? showLightboxItem() : null));
  }

  function stepLightbox(delta) {
    const lb = state.lightbox;
    const n = lbList(lb).length;
    if (!n) return;
    lb.index = (lb.index + delta + n) % n;
    showLightboxItem();
  }

  function closeLightbox() {
    noteLeave();
    $("lightbox").classList.remove("is-deleted");
    $("lbAction").hidden = false;
    $("lbInfoBtn").hidden = false;
    $("lbRestoreBtn").hidden = true;
    $("lbRemoveBtn").hidden = true;
    $("lbTones").hidden = true;
    state.lightbox = null;
    lbCloseZones();
    if (lbPdf) lbPdf.destroy();
    lbPdf = null;
    lbMode = "image";
    lbSetPlayer(null);
    $("lbMedia").replaceChildren();
    $("lbMedia").hidden = true;
    $("lightboxImg").hidden = false;
    $("lightbox").classList.remove("media", "is-video");
    $("lightbox").hidden = true;
    $("lightbox").classList.remove("zoomed");
    document.body.classList.remove("lightbox-open");
    $("lightboxImg").removeAttribute("src");
  }

  function bindLightbox() {
    const stage = $("lightboxStage");
    $("lightboxPrev").addEventListener("click", () => stepLightbox(-1));
    $("lightboxNext").addEventListener("click", () => stepLightbox(1));
    $("lightboxZoom").addEventListener("click", () => lbToggleZoom());
    $("lbInfoBtn").textContent = t("viewerInfo");
    $("lbInfoBtn").addEventListener("click", lbToggleInfo);
    $("lbTextBtn").textContent = t("captionChip");
    $("lbTextBtn").title = t("captionLbTitle");
    $("lbTextBtn").addEventListener("click", lbToggleText);
    $("lbRestoreBtn").textContent = t("deletedRestore");
    $("lbRestoreBtn").addEventListener("click", () => {
      const item = lightboxItem();
      if (item) restoreDeleted([item.abs]);
    });
    $("lbRemoveBtn").textContent = t("deletedRemove");
    $("lbRemoveBtn").addEventListener("click", () => {
      const item = lightboxItem();
      if (item) askRemoveDeleted([item.abs]);
    });
    $("lbSourceBtn").textContent = t("source");
    $("lbSourceBtn").addEventListener("click", () => {
      const item = lightboxItem();
      if (item && item.pageUrl) invoke("open_url", { url: sourceUrl(item) }).catch(fail);
    });
    $("lbOfflineBtn").textContent = t("offlinePage");
    $("lbOfflineBtn").title = t("offlinePageTitle");
    $("lbOfflineBtn").addEventListener("click", () => {
      const item = lightboxItem();
      if (item) invoke("open_web_archive", { hash: item.hash }).catch(fail);
    });
    const action = $("lbAction");
    action.replaceChildren(el("span", "lb-dot"), el("span", "lb-action-zone", "Archiver"));
    action.title = t("dropBar");
    action.addEventListener("click", () => ($("lbZones").hidden ? lbOpenZones() : lbCloseZones()));
    // 0.28: Klick neben das Objekt schließt (offene Zonen erst zuklappen, gezoomt nicht)
    const backdropClick = (e) => {
      if (!$("lbZones").hidden) return lbCloseZones();
      const bg = e.target === stage || e.target === $("lbMedia") || e.target.classList.contains("pdf-scroll") || e.target.classList.contains("lb-note");
      if (bg && lbView.fitted && state.lightbox) closeLightbox();
    };
    stage.addEventListener("click", backdropClick);
    $("lbMedia").addEventListener("click", backdropClick);
    // PDF: Zwei-Finger-Zoom bzw. ⌘ + Scrollen zoomt, Scrollen blättert
    $("lbMedia").addEventListener(
      "wheel",
      (e) => {
        if (!lbPdf || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const d = Math.max(-50, Math.min(50, e.deltaY));
        lbPdf.setZoom(lbPdf.zoom * Math.exp(-d * 0.01));
      },
      { passive: false }
    );

    // Zwei-Finger-Zoom kommt als wheel mit ctrlKey, ⌘ + Scrollen ebenso.
    // Ohne Taste wird ein vergrößertes Bild verschoben.
    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const d = Math.max(-50, Math.min(50, e.deltaY));
          lbZoomAt(lbView.scale * Math.exp(-d * 0.01), e.clientX, e.clientY);
        } else if (!lbView.fitted) {
          lbView.x -= e.deltaX;
          lbView.y -= e.deltaY;
          lbClamp();
          lbApply();
        }
      },
      { passive: false }
    );

    // Safari-Gesten (WebKit auf dem Mac)
    let gestureBase = 1;
    stage.addEventListener("gesturestart", (e) => {
      e.preventDefault();
      gestureBase = lbView.scale;
    });
    stage.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      lbZoomAt(gestureBase * e.scale, e.clientX, e.clientY);
    });
    stage.addEventListener("gestureend", (e) => e.preventDefault());

    // Ganzes Bild ziehen: Zonen klappen auf, das Bild lässt sich hineinlegen
    // (oder in den Finder). Vergrößert verschiebt Ziehen den Ausschnitt.
    let lift = null;
    $("lightboxImg").draggable = false;
    window.addEventListener("resize", () => {
      if (!$("lbZones").hidden) lbBalanceZones();
    });
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !lbView.fitted || lbMode !== "image") return;
      if (e.target !== $("lightboxImg") || state.lightbox.deleted) return;
      lift = { x: e.clientX, y: e.clientY };
    });
    stage.addEventListener("pointermove", (e) => {
      if (!lift || !(e.buttons & 1)) return;
      if (Math.hypot(e.clientX - lift.x, e.clientY - lift.y) < DRAG_THRESHOLD) return;
      lift = null;
      const item = lightboxItem();
      if (!item) return;
      const opened = $("lbZones").hidden;
      if (opened) lbOpenZones();
      startNativeDrag([item], () => {
        if (opened && state.lightbox) setTimeout(lbCloseZones, 300);
      });
    });
    stage.addEventListener("pointerup", () => (lift = null));

    // Ziehen verschiebt das vergrößerte Bild
    let drag = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || lbView.fitted) return;
      drag = { x: e.clientX, y: e.clientY, vx: lbView.x, vy: lbView.y };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      lbView.x = drag.vx + e.clientX - drag.x;
      lbView.y = drag.vy + e.clientY - drag.y;
      lbClamp();
      lbApply();
    });
    const endDrag = () => {
      drag = null;
      stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("dblclick", (e) => lbToggleZoom(e.clientX, e.clientY));

    window.addEventListener("resize", () => {
      if (!state.lightbox) return;
      if (lbView.fitted) lbFit(false);
      else {
        lbClamp();
        lbApply();
      }
    });
  }

  function lightboxKey(e, mod) {
    const [cx, cy] = lbCenter();
    if (mod && lbMode === "pdf" && lbPdf && /^[=+\-0]$/.test(e.key)) {
      lbPdf.setZoom(e.key === "0" ? 1 : e.key === "-" ? lbPdf.zoom / 1.25 : lbPdf.zoom * 1.25);
      return true;
    }
    if (mod && lbMode === "video" && lbVZoom && /^[=+\-0]$/.test(e.key)) {
      if (e.key === "0") lbVZoom.reset();
      else lbVZoom.zoomBy(e.key === "-" ? 1 / 1.25 : 1.25);
      return true;
    }
    if (mod) {
      if (e.key === "=" || e.key === "+") lbZoomAt(lbView.scale * 1.25, cx, cy, true);
      else if (e.key === "-") lbZoomAt(lbView.scale / 1.25, cx, cy, true);
      else if (e.key === "0") lbFit(true);
      else if (e.key === "d" || e.key === "D") lbToggleInfo();
      else if (e.key === "c") {
        if (hasTextSelection()) return false;
        copyImages([lightboxItem()].filter(Boolean));
      }
      else return false;
      return true;
    }
    if (state.lightbox.deleted) {
      if (e.key === "Backspace" || e.key === "Delete") {
        const item = lightboxItem();
        if (item) askRemoveDeleted([item.abs]);
        return true;
      }
      if (/^[1-4]$/.test(e.key) || e.key === "Enter" || e.key === "i" || e.key === "I") return true;
    }
    if (lbMode === "pdf" && lbPdf && (e.key === "ArrowDown" || e.key === "ArrowUp")) lbPdf.step(e.key === "ArrowDown" ? 1 : -1);
    else if (lbMode === "pdf" && lbPdf && e.key === "Escape" && !lbPdf.fitted() && $("lbZones").hidden) lbPdf.setZoom(1);
    else if (e.key === "ArrowRight") stepLightbox(1);
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "z" || e.key === "Z") lbToggleZoom();
    else if (e.key === "i" || e.key === "I") lbToggleInfo();
    else if ((e.key === "t" || e.key === "T") && hasCaption(lightboxItem())) lbToggleText();
    else if (e.key === "Enter") $("lbZones").hidden ? lbOpenZones() : lbCloseZones();
    else if (e.key === "Escape" && !$("lbZones").hidden) lbCloseZones();
    else if (e.key === "Escape" && lbMode === "video" && lbVZoom && lbVZoom.scale() > 1) lbVZoom.reset();
    else if (e.key === "Escape" && !lbView.fitted) lbFit(true);
    else if (e.key === " " && (lbMode === "video" || lbMode === "audio") && Media.togglePlay($("lbMedia"))) {}
    else if (e.key === "Escape" || e.key === " ") closeLightbox();
    else if (/^[1-4]$/.test(e.key)) {
      const zone = state.zones[Number(e.key) - 1];
      if (zone) moveSelection(zone.path).then(() => (state.lightbox ? showLightboxItem() : null));
    } else return false;
    return true;
  }

  // ---- Import ----

  async function openImportDialog() {
    const info = await invoke("start_info").catch(() => ({}));
    const modal = $("modal");
    const dialog = el("div", "dialog");
    dialog.appendChild(el("h3", null, t("importTitle")));
    const status = el("span", "muted");

    const run = async (cmd, args) => {
      for (const b of dialog.querySelectorAll("button")) b.disabled = true;
      status.textContent = t("importRunning");
      try {
        const r = await invoke(cmd, args);
        closeModal();
        toast(t("importDone", { imported: r.imported, duplicates: r.duplicates, sources: r.withSource }));
        if (r.missing) toast(t("importMissing", { n: r.missing }), false);
        await refresh();
      } catch (e) {
        status.textContent = "";
        for (const b of dialog.querySelectorAll("button")) b.disabled = false;
        fail(e);
      }
    };

    const ext = el("section");
    ext.appendChild(el("h4", null, t("importExtension")));
    ext.appendChild(el("p", null, t("importExtensionText")));
    const extRow = el("div", "row");
    if (info.extensionExport) {
      ext.appendChild(el("div", "path", t("importExtensionFound", { path: info.extensionExport })));
      extRow.appendChild(
        button("btn primary", t("importExtensionRun"), () =>
          run("import_extension_export", { path: info.extensionExport })
        )
      );
    }
    extRow.appendChild(
      button("btn", t("importExtensionPick"), async () => {
        const path = await invoke("pick_export_file");
        if (path) run("import_extension_export", { path });
      })
    );
    ext.appendChild(extRow);
    dialog.appendChild(ext);

    const folder = el("section");
    folder.appendChild(el("h4", null, t("importFolder")));
    folder.appendChild(el("p", null, t("importFolderText")));
    const folderRow = el("div", "row");
    folderRow.appendChild(
      button("btn", t("importFolderPick"), async () => {
        const path = await invoke("pick_folder");
        if (path) run("import_folder", { path });
      })
    );
    folder.appendChild(folderRow);
    dialog.appendChild(folder);

    const foot = el("div", "dialog-foot");
    status.style.marginRight = "auto";
    foot.appendChild(status);
    foot.appendChild(button("btn", t("close"), closeModal));
    dialog.appendChild(foot);

    modal.replaceChildren(dialog);
    modal.hidden = false;
  }

  function closeModal() {
    $("modal").onEnter = null;
    $("modal").hidden = true;
    $("modal").innerHTML = "";
  }

  // ---- Ziehen: raus aus der App und wieder hinein ----

  const DRAG_THRESHOLD = 5;
  let pressed = null; // { path, x, y }
  let suppressClick = false;

  // Hot Zones: Beim Ziehen fahren unten die ersten vier Zonen als große
  // Karten ein (wie in der Extension). Welche vier, bestimmt die Übersicht;
  // Die Tasten 1–4 legen in genau diese vier.
  // Zone, in der alle gezogenen Objekte schon liegen: wird nicht hervorgehoben
  let dragHome = null;
  function showDropbar() {
    const bar = $("dropbar");
    if (!bar.hidden) return;
    const cards = state.zones.slice(0, HOT_ZONES).map((zone, i) => {
      const c = el("div", "p-hot");
      c.dataset.zone = zone.path;
      c.classList.toggle("is-home", zone.path === dragHome);
      c.appendChild(el("span", "p-drop-key", String(i + 1).padStart(2, "0")));
      c.appendChild(zoneNameEl(zone));
      c.appendChild(el("span", "p-hot-hint", t("hotRelease")));
      return c;
    });
    bar.replaceChildren(...cards);
    bar.hidden = false;
    document.body.classList.add("dragging");
  }

  // Vorschau beim Einstellen der Deckkraft: die Leiste steht, solange der Regler bewegt wird
  let previewTimer = 0;
  function previewDropbar(on) {
    clearTimeout(previewTimer);
    const bar = $("dropbar");
    if (on) {
      if (bar.hidden) {
        showDropbar();
        document.body.classList.remove("dragging");
        bar.classList.add("preview");
      }
      previewTimer = setTimeout(() => previewDropbar(false), 1600);
    } else if (bar.classList.contains("preview")) {
      bar.classList.remove("preview");
      hideDropbar();
    }
  }

  // Abgelegt: Liegt das Ziel in der Leiste, bleibt sie kurz stehen und
  // blendet dann ruhig aus (kein Glühen, keine Bewegung).
  let landingUntil = 0;
  function landOn(target) {
    const bar = $("dropbar");
    if (!target) return hideDropbar();
    if (bar.hidden || !bar.contains(target)) return hideDropbar();
    bar.classList.add("leaving");
    landingUntil = Date.now() + 500;
    setTimeout(() => {
      landingUntil = 0;
      hideDropbar();
    }, 500);
  }

  function hideDropbar() {
    if (Date.now() < landingUntil) return;
    $("dropbar").classList.remove("leaving");
    dragHome = null;
    $("dropbar").hidden = true;
    document.body.classList.remove("dragging");
  }

  async function startNativeDrag(items, onEnd) {
    const channel = new TAURI.core.Channel();
    // Das Ende des Ziehens kann vor dem Drop-Ereignis ankommen. Die Leiste
    // bleibt deshalb kurz stehen, sonst findet der Drop sein Ziel nicht mehr.
    channel.onmessage = () => {
      setTimeout(hideDropbar, 250);
      if (onEnd) onEnd();
    };
    const zones = new Set(items.map((i) => i.zone));
    dragHome = zones.size === 1 ? [...zones][0] : null;
    if (!document.body.classList.contains("at-home")) showDropbar();
    const first = items[0];
    // kleines Drag-Bild, damit die Zonen beim Ziehen sichtbar bleiben
    const icon =
      (await invoke("drag_icon", { hash: first.hash, path: first.thumb || first.abs, color: quoteOf(first) && !first.thumb ? quoteTone(first)[0] : null }).catch(() => null)) ||
      first.thumb ||
      // nie das Original (große Bilder würden riesig gezogen): neutrale Fläche
      (await invoke("drag_icon", { hash: first.hash, path: first.abs, color: "#8c8c8c" }).catch(() => null)) ||
      first.abs;
    invoke("plugin:drag|start_drag", {
      item: items.map((i) => i.abs),
      image: icon,
      onEvent: channel,
    }).catch(fail);
  }

  function zoneCardAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    return hit ? hit.closest("[data-zone]") : null;
  }

  function insideLibrary(path) {
    return state.root && path.startsWith(state.root + "/");
  }

  function clearDropUi() {
    for (const n of document.querySelectorAll(".drop-active")) n.classList.remove("drop-active");
    for (const n of document.querySelectorAll(".drop-target")) n.classList.remove("drop-target");
  }

  // Umsortieren: alle gezogenen Objekte liegen in der gerade offenen Zone,
  // die Maus steht über einer anderen Karte dieser Zone. Das Ziel trägt den
  // Fokus-Ring; die Objekte nehmen seinen Platz ein (nach vorn gezogen davor,
  // nach hinten gezogen dahinter).
  function reorderTarget(x, y) {
    if (!feat("order") || !isZone(state.focus) || state.query.trim() || filtersActive()) return null;
    if (state.folder != null || zoneLayout(state.focus) === "sections") return null; // nur im vollen Raster
    if (!dragPaths.length || dragHome !== state.focus) return null;
    const rels = dragPaths.filter(insideLibrary).map((p) => p.slice(state.root.length + 1));
    if (rels.length !== dragPaths.length || rels.some((r) => (state.byPath.get(r) || {}).zone !== state.focus)) return null;
    const hit = document.elementFromPoint(x, y);
    const card = hit && !hit.closest("#dropbar") ? hit.closest("#zones .card") : null;
    if (!card || rels.includes(card.dataset.path)) return null;
    const list = state.lists.get(state.focus) || [];
    const at = (path) => list.findIndex((i) => i.path === path);
    const after = at(rels[0]) < at(card.dataset.path);
    return { card, ref: card.dataset.path, after, moved: rels };
  }

  let dragPaths = [];
  let lastTarget = null;
  let lastReorder = null;

  function onDragDrop(event) {
    if (!isUnlocked()) return;
    const p = event.payload;
    if (p.type === "leave") {
      dragPaths = [];
      lastTarget = null;
      lastReorder = null;
      return clearDropUi();
    }
    if (p.type === "enter" && !document.body.classList.contains("at-home")) showDropbar();
    if (p.paths) dragPaths = p.paths;
    // macOS meldet die Position schon in Punkten (logisch), andere Systeme in Pixeln
    const ratio = isMac ? 1 : window.devicePixelRatio || 1;
    const x = p.position ? p.position.x / ratio : -1;
    const y = p.position ? p.position.y / ratio : -1;
    let target = zoneCardAt(x, y);

    if (p.type === "enter" || p.type === "over") {
      clearDropUi();
      lastTarget = target;
      lastReorder = target && target.dataset.zone !== dragHome ? null : reorderTarget(x, y);
      if (lastReorder) lastReorder.card.classList.add("drop-target");
      if (target && target.dataset.zone !== dragHome) target.classList.add("drop-active");
      return;
    }
    // Beim Drop gilt das zuletzt markierte Ziel: ist die Leiste schon weg,
    // läge an derselben Stelle sonst die eigene Zone darunter.
    if (lastTarget) target = lastTarget;
    lastTarget = null;
    const reorder = lastReorder;
    lastReorder = null;

    if (p.type === "drop" && reorder && (!target || target.dataset.zone === dragHome)) {
      clearDropUi();
      hideDropbar();
      dragPaths = [];
      return reorderInZone(state.focus, reorder.moved, reorder.ref, reorder.after);
    }

    if (p.type === "drop") {
      clearDropUi();
      landOn(target && dragPaths.length && target.dataset.zone !== dragHome ? target : null);
      const paths = dragPaths;
      dragPaths = [];
      if (!paths.length) return;
      if (!target) {
        // 0.27: Ordner (und Dateien) von außen ohne Ziel: Ordner werden zu Zonen,
        // lose Dateien landen in der Standard-Zone
        const outside = paths.filter((path) => !insideLibrary(path));
        if (outside.length && state.focus !== DELETED)
          invoke("import_files", { paths: outside, zone: "" })
            .then((r) => {
              toast(t("importDone", { imported: r.imported, duplicates: r.duplicates, sources: r.withSource }));
              return refresh();
            })
            .catch(fail);
        return;
      }
      const zone = target.dataset.zone;
      // Aus der Lightbox auf eine ihrer Zonen: wie ein Klick auf die Zone
      const lbItem = state.lightbox && target.classList.contains("lb-chip") ? lightboxItem() : null;
      if (lbItem && paths.length === 1 && paths[0] === lbItem.abs) return lbMoveTo(zone);
      const own = paths.filter(insideLibrary).map((path) => path.slice(state.root.length + 1));
      const foreign = paths.filter((path) => !insideLibrary(path));
      const toMove = own.filter((rel) => {
        const item = state.byPath.get(rel);
        return item && item.zone !== zone && dirOf(rel) !== zone;
      });
      if (toMove.length) {
        state.selection = new Set(toMove);
        moveSelection(zone);
      }
      if (foreign.length) {
        invoke("import_files", { paths: foreign, zone })
          .then((r) => {
            toast(t("importDone", { imported: r.imported, duplicates: r.duplicates, sources: r.withSource }));
            return refresh();
          })
          .catch(fail);
      }
    }
  }

  // Suche klappt in der Navigation auf (das Feld ist zu, solange es leer ist)
  function openSearch() {
    $("navSearch").classList.add("open");
    $("search").focus();
  }

  // ---- Ausgeben: PDF-Ersteller (⌘P) ----
  // Nimmt die Auswahl, sonst alles, was in der Zone oder unter „Finden“ sichtbar ist.
  // Vorschau der Seiten im gewählten Layout; Referenzen lassen sich verschieben
  // und herausnehmen, dann schreibt lib.rs das PDF.

  const PDF_LAYOUTS = [
    // [Schlüssel, Spalten × Zeilen quer, Spalten × Zeilen hoch]
    ["1", [1, 1], [1, 1]],
    ["2", [2, 1], [1, 2]],
    ["4", [2, 2], [2, 2]],
    ["6", [3, 2], [2, 3]],
    ["12", [4, 3], [3, 4]],
    ["16", [4, 4], [4, 4]],
  ];
  const PDF_PAGE = { long: 842, short: 595, margin: 40, gap: 20, caption: 28 };

  function exportPdf() {
    if (document.querySelector(".pdf-maker")) return;
    const home = document.body.classList.contains("at-home");
    const items = state.selection.size ? selectedItems() : home ? [] : allVisible();
    if (!items.length) return toast(t("pdfNothing"));
    const zones = new Set(items.map((i) => i.zone));
    const query = state.query.trim();
    const title = query ? "„" + query + "“" : zones.size === 1 ? zoneLabel([...zones][0]) : t("pdfSelection");
    openPdfMaker(items.slice(), title);
  }

  function sheetItem(i) {
    return {
      thumb: i.thumb || null,
      file: kindOf(i) === "image" ? i.abs : null,
      name: i.quote ? domainOf(i.pageUrl) || i.filename : i.filename,
      source: i.quote ? i.pageTitle || null : [i.artist, i.album].filter(Boolean).join(" · ") || domainOf(i.pageUrl) || null,
      quote: i.quote || null,
      label: String(i.format || "").toUpperCase(),
      note: i.caption || null, // PDF „Mit Bildtext“
    };
  }

  // ---- Moodboard: Objekte frei auf einer Seite (PDF-Ersteller, Stil „Moodboard“) ----
  // Lage und Größe als Anteile (0–1) der Fläche zwischen Kopf und Fuß, wie
  // pdf.rs board_area. Gemerkt je Auswahl (über die Hashes), damit ein
  // Moodboard beim nächsten Öffnen so aussieht wie verlassen.

  const BOARD_GAP = 8; // Punkte
  function boardArea(portrait) {
    const P = PDF_PAGE;
    const [w, h] = portrait ? [P.short, P.long] : [P.long, P.short];
    return { w: w - 2 * P.margin, h: h - P.margin - 30 - (P.margin + 18) };
  }

  function boardRatio(item) {
    if (item.quote || quoteOf(item)) return 4 / 3;
    return item.width && item.height ? item.width / item.height : 1;
  }

  // Erste Anordnung: Zeilen im Blocksatz, so viele, dass die Fläche am besten gefüllt ist
  function boardAuto(items, portrait, notes) {
    const A = boardArea(portrait);
    const cap = notes ? 22 : 0;
    const ratios = items.map(boardRatio);
    let best = null;
    for (let rows = 1; rows <= Math.max(1, items.length); rows++) {
      // Zeilen mit möglichst gleicher Summe der Seitenverhältnisse
      const total = ratios.reduce((a, b) => a + b, 0);
      const lines = [];
      let line = [];
      let sum = 0;
      ratios.forEach((r, i) => {
        line.push(i);
        sum += r;
        if (sum >= (total / rows) * (lines.length + 1) - r / 2 && lines.length < rows - 1) {
          lines.push(line);
          line = [];
        }
      });
      if (line.length) lines.push(line);
      const heights = lines.map((l) => (A.w - BOARD_GAP * (l.length - 1)) / l.reduce((a, i) => a + ratios[i], 0));
      const used = heights.reduce((a, b) => a + b + cap, 0) + BOARD_GAP * (lines.length - 1);
      const scale = Math.min(1, A.h / used);
      const fill = used * scale * (A.w * scale) / (A.w * A.h);
      if (!best || fill > best.fill) best = { lines, heights, scale, used, fill };
    }
    const pos = new Map();
    let y = (A.h - best.used * best.scale) / 2;
    best.lines.forEach((l, li) => {
      const h = best.heights[li] * best.scale;
      const width = l.reduce((a, i) => a + ratios[i] * h, 0) + BOARD_GAP * best.scale * (l.length - 1);
      let x = (A.w - width) / 2;
      for (const i of l) {
        const w = ratios[i] * h;
        pos.set(items[i].path, { x: x / A.w, y: y / A.h, w: w / A.w, h: h / A.h });
        x += w + BOARD_GAP * best.scale;
      }
      y += h + (cap + BOARD_GAP) * best.scale;
    });
    return pos;
  }

  function boardKey(items) {
    let h = 0;
    for (const s of items.map((i) => i.hash).sort().join("")) h = (h * 31 + s.charCodeAt(0)) >>> 0;
    return "board." + h.toString(36);
  }

  // Helligkeit unten links im Vorschaubild (wo die Plakat-Beschriftung steht).
  // Klappt nur, wenn das Bild lesbar ist; sonst bleibt die Schrift dunkel.
  function captionTone(img) {
    try {
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 32;
      const x = c.getContext("2d", { willReadFrequently: true });
      const box = img.parentElement.getBoundingClientRect();
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const scale = Math.max(box.width / nw, box.height / nh);
      const vw = box.width / scale, vh = box.height / scale;
      const sx = (nw - vw) / 2, sy = (nh - vh) / 2;
      x.drawImage(img, sx, sy, vw, vh, 0, 0, 32, 32);
      const d = x.getImageData(1, 26, 16, 5).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4) / 255 < 0.5 ? "dark" : "light";
    } catch {
      return null;
    }
  }

  function openPdfMaker(items, title, preset) {
    const opts = {
      title,
      layout: pref("pdfLayout", items.length === 1 ? "1" : items.length === 2 ? "2" : "6"),
      portrait: pref("pdfPortrait", false),
      captions: pref("pdfCaptions", true),
      poster: pref("pdfPoster", false),
      board: feat("moodboard") && pref("pdfBoard", false),
      notes: pref("pdfNotes", false),
      dark: pref("pdfBoardDark", false),
    };
    if (preset && preset.poster) opts.board = false;
    // Moodboard: Lage je Objekt (Pfad → x, y, w, h), Reihenfolge der Liste = Stapel
    const saved = pref(boardKey(items), null);
    let board = saved && saved.portrait === opts.portrait ? new Map(Object.entries(saved.pos)) : null;
    const boardFit = () => {
      board = boardAuto(items, opts.portrait, opts.notes);
      saveBoard();
    };
    const saveBoard = () => setPref(boardKey(items), { portrait: opts.portrait, pos: Object.fromEntries(board) });
    if (board && items.some((i) => !board.has(i.path))) board = null;
    // Tour, Kapitel Plakat: gleich im Plakat-Stil, hoch, 16 pro Seite
    if (preset && preset.poster && !opts.poster) Object.assign(opts, { poster: true, portrait: true, layout: "16" });
    if (items.length <= 2 && !["1", "2"].includes(opts.layout)) opts.layout = items.length === 1 ? "1" : "2";
    const date = new Date().toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
    const meta = () => t(items.length === 1 ? "pdfCount1" : "pdfCount", { n: items.length }) + " · " + date;
    const grid = () => {
      const entry = PDF_LAYOUTS.find(([k]) => k === opts.layout) || PDF_LAYOUTS[3];
      const [cols, rows] = opts.portrait ? entry[2] : entry[1];
      return { cols, rows };
    };

    const root = el("div", "pdf-maker");
    const side = el("aside", "pdf-side");
    const stage = el("div", "pdf-stage");
    root.append(side, stage);

    // ---- Seitenleiste: Titel, Layout, Format, Bildunterschrift ----
    side.appendChild(el("h2", "pdf-title", t("pdfExport")));
    const titleInput = el("input", "pdf-input");
    titleInput.value = opts.title;
    titleInput.spellcheck = false;
    titleInput.addEventListener("input", () => {
      opts.title = titleInput.value;
      renderPages();
    });
    side.appendChild(field(t("pdfTitleLabel"), titleInput));

    const styleRow = el("div", "pdf-chips");
    side.appendChild(field(t("pdfStyleLabel"), styleRow));
    const layoutRow = el("div", "pdf-layouts");
    side.appendChild(field(t("pdfLayoutLabel"), layoutRow));
    const formatRow = el("div", "pdf-chips");
    side.appendChild(field(t("pdfFormatLabel"), formatRow));
    const captionRow = el("div", "pdf-chips");
    side.appendChild(field(t("pdfCaptionsLabel"), captionRow));
    const bgRow = el("div", "pdf-chips");
    const bgField = field(t("pdfBoardBg"), bgRow);
    side.appendChild(bgField);
    const layoutField = layoutRow.parentElement;
    const hint = el("p", "pdf-hint", t("pdfHint"));
    side.appendChild(hint);
    const count = el("div", "pdf-count");
    side.appendChild(count);

    const actions = el("div", "pdf-actions");
    actions.appendChild(button("btn", t("cancel"), close));
    const save = button("btn primary", t("pdfSave"), run);
    actions.appendChild(save);
    side.appendChild(actions);

    // div statt label: ein label leitet Klicks an den ersten Knopf darin weiter
    function field(label, control) {
      const f = el("div", "pdf-field");
      f.appendChild(el("span", "p-mono dim", "(" + label + ")"));
      f.appendChild(control);
      return f;
    }

    function renderControls() {
      layoutRow.replaceChildren(
        ...PDF_LAYOUTS.map(([key]) => {
          const b = button("pdf-layout" + (opts.layout === key ? " active" : ""), "", () => {
            opts.layout = key;
            setPref("pdfLayout", key);
            renderAll();
          });
          const { cols, rows } = (() => {
            const e = PDF_LAYOUTS.find(([k]) => k === key);
            const [c, r] = opts.portrait ? e[2] : e[1];
            return { cols: c, rows: r };
          })();
          const mini = el("span", "pdf-mini" + (opts.portrait ? " portrait" : ""));
          mini.style.setProperty("--cols", cols);
          mini.style.setProperty("--rows", rows);
          for (let n = 0; n < cols * rows; n++) mini.appendChild(el("i"));
          b.appendChild(mini);
          b.appendChild(el("span", "p-mono", key));
          b.title = t("pdfPerPage", { n: key });
          return b;
        })
      );
      const sheetStyle = () => {
        opts.board = false;
        setPref("pdfBoard", false);
      };
      styleRow.replaceChildren(
        chip("(" + t("pdfStyleSheet") + ")", !opts.poster && !opts.board, () => {
          sheetStyle();
          setOpt("poster", false, "pdfPoster");
        }),
        chip("(" + t("pdfStylePoster") + ")", opts.poster && !opts.board, () => {
          sheetStyle();
          // Plakat lebt vom dichten Raster: beim ersten Wechsel hochkant mit 16 pro Seite
          if (!opts.poster && pref("pdfPosterSet", false) === false) {
            setPref("pdfPosterSet", true);
            opts.portrait = true;
            setPref("pdfPortrait", true);
            opts.layout = "16";
            setPref("pdfLayout", "16");
          }
          setOpt("poster", true, "pdfPoster");
        })
      );
      if (feat("moodboard"))
        styleRow.appendChild(
          chip("(" + t("pdfStyleMoodboard") + ")", opts.board, () => {
            opts.poster = false;
            setPref("pdfPoster", false);
            setOpt("board", true, "pdfBoard");
          })
        );
      layoutField.hidden = opts.board;
      bgField.hidden = !opts.board;
      bgRow.replaceChildren(
        chip("(" + t("pdfBoardLight") + ")", !opts.dark, () => setOpt("dark", false, "pdfBoardDark")),
        chip("(" + t("pdfBoardDark") + ")", opts.dark, () => setOpt("dark", true, "pdfBoardDark")),
        chip("(" + t("pdfBoardArrange") + ")", false, () => {
          boardFit();
          renderPages();
        })
      );
      formatRow.replaceChildren(
        chip("(" + t("pdfLandscape") + ")", !opts.portrait, () => setOpt("portrait", false, "pdfPortrait")),
        chip("(" + t("pdfPortraitLabel") + ")", opts.portrait, () => setOpt("portrait", true, "pdfPortrait"))
      );
      // Bildunterschrift: aus, Name, Name mit Notiz (Moodboard: nur Notiz an/aus)
      const capMode = opts.board ? (opts.notes ? "note" : "off") : !opts.captions ? "off" : opts.notes ? "note" : "on";
      const setCaps = (captions, notes) => {
        opts.notes = notes;
        setPref("pdfNotes", notes);
        if (opts.board) return renderAll();
        setOpt("captions", captions, "pdfCaptions");
      };
      const capChips = [];
      if (!opts.board) capChips.push(chip("(" + t("setOn") + ")", capMode === "on", () => setCaps(true, false)));
      capChips.push(chip("(" + t("setOff") + ")", capMode === "off", () => setCaps(false, false)));
      if (!opts.poster) capChips.push(chip("(" + t("pdfCaptionsNotes") + ")", capMode === "note", () => setCaps(true, true)));
      captionRow.replaceChildren(...capChips);
      const { cols, rows } = grid();
      const pages = opts.board ? 1 : Math.max(1, Math.ceil(items.length / (cols * rows)));
      count.textContent = meta() + " · " + t(pages === 1 ? "pdfPages1" : "pdfPagesN", { n: pages });
      save.disabled = !items.length;
    }

    function setOpt(key, value, prefKey) {
      opts[key] = value;
      setPref(prefKey, value);
      // Neues Format: Moodboard neu anordnen
      if (key === "portrait" && board) board = null;
      renderAll();
    }

    // ---- Vorschau: Seiten in A4-Proportion, Felder wie im PDF ----
    function renderPages() {
      hint.textContent = t(opts.board ? "pdfBoardHint" : "pdfHint");
      if (opts.board) return renderBoard();
      stage.classList.remove("board");
      const { cols, rows } = grid();
      const per = cols * rows;
      const P = PDF_PAGE;
      const [w, h] = opts.portrait ? [P.short, P.long] : [P.long, P.short];
      const pages = [];
      for (let p = 0; p * per < Math.max(1, items.length); p++) {
        const page = el("div", "pdf-page");
        page.style.aspectRatio = `${w} / ${h}`;
        page.style.setProperty("--pad-x", (P.margin / w) * 100 + "%");
        page.style.setProperty("--pad-y", (P.margin / h) * 100 + "%");
        const head = el("div", "pdf-head");
        const pageCount = Math.max(1, Math.ceil(items.length / per));
        head.append(el("b", null, opts.title), el("span", null, opts.poster ? `${meta()}  ${p + 1} / ${pageCount}` : meta()));
        page.classList.toggle("poster", opts.poster);
        const body = el("div", "pdf-grid");
        body.style.setProperty("--cols", cols);
        body.style.setProperty("--rows", rows);
        body.style.setProperty("--gap-x", (P.gap / w) * 100 + "cqw");
        items.slice(p * per, p * per + per).forEach((item, k) => body.appendChild(pdfCell(item, p * per + k)));
        const foot = el("div", "pdf-foot");
        foot.append(el("span", null, "Archiver"), el("span", null, `${p + 1} / ${Math.max(1, Math.ceil(items.length / per))}`));
        page.append(head, body, foot);
        page.classList.toggle("no-captions", !opts.captions);
        page.classList.toggle("with-notes", opts.captions && opts.notes && !opts.poster);
        pages.push(page);
      }
      stage.replaceChildren(...pages);
      stage.classList.toggle("portrait", opts.portrait);
      stage.classList.toggle("dense", per >= 6);
    }

    function pdfCell(item, index) {
      const cell = el("div", "pdf-cell");
      cell.dataset.index = index;
      const box = el("div", "pdf-box");
      if (item.quote) box.appendChild(el("div", "pdf-quote", "„" + item.quote.trim() + "“"));
      else {
        const img = el("img");
        img.src = thumbSrc(item);
        img.draggable = false;
        box.appendChild(img);
      }
      cell.appendChild(box);
      const s = sheetItem(item);
      const cap = el("div", "pdf-cap");
      const name = opts.poster ? s.name.replace(/\.[a-z0-9]{1,5}$/i, "") : s.name;
      cap.append(el("span", null, name), el("span", "dim", s.source || ""));
      if (opts.notes && !opts.poster && s.note) cap.appendChild(el("span", "pdf-note", s.note));
      if (opts.poster && !item.quote) {
        // Wie im PDF: Schrift hell auf dunklem Grund, sonst dunkel
        const img = box.querySelector("img");
        img.addEventListener("load", () => {
          const tone = captionTone(img);
          if (tone) cell.classList.toggle("on-dark", tone === "dark");
        });
      }
      cell.appendChild(cap);
      const remove = button("pdf-remove", "×", (e) => {
        e.stopPropagation();
        items.splice(index, 1);
        renderAll();
      });
      remove.title = t("pdfRemove");
      cell.appendChild(remove);
      cell.addEventListener("pointerdown", (e) => startMove(e, index));
      return cell;
    }

    // ---- Verschieben: Feld greifen und auf ein anderes ziehen ----
    let moving = null;
    function startMove(e, index) {
      if (e.button !== 0 || e.target.closest(".pdf-remove")) return;
      e.preventDefault();
      moving = { index, x: e.clientX, y: e.clientY, active: false };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", endMove, { once: true });
    }
    function onMove(e) {
      if (!moving) return;
      if (!moving.active && Math.hypot(e.clientX - moving.x, e.clientY - moving.y) < 4) return;
      moving.active = true;
      root.classList.add("moving");
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".pdf-cell");
      const to = target ? Number(target.dataset.index) : moving.index;
      if (to !== moving.index) {
        const [item] = items.splice(moving.index, 1);
        items.splice(to, 0, item);
        moving.index = to;
        renderPages();
      }
      for (const c of stage.querySelectorAll(".pdf-cell")) c.classList.toggle("lifted", Number(c.dataset.index) === moving.index);
    }
    function endMove() {
      window.removeEventListener("pointermove", onMove);
      moving = null;
      root.classList.remove("moving");
      for (const c of stage.querySelectorAll(".lifted")) c.classList.remove("lifted");
    }

    function renderAll() {
      renderControls();
      renderPages();
    }

    // ---- Moodboard: eine Seite, Objekte frei verschieben und skalieren ----
    function renderBoard() {
      if (!board) boardFit();
      const P = PDF_PAGE;
      const [w, h] = opts.portrait ? [P.short, P.long] : [P.long, P.short];
      const page = el("div", "pdf-page board" + (opts.dark ? " dark" : ""));
      page.style.aspectRatio = `${w} / ${h}`;
      const head = el("div", "pdf-head");
      head.append(el("b", null, opts.title), el("span", null, meta()));
      const area = el("div", "pdf-board");
      items.forEach((item) => area.appendChild(boardCell(item, area)));
      const foot = el("div", "pdf-foot");
      foot.append(el("span", null, "Archiver"), el("span"));
      page.append(head, area, foot);
      stage.replaceChildren(page);
      stage.classList.toggle("portrait", opts.portrait);
      stage.classList.add("board");
    }

    function placeCell(cell, p) {
      cell.style.left = p.x * 100 + "%";
      cell.style.top = p.y * 100 + "%";
      cell.style.width = p.w * 100 + "%";
      cell.style.height = p.h * 100 + "%";
    }

    function boardCell(item, area) {
      const cell = el("div", "pdf-bcell");
      const p = board.get(item.path);
      placeCell(cell, p);
      if (quoteOf(item)) {
        const q = textSheet(item, "text-sheet pdf-bquote");
        cell.appendChild(q);
      } else {
        const img = el("img");
        img.src = thumbSrc(item);
        img.draggable = false;
        cell.appendChild(img);
      }
      const s = sheetItem(item);
      if (opts.notes && s.note) cell.appendChild(el("div", "pdf-bnote", s.note));
      const grip = el("span", "pdf-grip");
      cell.appendChild(grip);
      const remove = button("pdf-remove", "×", (e) => {
        e.stopPropagation();
        items.splice(items.indexOf(item), 1);
        board.delete(item.path);
        saveBoard();
        renderAll();
      });
      remove.title = t("pdfRemove");
      cell.appendChild(remove);
      // Doppelklick: nach vorn (zuletzt gezeichnet)
      cell.addEventListener("dblclick", () => {
        items.splice(items.indexOf(item), 1);
        items.push(item);
        renderPages();
      });
      cell.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".pdf-remove")) return;
        e.preventDefault();
        const box = area.getBoundingClientRect();
        const start = { ...board.get(item.path) };
        const scaling = e.target === grip;
        const ratio = (start.w * box.width) / (start.h * box.height);
        root.classList.add("moving");
        cell.classList.add("lifted");
        let moved = false;
        const move = (ev) => {
          moved = true;
          const dx = (ev.clientX - e.clientX) / box.width;
          const dy = (ev.clientY - e.clientY) / box.height;
          const next = { ...start };
          if (scaling) {
            // Ecke unten rechts: Seitenverhältnis bleibt
            next.w = Math.max(0.04, Math.min(1.2, start.w + dx));
            next.h = (next.w * box.width) / ratio / box.height;
          } else {
            next.x = Math.max(-next.w / 2, Math.min(1 - next.w / 2, start.x + dx));
            next.y = Math.max(-next.h / 2, Math.min(1 - next.h / 2, start.y + dy));
          }
          board.set(item.path, next);
          placeCell(cell, next);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          root.classList.remove("moving");
          cell.classList.remove("lifted");
          saveBoard();
          // Bewegtes liegt danach oben
          const at = items.indexOf(item);
          if (moved && at !== items.length - 1) {
            items.splice(at, 1);
            items.push(item);
            renderPages();
          }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
      });
      return cell;
    }

    function onKey(e) {
      if (e.key === "Escape" && document.activeElement !== titleInput) close();
      else if (e.key === "Escape") titleInput.blur();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }

    function close() {
      endMove();
      document.removeEventListener("keydown", onKey, true);
      root.remove();
    }

    async function run() {
      if (!items.length) return;
      const { cols, rows } = grid();
      const name = (opts.title.replace(/[„“"]/g, "").replace(/[\/:*?<>|]+/g, " – ").trim() || "Archiver") + ".pdf";
      save.disabled = true;
      save.textContent = t("pdfWorking");
      try {
        const path = opts.board
          ? await invoke("export_moodboard", {
              title: opts.title,
              meta: meta(),
              fileName: name,
              board: {
                portrait: opts.portrait,
                notes: opts.notes,
                dark: opts.dark,
                items: items.map((i) => ({ ...sheetItem(i), ...board.get(i.path) })),
              },
            })
          : await invoke("export_pdf", {
              title: opts.title,
              meta: meta(),
              fileName: name,
              items: items.map(sheetItem),
              layout: { cols, rows, portrait: opts.portrait, captions: opts.captions, poster: opts.poster, notes: opts.captions && opts.notes && !opts.poster },
            });
        if (path) {
          toast(t("pdfDone", { name: path.split("/").pop() }));
          close();
          return;
        }
      } catch (e) {
        fail(e);
      }
      save.disabled = false;
      save.textContent = t("pdfSave");
    }

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    renderAll();
  }

  // ---- Rechtsklick auf ein Bild: Vorschau, Öffnen, Quelle, Ablegen in, Kopieren … ----
  // Gilt für die Auswahl; liegt das Bild nicht darin, wird es allein ausgewählt.
  function openItemMenu(path, x, y) {
    closeMenus();
    closeMoreMenu();
    if (!state.selection.has(path)) selectOnly(path);
    const items = selectedItems();
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null;
    const menu = el("div", "zone-menu p-ctx-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    const entry = (parent, text, fn, key, cls = "") => {
      const b = button("zone-menu-item" + cls, text, () => {
        closeMenus();
        fn();
      });
      if (key) b.appendChild(el("span", "p-ctx-key", key));
      parent.appendChild(b);
      return b;
    };
    const rule = () => menu.appendChild(el("div", "p-more-rule"));
    if (!one) menu.appendChild(el("div", "p-more-label", t("ctxSelected", { n: items.length })));
    if (one) {
      entry(menu, t("ctxPreview"), () => openLightbox(one), "␣");
      entry(menu, t("openFile"), () => invoke("open_file", { path: one.abs }).catch(fail));
      if (one.pageUrl) entry(menu, t("ctxSource"), () => invoke("open_url", { url: sourceUrl(one) }).catch(fail));
      rule();
    }
    // Ablegen in: alle Zonen als Kästchen in zwei Spalten, Active Zones zuerst mit Taste
    menu.appendChild(el("div", "p-more-label", t("ctxDropIn")));
    const here = new Set(items.map((i) => i.zone));
    const grid = el("div", "p-ctx-zones");
    state.zones.forEach((z, i) => {
      const all = here.size === 1 && here.has(z.path);
      const box = button("p-ctx-zone" + (i < HOT_ZONES ? " hot" : "") + (all ? " on" : ""), "", () => {
        closeMenus();
        moveSelection(z.path);
      });
      const parts = z.path.split("/");
      const name = el("span", "p-ctx-zone-name");
      if (parts.length > 1) name.appendChild(el("span", "p-ctx-zone-parent", parts.slice(0, -1).join(" / ") + " / "));
      name.appendChild(document.createTextNode(parts[parts.length - 1]));
      box.appendChild(name);
      if (i < HOT_ZONES) box.appendChild(el("span", "p-ctx-key", String(i + 1)));
      box.title = zoneLabel(z.path);
      if (all) box.disabled = true;
      grid.appendChild(box);
    });
    menu.appendChild(grid);
    rule();
    if (isZone(state.focus) && !state.query.trim() && canEdit(state.focus)) entry(menu, t("newFolderWith"), () => newFolder(true));
    entry(menu, t("ctxCopy"), () => copyImages(items), "⌘C");
    if (one) entry(menu, t("reveal"), () => invoke("reveal", { path: one.abs }).catch(fail));
    entry(menu, t("pdfExport"), exportPdf, "⌘P");
    rule();
    entry(menu, t("trash"), trashSelection, "⌫", " danger");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }

  // ---- Zuletzt gelöscht (0.27) ----
  // Gelöschtes liegt 7 Tage unter .archiver/deleted in der Bibliothek, dann geht
  // es in den Papierkorb des Macs. Hier lässt es sich zurückholen.

  const DELETED_DAYS = 7;

  async function openDeleted() {
    state.deletedItems = await invoke("deleted_items").catch(() => []);
    state.delSel = new Set();
    setFocus(DELETED);
  }

  function daysLeft(item) {
    return Math.max(1, Math.ceil(DELETED_DAYS - (Date.now() - item.deletedAt) / 86400000));
  }

  function renderDeleted() {
    const list = state.deletedItems || [];
    const sel = state.delSel || (state.delSel = new Set());
    for (const k of [...sel]) if (!list.some((i) => i.abs === k)) sel.delete(k);
    const wrap = el("div", "p-page p-gallery p-deleted");
    wrap.appendChild(headline(t("deletedTitle"), list.length ? t("deletedText", { count: countText(list.length), days: DELETED_DAYS }) : t("deletedEmpty")));
    const bar = el("div", "p-bar");
    bar.appendChild(mono((sel.size ? t("ctxSelected", { n: sel.size }) : t("allLabel")) + " (" + (sel.size || list.length) + ")", "strong"));
    bar.appendChild(el("span", "p-flex"));
    const targets = () => (sel.size ? [...sel] : list.map((i) => i.abs));
    if (list.length) {
      bar.appendChild(chip("(" + t(sel.size ? "deletedRestore" : "deletedRestoreAll") + ")", false, () => restoreDeleted(targets())));
      bar.appendChild(el("span", "p-filter-gap"));
      const rm = chip("(" + t(sel.size ? "deletedRemove" : "deletedRemoveAll") + ")", false, () => askRemoveDeleted(targets()));
      rm.classList.add("danger");
      bar.appendChild(rm);
    }
    bar.appendChild(el("span", "p-filter-gap"));
    bar.appendChild(sizeChips(Math.max(0, SIZES.indexOf(state.size)), SIZES.length, (step) => {
      state.size = SIZES[step];
      setPref("size", state.size);
      renderToolbar();
      renderZones();
    }));
    wrap.appendChild(bar);
    // 0.28: dieselbe Karte und dasselbe Raster wie in jeder Zone; Badge zeigt Zone und Resttage
    const section = el("section", "zone-card p-section");
    const body = el("div", "zone-card-grid");
    body.tabIndex = -1;
    const items = el("div", "zone-card-items");
    for (const item of list) {
      const card = el("div", "card del" + (sel.has(item.abs) ? " selected" : ""));
      card.dataset.del = item.abs;
      card.title = item.path;
      const img = quoteOf(item) ? textSheet(item, "text-sheet") : previewImg(item);
      if (img.tagName === "IMG") img.loading = "lazy";
      card.classList.toggle("card-text", !!quoteOf(item));
      card.appendChild(img);
      card.appendChild(el("div", "card-badge", zoneLabel(item.zone) + " · " + t("deletedDays", { n: daysLeft(item) })));
      const label = item.format ? mediaLabel({ ...item, duration: null, pages: null }) : "";
      const media = el("div", "card-media", label);
      media.hidden = !label;
      card.appendChild(media);
      card.addEventListener("click", (e) => {
        if (!(e.metaKey || e.shiftKey)) sel.clear();
        if (sel.has(item.abs) && (e.metaKey || e.shiftKey)) sel.delete(item.abs);
        else sel.add(item.abs);
        renderZones();
      });
      card.addEventListener("dblclick", () => openDeletedLightbox(item));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!sel.has(item.abs)) {
          sel.clear();
          sel.add(item.abs);
          renderZones();
        }
        openDeletedMenu(e.clientX, e.clientY);
      });
      items.appendChild(card);
    }
    body.appendChild(items);
    section.appendChild(body);
    wrap.appendChild(section);
    return wrap;
  }

  function openDeletedMenu(x, y) {
    closeMenus();
    closeMoreMenu();
    const files = [...(state.delSel || [])];
    const menu = el("div", "zone-menu p-ctx-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    const entry = (text, fn, cls = "") =>
      menu.appendChild(button("zone-menu-item" + cls, text, () => {
        closeMenus();
        fn();
      }));
    entry(t("deletedRestore"), () => restoreDeleted(files));
    menu.appendChild(el("div", "p-more-rule"));
    entry(t("deletedRemove"), () => askRemoveDeleted(files), " danger");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }

  async function restoreDeleted(files) {
    if (!files.length) return;
    try {
      const n = await invoke("restore_deleted", { files });
      state.delSel = new Set();
      await refresh();
      lbSyncDeleted();
      toast(t("deletedRestored", { n }));
    } catch (e) {
      fail(e);
    }
  }

  // Lightbox in „Zuletzt gelöscht“ (0.29.1): Doppelklick, Leertaste oder Enter
  function openDeletedLightbox(item) {
    const list = state.deletedItems || [];
    if (!item || !list.length) return;
    state.lightbox = { zone: null, list, index: Math.max(0, list.indexOf(item)), deleted: true };
    $("lightbox").hidden = false;
    document.body.classList.add("lightbox-open");
    lbView.fitted = true;
    showLightboxItem();
  }

  // Nach Zurückholen oder Löschen: die Lightbox blättert in der neuen Liste weiter
  function lbSyncDeleted() {
    const lb = state.lightbox;
    if (!lb || !lb.deleted) return;
    lb.list = state.deletedItems || [];
    if (!lb.list.length) return closeLightbox();
    lb.index = Math.min(lb.index, lb.list.length - 1);
    showLightboxItem();
  }

  // ⌫ und „Sofort löschen“ fragen nach: danach liegt es im Papierkorb des Macs
  function askRemoveDeleted(files) {
    if (!files.length) return;
    const n = files.length;
    const dialog = el("div", "dialog confirm");
    dialog.appendChild(el("h3", null, n === 1 ? t("deletedAskOne") : t("deletedAskMany", { n })));
    dialog.appendChild(el("p", null, t("deletedAskText")));
    const foot = el("div", "confirm-foot");
    const go = () => {
      closeModal();
      removeDeleted(files);
    };
    foot.appendChild(button("btn", t("cancel"), closeModal));
    const ok = button("btn danger-fill", t("deletedRemove"), go);
    foot.appendChild(ok);
    dialog.appendChild(foot);
    const modal = $("modal");
    modal.replaceChildren(dialog);
    modal.hidden = false;
    modal.onEnter = go;
    ok.focus();
  }

  async function removeDeleted(files) {
    if (!files.length) return;
    try {
      const n = await invoke("remove_deleted", { files });
      state.delSel = new Set();
      await refresh();
      lbSyncDeleted();
      toast(t("deletedRemoved", { n }));
    } catch (e) {
      fail(e);
    }
  }

  // ---- Menü ⋯ in der Navigation ----

  function closeMoreMenu() {
    closeMenus();
    $("navMore").classList.remove("active");
  }

  // Beta: fertige Mail mit Version und drei Fragen.
  const FEEDBACK_TO = "feedback@archiver-app.com";
  async function sendFeedback() {
    const version = TAURI.app && TAURI.app.getVersion ? await TAURI.app.getVersion().catch(() => "") : "";
    const body = t("feedbackBody").replace("{version}", version);
    const url = `mailto:${FEEDBACK_TO}?subject=${encodeURIComponent(`${t("feedbackSubject")} ${version}`.trim())}&body=${encodeURIComponent(body)}`;
    invoke("open_url", { url }).catch(() => {});
  }

  function openMoreMenu() {
    closeMenus();
    const menu = el("div", "zone-menu p-more-menu");
    const zone = isZone(state.focus) && !state.query && state.zones.find((z) => z.path === state.focus);
    if (zone) {
      menu.appendChild(el("div", "p-more-label", lastSegment(zone.path)));
      for (const b of [...zoneMenu(zone).children]) menu.appendChild(b);
      menu.appendChild(el("div", "p-more-rule"));
    }
    // Kürzel steht in Klammern hinter dem Eintrag
    const item = (text, fn, active, key) => {
      const b = button("zone-menu-item" + (active ? " on" : ""), text, () => {
        closeMoreMenu();
        fn();
      });
      if (key) b.appendChild(el("span", "p-more-key", " (" + key + ")"));
      menu.appendChild(b);
    };
    item("+ " + t("newZone"), startNewZone, false, "⌘N");
    item(t("infoPanel"), toggleInfo, state.infoOpen, "⌘D");
    item(t("pdfExport"), exportPdf, false, "⌘P");
    item(t("deletedTitle") + (state.deletedCount ? " · " + state.deletedCount : ""), openDeleted, state.focus === DELETED);
    menu.appendChild(el("div", "p-more-rule"));
    (state.libraries || []).forEach((slot, i) => {
      if (slot.path) item(libraryName(slot, i), () => switchLibrary(i), slot.active, "⌘" + (i + 1));
    });
    if ((state.libraries || []).some((l) => l.path)) menu.appendChild(el("div", "p-more-rule"));
    item(t("settings"), () => togglePage("settings"), state.page === "settings", "⌘,");
    item(t("manual"), () => togglePage("manual"), state.page === "manual");
    item(t("about"), () => togglePage("about"), state.page === "about");
    const note = el("div", "p-more-note");
    note.appendChild(el("div", null, state.root.replace(/^\/(Users|home)\/[^/]+/, "~")));
    menu.appendChild(note);
    $("navMore").parentElement.appendChild(menu);
    $("navMore").classList.add("active");
  }

  // ---- Ereignisse ----

  function bindEvents() {
    $("lockText").textContent = t("lockText");
    $("libTabBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      openLibMenu();
    });
    const zones = $("zones");

    zones.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const card = e.target.closest(".card:not(.del)");
      suppressClick = false;
      if (!card) {
        const control = e.target.closest("button, input, select, a, .p-bar, .p-section-head, .p-head-title, .zone-menu, .zone-card-name, .p-card, .p-row");
        if (!control && state.selection.size && !(e.metaKey || e.ctrlKey || e.shiftKey)) selectOnly(null);
        return;
      }
      pressed = { path: card.dataset.path, x: e.clientX, y: e.clientY };
    });

    document.addEventListener("mousemove", (e) => {
      if (!pressed || !(e.buttons & 1)) return;
      if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < DRAG_THRESHOLD) return;
      const path = pressed.path;
      pressed = null;
      suppressClick = true;
      if (!state.selection.has(path)) selectOnly(path);
      const items = selectedItems();
      if (items.length) startNativeDrag(items);
    });

    document.addEventListener("mouseup", () => {
      pressed = null;
    });

    zones.addEventListener("click", (e) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const card = e.target.closest(".card:not(.del)");
      if (card) clickCard(card.dataset.path, e);
    });

    zones.addEventListener("scroll", () => {
      if (document.querySelector(".p-ctx-menu, .zone-menu.floating")) closeMenus();
    }, { passive: true, capture: true });

    zones.addEventListener("contextmenu", (e) => {
      const zoneEl = e.target.closest(".p-home [data-zone]");
      if (zoneEl && !e.target.closest(".card:not(.del)")) {
        e.preventDefault();
        openZoneContext(zoneEl.dataset.zone, e.clientX, e.clientY);
        return;
      }
      const card = e.target.closest(".card:not(.del)");
      if (!card) {
        if (state.focus === DELETED) return;
        // In einer Zone: Rechtsklick in den Hintergrund legt einen Unterordner an
        if (isZone(state.focus) && !state.query.trim() && canEdit(state.focus)) {
          e.preventDefault();
          openZoneBackgroundMenu(e.clientX, e.clientY);
        }
        return;
      }
      e.preventDefault();
      openItemMenu(card.dataset.path, e.clientX, e.clientY);
    });

    zones.addEventListener("dblclick", (e) => {
      const card = e.target.closest(".card:not(.del)");
      if (card) openLightbox(state.byPath.get(card.dataset.path));
    });

    // 0.27: Video beim Hover als kurze Vorschau aus wenigen Bildern
    zones.addEventListener("pointerover", (e) => {
      const card = e.target.closest(".card:not(.del)");
      if (card && !card.contains(e.relatedTarget)) videoScrub(card);
    });

    $("search").placeholder = t("search");
    $("search").addEventListener(
      "input",
      debounce(() => {
        state.query = $("search").value;
        renderZones();
        renderToolbar();
        renderInfo();
      }, 80)
    );

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".zone-menu, .zone-menu-btn")) closeMenus();
      if (!e.target.closest(".p-more-menu, #navMore")) closeMoreMenu();
    });

    // Nach einem Drag nach außen (Finder, Figma) kommt kein Ende-Ereignis ins Fenster.
    document.addEventListener("mousemove", (e) => {
      if (!e.buttons && document.body.classList.contains("dragging")) hideDropbar();
    });

    $("navSearchLabel").textContent = t("navSearch");
    $("navSearch").addEventListener("click", openSearch);
    $("search").addEventListener("focus", renderToolbar);
    $("search").addEventListener("blur", () => setTimeout(renderToolbar, 0));
    setupNavGlide();
    // „Archiver“ in der Leiste führt immer zum Start: Zonen als Karten.
    $("navBrand").addEventListener("click", () => {
      closePage();
      state.home = "cards";
      if (state.focus == null && !state.query) renderZones();
      else setFocus(null);
    });
    $("navMore").textContent = "≡";
    $("navMore").title = t("navMore");
    $("navMore").setAttribute("aria-label", t("navMore"));
    $("navMore").addEventListener("click", (e) => {
      e.stopPropagation();
      if (document.querySelector(".p-more-menu")) return closeMoreMenu();
      openMoreMenu();
    });

    bindLightbox();

    $("modal").addEventListener("mousedown", (e) => {
      if (e.target === $("modal")) closeModal();
    });

    document.addEventListener("keydown", onKey);
    // Maus übernimmt: Tastatur-Markierung auf der Startseite ausblenden
    document.addEventListener("pointerdown", () => {
      if (!state.homeKbd) return;
      state.homeKbd = false;
      applyHomeCursor(false);
    });
    // 0.29: ⌘V mit Text auf ein gewähltes Bild (oder in der Lightbox) setzt den Bildtext
    document.addEventListener("paste", (e) => {
      if (e.target.closest && e.target.closest("input, textarea, [contenteditable]")) return;
      const text = (e.clipboardData && e.clipboardData.getData("text/plain") || "").trim();
      if (!text || (e.clipboardData.files && e.clipboardData.files.length)) return;
      const items = state.lightbox ? [lightboxItem()].filter(Boolean) : selectedItems();
      if (items.length !== 1 || quoteOf(items[0])) return;
      e.preventDefault();
      const item = items[0];
      const had = !!item.caption;
      item.caption = text.slice(0, 4000);
      saveNote(item, { caption: item.caption });
      toast(t(had ? "captionReplaced" : "captionSet"));
      if (state.lightbox) lbRenderText();
    });

    window.addEventListener(
      "resize",
      debounce(() => {
        if (document.body.classList.contains("at-home") && (state.home === "cards" || state.home === "overview")) renderZones();
        else layoutMasonry(false);
      }, 120)
    );

    if (TAURI.webview && TAURI.webview.getCurrentWebview) {
      TAURI.webview.getCurrentWebview().onDragDropEvent(onDragDrop);
    }
  }

  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;

    if (!$("modal").hidden) {
      if (e.key === "Escape") closeModal();
      else if (e.key === "Enter" && $("modal").onEnter) {
        e.preventDefault();
        $("modal").onEnter();
      }
      return;
    }

    if (state.lightbox) {
      if (lightboxKey(e, mod)) e.preventDefault();
      return;
    }

    const target = e.target;
    if (!isUnlocked() && !(target && target.tagName === "INPUT")) {
      if (mod && e.key === ",") togglePage("settings");
      else if (e.key === "Escape") closePage();
      else if (!mod) return;
      if (mod && !["q", "w", "h", "m"].includes(e.key)) e.preventDefault();
      return;
    }

    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT")) {
      if (target === $("search") && e.key === "Escape") {
        target.value = "";
        state.query = "";
        target.blur();
        renderZones();
        renderToolbar();
      }
      if (target === $("search") && (e.key === "Enter" || e.key === "ArrowDown")) {
        target.blur();
        moveCursor("right");
        e.preventDefault();
      }
      return;
    }

    // Zuletzt gelöscht: Leertaste/Enter groß ansehen, ⌫ fragt vor dem endgültigen Löschen
    if (!mod && !e.altKey && !state.page && state.focus === DELETED && !state.query.trim()) {
      const list = state.deletedItems || [];
      const sel = [...(state.delSel || [])];
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        openDeletedLightbox(list.find((i) => i.abs === sel[0]) || list[0]);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (sel.length) askRemoveDeleted(sel);
        return;
      }
    }

    if (!mod && !e.altKey && document.body.classList.contains("at-home") && !state.page && homeKey(e)) {
      e.preventDefault();
      return;
    }

    if (!mod && !e.altKey && !state.page && isZone(state.focus) && folderKey(e)) {
      e.preventDefault();
      return;
    }

    // ⌘↑ wie im Finder: eine Ordnerebene hoch, oben in der Zone zurück zur Übersicht
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "ArrowUp" && !state.page && state.focus != null) {
      e.preventDefault();
      if (!(isZone(state.focus) && folderUp())) {
        const back = state.focus;
        if (state.zones.some((z) => z.path === back)) {
          state.homeCursor = back;
          state.homeKbd = true;
        }
        setFocus(null);
        applyHomeCursor(true);
      }
      return;
    }

    if (mod && (e.key === "n" || e.key === "N") && e.shiftKey) {
      newNote();
    } else if (mod && (e.key === "n" || e.key === "N") && !e.shiftKey) {
      startNewZone();
    } else if (mod && !e.shiftKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      reloadObjects();
    } else if (mod && (e.key === "d" || e.key === "D")) {
      toggleInfo();
    } else if (mod && e.key === ",") {
      togglePage("settings");
    } else if (mod && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
      undo();
    } else if (mod && !e.shiftKey && !e.altKey && /^[1-3]$/.test(e.key)) {
      switchLibrary(Number(e.key) - 1);
    } else if (mod && (e.key === "p" || e.key === "P")) {
      exportPdf();
    } else if (mod && e.key === "c") {
      if (!hasTextSelection()) copyImages(selectedItems());
    } else if ((mod && e.key === "f") || e.key === "/") {
      openSearch();
      $("search").select();
    } else if (mod && e.key === "a") {
      state.selection = new Set(allVisible().map((i) => i.path));
      updateSelectionClasses();
    } else if (e.key === "Escape") {
      if (document.querySelector(".zone-menu")) {
        closeMenus();
        closeMoreMenu();
      }
      else if (state.page === "settings" && state.settingsSub) openSettingsSection(null);
      else if (state.page) closePage();
      else if (state.selection.size) selectOnly(null);
      else if (isZone(state.focus) && folderUp()) {
        // im Unterordner: eine Ebene zurück
      } else if (state.focus != null) {
        // zurück zur Startseite, die eben offene Zone ist dort gewählt
        const back = state.focus;
        if (state.zones.some((z) => z.path === back)) {
          state.homeCursor = back;
          state.homeKbd = true;
        }
        setFocus(null);
        applyHomeCursor(true);
      }
    } else if (e.key === " " || e.key === "Enter") {
      openLightbox(selectedItems()[0] || allVisible()[0]);
    } else if (/^[1-4]$/.test(e.key) && !mod) {
      const zone = state.zones[Number(e.key) - 1];
      if (zone) moveSelection(zone.path);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      trashSelection();
    } else if (e.key === "i" && !mod && !e.altKey) {
      toggleInfo(); // bisheriges Kürzel, bleibt als Abkürzung
    } else if ((e.key === "+" || e.key === "=") && !e.altKey) {
      resize(1);
    } else if (e.key === "-" && !e.altKey) {
      resize(-1);
    } else if (e.key === "ArrowRight") moveCursor("right", e.shiftKey);
    else if (e.key === "ArrowLeft") moveCursor("left", e.shiftKey);
    else if (e.key === "ArrowDown") moveCursor("down", e.shiftKey);
    else if (e.key === "ArrowUp") moveCursor("up", e.shiftKey);
    else return;
    e.preventDefault();
  }

  // ---- Start ----

  // ---- Bibliotheken: drei feste Plätze (lib.rs: libraries, set_library_slot) ----
  // Hot Zones und Zonenreihenfolge liegen in der Bibliothek selbst,
  // die Extension sammelt immer in die gerade aktive.

  async function loadLibraries() {
    state.libraries = await invoke("libraries").catch(() => state.libraries || []);
    renderLibTab();
    return state.libraries;
  }

  // Reiter oben rechts: aktive Bibliothek, Klick zeigt die anderen
  function renderLibTab() {
    const tab = $("libTab");
    if (!tab) return;
    const slots = state.libraries || [];
    const i = slots.findIndex((l) => l.active);
    const name = i >= 0 ? libraryName(slots[i], i) : state.name;
    tab.hidden = !name || !state.root;
    $("libTabBtn").textContent = name || "";
    $("libTabBtn").title = state.root.replace(/^\/(Users|home)\/[^/]+/, "~");
  }

  function openLibMenu() {
    if (document.querySelector(".p-lib-menu")) return closeMenus();
    closeMenus();
    const menu = el("div", "zone-menu p-lib-menu");
    (state.libraries || []).forEach((slot, i) => {
      if (!slot.path) return;
      const b = button("zone-menu-item" + (slot.active ? " on" : ""), libraryName(slot, i), () => {
        closeMenus();
        switchLibrary(i);
      });
      b.appendChild(el("span", "p-more-key", " (⌘" + (i + 1) + ")"));
      b.title = slot.path.replace(/^\/(Users|home)\/[^/]+/, "~");
      menu.appendChild(b);
    });
    if (menu.children.length) menu.appendChild(el("div", "p-more-rule"));
    menu.appendChild(button("zone-menu-item", t("libManage"), () => {
      closeMenus();
      if (state.page !== "settings") togglePage("settings");
      openSettingsSection("library");
    }));
    $("libTab").appendChild(menu);
    $("libTabBtn").classList.add("active");
  }

  function libraryName(slot, i) {
    return (slot && slot.name) || t("libSlot", { n: i + 1 });
  }

  // Fehler des Ordner-Schutzes (lib.rs: check_library) verständlich machen
  function libraryFail(e) {
    const msg = String(e && e.message ? e.message : e);
    const key = { "library-system": "libSystem", "library-large": "libLarge", "library-slow": "libSlow", "library-active": "libActive", "library-missing": "libMissing" }[msg];
    if (key) toast(t(key), false, 5200);
    else fail(e);
  }

  function afterLibrarySwitch() {
    state.focus = null;
    state.selection = new Set();
    cardCache.clear();
    return showApp();
  }

  async function switchLibrary(i) {
    const slots = await loadLibraries();
    const slot = slots[i];
    if (!slot || !slot.path) {
      togglePage("settings");
      openSettingsSection("library");
      return;
    }
    if (slot.active) return;
    document.body.classList.add("lib-loading");
    try {
      await invoke("open_library", { path: slot.path });
      if (state.page) closePage();
      await afterLibrarySwitch();
      toast(libraryName(slot, i));
    } catch (e) {
      libraryFail(e);
    } finally {
      document.body.classList.remove("lib-loading");
    }
  }

  function renderLibrarySlots() {
    const b = block(t("setLibraries"));
    const slots = state.libraries && state.libraries.length ? state.libraries : [{}, {}, {}];
    slots.forEach((slot, i) => {
      const name = el("div", "p-lib-name" + (slot.path ? "" : " empty"), libraryName(slot, i));
      name.title = t("libRename");
      name.addEventListener("click", () => {
        inlineInput(
          name,
          slot.name || "",
          async (value) => {
            await invoke("set_library_slot", { index: i, name: value }).catch(libraryFail);
            await loadLibraries();
            renderPage(true);
          },
          () => renderPage(true)
        );
      });
      const main = [name, slot.path ? pathEl(slot.path, "p-lib-path") : el("div", "p-lib-path", t("libEmpty"))];
      const side = [];
      if (slot.active) {
        side.push(el("span", "p-lib-active", t("libActiveLabel")));
        side.push(button("p-link", t("reveal"), () => invoke("reveal_zone", { zone: "" }).catch(fail)));
      }
      else if (slot.path) side.push(button("p-link", t("libOpen") + " (⌘" + (i + 1) + ")", () => switchLibrary(i)));
      side.push(
        button("p-link", slot.path ? t("libChoose") : t("libAssign"), async () => {
          const path = await invoke("pick_folder");
          if (!path) return;
          try {
            await invoke("set_library_slot", { index: i, path });
            // aktiver Platz bekommt einen neuen Ordner: gleich öffnen
            if (slot.active) {
              await invoke("open_library", { path });
              await afterLibrarySwitch();
            }
          } catch (e) {
            libraryFail(e);
          }
          await loadLibraries();
          renderPage(true);
        })
      );
      if (slot.path && !slot.active) {
        side.push(
          button("p-link p-lib-clear", "✕", async () => {
            await invoke("set_library_slot", { index: i, clear: true }).catch(libraryFail);
            await loadLibraries();
            renderPage(true);
          })
        );
      }
      const row = blockRow(main, side);
      row.classList.add("p-lib-row");
      if (slot.active) row.classList.add("active");
      b.appendChild(row);
    });
    b.appendChild(el("p", "p-block-hint", t("libHint")));
    return b;
  }

  // 0.30.1: Ordner außerhalb der Bibliothek als Zone. Nur hier anzulegen;
  // im Raster, in Tray, Zonenleiste und Extension wie jede andere Zone.
  function renderExternalZones() {
    const b = block(t("extZones"));
    const list = el("div");
    b.appendChild(list);
    const fill = (rows) => {
      list.replaceChildren(
        ...rows.map(({ zone, path, online }) =>
          blockRow(
            [el("div", "p-lib-name", online === false ? `${zone} · ${t("extZoneOffline")}` : zone), pathEl(path, "p-lib-path")],
            [
              button("p-link", t("reveal"), () => invoke("reveal_zone", { zone }).catch(fail)),
              button("p-link p-lib-clear", "✕", async () => {
                await invoke("unlink_folder", { zone }).catch(fail);
                await refresh();
                renderPage(true);
              }),
            ]
          )
        )
      );
    };
    invoke("external_zones").then(fill, () => fill([]));
    b.appendChild(
      blockRow(
        el("div", "p-block-text", t("extZonesHint")),
        button("p-link", t("extZonesAdd"), async () => {
          const path = await invoke("pick_folder");
          if (!path) return;
          try {
            const zone = await invoke("link_folder", { path });
            await refresh();
            toast(t("extZonesAdded", { zone }));
          } catch (e) {
            const msg = String(e && e.message ? e.message : e);
            const key = { "zone-system": "zoneSystem", "zone-large": "zoneLarge", "zone-slow": "zoneSlow", "zone-overlap": "zoneOverlap", "zone-missing": "zoneMissing" }[msg];
            if (key) toast(t(key), false, 5200);
            else fail(e);
          }
          renderPage(true);
        })
      )
    );
    return b;
  }

  // ---- Erster Start: 1 Bibliothek, 2 Extension, 3 erstes Bild ----

  function welcomeStep(n, title, text) {
    $("app").hidden = true;
    $("welcome").hidden = false;
    $("welcomeMark").textContent = t("onbStep", { n });
    $("welcomeTitle").textContent = title;
    $("welcomeText").textContent = text;
    $("welcomeStatus").hidden = true;
  }

  function showWelcome(info) {
    welcomeStep(1, t("welcomeTitle"), t("welcomeText"));
    const home = info.suggestedLibrary.replace(/^\/(Users|home)\/[^/]+/, "~");
    $("welcomeCreate").textContent = t("welcomeCreate", { path: home });
    $("welcomeCreate").onclick = async () => {
      try {
        await invoke("open_library", { path: info.suggestedLibrary });
        showExtensionStep();
      } catch (e) {
        libraryFail(e);
      }
    };
    $("welcomeChoose").textContent = t("welcomeChoose");
    $("welcomeChoose").onclick = async () => {
      const path = await invoke("pick_folder");
      if (!path) return;
      try {
        await invoke("open_library", { path });
        showExtensionStep();
      } catch (e) {
        libraryFail(e);
      }
    };
  }

  function showExtensionStep() {
    welcomeStep(2, t("onbExtTitle"), t("onbExtText"));
    const status = $("welcomeStatus");
    status.hidden = false;
    let timer = 0;
    const check = () =>
      Promise.all([invoke("bridge_browsers"), extensionState()])
        .then(([list, s]) => {
          // Verbunden heißt: Die Extension hat sich gemeldet (nicht nur die Brücke eingerichtet)
          const on = list.length > 0 && !!s && s.kind !== "missing";
          status.textContent = on ? t("onbExtOn", { list: list.join(", ") }) : t("onbExtWaiting");
          status.classList.toggle("ok", on);
          $("welcomeCreate").textContent = t(on ? "onbNext" : "onbExtOpen");
        })
        .catch(() => (status.textContent = t("onbExtWaiting")));
    check();
    timer = setInterval(check, 2000);
    const next = () => {
      clearInterval(timer);
      showFirstDropStep();
    };
    $("welcomeCreate").onclick = () => {
      if (status.classList.contains("ok")) next();
      else
        navigator.clipboard
          .writeText("chrome://extensions")
          .then(() => toast(t("onbExtCopied")))
          .catch(fail);
    };
    $("welcomeChoose").textContent = t("onbSkip");
    $("welcomeChoose").onclick = next;
  }

  async function showFirstDropStep() {
    setPref("onboarded", true);
    await showApp();
    showDropHint();
  }

  function revealTargets() {
    const out = [];
    const nav = $("nav");
    if (nav) out.push(nav);
    const walk = (node, depth) => {
      for (const c of node.children) {
        if (out.length > 60) return;
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
        if ((r.height > innerHeight * 0.45 || r.width > innerWidth * 0.6) && depth < 5 && c.children.length) walk(c, depth + 1);
        else out.push(c);
      }
    };
    const zones = $("zones");
    if (zones) walk(zones, 0);
    return out;
  }

  function playReveal(cover) {
    const mode = pref("revealForm", "wave");
    return window.ArchiverReveal.play({
      mode,
      targets: revealTargets(),
      onStart: () => {
        if (cover) cover.remove();
      },
      onOpen: () => playStartSound(),
    });
  }

  function showDropHint() {
    if (state.items.length) return;
    const hint = el("div", "onb-drop");
    hint.appendChild(el("div", "onb-drop-mark", t("onbStep", { n: 3 })));
    hint.appendChild(el("div", "onb-drop-title", t("onbDropTitle")));
    hint.appendChild(el("div", "onb-drop-text", t("onbDropText")));
    hint.appendChild(button("onb-drop-close", "×", () => hint.remove()));
    document.body.appendChild(hint);
    const done = setInterval(() => {
      if (!state.items.length && document.body.contains(hint)) return;
      clearInterval(done);
      if (!document.body.contains(hint)) return;
      hint.querySelector(".onb-drop-title").textContent = t("onbDropDone");
      hint.querySelector(".onb-drop-text").textContent = t("onbDropDoneText");
      setTimeout(() => hint.remove(), 4000);
    }, 600);
  }

  // Ecken und Glas an die Bibliothek melden: Die Extension zeigt dieselben Werte
  function lookToLibrary() {
    const I = window.ArchiverI18n;
    invoke("set_look", { radius: pref("radius", "round"), alpha: I.zoneGlass() }).catch(() => {});
  }

  function showApp() {
    $("welcome").hidden = true;
    $("app").hidden = false;
    applyLock();
    loadLibraries();
    return refresh().then(() => {
      // Nach dem Sprachwechsel wieder in den Einstellungen landen
      const reopen = sessionStorage.getItem("archiver.reopen") || "";
      if (reopen.startsWith("settings")) {
        sessionStorage.removeItem("archiver.reopen");
        togglePage("settings");
        if (reopen.includes(":")) openSettingsSection(reopen.split(":")[1]);
      }
      // Ecken an die Bibliothek melden, die Extension zeigt dieselbe Stufe
      lookToLibrary();
      // 0.30: „Unterordner als Zonen“ gibt es nicht mehr, Unterordner sind Ordner in der Zone
      if (state.structure && state.structure.subzones)
        invoke("set_structure", { structure: { ...state.structure, subzones: false } })
          .then(refresh)
          .catch(() => {});
    });
  }

  // Aus dem Betrachter: Bild in seiner Zone zeigen und auswählen.
  async function revealFromViewer(path) {
    await refresh();
    const item = state.byPath.get(path);
    if (!item) return;
    if (state.lightbox) closeLightbox();
    if (state.page) closePage();
    if (state.focus !== ALL && state.focus !== item.zone) setFocus(item.zone);
    selectAndShow(path);
  }

  // Startanimation (app.css): Das Hauptfenster startet unsichtbar. Die
  // Animation beginnt erst, wenn es zu sehen ist, läuft einmal ganz durch,
  // und erst dann gibt die schwarze Fläche die Oberfläche frei.
  const SPLASH_MS = matchMedia("(prefers-reduced-motion: reduce)").matches ? 300 : 2500;
  const SOUND_DELAY_MS = 350;
  const splashPlayed = new Promise((resolve) => {
    const win = TAURI.window && TAURI.window.getCurrentWindow && TAURI.window.getCurrentWindow();
    const started = Date.now();
    const play = () => {
      $("splash").classList.add("play");
      // Ton setzt ein, wenn die Wortmarke ins Bild gleitet
      setTimeout(playStartSound, SOUND_DELAY_MS);
      setTimeout(resolve, SPLASH_MS);
    };
    const poll = () => {
      if (!win || Date.now() - started > 4000) return play();
      win
        .isVisible()
        .then((visible) => (visible ? play() : setTimeout(poll, 40)))
        .catch(play);
    };
    poll();
  });

  function hideSplash() {
    splashPlayed.then(() => {
      $("splash").classList.add("done");
      setTimeout(() => $("splash").remove(), 650);
      setTimeout(updateHappening, 900);
    });
  }

  // ---- Nach einem Update: Röntgen-Band swoosht einmal schräg über die Oberfläche ----
  // Unter dem Band wird die echte Oberfläche zum Röntgenbild (backdrop-filter),
  // danach kurz „Archiver X ist da“. Läuft nur beim ersten Start einer neuen Version.

  async function updateHappening() {
    const getVersion = TAURI.app && TAURI.app.getVersion;
    if (!getVersion) return;
    const version = await getVersion().catch(() => null);
    if (!version) return;
    const last = pref("lastVersion", null);
    setPref("lastVersion", version);
    if (!last || last === version) return;
    toast(t("updatedTo", { version }));
  }

  // ---- Updates (lib.rs: update_check / update_install) ----
  async function checkUpdate() {
    if (document.querySelector(".p-update:not(.p-ext)")) return;
    const info = await invoke("update_check").catch(() => null);
    if (!info || document.querySelector(".p-update:not(.p-ext)")) return;
    // Das App-Update geht vor; die neue App bringt meist auch die Extension mit
    document.querySelectorAll(".p-ext").forEach((n) => n.remove());
    const bar = el("div", "p-update");
    bar.appendChild(el("span", null, t("updateAvailable", { version: info.version })));
    const go = button("p-update-btn", "(" + t("updateInstall") + ")", () => {
      go.disabled = true;
      go.textContent = "(" + t("updateLoading") + ")";
      invoke("update_install").catch((e) => {
        go.disabled = false;
        go.textContent = "(" + t("updateInstall") + ")";
        fail(e);
      });
    });
    bar.appendChild(go);
    bar.appendChild(button("p-update-close", "×", () => bar.remove()));
    document.body.appendChild(bar);
  }

  // ---- Extension fehlt oder ist veraltet (bridge.rs: extension_status) ----
  // Der Host notiert bei jedem Kontakt die Version der Extension. Gleiche Leiste
  // wie der Update-Hinweis; × blendet ihn aus, bis sich der Zustand ändert.

  const EXTENSION_DOWNLOAD = "https://archiver-app.com/download/";
  const EXT_MISSING_GRACE = 2 * 24 * 60 * 60 * 1000;

  function openExtensionDownload() {
    invoke("open_url", { url: EXTENSION_DOWNLOAD }).catch(fail);
  }

  function versionLess(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  // { kind: "ok" | "old" | "missing", version, min } oder null
  async function extensionState() {
    const s = await invoke("extension_status").catch(() => null);
    if (!s) return null;
    const kind = !s.seen ? "missing" : !s.version || versionLess(s.version, s.min) ? "old" : "ok";
    return { kind, version: s.version, min: s.min };
  }

  async function checkExtension() {
    if (document.querySelector(".p-update") || $("app").hidden || !$("lock").hidden) return;
    const s = await extensionState();
    if (!s) return;
    if (s.kind === "ok") {
      setPref("extMissingSince", null);
      return;
    }
    // Fehlt sie, erst nach zwei Tagen melden: Nach einem App-Update meldet sich
    // eine vorhandene Extension erst, wenn sie das nächste Mal etwas tut.
    if (s.kind === "missing") {
      const since = pref("extMissingSince", null);
      if (!since) return setPref("extMissingSince", Date.now());
      if (Date.now() - since < EXT_MISSING_GRACE) return;
    }
    const key = s.kind + ":" + s.min;
    if (pref("extHintClosed", null) === key || document.querySelector(".p-update")) return;
    const bar = el("div", "p-update p-ext");
    bar.appendChild(el("span", null, s.kind === "old" ? t("extOld", { min: s.min }) : t("extMissing")));
    bar.appendChild(button("p-update-btn", "(" + t("extGet") + ")", openExtensionDownload));
    bar.appendChild(
      button("p-update-close", "×", () => {
        setPref("extHintClosed", key);
        bar.remove();
      })
    );
    document.body.appendChild(bar);
  }

  async function boot() {
    bindEvents();
    TAURI.event.listen("library-changed", debounce(refresh, 120));
    // Fehler im Hintergrund (Einlesen, Ordner nicht lesbar) und vergessene
    // Promise-Fehler nicht mehr still schlucken (0.31.0)
    TAURI.event.listen("library-error", (e) => toast(t("error", { msg: String(e.payload) }), false, 5000));
    window.addEventListener("unhandledrejection", (e) => {
      e.preventDefault();
      fail(e.reason);
    });
    TAURI.event.listen("thumbs-ready", (e) => applyThumbs(e.payload));
    TAURI.event.listen("analysis-ready", (e) => applyAnalysis(e.payload));
    TAURI.event.listen("reveal-in-app", (e) => revealFromViewer(e.payload));
    // Bibliothek anderswo gewechselt (Palette, ⌘1–3): nachziehen
    TAURI.event.listen("library-switched", (e) => {
      if (!e || e.payload === state.root || $("app").hidden) return;
      afterLibrarySwitch();
    });
    const info = await invoke("start_info");
    // Die Bibliothek wird erst hier geöffnet (im Hintergrund, mit Ordner-Schutz),
    // damit das Fenster nie hängt.
    if (!info.library && info.pending) {
      try {
        await invoke("open_library", { path: info.pending });
        info.library = info.pending;
      } catch (e) {
        setTimeout(() => libraryFail(e), 2600);
      }
    }
    if (info.library) {
      await showApp();
    } else showWelcome(info);
    hideSplash();
    setTimeout(checkUpdate, 3000);
    setTimeout(checkExtension, 6000);
    // Auch im laufenden Betrieb: alle 30 Minuten und wenn das Fenster wieder nach vorne kommt
    setInterval(checkUpdate, 30 * 60 * 1000);
    let lastFocusCheck = Date.now();
    window.addEventListener("focus", () => {
      if (Date.now() - lastFocusCheck < 5 * 60 * 1000) return;
      lastFocusCheck = Date.now();
      checkUpdate();
      checkExtension();
    });
  }

  boot().catch((e) => {
    hideSplash();
    fail(e);
  });
})();
