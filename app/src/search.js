// search.js — eine Suche für App und Tray (0.31.1).
// Gesucht wird in Name, Zone, Bildtext, Quelle, erkannten Motiven, Text im
// Bild und Farben. Jedes Wort muss irgendwo passen. Ganze Wörter und deutsche
// Wortformen („Kreise“ → Kreis) zählen voll, Wortanfänge nur beim Wort, das
// gerade getippt wird, Wortteile („Entwurf“ in „Plakatentwurf“) nur in Namen.
// Motive zählen erst ab einer Sicherheit von LABEL_MIN.

(function (global) {
  // Deutsche Suchbegriffe → Motive der Bilderkennung (englisch)
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

  const COLOR_NAMES = new Set(["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "black", "gray", "white"]);
  const COLOR_SHARE = 0.12; // ab diesem Anteil zählt eine Farbe für Suche und Filter
  const LABEL_MIN = 0.5; // ab dieser Sicherheit zählt ein Motiv für Suche und Motiv-Filter
  const LEGACY_LABELS = 4; // ältere Analysen ohne Sicherheit: nur die ersten Motive zählen

  // Kleinschreibung, Umlaute als ae/oe/ue, ß als ss, Akzente weg
  function fold(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  // Wörter; Dateinamen werden auch an Groß-/Kleinschreibung und Ziffern
  // getrennt („KonzertPlakat2024“ → konzert, plakat, 2024)
  function tokens(text) {
    const split = String(text || "")
      .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
      .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, (m, a, b, c, d) => (a ? a + " " + b : c + " " + d));
    return fold(split).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  // Leichter Wortstamm für Deutsch und Englisch: eine Endung ab
  const ENDINGS = ["ern", "en", "er", "es", "em", "e", "n", "s"];
  function stem(w) {
    for (const end of ENDINGS) {
      if (!w.endsWith(end) || w.length - end.length < 3) continue;
      if ((end === "s" || end === "n") && (w.length < 5 || /[siu]$/.test(w.slice(0, -1)))) continue;
      return w.slice(0, -end.length);
    }
    return w;
  }

  // Gleiches Wort, auch in anderer Form (Kreis, Kreise, Kreisen)
  function same(a, b) {
    if (a === b) return true;
    const sa = stem(a);
    const sb = stem(b);
    return sa === sb || sa === b || a === sb;
  }

  const DICT = {};
  for (const [de, en] of Object.entries(SEARCH_DE)) DICT[fold(de)] = en;

  // Rückweg Englisch → Deutsch für die Motiv-Chips (erster deutscher Begriff gewinnt)
  const LABEL_DE = {};
  for (const [de, en] of Object.entries(SEARCH_DE)) if (!LABEL_DE[en]) LABEL_DE[en] = de;
  Object.assign(LABEL_DE, { "interior room": "innenraum", adult: "erwachsene", people: "menschen", outdoor: "draußen", indoor: "drinnen" });

  function translate(w) {
    return DICT[w] || DICT[stem(w)] || null;
  }

  // „poster:0.92, art:0.55“ (ab 0.31.1) oder „poster, art“ (älter, ohne Sicherheit)
  function parseLabels(text) {
    const list = String(text || "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .map((part, i) => {
        const m = /^(.*?):([\d.]+)$/.exec(part);
        if (m) return { name: m[1].trim(), conf: Number(m[2]) || 0 };
        return { name: part, conf: i < LEGACY_LABELS ? LABEL_MIN : 0 };
      });
    return list.filter((l) => l.name && l.conf >= LABEL_MIN);
  }

  function parseColors(text) {
    const colors = new Map();
    for (const part of String(text || "").split(" ")) {
      const [name, share] = part.split(":");
      if (name) colors.set(name, Number(share) || 0);
    }
    return colors;
  }

  const stripExt = (name) => String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const domainOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };

  // Suchindex pro Objekt; `item._idx = null` verwirft ihn (neue Analyse)
  function index(item, opts) {
    if (item._idx) return item._idx;
    const rights = !!(opts && opts.rights);
    const labels = parseLabels(item.labels);
    item._idx = {
      name: tokens([stripExt(item.filename), item.pageTitle, item.title, item.artist, item.album].join(" ")),
      nameText: fold([stripExt(item.filename), item.title, item.pageTitle].join(" ")).replace(/[^\p{L}\p{N}]+/gu, " "),
      zone: tokens(item.zone),
      own: tokens([item.caption, item.quote, item.note, rights ? item.credit : ""].join(" ")),
      by: tokens(item.addedBy),
      site: tokens(domainOf(item.pageUrl) + " " + domainOf(item.imageUrl)),
      ocr: tokens(item.text),
      labels,
      labelNames: labels.map((l) => l.name),
      colors: parseColors(item.colors),
    };
    return item._idx;
  }

  // Suchtext in Wörter; das letzte Wort darf ein Wortanfang sein, solange
  // danach kein Leerzeichen getippt ist
  const STOP = new Set(["der", "die", "das", "den", "dem", "des", "und", "oder", "mit", "von", "vom", "im", "in", "am", "an", "auf", "ein", "eine", "einen", "the", "and", "or", "of", "a", "an", "with", "on"]);

  function parse(query) {
    const raw = String(query || "");
    let words = tokens(raw);
    const kept = words.filter((w) => !STOP.has(w));
    if (kept.length) words = kept;
    words.typing = words.length > 0 && !/\s$/.test(raw);
    words.phrase = words.join(" ");
    return words;
  }

  // Punkte eines Wortes in einer Liste: ganz, angefangen oder als Wortteil
  function inList(list, w, typing, full, start, part) {
    let best = 0;
    for (const x of list) {
      if (same(x, w)) return full;
      if (start && typing && w.length >= 2 && x.startsWith(w)) best = Math.max(best, start);
      else if (part && w.length >= 4 && x.length > w.length + 2 && x.includes(stem(w))) best = Math.max(best, part);
    }
    return best;
  }

  function wordScore(idx, w, typing) {
    const en = translate(w);
    let best = Math.max(
      inList(idx.name, w, typing, 6, 5, 3),
      inList(idx.zone, w, typing, 4, 3.5, 2.5),
      inList(idx.own, w, typing, 4, 3, 0),
      inList(idx.site, w, typing, 3.5, 3, 0),
      inList(idx.by, w, false, 3, 0, 0),
      inList(idx.ocr, w, typing && w.length >= 4, 2, 1, 0)
    );
    // Motive: sicher erkannte zählen nach ihrer Sicherheit
    for (const label of idx.labels) {
      const parts = label.name.split(" ");
      const hit = label.name === en || (en && parts.includes(en)) || parts.some((p) => same(p, w));
      if (hit) best = Math.max(best, 2 + 3 * label.conf);
      else if (typing && w.length >= 4 && parts.some((p) => p.startsWith(w))) best = Math.max(best, 1 + 2 * label.conf);
    }
    const color = en && COLOR_NAMES.has(en) ? en : COLOR_NAMES.has(w) ? w : null;
    const share = color ? idx.colors.get(color) || 0 : 0;
    if (share >= COLOR_SHARE) best = Math.max(best, 2 + share * 4);
    return best;
  }

  // 0 = kein Treffer; jedes Wort muss passen. Steht die ganze Suche so im
  // Namen, kommt das Objekt nach vorn.
  function score(item, words, opts) {
    if (!words.length) return 1;
    const idx = index(item, opts);
    let total = 0;
    words.forEach((w, i) => {
      if (total < 0) return;
      const s = wordScore(idx, w, !!words.typing && i === words.length - 1);
      total = s ? total + s : -1;
    });
    if (total <= 0) return 0;
    if (words.length > 1 && (" " + idx.nameText + " ").includes(" " + words.phrase)) total += 3;
    return total;
  }

  // Motive für Chips und Filter: die sicheren, höchstens n
  function motifs(item, n, opts) {
    const names = index(item, opts).labelNames;
    return n ? names.slice(0, n) : names;
  }

  function colorShare(item, color, opts) {
    return index(item, opts).colors.get(color) || 0;
  }

  global.ArchiverSearch = { parse, score, index, motifs, colorShare, tokens, stem, fold, LABEL_DE, COLOR_SHARE, LABEL_MIN };
})(typeof window !== "undefined" ? window : globalThis);
