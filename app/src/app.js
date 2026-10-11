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

  // Position der Navigation: oben/unten, jeweils links, Mitte, rechts
  const NAV_POS = ["tl", "tc", "tr", "bl", "bc", "br"];
  function applyNavPos(id) {
    if (id && id !== "tl" && NAV_POS.includes(id)) document.documentElement.dataset.nav = id;
    else delete document.documentElement.dataset.nav;
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

  // ---- Freischalten: ein gemeinsamer Code, nur sein Hash steht im Code ----

  const UNLOCK_HASH = "4ffbc1224a6cd30617b443e4665695d19c63d76ba51f6b16bdcdc8b28a2d1e13";

  function isUnlocked() {
    return pref("unlock", null) === UNLOCK_HASH;
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
  }

  function openUnlock() {
    if (state.page !== "settings") togglePage("settings");
    setTimeout(() => {
      const input = document.querySelector(".p-unlock-input");
      if (!input) return;
      input.scrollIntoView({ block: "center", behavior: "smooth" });
      input.focus();
    }, 320);
  }

  // ---- Zustand ----

  const SIZES = [72, 96, 120, 160, 220, 300];
  const ALL = "\u0000all";
  const isZone = (f) => f != null && !String(f).startsWith("\u0000");
  // Startseite: Vorschaubilder im Index, Spalten im Mosaik, Titelbild der Karten
  const HOME_SIZES = [
    { thumb: 26, cols: 6, cover: 120 },
    { thumb: 40, cols: 4, cover: 170 },
    { thumb: 64, cols: 3, cover: 240 },
    { thumb: 96, cols: 2, cover: 320 },
  ]; // state.focus für „Alle Bilder“

  applyRadius(pref("radius", "round"));
  applyNavPos(pref("navPos", "tl"));

  const state = {
    root: "",
    name: "",
    zones: [], // nur die angezeigten Zonen, in Anzeige-Reihenfolge
    items: [],
    byPath: new Map(),
    // Pfad der allein gezeigten Zone, sonst null (alte Seiten-Werte "\u0000…" verwerfen)
    focus: null, // jeder Start beginnt auf der Startseite (Zonen als Karten)
    page: null, // Seite, die von rechts hereingleitet: null | "settings" | "about"
    home: "overview", // Startseite: "overview" | "index" | "preview" | "cards"; jeder Start beginnt mit der Übersicht
    hover: null, // Zone in der Vorschau (Layout "preview")
    // Bildgröße auf der Startseite, Stufe 0–3, je Ansicht getrennt
    homeSizes: pref("homeSizes", null) || { index: pref("homeSize", 1), preview: pref("homeSize", 1), cards: pref("homeSize", 1) },
    // (Übersicht: Größe wie die Karten, solange nichts eigenes gespeichert ist)
    query: "",
    filters: { kind: null, color: null, orient: null, format: null, period: null, dup: false, label: null, site: null },
    found: null, // Seite „Finden“: Treffer nach Rangfolge, null ohne Suche und Filter
    view: pref("view", "grid"),
    size: pref("size", 120),
    infoOpen: pref("infoOpen", false),
    selection: new Set(),
    anchor: null,
    lead: null, // bewegliches Ende einer Shift-Auswahl
    lists: new Map(), // Zone → sichtbare Einträge (nach Suche)
    lightbox: null, // { zone, index }
  };

  // ---- Helfer ----

  function monogram(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return String(name || "?").slice(0, 2).toUpperCase();
  }

  function zoneLabel(path) {
    if (path === "") return state.name;
    return path.split("/").join(" / ");
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

  // Textkarte: der gespeicherte Text. Ältere Karten (vor 0.9.0) haben ihn
  // nur als Bild; dann aus der Texterkennung („TEXT … domain · Datum“).
  function quoteOf(item) {
    if (item.quote) return item.quote;
    if (item.width !== 1400 || item.imageUrl || !item.text || item.format !== "png") return "";
    const m = /^TEXT\s+([\s\S]+?)(?:\s+(?:[\w.-]+\.[a-z]{2,}\s+·\s+)?[\d./-]+)?\s*$/i.exec(item.text.trim());
    return m ? m[1].trim() : "";
  }

  // Textkarte als Text statt Bild: Kennung, Zitat, Quelle und Datum
  function textSheet(item, cls) {
    const len = quoteOf(item).length;
    const sheet = el("div", cls + (len < 140 ? " short" : len < 400 ? " medium" : " long"));
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
    toast(t("error", { msg: String(e && e.message ? e.message : e) }), false);
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
    const rank = (z) => {
      const i = order.indexOf(z.path);
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
    if (isZone(state.focus) && !state.zones.some((z) => z.path === state.focus)) state.focus = null;
    for (const p of [...state.selection]) if (!state.byPath.has(p)) state.selection.delete(p);
    // Offenes Menü nicht unter der Maus wegzeichnen (z. B. während „Wirklich löschen?“)
    if (document.querySelector(".zone-menu")) pendingRender = true;
    else render();
  }

  let pendingRender = false;

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
      text: tokens([item.text, item.quote].join(" ")),
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
    return filtersShown() && !!(f.kind || f.color || f.orient || f.format || f.period || f.dup || f.label || f.site);
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
    return true;
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
    // Art zuerst: Bilder, Tracks, Video, PDF
    for (const k of ["image", "audio", "video", "pdf"])
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
    if (filtersActive()) {
      bar.appendChild(el("span", "p-flex"));
      bar.appendChild(
        chip("(" + t("filterReset") + ")", false, () => {
          state.filters = { kind: null, color: null, orient: null, format: null, period: null, dup: false, label: null, site: null };
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

  function render() {
    renderZones();
    renderToolbar();
    renderInfo();
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
    return state.items.filter((i) => i.zone === path); // neueste zuerst (Reihenfolge aus Rust)
  }

  // Vorschaubild für Startseite und Karten; fehlt das Thumbnail noch, das Original nehmen.
  function previewImg(item) {
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
    // Finden: eine Liste nach Relevanz, bei gleicher Punktzahl das Neueste zuerst
    state.found = words.length || filtering ? found.sort((a, b) => b[0] - a[0] || b[1] - a[1]).map((x) => x[2]) : null;

    const grid = $("zones");
    const home = state.focus == null && !words.length && !filtering;
    document.body.classList.toggle("at-home", home);
    grid.classList.toggle("original", state.view === "original");
    const key = home ? "home:" + state.home : words.length || filtering ? "search" : "zone:" + state.focus;
    const scroll = key === lastViewKey ? grid.scrollTop : 0;
    lastViewKey = key;

    grid.replaceChildren(home ? renderHome() : renderGallery(words.length > 0 || filtering));
    if (home) applyHomeCursor(false);
    layoutMasonry(true);
    grid.scrollTop = scroll;
    for (const path of [...cardCache.keys()]) if (!state.byPath.has(path)) cardCache.delete(path);
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
    else if (state.home === "cards") wrap.appendChild(cardsLayout());
    else if (state.home === "preview") {
      const split = el("div", "p-split");
      split.appendChild(indexList(true));
      split.appendChild(previewPanel());
      wrap.appendChild(split);
    } else wrap.appendChild(indexList(false));
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

  function indexList(compact, zones = state.zones, offset = 0) {
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

    zones.forEach((zone, i) => {
      const index = offset + i;
      const row = el("div", "p-row p-zone");
      row.dataset.zone = zone.path;
      if (offset) {
        // Übersicht: Zeile per Ziehen mit einer Hot Zone tauschen
        row.dataset.swap = zone.path;
        row.addEventListener("pointerdown", (e) => dragSwap(e, row));
      }
      if (compact && zone.path === previewZone()) row.classList.add("current");
      const no = mono(String(index + 1).padStart(2, "0"), "dim");
      if (index < HOT_ZONES) no.title = t("keyHint", { n: index + 1 });
      row.appendChild(no);
      const name = zoneNameEl(zone);
      row.appendChild(name);
      row.appendChild(el("span", "p-num", String(zone.count)));
      if (!compact) {
        row.appendChild(el("span", "p-num", recentDate(lastSaved(zone.path))));
        const thumbs = el("span", "p-thumbs");
        for (const item of zoneItems(zone.path).slice(0, 6)) {
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
    add.addEventListener("click", startNewZone);
    list.appendChild(add);
    return list;
  }

  // ---- Übersicht: oben die vier Hot Zones als Karten, darunter der Index ----

  function overviewLayout() {
    const wrap = el("div", "p-overview");
    const row = el("div", "p-hotrow");
    for (let i = 0; i < HOT_ZONES; i++) row.appendChild(state.zones[i] ? hotCard(state.zones[i], i) : hotSlot(i));
    wrap.appendChild(row);
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
    const items = zoneItems(zone.path);
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
    const onMove = (ev) => {
      if (!lifted) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        lifted = true;
        node.classList.add("lifted");
        node.style.pointerEvents = "none";
        document.body.classList.add("sorting");
        window.getSelection().removeAllRanges();
      }
      ev.preventDefault();
      node.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const next = hit && hit.closest("[data-swap]");
      target = next && next !== node ? next : null;
      for (const n of document.querySelectorAll(".swap-target")) if (n !== target) n.classList.remove("swap-target");
      if (target) target.classList.add("swap-target");
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!lifted) return;
      cardDragged = true;
      setTimeout(() => (cardDragged = false), 0);
      document.body.classList.remove("sorting");
      node.classList.remove("lifted");
      node.style.transform = "";
      node.style.pointerEvents = "";
      for (const n of document.querySelectorAll(".swap-target")) n.classList.remove("swap-target");
      if (!target) return;
      const order = state.zones.map((z) => z.path);
      const a = order.indexOf(node.dataset.swap);
      const b = order.indexOf(target.dataset.swap);
      if (a < 0 || b < 0) return;
      [order[a], order[b]] = [order[b], order[a]];
      setZoneOrder(order);
      renderZones();
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
    const items = zoneItems(path);
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
    for (const zone of state.zones) {
      const top = zone.path === "" ? "" : zone.path.split("/")[0];
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(zone);
    }
    const cards = [];
    for (const [top, zones] of groups) {
      const card = zones.length === 1 && !zones[0].path.includes("/") ? zoneCardTile(zones[0]) : groupCard(top, zones);
      card.dataset.group = top;
      card.addEventListener("pointerdown", (e) => dragCard(e, card, [...groups.keys()]));
      card.addEventListener("dragstart", (e) => e.preventDefault());
      cards.push(card);
    }
    const add = el("article", "p-card p-new");
    add.appendChild(el("div", "zone-card-name", "+ " + t("newZone")));
    add.addEventListener("click", startNewZone);
    cards.push(add);

    // Spalten wie ein Mauerwerk: jede Karte in die gerade kürzeste Spalte
    const width = $("zones").clientWidth - 80;
    const count = Math.max(1, Math.min(4, Math.floor((width + 10) / 280)));
    const wrap = el("div", "p-cards");
    const cols = Array.from({ length: count }, () => wrap.appendChild(el("div", "p-cards-col")));
    const heights = cols.map(() => 0);
    for (const card of cards) {
      const i = heights.indexOf(Math.min(...heights));
      cols[i].appendChild(card);
      heights[i] += (card.querySelector(".p-card-cover") ? 3 : 1) + card.querySelectorAll(".p-card-row").length;
    }
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
      for (const other of document.querySelectorAll(".p-cards .p-card[data-group]")) {
        if (other === card) continue;
        const r = other.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          target = other;
          after = ev.clientY > r.top + r.height / 2;
        }
      }
      for (const other of document.querySelectorAll(".p-cards .p-card[data-group]")) {
        other.classList.toggle("drop-before", other === target && !after);
        other.classList.toggle("drop-after", other === target && after);
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
      for (const n of document.querySelectorAll(".drop-before, .drop-after")) n.classList.remove("drop-before", "drop-after");
      if (!target) return;
      const tops = order.filter((top) => top !== card.dataset.group);
      tops.splice(tops.indexOf(target.dataset.group) + (after ? 1 : 0), 0, card.dataset.group);
      const rank = new Map(tops.map((top, i) => [top, i]));
      const topOf = (path) => (path === "" ? "" : path.split("/")[0]);
      const paths = state.zones.map((z, i) => [z.path, i]);
      paths.sort((a, b) => rank.get(topOf(a[0])) - rank.get(topOf(b[0])) || a[1] - b[1]);
      setZoneOrder(paths.map(([path]) => path));
      renderZones();
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  }

  function cardMeta(zone) {
    const latest = lastSaved(zone.path);
    return zone.count ? countText(zone.count) + (latest ? " · " + recentDate(latest) : "") : t("emptyShort");
  }

  function zoneCardTile(zone) {
    const card = el("article", "p-card");
    card.dataset.zone = zone.path;
    const items = zoneItems(zone.path);
    if (items.length) {
      const cover = el("div", "p-card-cover" + (items.length >= 3 ? " trio" : ""));
      for (const item of items.slice(0, items.length >= 3 ? 3 : 1)) {
        cover.appendChild(previewImg(item));
      }
      card.appendChild(cover);
    }
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

  function groupCard(top, zones) {
    const card = el("article", "p-card p-card-group");
    card.appendChild(el("div", "p-card-group-title", top));
    for (const zone of zones) {
      const row = el("div", "p-card-row");
      row.dataset.zone = zone.path;
      const text = el("div");
      const name = el("div", "zone-card-name", zone.path === top ? top : zone.path.slice(top.length + 1).split("/").join(" / "));
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
    if (state.page) sheet.replaceChildren(state.page === "settings" ? renderSettings() : renderAbout());
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

  // 3 × 2 Punkte wie eine Ausrichtungs-Wahl: oben und unten, je links, Mitte, rechts
  function navPosPicker(rerender) {
    const cur = pref("navPos", "tl");
    const wrap = el("span", "p-navpos");
    for (const id of NAV_POS) {
      const b = button("p-navpos-dot" + (cur === id ? " on" : ""), "", () => {
        setPref("navPos", id);
        applyNavPos(id);
        rerender();
      });
      b.title = t("navPos_" + id);
      b.setAttribute("aria-label", t("navPos_" + id));
      wrap.appendChild(b);
    }
    return wrap;
  }

  function shortPath(path) {
    return String(path || "").replace(/^\/(Users|home)\/[^/]+/, "~");
  }

  // Einklappbare Blöcke in den Einstellungen; der Zustand bleibt gemerkt.
  function collapsible(id, title) {
    return block(title);
  }

  // Zonen: umbenennen, neu anlegen (die ersten vier sind die Hot Zones, Tasten 1–4)
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
  const SETTINGS_SECTIONS = ["library", "look", "connect", "sound", "general"];

  function sectionTitle(id) {
    return t({ library: "setLibrary", look: "setView", connect: "setConnect", sound: "setSound", general: "setGeneral" }[id]);
  }

  function sectionSummary(id) {
    if (id === "library") return shortPath(state.root);
    if (id === "look") {
      const th = window.ArchiverI18n.theme();
      const scheme = window.ArchiverI18n.scheme() === "sage" ? t("schemeSage") : t("schemeStandard");
      return t({ system: "themeSystem", light: "themeLight", dark: "themeDark" }[th]) + " · " + scheme;
    }
    if (id === "connect") return t("setConnectSummary");
    if (id === "sound") return pref("startSound", true) ? t("setOn") : t("setOff");
    return lang === "de" ? "Deutsch" : "English";
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
      const lib = block(t("setLibraryFolder"));
      lib.appendChild(
        blockRow(shortPath(state.root), [
          button("p-link", t("reveal"), () => invoke("reveal_zone", { zone: "" }).catch(fail)),
          button("p-link", t("libraryChange"), chooseLibrary),
        ])
      );
      wrap.appendChild(lib);
      wrap.appendChild(renderZoneSettings());
    }

    if (sub === "look") {
      const view = block(t("setObjects"));
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

      const look = block(t("setLook"));
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
          t("setScheme"),
          choice([["standard", t("schemeStandard")], ["sage", t("schemeSage")]], window.ArchiverI18n.scheme(), (id) => {
            window.ArchiverI18n.setScheme(id);
            rerender();
          })
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
              rerender();
            }
          )
        )
      );
      look.appendChild(blockRow(t("setNavPos"), navPosPicker(rerender)));
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
      look.appendChild(blockRow(t("setReveal"), reveal));
      wrap.appendChild(look);
      wrap.appendChild(renderDragSettings());
    }

    if (sub === "connect") {
      const extBlock = block(t("setExtension"));
      const ext = el("div", null, "…");
      invoke("bridge_browsers")
        .then((list) => (ext.textContent = list.length ? t("setBridgeOn", { list: list.join(", ") }) : t("setBridgeOff")))
        .catch(() => (ext.textContent = t("setBridgeOff")));
      extBlock.appendChild(blockRow(ext, [button("p-link", t("import"), openImportDialog)]));
      wrap.appendChild(extBlock);
      if (isMac) {
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

    if (sub === "sound") wrap.appendChild(renderSoundSettings());

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

  // Zonen beim Ziehen: Deckkraft, gilt in der App und (über die Bibliothek) in der Extension
  function dragAlpha() {
    const v = pref("zoneAlpha", null);
    return typeof v === "number" ? v : null;
  }

  function applyDragAlpha() {
    const v = dragAlpha();
    if (v == null) document.documentElement.style.removeProperty("--zone-alpha");
    else document.documentElement.style.setProperty("--zone-alpha", String(v));
  }

  function renderDragSettings() {
    const b = block(t("setDragZones"));
    b.appendChild(blockRow(el("div", "p-block-text", t("setDragZonesText"))));
    const value = mono("", "p-alpha-value");
    const slider = el("input", "p-volume p-alpha");
    slider.type = "range";
    slider.min = "30";
    slider.max = "100";
    slider.step = "5";
    const show = (pct) => (value.textContent = pct + " %");
    const start = Math.round((dragAlpha() ?? 0.9) * 100);
    slider.value = String(start);
    show(start);
    slider.addEventListener("input", () => {
      show(slider.value);
      document.documentElement.style.setProperty("--zone-alpha", String(Number(slider.value) / 100));
      previewDropbar(true);
    });
    slider.addEventListener("change", () => {
      const v = Number(slider.value) / 100;
      setPref("zoneAlpha", v);
      invoke("set_drag_alpha", { alpha: v }).catch(() => {});
      setTimeout(() => previewDropbar(false), 900);
    });
    b.appendChild(blockRow(t("setDragAlpha"), [slider, value]));
    return b;
  }

  // Ganz unten: Freischalt-Code eingeben, danach nur noch ein ruhiges „Freigeschaltet“
  function renderUnlock() {
    const b = block(t("unlockTitle"));
    b.classList.add("p-unlock");
    if (isUnlocked()) {
      b.appendChild(blockRow(el("div", "p-block-text", t("unlockDone")), mono("●", "p-unlock-dot")));
      return b;
    }
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
      if (hash !== UNLOCK_HASH) {
        form.classList.remove("wrong");
        void form.offsetWidth;
        form.classList.add("wrong");
        input.select();
        return;
      }
      setPref("unlock", hash);
      applyLock();
      renderPage(true);
      toast(t("unlockOk"));
    });
    input.addEventListener("input", () => form.classList.remove("wrong"));
    b.appendChild(el("div", "p-block-text p-unlock-text", t("unlockText")));
    b.appendChild(form);
    return b;
  }

  // Startton: Ein/Aus, Lautstärke mit Probehören, eigene Datei oder der Standard
  function renderSoundSettings() {
    const b = collapsible("sound", t("setSound"));
    b.appendChild(
      blockRow(
        t("setSoundPlay"),
        choice([["on", t("setOn")], ["off", t("setOff")]], pref("startSound", true) ? "on" : "off", (id) => {
          setPref("startSound", id === "on");
          renderPage(true);
        })
      )
    );
    const slider = el("input", "p-volume");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
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
    if (!force && !pref("startSound", true)) return;
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
    meta.appendChild(blockRow(t("setLibrary"), shortPath(state.root)));
    meta.appendChild(blockRow(t("aboutFont"), "SIL OFL"));
    wrap.appendChild(meta);

    wrap.appendChild(el("div", "p-sheet-foot", "© 2026 Lukas Rudolph"));
    return wrap;
  }

  // ---- In einer Zone (G), Alle Bilder und Suche ----

  function renderGallery(searching) {
    const single = !state.query.trim() && isZone(state.focus);
    const shown = single ? state.zones.filter((z) => z.path === state.focus) : state.zones;
    const wrap = el("div", "p-page p-gallery");

    if (single && shown[0]) {
      const zone = shown[0];
      const items = state.lists.get(zone.path) || [];
      const latest = lastSaved(zone.path);
      const sentence = items.length
        ? [t("headZone", { count: countText(items.length), date: recentDate(latest) }), topDomains(items)].filter(Boolean).join(" ")
        : t("headZoneEmpty");
      const h = headline(lastSegment(zone.path), sentence);
      if (canEdit(zone.path)) {
        const title = h.querySelector(".p-head-title");
        title.classList.add("zone-card-name");
        title.title = t("renameHint");
        title.addEventListener("dblclick", () => startRename(title, zone.path));
      }
      wrap.appendChild(h);
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
    if (single && shown[0]) bar.appendChild(mono(t("allLabel") + " (" + shown[0].count + ")", "strong"));
    else if (state.found) bar.appendChild(mono(t("foundLabel") + " (" + state.found.length + ")", "strong"));
    else bar.appendChild(mono(t("allZonesLabel") + " (" + state.zones.length + ")", "strong"));
    bar.appendChild(el("span", "p-flex"));
    for (const v of ["grid", "original"]) {
      const c = chip("(" + t(v === "grid" ? "viewGrid" : "viewOriginal") + ")", state.view === v, () => {
        state.view = v;
        setPref("view", v);
        render();
      });
      c.title = t(v === "grid" ? "viewGridTitle" : "viewOriginalTitle");
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
    return name;
  }

  function lastSaved(zonePath) {
    let latest = 0;
    for (const item of state.items) {
      if (item.zone === zonePath) latest = Math.max(latest, item.capturedAt || item.addedAt || 0);
    }
    return latest;
  }

  function canEdit(path) {
    return path !== "" && path !== "Inbox";
  }

  // ---- Zonen-Menü (⋯): Umbenennen, im Finder zeigen, löschen ----

  function closeMenus() {
    for (const m of document.querySelectorAll(".zone-menu")) m.remove();
    for (const b of document.querySelectorAll(".zone-menu-btn.open")) b.classList.remove("open");
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  }

  function zoneMenuButton(zone) {
    const btn = button("zone-menu-btn", "⋯");
    btn.title = t("zoneOptions");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = btn.classList.contains("open");
      closeMenus();
      if (open) return;
      // Schwebt über allem: Karten schneiden ihren Inhalt ab
      const menu = zoneMenu(zone);
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
      list.forEach((item, i) => cols[i % count].appendChild(itemCard(item)));
      node.replaceChildren(...cols);
    }
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
      card.appendChild(img);
      card.appendChild(el("div", "card-badge"));
      card.appendChild(el("div", "card-media"));
      cardCache.set(item.path, card);
    }
    const label = mediaLabel(item);
    const media = card.querySelector(".card-media");
    media.textContent = label;
    media.hidden = !label;
    const img = card.querySelector("img");
    const quote = quoteOf(item);
    card.classList.toggle("card-text", !!quote);
    let sheet = card.querySelector(".text-sheet");
    if (quote) {
      if (!sheet || sheet.dataset.quote !== quote) {
        if (sheet) sheet.remove();
        sheet = textSheet(item, "text-sheet");
        sheet.dataset.quote = quote;
        card.insertBefore(sheet, img);
      }
      img.hidden = true;
    } else {
      if (sheet) sheet.remove();
      img.hidden = false;
      const src = thumbSrc(item);
      if (img.getAttribute("src") !== src) img.src = src;
    }
    card.querySelector(".card-badge").textContent = domainOf(item.pageUrl) || item.filename;
    // Seitenverhältnis fürs Bild, damit die Spalten vor dem Laden stehen
    if (state.view === "original" && item.width && item.height) card.style.setProperty("--ar", `${item.width} / ${item.height}`);
    else card.style.removeProperty("--ar");
    card.classList.toggle("selected", state.selection.has(item.path));
    return card;
  }

  function setFocus(path) {
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

  async function moveSelection(zone) {
    const items = selectedItems().filter((i) => i.zone !== zone);
    if (!items.length) return;
    const pos = rememberPosition(items);
    try {
      await invoke("move_items", { paths: items.map((i) => i.path), zone });
      await refresh();
      selectNextAt(pos);
      tourStats.drops++;
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
      await invoke("trash_items", { paths: items.map((i) => i.path) });
      await refresh();
      selectNextAt(pos);
      toast(t("trashed", { n: items.length }));
    } catch (e) {
      fail(e);
    }
  }

  // ---- Zonen anlegen und umbenennen ----

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
    return {
      left: LB_PAD.side,
      top: LB_PAD.top,
      width: Math.max(1, a.width - LB_PAD.side * 2),
      height: Math.max(1, a.height - LB_PAD.top - LB_PAD.bottom),
    };
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
    return lb.zone === FOUND ? state.found || [] : state.lists.get(lb.zone) || [];
  }

  function openLightbox(item) {
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
    lb.index = list.indexOf(item);
    $("lbName").textContent = item.filename;
    $("lbName").title = item.filename;
    // Quelle nur, wenn es eine gibt; der blaue Knopf zeigt die Zone
    $("lbSourceBtn").hidden = !item.pageUrl;
    $("lbSourceBtn").title = item.pageUrl || "";
    const zoneName = $("lbAction").querySelector(".lb-action-zone");
    if (zoneName) zoneName.textContent = zoneLabel(item.zone);
    $("lbBrowse").hidden = list.length < 2;
    $("lbCount").textContent = `${lb.index + 1} / ${list.length}`;
    lbCloseZones();
    if (lbInfoOpen) lbRenderInfo(item);
    selectAndShow(item.path);
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
    const k = quoteOf(item) ? "text" : kindOf(item);
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
    if (k === "text") {
      const wrap = el("div", "lb-text");
      wrap.appendChild(textSheet(item, "text-sheet large"));
      box.appendChild(wrap);
      $("lightboxZoom").textContent = "";
      return true;
    }
    if (k === "audio") {
      const sub = [item.artist, item.album].filter(Boolean).join(" · ");
      const wrap = Media.audioEl(fileSrc(item.abs), item.thumb ? fileSrc(item.thumb) : null, item.title || item.filename, sub);
      box.appendChild(wrap);
      lbSetPlayer(wrap.querySelector("audio"));
      $("lightboxZoom").textContent = "";
      return true;
    }
    if (k === "video") {
      const v = Media.videoEl(fileSrc(item.abs), item.thumb ? fileSrc(item.thumb) : null);
      box.appendChild(v);
      lbVZoom = Media.zoomable(v, lbVideoZoomed);
      lbSetPlayer(v);
      lbVideoZoomed(1);
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
    if (quoteOf(item)) inner.appendChild(lbBlock(t("quote"), [quoteBox(item, "lb-quote")]));

    let source = null;
    if (item.pageUrl) {
      const link = el("button", "lb-link", item.pageTitle || domainOf(item.pageUrl));
      link.type = "button";
      link.title = item.pageUrl;
      link.addEventListener("click", () => invoke("open_url", { url: item.pageUrl }).catch(fail));
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
        source || lbRow(t("source"), t("noSource")),
        imageUrl,
        lbRow(t("savedAt"), formatDate(item.capturedAt || item.addedAt)),
      ])
    );
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
    lbInfoOpen = !lbInfoOpen;
    $("lightbox").classList.toggle("info-open", lbInfoOpen);
    $("lbInfoBtn").classList.toggle("active", lbInfoOpen);
    if (lbInfoOpen) lbRenderInfo();
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
    $("lbSourceBtn").textContent = t("source");
    $("lbSourceBtn").addEventListener("click", () => {
      const item = lightboxItem();
      if (item && item.pageUrl) invoke("open_url", { url: item.pageUrl }).catch(fail);
    });
    const action = $("lbAction");
    action.replaceChildren(el("span", "lb-dot"), el("span", "lb-action-zone", "Archiver"));
    action.title = t("dropBar");
    action.addEventListener("click", () => ($("lbZones").hidden ? lbOpenZones() : lbCloseZones()));
    stage.addEventListener("click", lbCloseZones);
    $("lbMedia").addEventListener("click", lbCloseZones);
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
      if (e.target !== $("lightboxImg")) return;
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
    if (lbMode === "pdf" && lbPdf && (e.key === "ArrowDown" || e.key === "ArrowUp")) lbPdf.step(e.key === "ArrowDown" ? 1 : -1);
    else if (lbMode === "pdf" && lbPdf && e.key === "Escape" && !lbPdf.fitted() && $("lbZones").hidden) lbPdf.setZoom(1);
    else if (e.key === "ArrowRight") stepLightbox(1);
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "z" || e.key === "Z") lbToggleZoom();
    else if (e.key === "i" || e.key === "I") lbToggleInfo();
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

  // Abgelegt: Die Zielkarte glüht kurz von hinten nach. Liegt sie in der
  // Leiste, bleibt die so lange stehen und blendet dann aus.
  let landingUntil = 0;
  function landOn(target) {
    const bar = $("dropbar");
    if (!target) return hideDropbar();
    target.classList.add("landed");
    setTimeout(() => target.classList.remove("landed"), 900);
    if (bar.hidden || !bar.contains(target)) return hideDropbar();
    bar.classList.add("leaving");
    landingUntil = Date.now() + 850;
    setTimeout(() => {
      landingUntil = 0;
      hideDropbar();
    }, 850);
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
      (await invoke("drag_icon", { hash: first.hash, path: first.thumb || first.abs }).catch(() => null)) ||
      first.thumb ||
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
  }

  let dragPaths = [];
  let lastTarget = null;
  let dropCount = 0; // für die Tour: wurde schon etwas abgelegt?

  function onDragDrop(event) {
    if (!isUnlocked()) return;
    const p = event.payload;
    if (p.type === "leave") {
      dragPaths = [];
      lastTarget = null;
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
      if (target && target.dataset.zone !== dragHome) target.classList.add("drop-active");
      return;
    }
    // Beim Drop gilt das zuletzt markierte Ziel: ist die Leiste schon weg,
    // läge an derselben Stelle sonst die eigene Zone darunter.
    if (lastTarget) target = lastTarget;
    lastTarget = null;

    if (p.type === "drop") {
      clearDropUi();
      landOn(target && dragPaths.length && target.dataset.zone !== dragHome ? target : null);
      const paths = dragPaths;
      dragPaths = [];
      if (!target || !paths.length) return;
      dropCount++;
      tourStats.drops++;
      const zone = target.dataset.zone;
      // Aus der Lightbox auf eine ihrer Zonen: wie ein Klick auf die Zone
      const lbItem = state.lightbox && target.classList.contains("lb-chip") ? lightboxItem() : null;
      if (lbItem && paths.length === 1 && paths[0] === lbItem.abs) return lbMoveTo(zone);
      const own = paths.filter(insideLibrary).map((path) => path.slice(state.root.length + 1));
      const foreign = paths.filter((path) => !insideLibrary(path));
      const toMove = own.filter((rel) => {
        const item = state.byPath.get(rel);
        return item && item.zone !== zone;
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
    };
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
    };
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
    side.appendChild(el("p", "pdf-hint", t("pdfHint")));
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
      styleRow.replaceChildren(
        chip("(" + t("pdfStyleSheet") + ")", !opts.poster, () => setOpt("poster", false, "pdfPoster")),
        chip("(" + t("pdfStylePoster") + ")", opts.poster, () => {
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
      formatRow.replaceChildren(
        chip("(" + t("pdfLandscape") + ")", !opts.portrait, () => setOpt("portrait", false, "pdfPortrait")),
        chip("(" + t("pdfPortraitLabel") + ")", opts.portrait, () => setOpt("portrait", true, "pdfPortrait"))
      );
      captionRow.replaceChildren(
        chip("(" + t("setOn") + ")", opts.captions, () => setOpt("captions", true, "pdfCaptions")),
        chip("(" + t("setOff") + ")", !opts.captions, () => setOpt("captions", false, "pdfCaptions"))
      );
      const { cols, rows } = grid();
      const pages = Math.max(1, Math.ceil(items.length / (cols * rows)));
      count.textContent = meta() + " · " + t(pages === 1 ? "pdfPages1" : "pdfPagesN", { n: pages });
      save.disabled = !items.length;
    }

    function setOpt(key, value, prefKey) {
      opts[key] = value;
      setPref(prefKey, value);
      renderAll();
    }

    // ---- Vorschau: Seiten in A4-Proportion, Felder wie im PDF ----
    function renderPages() {
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
        const path = await invoke("export_pdf", {
          title: opts.title,
          meta: meta(),
          fileName: name,
          items: items.map(sheetItem),
          layout: { cols, rows, portrait: opts.portrait, captions: opts.captions, poster: opts.poster },
        });
        if (path) {
          tourStats.pdfs++;
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
      if (one.pageUrl) entry(menu, t("ctxSource"), () => invoke("open_url", { url: one.pageUrl }).catch(fail));
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
    menu.appendChild(el("div", "p-more-rule"));
    item(t("settings"), () => togglePage("settings"), state.page === "settings", "⌘,");
    item(t("about"), () => togglePage("about"), state.page === "about");
    item(t("tour"), () => startTour());
    const note = el("div", "p-more-note");
    note.appendChild(el("div", null, state.root.replace(/^\/(Users|home)\/[^/]+/, "~")));
    menu.appendChild(note);
    $("navMore").parentElement.appendChild(menu);
    $("navMore").classList.add("active");
  }

  // ---- Ereignisse ----

  function bindEvents() {
    $("lockText").textContent = t("lockText");
    $("lockOpen").textContent = t("lockOpen");
    $("lockOpen").addEventListener("click", openUnlock);
    const zones = $("zones");

    zones.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const card = e.target.closest(".card");
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
      const card = e.target.closest(".card");
      if (card) clickCard(card.dataset.path, e);
    });

    zones.addEventListener("scroll", () => {
      if (document.querySelector(".p-ctx-menu, .zone-menu.floating")) closeMenus();
    }, { passive: true, capture: true });

    zones.addEventListener("contextmenu", (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      e.preventDefault();
      openItemMenu(card.dataset.path, e.clientX, e.clientY);
    });

    zones.addEventListener("dblclick", (e) => {
      const card = e.target.closest(".card");
      if (card) openLightbox(state.byPath.get(card.dataset.path));
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
    window.addEventListener(
      "resize",
      debounce(() => {
        if (document.body.classList.contains("at-home") && state.home === "cards") renderZones();
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

    if (!mod && !e.altKey && document.body.classList.contains("at-home") && !state.page && homeKey(e)) {
      e.preventDefault();
      return;
    }

    if (mod && (e.key === "n" || e.key === "N") && !e.shiftKey) {
      startNewZone();
    } else if (mod && (e.key === "d" || e.key === "D")) {
      toggleInfo();
    } else if (mod && e.key === ",") {
      togglePage("settings");
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
      else if (state.focus != null) {
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

  async function chooseLibrary() {
    const path = await invoke("pick_folder");
    if (!path) return;
    try {
      await invoke("open_library", { path });
      state.focus = null;
      cardCache.clear();
      showApp();
    } catch (e) {
      fail(e);
    }
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
        fail(e);
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
        fail(e);
      }
    };
  }

  function showExtensionStep() {
    welcomeStep(2, t("onbExtTitle"), t("onbExtText"));
    const status = $("welcomeStatus");
    status.hidden = false;
    let timer = 0;
    const check = () =>
      invoke("bridge_browsers")
        .then((list) => {
          const on = list.length > 0;
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
    startTour(showDropHint);
  }

  // ---- Getting Started (0.19): neun Kapitel, fünf zum Mitmachen ----
  // Läuft im Vollbild, auf Wunsch in einer Demo-Bibliothek (~/Archiver Demo/,
  // lib.rs: open_demo / close_demo). Mitmach-Schritte (live) lassen die
  // Oberfläche bedienbar und gehen erst nach der Aktion weiter. Am Ende
  // verlässt die App das Vollbild, dann öffnet Licht die Oberfläche (reveal.js).

  const TOUR_PREF = "tour3Done";
  // Mitgelieferte Grafiken für das Schema, wenn die Tour in der eigenen Bibliothek läuft
  const TOUR_WEB = ["welle-plakat", "dreieck", "zitrone-etikett", "buchstabe-g", "raster-gelb", "abend-verlauf"];
  // Eintrag im Chrome Web Store, sobald es ihn gibt; bis dahin der Weg über chrome://extensions
  const EXT_STORE_URL = null;
  const tourStats = { drops: 0, pdfs: 0, collected: 0 };
  const tourDemo = { on: false, prevOrder: null, zones: [], web: [] };
  const demoHot = () => tourDemo.zones.filter((z) => z !== "Inbox").slice(0, HOT_ZONES);

  const zoneByName = (name) => state.zones.find((z) => z.path === name);
  const kbdHtml = (s) => s; // Texte stammen aus i18n.js und enthalten <kbd>

  async function enterDemo() {
    tourDemo.prevOrder = pref("zoneOrder", []);
    setPref("demoPrevOrder", tourDemo.prevOrder);
    const info = await invoke("open_demo");
    tourDemo.zones = info.zones;
    tourDemo.web = info.web;
    setPref("zoneOrder", info.zones);
    tourDemo.on = true;
    document.body.classList.add("demo-lib");
    if (state.focus != null || state.query) setFocus(null);
    state.home = "overview";
    await refresh();
  }

  async function leaveDemo(keep) {
    if (!tourDemo.on) return 0;
    tourDemo.on = false;
    document.body.classList.remove("demo-lib");
    const moved = await invoke("close_demo", { keep }).catch((e) => (fail(e), 0));
    setPref("zoneOrder", tourDemo.prevOrder || []);
    localStorage.removeItem("archiver.demoPrevOrder");
    if (state.focus != null || state.query) setFocus(null);
    state.home = "cards";
    await refresh();
    return moved;
  }

  // Ein Absturz mitten in der Demo: beim nächsten Start die eigene Reihenfolge zurückholen
  function restoreAfterDemo() {
    const prev = pref("demoPrevOrder", null);
    if (prev == null) return;
    setPref("zoneOrder", prev);
    localStorage.removeItem("archiver.demoPrevOrder");
  }
  restoreAfterDemo();


  function finderList() {
    const list = el("div", "tour-finder");
    const zones = (tourDemo.on ? demoHot().map(zoneByName) : state.zones.slice(0, HOT_ZONES)).filter(Boolean).slice(0, 3);
    for (const z of zones) {
      const row = el("div", "tour-finder-row");
      row.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13z" fill="none" stroke="currentColor"/></svg>';
      row.append(el("span", null, shortPath(state.root + "/" + z.path) + "/"), el("span", "tour-mono", countText(z.count)));
      list.appendChild(row);
    }
    return list;
  }

  // Vorschläge aus dem, was die Bildanalyse in den Objekten gefunden hat:
  // zwei häufige Farben und zwei häufige Bildinhalte, auf Deutsch, wo es geht.
  function tourSearchWords() {
    const de = new Map();
    if (lang === "de") for (const [word, en] of Object.entries(SEARCH_DE)) if (!de.has(en)) de.set(en, word);
    const colors = new Map();
    const labels = new Map();
    for (const item of state.items) {
      const idx = searchIndex(item);
      for (const [c, share] of idx.colors) if (share >= COLOR_SHARE && c !== "white" && c !== "black" && c !== "gray") colors.set(c, (colors.get(c) || 0) + 1);
      for (const l of idx.labels.slice(0, 3)) labels.set(l, (labels.get(l) || 0) + 1);
    }
    const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => de.get(k) || k);
    const words = [...top(colors, 2), ...top(labels, 2)];
    return words.length >= 2 ? words : t("tourSearchTry").split(", ");
  }

  function keyList() {
    const list = el("div", "tour-keys");
    for (const [k, label] of [["1–4", "tourKeyFile"], [t("tourSpace"), "tourKeyView"], ["⌘F", "tourKeySearch"], ["+ −", "tourKeySize"], ["⌫", "tourKeyTrash"]])
      list.append(el("kbd", null, k), el("span", null, t(label)));
    return list;
  }

  // Schema-Browser wie auf der Website: die Geste spielt dreimal von selbst,
  // dann zieht man selbst. Ein Drop legt das Bild wirklich in die Demo-Zone.
  function browserSchema(ctx) {
    const s = el("div", "tour-schema");
    const tag = el("span", "tour-schema-tag", "(" + t("tourSchemaAuto") + ")");
    const bar = el("div", "tour-schema-bar");
    bar.append(el("span", "tour-schema-dots"), el("span", "tour-schema-url", t("tourSchemaUrl")));
    const grid = el("div", "tour-schema-grid");
    const drop = el("div", "tour-schema-drop");
    const zones = (tourDemo.on ? demoHot() : state.zones.slice(0, HOT_ZONES).map((z) => z.path)).slice(0, HOT_ZONES);
    zones.forEach((z, i) => {
      const d = el("div", "tour-schema-zone");
      d.dataset.zone = z;
      d.append(el("span", "tour-mono", String(i + 1).padStart(2, "0")), el("span", null, zoneLabel(z)));
      drop.appendChild(d);
    });
    const cursor = el("div", "tour-schema-cursor");
    cursor.innerHTML =
      '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M4 2l13 9.5-6.2.9 3.6 7-2.6 1.3-3.6-7L4 18z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    s.append(tag, bar, grid, drop, cursor);
    ctx.user = false;

    const saved = (node, zone, zoneEl, byUser) => {
      node.classList.add("taken");
      zoneEl.classList.remove("flash");
      void zoneEl.offsetWidth;
      zoneEl.classList.add("flash");
      if (tourDemo.on && node.dataset.file) invoke("demo_collect", { file: node.dataset.file, zone }).catch(() => {});
      if (byUser) {
        tourStats.collected++;
        toast(t("tourSchemaSaved", { zone: zoneLabel(zone) }));
      }
    };

    const web = tourDemo.on && tourDemo.web.length ? tourDemo.web : TOUR_WEB.map((n) => ({ file: "", show: "tour/" + n + ".jpg" }));
    for (const w of web) {
      const item = el("div", "tour-schema-item");
      item.dataset.file = w.file;
      const img = el("img");
      img.src = w.show.startsWith("/") ? fileSrc(w.show) : w.show;
      img.alt = "";
      img.draggable = false;
      item.appendChild(img);
      item.addEventListener("pointerdown", (e) => {
        if (e.button || item.classList.contains("taken")) return;
        ctx.user = true;
        tag.textContent = "(" + t("tourSchemaYou") + ")";
        const sx = e.clientX;
        const sy = e.clientY;
        let ghost = null;
        let over = null;
        const move = (ev) => {
          if (!ghost) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
            ghost = el("div", "tour-schema-ghost");
            ghost.appendChild(img.cloneNode());
            document.body.appendChild(ghost);
            item.classList.add("lifted");
            s.classList.add("dragging");
          }
          ghost.style.left = ev.clientX + "px";
          ghost.style.top = ev.clientY + "px";
          const hit = document.elementFromPoint(ev.clientX, ev.clientY);
          const z = hit && hit.closest(".tour-schema-zone");
          const ok = z && drop.contains(z) ? z : null;
          if (ok !== over) {
            if (over) over.classList.remove("over");
            if (ok) ok.classList.add("over");
            over = ok;
          }
        };
        const up = () => {
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          if (!ghost) return;
          ghost.remove();
          item.classList.remove("lifted");
          s.classList.remove("dragging");
          if (over) {
            over.classList.remove("over");
            saved(item, over.dataset.zone, over, true);
          }
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      });
      grid.appendChild(item);
    }

    // Selbstlauf
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rel = (n) => {
      const a = n.getBoundingClientRect();
      const b = s.getBoundingClientRect();
      return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
    };
    const glide = (n, a, b, ms) =>
      n.animate([{ left: a.x + "px", top: a.y + "px" }, { left: b.x + "px", top: b.y + "px" }], {
        duration: ms,
        easing: "cubic-bezier(.55,.05,.25,1)",
        fill: "forwards",
      }).finished;
    (async () => {
      await wait(800);
      for (let k = 0; k < 3; k++) {
        if (ctx.user || !s.isConnected || still) break;
        const free = [...grid.children].filter((n) => !n.classList.contains("taken"));
        if (!free.length) break;
        const card = free[k % free.length];
        const zoneEl = drop.children[[1, 0, 2][k] % drop.children.length];
        if (!zoneEl) break;
        const start = { x: s.clientWidth * 0.5, y: s.clientHeight * 0.55 };
        const a = rel(card);
        cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });
        await glide(cursor, start, a, 650);
        if (ctx.user) break;
        await wait(140);
        const ghost = el("div", "tour-schema-ghost local");
        ghost.appendChild(card.firstChild.cloneNode());
        s.appendChild(ghost);
        ghost.style.left = a.x + "px";
        ghost.style.top = a.y + "px";
        card.classList.add("lifted");
        s.classList.add("dragging");
        await wait(260);
        const z = rel(zoneEl);
        setTimeout(() => zoneEl.classList.add("over"), 600);
        await Promise.all([glide(cursor, a, z, 850), glide(ghost, a, z, 850)]);
        await wait(220);
        zoneEl.classList.remove("over");
        ghost.remove();
        card.classList.remove("lifted");
        s.classList.remove("dragging");
        saved(card, zoneEl.dataset.zone, zoneEl, false);
        await cursor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 200, fill: "forwards" }).finished;
        await wait(700);
      }
      if (s.isConnected) tag.textContent = "(" + t("tourSchemaYou") + ")";
    })();
    return s;
  }

  const TOUR = [
    {
      key: "Start",
      center: true,
      buttons: (api) => [
        [t("tourOwn"), () => api.next()],
        [
          t("tourDemo"),
          async () => {
            try {
              await enterDemo();
            } catch (e) {
              fail(e);
            }
            api.next();
          },
          true,
        ],
      ],
    },
    {
      key: "Folders",
      setup: () => {
        if (state.focus != null || state.query) setFocus(null);
        if (state.home !== "overview") {
          state.home = "overview";
          renderZones();
        }
      },
      target: () => document.querySelector(".p-hotrow"),
      extra: finderList,
    },
    {
      key: "Active",
      setup: (ctx) => {
        if (state.focus != null || state.query) setFocus(null);
        if (state.home !== "overview") {
          state.home = "overview";
          renderZones();
        }
        // Die Leiste fährt ein und bleibt stehen, solange der Schritt offen ist
        ctx.peek = setTimeout(() => {
          showDropbar();
          document.body.classList.remove("dragging");
          $("dropbar").classList.add("preview");
        }, 500);
      },
      teardown: (ctx) => {
        clearTimeout(ctx.peek);
        $("dropbar").classList.remove("preview");
        hideDropbar();
      },
      target: () => document.querySelector(".p-hotrow"),
    },
    {
      key: "Browser",
      center: true,
      wide: true,
      setup: (ctx) => {
        ctx.n = tourStats.collected;
        const check = () =>
          invoke("bridge_browsers")
            .then((list) => (ctx.browsers = list))
            .catch(() => (ctx.browsers = []));
        check();
        ctx.timer = setInterval(check, 2000);
      },
      teardown: (ctx) => clearInterval(ctx.timer),
      extra: (ctx) => ctx.schema || (ctx.schema = browserSchema(ctx)),
      done: (ctx) => tourStats.collected > ctx.n,
      status: (ctx) =>
        ctx.browsers && ctx.browsers.length
          ? { ok: true, text: t("onbExtOn", { list: ctx.browsers.join(", ") }) }
          : { ok: false, text: t("onbExtWaiting") },
      third: (ctx) =>
        ctx.browsers && ctx.browsers.length
          ? null
          : EXT_STORE_URL
            ? [t("tourStore"), () => invoke("open_url", { url: EXT_STORE_URL }).catch(fail)]
            : [
                t("onbExtOpen"),
                () =>
                  navigator.clipboard
                    .writeText("chrome://extensions")
                    .then(() => toast(t("onbExtCopied")))
                    .catch(fail),
              ],
    },
    {
      key: "File",
      live: true,
      corner: true,
      setup: (ctx) => {
        ctx.n = tourStats.drops;
        const inbox = zoneByName("Inbox");
        if (tourDemo.on && inbox) setFocus(inbox.path);
        else if (state.items.length) setFocus(ALL);
      },
      text: () => (tourDemo.on || state.items.length ? "tourFileText" : "tourFileEmpty"),
      done: (ctx) => tourStats.drops > ctx.n || dropCount > (ctx.d ?? (ctx.d = dropCount)),
    },
    {
      key: "View",
      live: true,
      corner: true,
      setup: (ctx) => {
        ctx.seen = false;
        const zone = tourDemo.on && zoneByName(demoHot()[0]);
        if (zone) setFocus(zone.path);
        else if (state.items.length && state.focus == null) setFocus(ALL);
      },
      done: (ctx) => ctx.seen || (ctx.seen = !!state.lightbox),
    },
    {
      key: "Search",
      live: true,
      corner: true,
      setup: () => {
        if (state.lightbox) closeLightbox();
        setFocus(null);
        openSearch();
      },
      extra: () => {
        const chips = el("div", "tour-chips");
        for (const w of tourSearchWords()) {
          chips.appendChild(
            chip("„" + w + "“", false, () => {
              const input = $("search");
              input.value = w;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.focus();
            })
          );
        }
        return chips;
      },
      target: () => $("navSearch"),
      done: () => !!state.query.trim() && !!state.found && state.found.length > 0,
    },
    {
      key: "Poster",
      live: true,
      corner: true,
      setup: (ctx) => {
        ctx.n = tourStats.pdfs;
        $("search").value = "";
        $("search").blur();
        const zone = tourDemo.on && zoneByName(demoHot()[1] || demoHot()[0]);
        if (zone) setFocus(zone.path);
        else if (state.focus == null && state.items.length) setFocus(ALL);
      },
      buttons: (api, ctx) =>
        ctx.finished
          ? null
          : [
              [
                t("tourPosterDo"),
                () => {
                  const items = allVisible();
                  if (!items.length) return toast(t("pdfNothing"));
                  const title = isZone(state.focus) ? zoneLabel(state.focus) : t("pdfSelection");
                  openPdfMaker(items.slice(), title, { poster: true });
                },
                true,
              ],
            ],
      done: (ctx) => tourStats.pdfs > ctx.n,
    },
    {
      key: "End",
      center: true,
      extra: keyList,
      buttons: (api) =>
        tourDemo.on
          ? [
              [t("tourKeepDemo"), () => api.end("keep")],
              [t("tourToOwn"), () => api.end("own"), true],
            ]
          : [[t("tourDone"), () => api.end("own"), true]],
    },
  ];

  function startTour(done) {
    if (document.querySelector(".tour") || !isUnlocked()) return;
    closeMenus();
    closeMoreMenu();
    if (state.page) closePage();
    let step = 0;
    let ctx = {};
    let poll = 0;
    let ending = false;
    const layer = el("div", "tour");
    const ring = el("div", "tour-ring");
    const card = el("div", "tour-card");
    layer.append(ring, card);
    document.body.appendChild(layer);

    const leave = () => {
      clearInterval(poll);
      const s = TOUR[step];
      if (s && s.teardown) s.teardown(ctx);
    };
    const end = async (mode) => {
      if (ending) return;
      ending = true;
      leave();
      setPref(TOUR_PREF, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", render);
      await layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" }).finished;
      layer.remove();
      await finale(mode !== "keep");
      if (done) done();
    };
    const go = (to) => {
      leave();
      step = Math.max(0, to);
      if (step >= TOUR.length) return end("own");
      enter();
    };
    const api = { next: () => go(step + 1), end };
    const onKey = (e) => {
      // Tippen und offene Ansichten (Vorschau, PDF-Ersteller) gehören nicht der Tour
      if (e.target.closest && e.target.closest("input, textarea, [contenteditable]")) return;
      if (state.lightbox || document.querySelector(".pdf-maker")) return;
      const s = TOUR[step];
      if (e.key === "Escape") end("own");
      else if (e.key === "Enter" && !e.target.closest("button") && !s.buttons && !(s.done && !ctx.finished)) api.next();
      else if (e.key === "ArrowRight" && !s.live && !s.buttons && !(s.done && !ctx.finished)) api.next();
      else if (e.key === "ArrowLeft" && !s.live && step > 0) go(step - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };

    function enter() {
      const s = TOUR[step];
      ctx = { finished: false };
      card.replaceChildren();
      if (s.setup) s.setup(ctx);
      render();
      if (s.done || s.status)
        poll = setInterval(() => {
          layer.classList.toggle("away", !!document.querySelector(".pdf-maker"));
          if (s.done && !ctx.finished && s.done(ctx)) {
            ctx.finished = true;
            render();
          } else if (s.status) renderStatus();
        }, 400);
    }

    function renderStatus() {
      const s = TOUR[step];
      const node = card.querySelector(".tour-status");
      if (!s.status || !node) return;
      const st = s.status(ctx);
      node.className = "tour-status" + (st.ok ? " ok" : "");
      node.textContent = st.text;
      const acts = card.querySelector(".tour-actions");
      if (acts) acts.replaceWith(actions());
    }

    function actions() {
      const s = TOUR[step];
      const row = el("div", "tour-actions");
      const left = el("div", "tour-actions-group");
      const right = el("div", "tour-actions-group");
      if (step < TOUR.length - 1) left.appendChild(button("p-chip", "(" + t("tourSkip") + ")", () => end("own")));
      if (step > 0) left.appendChild(button("p-chip", "(" + t("tourBack") + ")", () => go(step - 1)));
      const third = s.third && !ctx.finished ? s.third(ctx) : null;
      if (third) right.appendChild(button("p-chip", "(" + third[0] + ")", third[1]));
      const custom = s.buttons ? s.buttons(api, ctx) : null;
      if (custom) for (const [label, fn, primary] of custom) right.appendChild(button("p-chip" + (primary ? " active" : ""), "(" + label + ")", fn));
      if (!custom || (s.key === "Poster" && ctx.finished)) {
        const waiting = s.done && !ctx.finished;
        right.appendChild(button("p-chip" + (waiting ? "" : " active"), "(" + t(waiting ? "tourLater" : "tourNext") + ")", api.next));
      }
      row.append(left, right);
      return row;
    }

    function render() {
      const s = TOUR[step];
      const keepSchema = s.key === "Browser" && ctx.schema && card.contains(ctx.schema);
      const title = t("tour" + s.key + (ctx.finished ? "Done" : "Title"));
      const textKey = ctx.finished ? "tour" + s.key + "DoneText" : s.text ? s.text() : "tour" + s.key + "Text";
      if (keepSchema) {
        card.querySelector(".tour-title").textContent = title;
        card.querySelector(".tour-text").innerHTML = kbdHtml(t(textKey));
        renderStatus();
        card.querySelector(".tour-actions").replaceWith(actions());
      } else {
        const count = el("div", "tour-progress");
        TOUR.forEach((_, i) => count.appendChild(el("i", i <= step ? "on" : null)));
        const text = el("div", "tour-text");
        text.innerHTML = kbdHtml(t(textKey));
        card.replaceChildren(count, el("div", "tour-title", title), text);
        if (s.extra) {
          const extra = el("div", "tour-extra");
          extra.appendChild(s.extra(ctx));
          card.appendChild(extra);
        }
        if (s.status) card.appendChild(el("div", "tour-status"));
        card.appendChild(actions());
        renderStatus();
      }
      layer.classList.toggle("live", !!s.live);
      card.className = "tour-card" + (s.wide ? " wide" : "") + (s.corner ? " corner" : "") + (s.center ? " center" : "");
      card.style.cssText = "";
      const target = s.target && s.target();
      const r = target ? target.getBoundingClientRect() : null;
      ring.hidden = !r || !r.width;
      if (ring.hidden) return;
      const pad = 6;
      ring.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${Math.min(r.height, innerHeight - r.top - 12) + pad * 2}px`;
      if (s.corner || s.center) return;
      const w = Math.min(380, innerWidth - 32);
      const left = Math.max(16, Math.min(innerWidth - w - 16, r.left + r.width / 2 - w / 2));
      if (r.bottom < innerHeight * 0.55) card.style.cssText = `left:${left}px;top:${Math.min(r.bottom + 18, innerHeight - card.offsetHeight - 16)}px`;
      else card.style.cssText = `left:${left}px;bottom:${innerHeight - r.top + 18}px`;
    }

    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", render);
    enter();
  }

  // Abschluss: zurück zur eigenen Bibliothek, Licht-Öffnung
  async function finale(own) {
    const cover = el("div", "reveal-cover");
    document.body.appendChild(cover);
    await cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "ease-in-out", fill: "forwards" }).finished;
    const demo = tourDemo.on;
    const moved = demo ? await leaveDemo(!own) : 0;
    if (!demo) {
      if (state.focus != null || state.query) setFocus(null);
      state.home = "cards";
      renderZones();
    }
    await playReveal(cover);
    if (demo) toast(moved ? t("tourBackOwnMoved", { n: moved }) : t("tourBackOwn"));
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

  function showApp() {
    $("welcome").hidden = true;
    $("app").hidden = false;
    applyLock();
    applyDragAlpha();
    return refresh().then(() => {
      // Nach dem Sprachwechsel wieder in den Einstellungen landen
      const reopen = sessionStorage.getItem("archiver.reopen") || "";
      if (reopen.startsWith("settings")) {
        sessionStorage.removeItem("archiver.reopen");
        togglePage("settings");
        if (reopen.includes(":")) openSettingsSection(reopen.split(":")[1]);
      }
      invoke("get_drag_alpha")
        .then((a) => {
          if (typeof a === "number") setPref("zoneAlpha", a);
          applyDragAlpha();
        })
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
    if (document.querySelector(".p-update")) return;
    const info = await invoke("update_check").catch(() => null);
    if (!info || document.querySelector(".p-update")) return;
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

  async function boot() {
    bindEvents();
    TAURI.event.listen("library-changed", debounce(refresh, 120));
    TAURI.event.listen("thumbs-ready", (e) => applyThumbs(e.payload));
    TAURI.event.listen("analysis-ready", (e) => applyAnalysis(e.payload));
    TAURI.event.listen("reveal-in-app", (e) => revealFromViewer(e.payload));
    const info = await invoke("start_info");
    if (info.library) {
      await showApp();
      // Einmal für alle, die vor der Tour schon eingerichtet waren
      if (!pref(TOUR_PREF, false)) setTimeout(() => startTour(), 2800);
    } else showWelcome(info);
    hideSplash();
    setTimeout(checkUpdate, 3000);
    // Auch im laufenden Betrieb: alle 30 Minuten und wenn das Fenster wieder nach vorne kommt
    setInterval(checkUpdate, 30 * 60 * 1000);
    let lastFocusCheck = Date.now();
    window.addEventListener("focus", () => {
      if (Date.now() - lastFocusCheck < 5 * 60 * 1000) return;
      lastFocusCheck = Date.now();
      checkUpdate();
    });
  }

  boot().catch((e) => {
    hideSplash();
    fail(e);
  });
})();
