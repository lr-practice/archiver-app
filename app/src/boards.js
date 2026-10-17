// boards.js — Boards (0.39.0): Präsentationen aus Bildern der Bibliothek, als
// eigener Bereich neben Archiver. Ein Board ist eine Datei Boards/Name.board
// (boards.rs), Bilder stehen darin als Verweis (Hash, Pfad), nie als Kopie.
//
// Ebenen: Übersicht (Boards als Karten) → Editor. Der Editor zeigt nur die
// Folie und unten eine Leiste; Folien, Bilder und Gestalten öffnen sich daraus
// als Glas und sind ab Werk zu. Folien sind 1600 × 1000 Einheiten, gezeichnet
// mit CSS-Transform. Siehe DESIGN.md 4.24.

(function () {
  const { t, lang } = window.ArchiverI18n;
  let A = null; // Bausteine aus app.js (init)

  const W = 1600;
  const H = 1000;
  const VERSION = 1;

  const B = {
    list: null, // boards_list
    name: null, // offenes Board (Dateiname ohne Endung)
    deck: null,
    cur: 0,
    sel: new Set(),
    tab: "template",
    open: { rail: false, lib: false, insp: false },
    zone: null, // Bilder: gewählte Zone, null = alle
    query: "",
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);
  const host = () => $("zones");
  const uid = () => Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, "0");

  function el(tag, cls, text) {
    return A.el(tag, cls, text);
  }

  function btn(cls, text, fn, title) {
    const b = A.button(cls, text, fn);
    if (title) b.title = title;
    return b;
  }

  // ---- Bilder der Bibliothek: Verweis über Hash, sonst Pfad ----

  let mapFor = null;
  let byHash = new Map();
  let byPath = new Map();
  function items() {
    const list = A.items();
    if (list !== mapFor) {
      mapFor = list;
      byHash = new Map();
      byPath = new Map();
      for (const it of list) {
        if (it.hash) byHash.set(it.hash, it);
        byPath.set(it.path, it);
      }
    }
    return list;
  }
  function itemOf(o) {
    items();
    return byHash.get(o.k) || byPath.get(o.p) || null;
  }
  const visual = (it) => it && (it.thumb || A.kindOf(it) === "image");
  const ratio = (it) => (it && it.width && it.height ? it.width / it.height : 4 / 3);
  const R = (k) => ratio(byHash.get(k) || itemOf({ k }));
  // Original für Bilder, sonst Vorschau (Video, PDF)
  const fullSrc = (it) => (A.kindOf(it) === "image" ? A.fileSrc(it.abs) : A.thumbSrc(it));
  const smallSrc = (it) => A.thumbSrc(it);

  function captionOf(it) {
    if (!it) return "";
    const name = String(it.filename || "").replace(/\.[^.]+$/, "");
    let src = "";
    try {
      if (it.pageUrl) src = new URL(it.pageUrl).hostname.replace(/^www\./, "");
    } catch {}
    return name + (src ? "|" + src : "");
  }

  // ---- Gestaltung ----

  // Nur Schriften, die auf jedem Mac liegen, dazu Geist aus der App
  const FONTS = {
    geist: ["Geist", '"Geist", system-ui, sans-serif'],
    helvetica: ["Helvetica Neue", '"Helvetica Neue", Helvetica, Arial, sans-serif'],
    avenir: ["Avenir Next", '"Avenir Next", Avenir, sans-serif'],
    futura: ["Futura", 'Futura, "Century Gothic", sans-serif'],
    didot: ["Didot", 'Didot, "Bodoni 72", Georgia, serif'],
    baskerville: ["Baskerville", 'Baskerville, "Baskerville Old Face", Georgia, serif'],
    mono: ["Geist Mono", '"Geist Mono", ui-monospace, monospace'],
  };
  const BGS = [
    ["#ffffff", "#111111", "#9a9a9a"],
    ["#f2efe8", "#1a1814", "#9b958a"],
    ["#e9e9e9", "#111111", "#8a8a8a"],
    ["#111111", "#f2f2f2", "#7a7a7a"],
    ["#1d2b6b", "#f4f1e8", "#8d96c2"],
    ["#e23e1b", "#fff6ee", "#ffb9a6"],
  ];
  const DEFAULT_STYLE = {
    cols: 12, margin: 14, gap: 8, align: "top", fit: "contain",
    bg: "#ffffff", fg: "#111111", dim: "#9a9a9a",
    font: "geist", hsize: 12, csize: 13, ssize: 66, weight: 500, track: -0.01,
    header: true, captions: false, grid: false, snap: true,
  };

  // ---- Vorlagen: ordnen nur die erste Lage, danach ist alles frei ----

  function area(s) {
    const top = s.header ? s.margin + 76 : s.margin;
    return { x: s.margin, y: top, w: W - 2 * s.margin, h: H - top - s.margin };
  }
  function colw(s) {
    const a = area(s);
    return (a.w - s.gap * (s.cols - 1)) / s.cols;
  }
  function span(s, c0, n) {
    const cw = colw(s);
    const a = area(s);
    return { x: a.x + c0 * (cw + s.gap), w: n * cw + (n - 1) * s.gap };
  }
  const units = (s, twelfths) => Math.max(1, Math.round((twelfths * s.cols) / 12));
  function vAlign(s, boxes, a) {
    if (s.align === "top" || !boxes.length) return boxes;
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    const room = a.y + a.h - bottom;
    const dy = s.align === "middle" ? room / 2 : room;
    return boxes.map((b) => ({ ...b, y: b.y + Math.max(0, dy) }));
  }
  function img(k, x, y, w, hh, extra) {
    const it = byHash.get(k);
    return { id: uid(), type: "img", k, p: it ? it.path : undefined, x, y, w, h: hh, ...(extra || {}) };
  }
  const txt = (text, x, y, w, size, extra) => ({ id: uid(), type: "text", text, x, y, w, h: size * 1.1, size, ...(extra || {}) });
  const cap = (k) => captionOf(byHash.get(k));

  const TEMPLATES = [
    {
      id: "index",
      fn(s, ks) {
        // Reihen nach einem Muster aus Spaltenbreiten; passt nicht alles, schrumpft alles gleichmäßig
        if (!ks.length) return [];
        const a = area(s);
        const pat = [5, 3, 4, 3, 2, 4, 3, 3];
        const rows = [];
        let c = 0;
        let row = [];
        ks.forEach((k, i) => {
          const n = Math.min(units(s, pat[i % pat.length]), s.cols);
          if (c + n > s.cols && row.length) {
            rows.push(row);
            row = [];
            c = 0;
          }
          row.push({ k, c, n });
          c += n;
        });
        if (row.length) rows.push(row);
        const heights = rows.map((r) => Math.max(...r.map((q) => span(s, q.c, q.n).w / R(q.k))));
        const gaps = s.gap * (rows.length - 1);
        const f = Math.min(1, (a.h - gaps) / heights.reduce((sum, v) => sum + v, 0));
        let y = a.y;
        const out = [];
        rows.forEach((r, ri) => {
          r.forEach((q) => {
            const sp = span(s, q.c, q.n);
            const w = sp.w * f;
            out.push(img(q.k, sp.x, y, w, s.fit === "cover" ? heights[ri] * f : w / R(q.k)));
          });
          y += heights[ri] * f + s.gap;
        });
        return vAlign(s, out, a);
      },
    },
    {
      id: "pair",
      fn(s, ks) {
        if (!ks.length) return [];
        const a = area(s);
        const [k1, k2] = ks;
        const w1 = Math.min(a.h * R(k1), a.w * (k2 ? 0.45 : 1));
        const out = [img(k1, a.x, a.y, w1, w1 / R(k1))];
        if (k2) {
          const w2 = a.w - w1 - s.gap;
          out.push(img(k2, a.x + w1 + s.gap, a.y, w2, Math.min(a.h, w2 / R(k2))));
        }
        return vAlign(s, out, a);
      },
    },
    {
      id: "statement",
      fn(s, ks, keep) {
        const a = area(s);
        const out = [txt(keep || t("bStatementText"), a.x, a.y - (s.header ? 30 : 0) + 10, a.w * 0.92, s.ssize, { weight: s.weight })];
        const n = Math.min(4, ks.length);
        const cell = (a.w - 3 * 40) / 4;
        const box = Math.min(cell, 250);
        ks.slice(0, n).forEach((k, i) => {
          const r = R(k);
          const w = r > 1 ? box : box * r;
          const hh = r > 1 ? box / r : box;
          out.push(img(k, a.x + i * (cell + 40), a.y + a.h - box - 70 + (box - hh) / 2, w, hh, { caption: cap(k) }));
        });
        return out;
      },
    },
    {
      id: "grid",
      fn(s, ks) {
        const a = area(s);
        const n = Math.max(2, Math.round(s.cols / 3));
        const cw = (a.w - s.gap * (n - 1)) / n;
        const ys = Array(n).fill(a.y);
        const out = [];
        ks.forEach((k) => {
          const i = ys.indexOf(Math.min(...ys));
          const hh = cw / R(k);
          if (ys[i] + hh > a.y + a.h + 1) return;
          out.push(img(k, a.x + i * (cw + s.gap), ys[i], cw, hh));
          ys[i] += hh + s.gap;
        });
        return out;
      },
    },
    {
      id: "single",
      fn(s, ks) {
        if (!ks.length) return [];
        const a = area(s);
        const k = ks[0];
        let hh = a.h;
        let w = hh * R(k);
        if (w > a.w) {
          w = a.w;
          hh = w / R(k);
        }
        return [img(k, a.x + (a.w - w) / 2, a.y + (a.h - hh) / 2, w, hh)];
      },
    },
    {
      id: "color",
      fn(s, ks, keep, pal) {
        const a = area(s);
        const k = ks[0];
        const colors = (pal && pal.length ? pal : ["#eee8da", "#e23e1b", "#170b10", "#aaa79f", "#192873"]).slice(0, 5);
        const cw = (a.w - s.gap * (colors.length - 1)) / colors.length;
        const out = colors.map((c, i) => ({ id: uid(), type: "sw", color: c, x: a.x + i * (cw + s.gap), y: a.y, w: cw, h: a.h * 0.6, caption: c.toUpperCase() }));
        if (k) {
          const w = 200;
          out.push(img(k, a.x + a.w - w, a.y + a.h - w / R(k), w, w / R(k)));
        }
        return out;
      },
    },
    {
      id: "title",
      fn(s, ks) {
        const a = area(s);
        const d = B.deck || {};
        const out = [txt(d.client || d.name || t("bDefaultName"), a.x, a.y + a.h - s.ssize * 2.3, span(s, 0, units(s, 6)).w, s.ssize * 1.8, { weight: 600 })];
        const k = ks[0];
        if (k) {
          const sp = span(s, units(s, 7), s.cols - units(s, 7));
          let hh = a.h;
          let w = hh * R(k);
          if (w > sp.w) {
            w = sp.w;
            hh = w / R(k);
          }
          out.push(img(k, sp.x + sp.w - w, a.y, w, hh));
        }
        return out;
      },
    },
    {
      id: "strip",
      fn(s, ks) {
        if (!ks.length) return [];
        const a = area(s);
        const list = ks.slice(0, 6);
        const sum = list.reduce((v, k) => v + R(k), 0);
        let hh = (a.w - s.gap * (list.length - 1)) / sum;
        hh = Math.min(hh, a.h * 0.62);
        let x = a.x + (a.w - (sum * hh + s.gap * (list.length - 1))) / 2;
        const y = a.y + (a.h - hh) / 2 - 30;
        return list.map((k) => {
          const o = img(k, x, y, hh * R(k), hh, { caption: cap(k) });
          x += hh * R(k) + s.gap;
          return o;
        });
      },
    },
    {
      id: "contact",
      fn(s, ks) {
        const a = area(s);
        const n = Math.max(4, (s.cols / 2) | 0);
        const cw = (a.w - s.gap * (n - 1)) / n;
        const out = [];
        ks.forEach((k, i) => {
          const r = (i / n) | 0;
          const c = i % n;
          const y = a.y + r * (cw + s.gap);
          if (y + cw <= a.y + a.h + 1) out.push(img(k, a.x + c * (cw + s.gap), y, cw, cw, { fit: "cover" }));
        });
        return out;
      },
    },
    {
      id: "diptych",
      fn(s, ks) {
        const [k1, k2] = ks;
        const out = [];
        if (k1) out.push(img(k1, 0, 0, k2 ? W / 2 : W, H, { fit: "cover" }));
        if (k2) out.push(img(k2, W / 2, 0, W / 2, H, { fit: "cover" }));
        return out;
      },
    },
    {
      id: "quote",
      fn(s, ks, keep) {
        const a = area(s);
        const left = span(s, 0, units(s, 7));
        const right = span(s, units(s, 9), s.cols - units(s, 9));
        const out = [
          txt(keep || t("bQuoteText"), left.x, a.y + 40, left.w, s.ssize * 1.1, { weight: 400 }),
          txt("‹" + t("bQuoteNote") + "›", left.x, a.y + 40 + s.ssize * 2.6, left.w, 18, { weight: 400 }),
        ];
        const k = ks[0];
        if (k) out.push(img(k, right.x, a.y, right.w, right.w / R(k)));
        return out;
      },
    },
    {
      id: "list",
      fn(s, ks) {
        const a = area(s);
        const list = ks.slice(0, 6);
        const rowH = Math.min(140, (a.h - s.gap * (list.length - 1)) / Math.max(1, list.length));
        const out = [];
        list.forEach((k, i) => {
          const y = a.y + i * (rowH + s.gap);
          const [name, src] = cap(k).split("|");
          out.push(txt(pad2(i + 1), a.x, y, 60, 18, { weight: 400, mono: true }));
          out.push(txt(name || "", span(s, units(s, 1), 1).x, y, 500, 22, { weight: 500 }));
          if (src) out.push(txt("‹" + src + "›", span(s, units(s, 5), 1).x, y + 2, 420, 16, { weight: 400 }));
          const w = rowH * R(k);
          out.push(img(k, a.x + a.w - w, y, w, rowH));
        });
        return out;
      },
    },
  ];
  const tplOf = (id) => TEMPLATES.find((q) => q.id === id);

  // ---- Palette aus einem Bild (boards.rs, k-means), je Hash einmal ----

  const palCache = new Map();
  async function paletteOf(k) {
    if (palCache.has(k)) return palCache.get(k);
    const it = byHash.get(k);
    if (!it) return [];
    let pal = [];
    try {
      pal = await A.invoke("board_palette", { path: it.thumb || it.abs });
    } catch {}
    palCache.set(k, pal);
    return pal;
  }
  const paletteNow = (k) => palCache.get(k) || [];

  // ---- Board: Datei, Verlauf, Sichern ----

  function newSlide(tpl, ks, title, styleOver) {
    const s = { ...DEFAULT_STYLE, ...(styleOver || {}) };
    if (tpl === "diptych") s.header = false;
    const sl = { id: uid(), tpl, title: title || "", text: "", tags: "", year: String(new Date().getFullYear()), style: s, keys: ks.slice(), objs: [] };
    sl.objs = tplOf(tpl).fn(s, ks, null, ks[0] ? paletteNow(ks[0]) : null);
    return sl;
  }

  function emptyDeck(name) {
    const deck = { format: "archiver-board", version: VERSION, name, client: "", slides: [] };
    const keep = B.deck;
    B.deck = deck; // die Titelvorlage liest den Namen
    deck.slides.push(newSlide("title", [], t("bSlideTitle")));
    B.deck = keep;
    return deck;
  }

  // Ältere oder von Hand geänderte Dateien: fehlende Werte ergänzen
  function normalize(deck, name) {
    const d = deck && typeof deck === "object" ? deck : {};
    d.format = "archiver-board";
    d.version = VERSION;
    d.name = name;
    d.client = d.client || "";
    if (!Array.isArray(d.slides) || !d.slides.length) d.slides = emptyDeck(name).slides;
    for (const sl of d.slides) {
      sl.id = sl.id || uid();
      sl.style = { ...DEFAULT_STYLE, ...(sl.style || {}) };
      if (!FONTS[sl.style.font]) sl.style.font = "geist";
      sl.objs = Array.isArray(sl.objs) ? sl.objs.filter((o) => o && o.type) : [];
      if (!Array.isArray(sl.keys)) sl.keys = imgKeys(sl);
      for (const o of sl.objs) o.id = o.id || uid();
    }
    return d;
  }

  const hist = [];
  const fut = [];
  function snap() {
    hist.push(JSON.stringify(B.deck));
    if (hist.length > 80) hist.shift();
    fut.length = 0;
  }
  function undo() {
    if (!hist.length) return;
    fut.push(JSON.stringify(B.deck));
    B.deck = JSON.parse(hist.pop());
    B.sel.clear();
    B.cur = Math.min(B.cur, B.deck.slides.length - 1);
    changed();
  }
  function redo() {
    if (!fut.length) return;
    hist.push(JSON.stringify(B.deck));
    B.deck = JSON.parse(fut.pop());
    B.sel.clear();
    changed();
  }

  let saveT = 0;
  function save(now) {
    B.dirty = true;
    clearTimeout(saveT);
    const go = () => {
      if (!B.dirty || !B.name || !B.deck) return Promise.resolve();
      B.dirty = false;
      return A.invoke("board_write", { name: B.name, data: JSON.stringify(B.deck, null, 1) }).catch((e) => {
        B.dirty = true;
        A.fail(e);
      });
    };
    if (now) return go();
    saveT = setTimeout(go, 600);
    return Promise.resolve();
  }

  const slide = () => B.deck.slides[B.cur];
  const imgKeys = (sl) => sl.objs.filter((o) => o.type === "img").map((o) => o.k);
  // Bilder einer Folie, auch die, die eine Vorlage gerade nicht zeigt (Paar, Einzel):
  // so kommen sie beim Wechsel der Vorlage zurück
  function slideKeys(sl) {
    const ks = (sl.keys || []).slice();
    for (const k of imgKeys(sl)) if (!ks.includes(k)) ks.push(k);
    return ks;
  }

  // ---- Folie zeichnen ----

  function lum(hex) {
    const v = parseInt(String(hex).slice(1), 16) || 0;
    return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  }

  // ‹…› setzt die zweite Farbe, etwa für die graue Fortsetzung einer Aussage
  function richText(e, text) {
    e.textContent = "";
    String(text || "")
      .split(/(‹[^›]*›)/)
      .forEach((part) => {
        if (!part) return;
        if (part.startsWith("‹")) e.appendChild(el("span", "b-dim", part.slice(1, -1)));
        else e.appendChild(document.createTextNode(part));
      });
  }

  function slideEl(sl, idx, mode) {
    // mode: "edit" | "show" (Präsentieren, Originale) | "mini" (Vorschaubilder)
    const s = sl.style;
    const root = el("div", "b-slide" + (mode === "edit" ? " b-edit" : ""));
    root.style.setProperty("--s-bg", s.bg);
    root.style.setProperty("--s-fg", s.fg);
    root.style.setProperty("--s-dim", s.dim);
    root.style.setProperty("--s-font", (FONTS[s.font] || FONTS.geist)[1]);
    root.style.setProperty("--s-hsize", s.hsize + "px");
    root.style.setProperty("--s-csize", s.csize + "px");
    root.style.setProperty("--s-track", s.track + "em");
    root.style.setProperty("--s-ring", lum(s.bg) > 0.5 ? "#111111" : "#ffffff");
    if (s.grid && mode === "edit") {
      const g = el("div", "b-grid");
      const a = area(s);
      for (let c = 0; c < s.cols; c++) {
        const sp = span(s, c, 1);
        const i = el("i");
        i.style.left = sp.x + "px";
        i.style.width = sp.w + "px";
        g.appendChild(i);
      }
      for (const y of [a.y, a.y + a.h]) {
        const u = el("u");
        u.style.top = y + "px";
        g.appendChild(u);
      }
      root.appendChild(g);
    }
    if (s.header) root.appendChild(header(sl, idx));
    sl.objs.forEach((o) => root.appendChild(objEl(o, s, mode)));
    return root;
  }

  function header(sl, idx) {
    const s = sl.style;
    const n = B.deck.slides.length;
    const wrap = el("div");
    const pos = (p) => p * (W - 2 * s.margin);
    const r1 = el("div", "b-hd");
    Object.assign(r1.style, { left: s.margin + "px", right: s.margin + "px", top: s.margin + "px" });
    for (const [text, p] of [[B.deck.client || "", 0], [B.deck.name || "", 1 / 3], [sl.title || "", 2 / 3]]) {
      const e = el("span", null, text);
      e.style.left = pos(p) + "px";
      r1.appendChild(e);
    }
    const pg = el("span", null, pad2(idx + 1) + " / " + pad2(n));
    pg.style.right = "0";
    r1.appendChild(pg);
    const r2 = el("div", "b-hd");
    Object.assign(r2.style, { left: s.margin + "px", right: s.margin + "px", top: s.margin + 34 + "px" });
    const cells = [
      ["[" + pad2(idx + 1) + "]", { left: "0" }],
      [sl.title || "", { left: "5%" }],
      [sl.text || "", { left: pos(1 / 3) + "px", width: "27%" }, "b-wrap"],
      [sl.tags || "", { right: "7%" }],
      [sl.year || "", { right: "0" }],
    ];
    for (const [text, st, cls] of cells) {
      const e = el("span", cls || null, text);
      Object.assign(e.style, st);
      r2.appendChild(e);
    }
    wrap.append(r1, r2);
    return wrap;
  }

  function objEl(o, s, mode) {
    const edit = mode === "edit";
    const e = el("div", "b-o b-" + o.type + (edit && B.sel.has(o.id) ? " sel" : ""));
    e.dataset.id = o.id;
    Object.assign(e.style, { left: o.x + "px", top: o.y + "px", width: o.w + "px" });
    if (o.type === "img") {
      e.style.height = o.h + "px";
      const it = itemOf(o);
      if (it) {
        const im = el("img");
        im.src = mode === "mini" ? smallSrc(it) : fullSrc(it);
        im.alt = it.filename || "";
        im.draggable = false;
        im.decoding = "async";
        im.style.objectFit = o.fit || (s.fit === "cover" ? "cover" : "contain");
        im.style.objectPosition = s.align === "bottom" ? "50% 100%" : s.align === "middle" ? "50% 50%" : "0 0";
        e.appendChild(im);
      } else {
        e.classList.add("b-missing");
        e.appendChild(el("span", null, t("bMissing")));
      }
    } else if (o.type === "sw") {
      e.style.height = o.h + "px";
      e.style.background = o.color;
    } else {
      e.style.fontSize = o.size + "px";
      e.style.fontWeight = o.weight || s.weight;
      e.style.letterSpacing = (o.mono ? 0 : o.size > 30 ? s.track - 0.02 : s.track) + "em";
      if (o.mono) e.style.fontFamily = FONTS.mono[1];
      e.style.color = o.color || "";
      richText(e, o.text);
    }
    if ((o.type === "img" || o.type === "sw") && o.caption && (s.captions || o.type === "sw")) {
      const c = el("div", "b-cap");
      const [a, b] = String(o.caption).split("|");
      c.appendChild(el("b", null, a));
      if (b) c.appendChild(el("span", null, b));
      e.appendChild(c);
    }
    if (edit) e.appendChild(el("div", "b-grip"));
    return e;
  }

  // Folie in einen Kasten einpassen (Leiste, Vorlagen, Karten)
  function fitMini(box, sl, idx, mode) {
    const s = slideEl(sl, idx, mode || "mini");
    box.appendChild(s);
    requestAnimationFrame(() => {
      s.style.transform = `scale(${box.clientWidth / W})`;
    });
    return s;
  }

  // ---- Übersicht ----

  function renderList() {
    const wrap = el("div", "p-page b-page");
    const h = el("h1", "p-head b-title");
    h.appendChild(el("span", "p-head-title", "Boards"));
    h.appendChild(document.createTextNode(" "));
    h.appendChild(el("span", "p-head-text", t(B.list && B.list.length ? "bListText" : "bListEmpty")));
    wrap.appendChild(h);
    const grid = el("div", "b-cards");
    items();
    for (const info of B.list || []) grid.appendChild(boardCard(info));
    const add = el("button", "p-card b-card b-new");
    add.type = "button";
    add.appendChild(el("span", "b-new-plus", "+"));
    add.appendChild(el("span", "b-new-text", t("bNew")));
    add.addEventListener("click", () => askNew());
    grid.appendChild(add);
    wrap.appendChild(grid);
    return wrap;
  }

  function boardCard(info) {
    const card = el("article", "p-card b-card");
    card.tabIndex = 0;
    const cover = el("div", "b-cover");
    const first = info.head && info.head.first;
    if (first && first.style) {
      const sl = normalize({ slides: [first] }, info.name).slides[0];
      const keep = B.deck;
      B.deck = { name: info.head.name || info.name, client: "", slides: Array(info.head.count || 1).fill(sl) };
      fitMini(cover, sl, 0);
      B.deck = keep;
    }
    card.appendChild(cover);
    const body = el("div", "b-card-body");
    const top = el("div", "b-card-top");
    top.appendChild(el("span", "zone-card-name", info.name));
    top.appendChild(el("span", "p-mono dim", pad2(info.head ? info.head.count : 0)));
    body.appendChild(top);
    body.appendChild(el("span", "b-card-meta", A.recentDate(info.modified)));
    card.appendChild(body);
    card.addEventListener("click", () => openBoard(info.name));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openBoard(info.name);
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cardMenu(info, e.clientX, e.clientY);
    });
    return card;
  }

  function menuAt(menu, x, y) {
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }

  function menuEntry(menu, text, fn, cls = "") {
    menu.appendChild(
      A.button("zone-menu-item" + cls, text, () => {
        A.closeMenus();
        fn();
      })
    );
  }

  function cardMenu(info, x, y) {
    A.closeMenus();
    A.closeMoreMenu();
    const menu = el("div", "zone-menu p-ctx-menu");
    menuEntry(menu, t("bOpen"), () => openBoard(info.name));
    menuEntry(menu, t("bRename"), () => askRename(info.name));
    menuEntry(menu, t("reveal"), () => A.invoke("reveal", { path: info.path }).catch(A.fail));
    menu.appendChild(el("div", "p-more-rule"));
    menuEntry(menu, t("bDelete"), () => askDelete(info.name), " danger");
    menuAt(menu, x, y);
  }

  function nameDialog(title, text, value, action, go) {
    const dialog = el("div", "dialog confirm b-dialog");
    dialog.appendChild(el("h3", null, title));
    if (text) dialog.appendChild(el("p", null, text));
    const input = el("input", "p-input note-field b-input");
    input.value = value || "";
    input.placeholder = t("bName");
    input.spellcheck = false;
    dialog.appendChild(input);
    const run = () => {
      if (!input.value.trim()) return input.focus();
      go(input.value.trim());
    };
    const foot = el("div", "confirm-foot");
    foot.appendChild(A.button("btn", t("cancel"), A.closeModal));
    foot.appendChild(A.button("btn primary", action, run));
    dialog.appendChild(foot);
    A.openModal(dialog, run);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  }

  // Neues Board, auf Wunsch gleich mit Bildern (Auswahl in einer Zone)
  function askNew(withItems) {
    nameDialog(t("bNew"), t("bNewText"), t("bDefaultName"), t("bCreate"), async (want) => {
      try {
        const deck = emptyDeck(want);
        const name = await A.invoke("board_create", { name: want, data: JSON.stringify(deck) });
        A.closeModal();
        if (withItems && withItems.length) await addItemsTo(name, withItems, true);
        else {
          await refreshList();
          openBoard(name);
        }
      } catch (e) {
        A.fail(e);
      }
    });
  }

  function askRename(name) {
    nameDialog(t("bRename"), null, name, t("bRenameDo"), async (to) => {
      try {
        if (B.name === name) await save(true);
        const next = await A.invoke("board_rename", { from: name, to });
        A.closeModal();
        if (B.name === name) {
          B.name = next;
          B.deck.name = next;
          save();
        }
        await refreshList();
        render();
      } catch (e) {
        A.fail(e);
      }
    });
  }

  function askDelete(name) {
    const dialog = el("div", "dialog confirm b-dialog");
    dialog.appendChild(el("h3", null, t("bDeleteAsk", { name })));
    dialog.appendChild(el("p", null, t("bDeleteText")));
    const go = async () => {
      try {
        await A.invoke("board_delete", { name });
        A.closeModal();
        if (B.name === name) closeBoard(false);
        await refreshList();
        render();
      } catch (e) {
        A.fail(e);
      }
    };
    const foot = el("div", "confirm-foot");
    foot.appendChild(A.button("btn", t("cancel"), A.closeModal));
    foot.appendChild(A.button("btn danger-fill", t("bDelete"), go));
    dialog.appendChild(foot);
    A.openModal(dialog, go);
  }

  async function refreshList() {
    try {
      B.list = await A.invoke("boards_list");
    } catch (e) {
      B.list = [];
      A.fail(e);
    }
  }

  // ---- Öffnen, Schließen ----

  async function openBoard(name) {
    try {
      const raw = await A.invoke("board_read", { name });
      let deck = null;
      try {
        deck = JSON.parse(raw);
      } catch {
        throw new Error(t("bBroken", { name }));
      }
      items();
      B.name = name;
      B.deck = normalize(deck, name);
      B.cur = 0;
      B.sel.clear();
      hist.length = 0;
      fut.length = 0;
      for (const sl of B.deck.slides) for (const k of imgKeys(sl)) paletteOf(k);
      render();
      A.renderToolbar();
    } catch (e) {
      A.fail(e);
    }
  }

  function closeBoard(rerender = true) {
    if (!B.name) return;
    save(true);
    B.name = null;
    B.deck = null;
    B.sel.clear();
    B.open = { rail: false, lib: false, insp: false };
    document.body.classList.remove("b-editing");
    if (rerender) {
      refreshList().then(() => {
        if (active()) {
          render();
          A.renderToolbar();
        }
      });
    }
  }

  // ---- Zeichnen ----

  const active = () => document.body.classList.contains("boards");

  function render() {
    if (!active()) return;
    const z = host();
    if (!B.name) {
      document.body.classList.remove("b-editing");
      z.replaceChildren(renderList());
      return;
    }
    document.body.classList.add("b-editing");
    if (!z.querySelector(".b-editor")) buildEditor(z);
    renderAll();
  }

  let ed = null; // Knoten des Editors
  function buildEditor(z) {
    const root = el("div", "b-editor");
    const stage = el("div", "b-stage");
    const box = el("div", "b-stagebox");
    stage.appendChild(box);
    const bar = el("div", "b-bar");
    stage.appendChild(bar);
    const rail = el("nav", "b-panel b-rail");
    const insp = el("aside", "b-panel b-insp");
    const lib = el("section", "b-panel b-lib");
    rail.hidden = insp.hidden = lib.hidden = true;
    root.append(stage, rail, insp, lib);
    z.replaceChildren(root);
    ed = { root, stage, box, bar, rail, insp, lib };
    stage.addEventListener("pointerdown", (e) => {
      if (e.target === stage && B.sel.size) {
        B.sel.clear();
        renderAll();
      }
    });
  }

  let railT = 0;
  function renderAll(light) {
    if (!B.deck || !ed || !ed.root.isConnected) return;
    renderStage();
    if (!light && B.open.insp) renderInsp();
    if (B.open.rail) {
      clearTimeout(railT);
      railT = setTimeout(renderRail, light ? 120 : 0);
    }
  }

  function changed(light) {
    renderAll(light);
    save();
  }

  let scale = 1;
  function renderStage() {
    // Offene Flächen schieben die Folie zur Seite, sie bleibt ganz sichtbar
    const pad = 40;
    const left = B.open.rail ? ed.rail.offsetWidth + 24 : pad;
    const right = B.open.insp ? ed.insp.offsetWidth + 24 : pad;
    const bottom = B.open.lib ? ed.lib.offsetHeight + 84 : pad + 40;
    ed.stage.style.padding = `${pad}px ${right}px ${bottom}px ${left}px`;
    const aw = ed.stage.clientWidth - left - right;
    const ah = ed.stage.clientHeight - pad - bottom;
    scale = Math.max(0.1, Math.min(aw / W, ah / H));
    ed.box.style.width = W * scale + "px";
    ed.box.style.height = H * scale + "px";
    const live = slideEl(slide(), B.cur, "edit");
    live.style.transform = `scale(${scale})`;
    live.classList.add("b-live");
    ed.box.replaceChildren(live);
    bindStage(live);
    renderBar();
  }

  function toggle(key, force) {
    B.open[key] = force != null ? force : !B.open[key];
    ed[key].hidden = !B.open[key];
    if (key === "rail" && B.open.rail) renderRail();
    if (key === "insp" && B.open.insp) renderInsp();
    if (key === "lib" && B.open.lib) renderLib();
    renderStage();
  }

  function renderBar() {
    const bar = ed.bar;
    bar.replaceChildren();
    const b = (text, fn, on, title, cls) => bar.appendChild(btn("b-bar-btn" + (on ? " on" : "") + (cls ? " " + cls : ""), text, fn, title));
    const sep = () => bar.appendChild(el("span", "b-bar-sep"));
    b("‹", () => go(-1), false, t("bPrev") + " (←)");
    bar.appendChild(el("span", "b-bar-count", pad2(B.cur + 1) + " / " + pad2(B.deck.slides.length)));
    b("›", () => go(1), false, t("bNext") + " (→)");
    sep();
    b(t("bSlides"), () => toggle("rail"), B.open.rail, t("bSlides") + " (F)");
    b(t("bImages"), () => toggle("lib"), B.open.lib, t("bImages") + " (B)");
    b(t("bDesign"), () => toggle("insp"), B.open.insp, t("bDesign") + " (E)");
    b("+ " + t("bText"), addText, false, t("bText") + " (T)");
    if (B.sel.size) {
      sep();
      b(t("bRemove"), removeSel, false, t("bRemove") + " (⌫)");
    }
    sep();
    b("▶ " + t("bPresent"), () => present(B.cur), false, t("bPresent") + " (P)");
  }

  function go(d) {
    B.cur = clamp(B.cur + d, 0, B.deck.slides.length - 1);
    B.sel.clear();
    renderAll();
  }

  function liveEl() {
    return ed && ed.box.querySelector(".b-live");
  }

  function toSlide(ev) {
    const r = liveEl().getBoundingClientRect();
    return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
  }

  // ---- Smart Guides: Kanten, Mitten, Spalten, Rand ----

  function hOf(o) {
    if (o.type !== "text") return o.h;
    const e = liveEl() && liveEl().querySelector(`[data-id="${o.id}"]`);
    return e ? e.offsetHeight : o.h;
  }
  function snapLines(s, moving) {
    const xs = [0, W, s.margin, W - s.margin, W / 2];
    const ys = [0, H, area(s).y, H - s.margin, H / 2];
    for (let c = 0; c < s.cols; c++) {
      const sp = span(s, c, 1);
      xs.push(sp.x, sp.x + sp.w);
    }
    for (const o of slide().objs)
      if (!moving.has(o.id)) {
        xs.push(o.x, o.x + o.w, o.x + o.w / 2);
        ys.push(o.y, o.y + hOf(o), o.y + hOf(o) / 2);
      }
    return { xs, ys };
  }
  function nearest(vals, cands, th) {
    let best = null;
    for (const v of vals)
      for (const c of cands) {
        const d = c - v;
        if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: c };
      }
    return best;
  }
  function showGuides(gx, gy) {
    const live = liveEl();
    live.querySelectorAll(".b-guide").forEach((g) => g.remove());
    if (gx) {
      const g = el("div", "b-guide v");
      g.style.left = gx.line - 1 / scale + "px";
      g.style.width = 2 / scale + "px";
      live.appendChild(g);
    }
    if (gy) {
      const g = el("div", "b-guide h");
      g.style.top = gy.line - 1 / scale + "px";
      g.style.height = 2 / scale + "px";
      live.appendChild(g);
    }
  }

  function bindStage(live) {
    live.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const oe = ev.target.closest(".b-o");
      if (!oe) {
        if (B.sel.size) {
          B.sel.clear();
          renderAll();
        }
        return;
      }
      if (oe.classList.contains("editing")) return;
      const id = oe.dataset.id;
      const o = slide().objs.find((q) => q.id === id);
      const s = slide().style;
      if (ev.shiftKey || ev.metaKey) {
        if (B.sel.has(id)) B.sel.delete(id);
        else B.sel.add(id);
        renderAll();
        return;
      }
      if (!B.sel.has(id)) {
        B.sel.clear();
        B.sel.add(id);
      }
      const resizing = ev.target.classList.contains("b-grip");
      const start = toSlide(ev);
      const objs = slide().objs.filter((q) => B.sel.has(q.id));
      const orig = objs.map((q) => ({ q, x: q.x, y: q.y, w: q.w, h: q.h, size: q.size }));
      let moved = false;
      snap();
      live.querySelectorAll(".b-o").forEach((n) => n.classList.toggle("sel", B.sel.has(n.dataset.id)));
      live.setPointerCapture(ev.pointerId);
      const move = (e2) => {
        const p = toSlide(e2);
        let dx = p.x - start.x;
        let dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) < 2) return;
        moved = true;
        const th = 8 / scale;
        const free = !s.snap || e2.altKey || e2.metaKey;
        if (resizing) {
          const O = orig.find((r) => r.q === o) || orig[0];
          let w = Math.max(30, O.w + dx);
          let gx = null;
          if (!free) {
            gx = nearest([O.x + w], snapLines(s, B.sel).xs, th);
            if (gx) w += gx.d;
          }
          o.w = w;
          if (o.type === "text") o.size = clamp(O.size * (w / O.w), 8, 400);
          else if (e2.shiftKey || o.type === "sw") o.h = Math.max(20, O.h + dy);
          else o.h = w * (O.h / O.w);
          showGuides(gx, null);
        } else {
          let gx = null;
          let gy = null;
          if (!free) {
            const L = snapLines(s, B.sel);
            const O = orig[0];
            gx = nearest([O.x + dx, O.x + dx + O.w, O.x + dx + O.w / 2], L.xs, th);
            if (gx) dx += gx.d;
            const oh = hOf(O.q);
            gy = nearest([O.y + dy, O.y + dy + oh, O.y + dy + oh / 2], L.ys, th);
            if (gy) dy += gy.d;
          }
          orig.forEach((r) => {
            r.q.x = r.x + dx;
            r.q.y = r.y + dy;
          });
          showGuides(gx, gy);
        }
        for (const r of orig) {
          const n = live.querySelector(`[data-id="${r.q.id}"]`);
          if (!n) continue;
          n.style.left = r.q.x + "px";
          n.style.top = r.q.y + "px";
          n.style.width = r.q.w + "px";
          if (r.q.type !== "text") n.style.height = r.q.h + "px";
          else n.style.fontSize = r.q.size + "px";
        }
      };
      const up = () => {
        live.removeEventListener("pointermove", move);
        live.removeEventListener("pointerup", up);
        live.removeEventListener("pointercancel", up);
        if (!moved) {
          hist.pop();
          renderAll();
        } else {
          slide().tpl = "free";
          changed();
        }
      };
      live.addEventListener("pointermove", move);
      live.addEventListener("pointerup", up);
      live.addEventListener("pointercancel", up);
    });
    live.addEventListener("dblclick", (ev) => {
      const oe = ev.target.closest(".b-o.b-text");
      if (!oe) return;
      const o = slide().objs.find((q) => q.id === oe.dataset.id);
      oe.textContent = o.text;
      oe.contentEditable = "true";
      oe.classList.add("editing");
      oe.focus();
      document.getSelection().selectAllChildren(oe);
      oe.addEventListener(
        "blur",
        () => {
          snap();
          o.text = oe.innerText.replace(/\n$/, "");
          changed();
        },
        { once: true }
      );
    });
  }

  // ---- Handlungen ----

  function addImage(k, at) {
    snap();
    const sl = slide();
    const s = sl.style;
    const w = colw(s) * units(s, 3) + s.gap * (units(s, 3) - 1);
    const n = sl.objs.length % 10;
    const p = at || { x: area(s).x + 20 * n, y: area(s).y + 20 * n };
    const o = img(k, p.x - (at ? w / 2 : 0), p.y - (at ? w / R(k) / 2 : 0), w, w / R(k), { caption: cap(k) });
    sl.objs.push(o);
    sl.keys = slideKeys(sl);
    B.sel = new Set([o.id]);
    paletteOf(k);
    changed();
  }

  function addText() {
    snap();
    const s = slide().style;
    const a = area(s);
    const o = txt(t("bNewText2"), a.x, a.y + a.h / 2, a.w * 0.6, 40, { weight: s.weight });
    slide().objs.push(o);
    B.sel = new Set([o.id]);
    changed();
  }

  async function addSwatch() {
    const sl = slide();
    const from = sl.objs.find((o) => B.sel.has(o.id) && o.type === "img") || sl.objs.find((o) => o.type === "img");
    const pal = from ? await paletteOf(from.k) : [];
    const color = pal[1] || pal[0] || "#e23e1b";
    snap();
    const a = area(sl.style);
    const o = { id: uid(), type: "sw", color, x: a.x, y: a.y + a.h - 160, w: 120, h: 120, caption: color.toUpperCase() };
    sl.objs.push(o);
    B.sel = new Set([o.id]);
    changed();
  }

  function removeSel() {
    if (!B.sel.size) return;
    snap();
    const sl = slide();
    const gone = sl.objs.filter((o) => B.sel.has(o.id) && o.type === "img").map((o) => o.k);
    sl.objs = sl.objs.filter((o) => !B.sel.has(o.id));
    // Vom Board genommen heißt auch: nicht mehr Teil der Folie (außer es liegt noch einmal darauf)
    const left = new Set(imgKeys(sl));
    sl.keys = slideKeys(sl).filter((k) => left.has(k) || !gone.includes(k));
    B.sel.clear();
    changed();
  }

  function duplicateSel() {
    if (!B.sel.size) return;
    snap();
    const add = slide()
      .objs.filter((o) => B.sel.has(o.id))
      .map((o) => ({ ...o, id: uid(), x: o.x + 24, y: o.y + 24 }));
    slide().objs.push(...add);
    B.sel = new Set(add.map((o) => o.id));
    changed();
  }

  function layer(dir) {
    if (!B.sel.size) return;
    snap();
    const all = slide().objs;
    const picked = all.filter((o) => B.sel.has(o.id));
    const rest = all.filter((o) => !B.sel.has(o.id));
    slide().objs = dir > 0 ? [...rest, ...picked] : [...picked, ...rest];
    changed();
  }

  function applyTemplate(id, quiet) {
    if (!quiet) snap();
    const sl = slide();
    const ks = slideKeys(sl);
    sl.keys = ks;
    const keepText = (sl.objs.find((o) => o.type === "text" && o.size >= 24) || {}).text;
    if (id === "diptych") sl.style.header = false;
    else if (sl.tpl === "diptych") sl.style.header = true;
    sl.objs = tplOf(id).fn(sl.style, ks, id === "statement" || id === "quote" ? keepText : null, ks[0] ? paletteNow(ks[0]) : null);
    sl.tpl = id;
    B.sel.clear();
    if (!quiet) changed();
  }

  function relayout() {
    const sl = slide();
    if (sl.tpl && sl.tpl !== "free" && tplOf(sl.tpl)) applyTemplate(sl.tpl, true);
  }

  function addSlide(tpl) {
    snap();
    const base = slide() ? { ...slide().style } : {};
    const sl = newSlide(tpl || "index", [], t("bNewSlide"), base);
    B.deck.slides.splice(B.cur + 1, 0, sl);
    B.cur++;
    B.sel.clear();
    changed();
  }

  function moveSlide(d) {
    const j = B.cur + d;
    if (j < 0 || j >= B.deck.slides.length) return;
    snap();
    const a = B.deck.slides;
    [a[B.cur], a[j]] = [a[j], a[B.cur]];
    B.cur = j;
    changed();
  }

  function duplicateSlide() {
    snap();
    const c = JSON.parse(JSON.stringify(slide()));
    c.id = uid();
    c.objs.forEach((o) => (o.id = uid()));
    B.deck.slides.splice(B.cur + 1, 0, c);
    B.cur++;
    changed();
  }

  function deleteSlide() {
    if (B.deck.slides.length < 2) return;
    snap();
    B.deck.slides.splice(B.cur, 1);
    B.cur = Math.max(0, B.cur - 1);
    B.sel.clear();
    changed();
  }

  function styleAll() {
    snap();
    const s = slide().style;
    B.deck.slides.forEach((sl) => {
      const head = sl.style.header;
      sl.style = { ...s, header: sl.tpl === "diptych" ? false : head };
    });
    A.toast(t("bStyleAllDone"));
    changed();
  }

  // ---- Folienleiste ----

  function renderRail() {
    if (!B.open.rail) return;
    const rail = ed.rail;
    const top = rail.scrollTop;
    rail.replaceChildren();
    B.deck.slides.forEach((sl, i) => {
      const b = el("button", "b-thumb" + (i === B.cur ? " on" : ""));
      b.type = "button";
      const mini = el("div", "b-mini");
      b.appendChild(mini);
      const tl = el("div", "b-thumb-label");
      tl.append(el("span", "p-mono", pad2(i + 1)), el("span", "p-mono faint", sl.title || ""));
      b.appendChild(tl);
      b.addEventListener("click", () => {
        B.cur = i;
        B.sel.clear();
        renderAll();
      });
      rail.appendChild(b);
      fitMini(mini, sl, i);
    });
    rail.appendChild(btn("b-add", "+ " + t("bSlide"), () => addSlide()));
    rail.scrollTop = top;
  }

  // ---- Inspektor ----

  function renderInsp() {
    if (!B.open.insp) return;
    const insp = ed.insp;
    const top = insp.scrollTop;
    insp.replaceChildren();
    const tabs = el("div", "b-tabs");
    for (const [id, key] of [["template", "bTabTemplate"], ["grid", "bTabGrid"], ["type", "bTabType"], ["color", "bTabColor"], ["slide", "bTabSlide"]])
      tabs.appendChild(
        btn("b-tab" + (B.tab === id ? " on" : ""), t(key), () => {
          B.tab = id;
          renderInsp();
        })
      );
    insp.appendChild(tabs);
    if (B.sel.size) insp.appendChild(objSection());
    ({ template: tplSection, grid: gridSection, type: typeSection, color: colorSection, slide: slideSection })[B.tab](insp);
    insp.scrollTop = top;
  }

  function sec(title, right) {
    const s = el("section", "b-sec");
    const h = el("h3", "b-sec-head");
    h.appendChild(el("span", "p-mono", title));
    if (right) h.appendChild(right);
    s.appendChild(h);
    return s;
  }

  function range(label, val, min, max, step, fmt, onInput, relay = true) {
    const r = el("label", "b-row");
    r.appendChild(el("span", null, label));
    const i = el("input");
    i.type = "range";
    i.min = min;
    i.max = max;
    i.step = step;
    i.value = val;
    const out = el("output", "p-mono", fmt(val));
    let started = false;
    i.addEventListener("input", () => {
      if (!started) {
        snap();
        started = true;
      }
      const v = +i.value;
      out.textContent = fmt(v);
      onInput(v);
      if (relay) relayout();
      changed(true);
    });
    i.addEventListener("change", () => {
      started = false;
      renderAll();
    });
    r.append(i, out);
    return r;
  }

  function choices(options, val, on) {
    const c = el("div", "b-chips");
    for (const [v, label] of options)
      c.appendChild(
        A.chip("(" + label + ")", v === val, () => {
          snap();
          on(v);
          changed();
        })
      );
    return c;
  }

  function rowWith(label, node) {
    const r = el("div", "b-row two");
    r.append(el("span", null, label), node);
    return r;
  }

  function note(text) {
    return el("p", "b-note", text);
  }

  function tplSection(insp) {
    const sl = slide();
    const s = sec("(" + t("bTemplates") + ") (" + TEMPLATES.length + ")", el("span", "p-mono faint", sl.tpl === "free" ? t("bFree") : ""));
    s.appendChild(note(t("bTemplatesText")));
    const grid = el("div", "b-tpls");
    const ks = slideKeys(sl);
    TEMPLATES.forEach((tp) => {
      const b = el("button", "b-tpl" + (sl.tpl === tp.id ? " on" : ""));
      b.type = "button";
      b.title = t("bTpl_" + tp.id + "_note");
      const mini = el("div", "b-mini");
      b.appendChild(mini);
      b.appendChild(el("span", "p-mono", t("bTpl_" + tp.id)));
      const st = { ...sl.style, grid: false, header: tp.id === "diptych" ? false : sl.style.header };
      fitMini(mini, { ...sl, style: st, objs: tp.fn(st, ks, null, ks[0] ? paletteNow(ks[0]) : null) }, B.cur);
      b.addEventListener("click", () => applyTemplate(tp.id));
      grid.appendChild(b);
    });
    s.appendChild(grid);
    const add = el("div", "b-btns");
    add.appendChild(btn("btn", t("bNewSlideWith"), () => addSlide(sl.tpl === "free" ? "index" : sl.tpl)));
    s.appendChild(add);
    insp.appendChild(s);
  }

  function gridSection(insp) {
    const st = slide().style;
    const s = sec("(" + t("bTabGrid") + ")");
    s.appendChild(range(t("bCols"), st.cols, 4, 24, 1, (v) => v, (v) => (st.cols = v)));
    s.appendChild(range(t("bMargin"), st.margin, 0, 160, 2, (v) => v + "", (v) => (st.margin = v)));
    s.appendChild(range(t("bGap"), st.gap, 0, 80, 2, (v) => v + "", (v) => (st.gap = v)));
    s.appendChild(rowWith(t("bAlign"), choices([["top", t("bTop")], ["middle", t("bMiddle")], ["bottom", t("bBottom")]], st.align, (v) => {
      st.align = v;
      relayout();
    })));
    s.appendChild(rowWith(t("bFit"), choices([["contain", t("bUncut")], ["cover", t("bCut")]], st.fit, (v) => {
      st.fit = v;
      slide().objs.forEach((o) => {
        if (o.type === "img") delete o.fit;
      });
      relayout();
    })));
    s.appendChild(rowWith(t("bShowGrid"), choices([[true, t("bOn")], [false, t("bOff")]], st.grid, (v) => (st.grid = v))));
    s.appendChild(rowWith(t("bSnap"), choices([[true, t("bOn")], [false, t("bOff")]], st.snap, (v) => (st.snap = v))));
    s.appendChild(note(t("bGridText")));
    insp.appendChild(s);
    const s2 = sec("(" + t("bHead") + ")");
    s2.appendChild(rowWith(t("bHeadLine"), choices([[true, t("bShow")], [false, t("bOff")]], st.header, (v) => {
      st.header = v;
      relayout();
    })));
    s2.appendChild(rowWith(t("bCaptions"), choices([[true, t("bShow")], [false, t("bOff")]], st.captions, (v) => (st.captions = v))));
    insp.appendChild(s2);
    insp.appendChild(allSection());
  }

  function typeSection(insp) {
    const st = slide().style;
    const s = sec("(" + t("bTabType") + ")");
    const fonts = el("div", "b-fonts");
    for (const k in FONTS) {
      const b = btn("b-font" + (st.font === k ? " on" : ""), FONTS[k][0], () => {
        snap();
        st.font = k;
        changed();
      });
      b.style.fontFamily = FONTS[k][1];
      fonts.appendChild(b);
    }
    s.appendChild(fonts);
    s.appendChild(range(t("bHeadSize"), st.hsize, 8, 28, 1, (v) => v + " px", (v) => (st.hsize = v), false));
    s.appendChild(range(t("bCapSize"), st.csize, 9, 28, 1, (v) => v + " px", (v) => (st.csize = v), false));
    s.appendChild(range(t("bBigSize"), st.ssize, 24, 160, 2, (v) => v + " px", (v) => {
      st.ssize = v;
      slide().objs.filter((o) => o.type === "text" && o.size >= 24).forEach((o) => (o.size = v));
    }, false));
    s.appendChild(range(t("bWeight"), st.weight, 300, 700, 100, (v) => v, (v) => {
      st.weight = v;
      slide().objs.filter((o) => o.type === "text" && !o.mono).forEach((o) => (o.weight = v));
    }, false));
    s.appendChild(range(t("bTrack"), st.track * 1000, -60, 60, 5, (v) => (v / 1000).toFixed(3), (v) => (st.track = v / 1000), false));
    s.appendChild(note(t("bTypeText")));
    insp.appendChild(s);
    insp.appendChild(allSection());
  }

  function swatch(color, on, fn, title) {
    const b = btn("b-swatch" + (on ? " on" : ""), "", fn, title || color);
    b.style.background = color;
    return b;
  }

  function colorInput(value, onInput) {
    const wrap = el("label", "b-swatch b-swatch-own");
    wrap.style.background = value;
    const i = el("input");
    i.type = "color";
    i.value = value;
    i.addEventListener("focus", () => snap());
    i.addEventListener("input", () => {
      wrap.style.background = i.value;
      onInput(i.value);
      changed(true);
    });
    wrap.appendChild(i);
    return wrap;
  }

  function colorSection(insp) {
    const st = slide().style;
    const s = sec("(" + t("bTabColor") + ")");
    const pre = el("div", "b-swatches");
    BGS.forEach(([bg, fg, dim]) =>
      pre.appendChild(
        swatch(bg, st.bg === bg, () => {
          snap();
          Object.assign(st, { bg, fg, dim });
          changed();
        })
      )
    );
    s.appendChild(rowWith(t("bSurface"), pre));
    const own = (label, key) => {
      const w = el("div", "b-swatches");
      w.append(colorInput(st[key], (v) => (st[key] = v)), el("span", "p-mono", String(st[key]).toUpperCase()));
      return rowWith(label, w);
    };
    s.append(own(t("bBg"), "bg"), own(t("bFg"), "fg"), own(t("bDimColor"), "dim"));
    const add = el("div", "b-btns");
    add.appendChild(btn("btn", t("bAddSwatch"), addSwatch));
    s.appendChild(add);
    insp.appendChild(s);
    const ks = [...new Set(imgKeys(slide()))].slice(0, 4);
    if (ks.length) {
      const s2 = sec("(" + t("bFromImages") + ")");
      s2.appendChild(note(t("bFromImagesText")));
      for (const k of ks) {
        const row = el("div", "b-swatches");
        const fill = (pal) => {
          row.replaceChildren();
          pal.forEach((c) =>
            row.appendChild(
              swatch(c, false, (e) => {
                snap();
                if (e.shiftKey) {
                  const a = area(st);
                  slide().objs.push({ id: uid(), type: "sw", color: c, x: a.x, y: a.y + a.h - 140, w: 120, h: 120, caption: c.toUpperCase() });
                } else if (e.altKey) st.fg = c;
                else {
                  st.bg = c;
                  st.fg = lum(c) > 0.5 ? "#111111" : "#f4f4f4";
                  st.dim = lum(c) > 0.5 ? "#8a8a8a" : "#9a9a9a";
                }
                changed();
              })
            )
          );
        };
        fill(paletteNow(k));
        if (!palCache.has(k)) paletteOf(k).then(fill);
        const it = byHash.get(k);
        s2.appendChild(rowWith(it ? String(it.filename).replace(/\.[^.]+$/, "") : "–", row));
      }
      insp.appendChild(s2);
    }
    insp.appendChild(allSection());
  }

  function field(label, value, onInput, area_) {
    const i = el(area_ ? "textarea" : "input", "b-field");
    i.value = value || "";
    i.spellcheck = false;
    i.addEventListener("focus", () => snap());
    i.addEventListener("input", () => {
      onInput(i.value);
      changed(true);
    });
    return rowWith(label, i);
  }

  function slideSection(insp) {
    const sl = slide();
    const s = sec("(" + t("bSlide") + " " + pad2(B.cur + 1) + ")");
    s.append(
      field(t("bTitle"), sl.title, (v) => (sl.title = v)),
      field(t("bDescription"), sl.text, (v) => (sl.text = v), true),
      field(t("bTags"), sl.tags, (v) => (sl.tags = v)),
      field(t("bYear"), sl.year, (v) => (sl.year = v))
    );
    const btns = el("div", "b-btns");
    for (const [text, fn, off] of [
      ["↑ " + t("bForward"), () => moveSlide(-1), B.cur === 0],
      ["↓ " + t("bBackward"), () => moveSlide(1), B.cur === B.deck.slides.length - 1],
      [t("bDuplicate"), duplicateSlide],
      [t("bDeleteSlide"), deleteSlide, B.deck.slides.length < 2],
    ]) {
      const b = btn("btn", text, fn);
      b.disabled = !!off;
      btns.appendChild(b);
    }
    s.appendChild(btns);
    insp.appendChild(s);
    const s2 = sec("(Board)");
    s2.appendChild(field(t("bClient"), B.deck.client, (v) => (B.deck.client = v)));
    const nm = el("div", "b-btns");
    nm.appendChild(btn("btn", t("bRename"), () => askRename(B.name)));
    s2.appendChild(nm);
    insp.appendChild(s2);
  }

  function objSection() {
    const sl = slide();
    const objs = sl.objs.filter((o) => B.sel.has(o.id));
    const o = objs[0];
    const it = o && o.type === "img" ? itemOf(o) : null;
    const title = objs.length > 1 ? t("bObjects", { n: objs.length }) : o.type === "img" ? (it ? it.filename : t("bImage")) : o.type === "sw" ? t("bSwatch") : t("bText");
    const s = sec("(" + title + ")");
    if (objs.length === 1) {
      const nums = el("div", "b-nums");
      const num = (lab, key) => {
        const i = el("input", "b-field");
        i.type = "number";
        i.value = Math.round(o[key]);
        i.addEventListener("focus", () => snap());
        i.addEventListener("change", () => {
          o[key] = +i.value;
          if (key === "w" && o.type === "img") o.h = o.w / R(o.k);
          sl.tpl = "free";
          changed();
        });
        const w = el("label", "p-mono");
        w.append(lab + " ", i);
        return w;
      };
      nums.append(num("X", "x"), num("Y", "y"), num("B", "w"));
      if (o.type !== "text") nums.append(num("H", "h"));
      s.appendChild(nums);
      if (o.type === "img") {
        s.appendChild(rowWith(t("bImage"), choices([["contain", t("bUncut")], ["cover", t("bCut")]], o.fit || sl.style.fit, (v) => (o.fit = v))));
        const c = el("input", "b-field");
        c.placeholder = t("bCaptionHint");
        c.value = o.caption || "";
        c.spellcheck = false;
        c.addEventListener("focus", () => snap());
        c.addEventListener("input", () => {
          o.caption = c.value;
          changed(true);
        });
        s.appendChild(rowWith(t("bCaption"), c));
      }
      if (o.type === "sw")
        s.appendChild(
          rowWith(
            t("bColor"),
            colorInput(o.color, (v) => {
              o.color = v;
              o.caption = v.toUpperCase();
            })
          )
        );
      if (o.type === "text") {
        s.appendChild(range(t("bSize"), o.size, 8, 200, 1, (v) => v + " px", (v) => (o.size = v), false));
        s.appendChild(rowWith(t("bColor"), choices([["", t("bFg")], [sl.style.dim, t("bDimColor")]], o.color || "", (v) => (o.color = v || undefined))));
        s.appendChild(note(t("bTextEdit")));
      }
    }
    const btns = el("div", "b-btns");
    for (const [text, fn] of [
      [t("bToFront"), () => layer(1)],
      [t("bToBack"), () => layer(-1)],
      [t("bDuplicate") + " ⌘D", duplicateSel],
      [t("bRemove") + " ⌫", removeSel],
    ])
      btns.appendChild(btn("btn", text, fn));
    s.appendChild(btns);
    return s;
  }

  function allSection() {
    const s = sec("(Board)");
    const b = el("div", "b-btns");
    b.appendChild(btn("btn", t("bStyleAll"), styleAll));
    s.appendChild(b);
    s.appendChild(note(t("bStyleAllText")));
    return s;
  }

  // ---- Bilder aus der Bibliothek: Klick legt auf die Folie, Ziehen an die Stelle ----

  function renderLib() {
    if (!B.open.lib) return;
    const lib = ed.lib;
    const keepScroll = lib.querySelector(".b-strip") ? lib.querySelector(".b-strip").scrollLeft : 0;
    lib.replaceChildren();
    const head = el("div", "b-lib-head");
    const search = el("input", "b-field b-search");
    search.type = "search";
    search.placeholder = t("bSearch");
    search.value = B.query;
    search.spellcheck = false;
    search.addEventListener("input", () => {
      B.query = search.value;
      fillStrip();
    });
    head.appendChild(search);
    const zones = el("div", "b-chips b-zones");
    zones.appendChild(
      A.chip("(" + t("bAllZones") + ")", B.zone == null, () => {
        B.zone = null;
        renderLib();
      })
    );
    for (const z of A.zones())
      zones.appendChild(
        A.chip("(" + z.path + ")", B.zone === z.path, () => {
          B.zone = z.path;
          renderLib();
        })
      );
    head.appendChild(zones);
    lib.appendChild(head);
    const strip = el("div", "b-strip");
    lib.appendChild(strip);
    lib.appendChild(note(t("bLibText")));
    const fillStrip = () => {
      const words = B.query.toLowerCase().split(/\s+/).filter(Boolean);
      const list = items()
        .filter((it) => visual(it) && (B.zone == null || it.zone === B.zone || it.zone.startsWith(B.zone + "/")))
        .filter((it) => {
          if (!words.length) return true;
          const hay = [it.filename, it.zone, it.labels, it.pageTitle, it.text].join(" ").toLowerCase();
          return words.every((w) => hay.includes(w));
        })
        .sort((a, b) => (b.addedAt || b.mtime || 0) - (a.addedAt || a.mtime || 0))
        .slice(0, 300);
      strip.replaceChildren();
      if (!list.length) strip.appendChild(el("span", "b-note", t("bNoImages")));
      for (const it of list) {
        const b = el("button", "b-pick");
        b.type = "button";
        b.title = it.filename;
        const im = el("img");
        im.src = smallSrc(it);
        im.alt = "";
        im.loading = "lazy";
        im.draggable = false;
        b.appendChild(im);
        b.addEventListener("pointerdown", (e) => pickDrag(e, it, b));
        strip.appendChild(b);
      }
    };
    fillStrip();
    strip.scrollLeft = keepScroll;
  }

  // Ziehen mit Zeiger statt HTML-Drag: der Webview gehört das Ziehen von Dateien
  function pickDrag(e, it, b) {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let ghost = null;
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!ghost) {
        ghost = el("img", "b-ghost");
        ghost.src = smallSrc(it);
        document.body.appendChild(ghost);
      }
      ghost.style.left = ev.clientX + "px";
      ghost.style.top = ev.clientY + "px";
    };
    const up = (ev) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (!ghost) {
        addImage(it.hash);
        return;
      }
      ghost.remove();
      const live = liveEl();
      const r = live && live.getBoundingClientRect();
      const overPanel = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".b-panel, .b-bar");
      if (r && !overPanel && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) addImage(it.hash, toSlide(ev));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    b.blur();
  }

  // ---- Präsentieren: Folien nacheinander im Vollbild ----

  let presenting = null;
  function present(start) {
    if (presenting) return;
    let i = start;
    const ov = el("div", "b-present");
    const box = el("div", "b-present-box");
    ov.appendChild(box);
    const foot = el("div", "b-present-foot");
    const esc = btn("b-present-esc", "esc · " + t("bBackToEditor"), () => close());
    const cnt = el("span");
    foot.append(esc, cnt);
    ov.appendChild(foot);
    const draw = () => {
      const sc = Math.min(innerWidth / W, (innerHeight - 40) / H) * 0.96;
      box.style.width = W * sc + "px";
      box.style.height = H * sc + "px";
      const s = slideEl(B.deck.slides[i], i, "show");
      s.style.transform = `scale(${sc})`;
      box.replaceChildren(s);
      cnt.textContent = pad2(i + 1) + " / " + pad2(B.deck.slides.length) + " · ← →";
    };
    const close = () => {
      ov.remove();
      removeEventListener("resize", draw);
      presenting = null;
      A.invoke("set_fullscreen", { on: false }).catch(() => {});
      B.cur = i;
      renderAll();
    };
    presenting = {
      key(e) {
        if (e.key === "Escape") close();
        else if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(e.key)) {
          i = Math.min(B.deck.slides.length - 1, i + 1);
          draw();
        } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
          i = Math.max(0, i - 1);
          draw();
        }
        return true;
      },
    };
    ov.addEventListener("click", (e) => {
      if (e.target.closest(".b-present-esc")) return;
      i = e.clientX > innerWidth / 2 ? Math.min(B.deck.slides.length - 1, i + 1) : Math.max(0, i - 1);
      draw();
    });
    addEventListener("resize", draw);
    document.body.appendChild(ov);
    draw();
    A.invoke("set_fullscreen", { on: true }).catch(() => {});
  }

  // ---- Aus einer Zone: Auswahl › Aufs Board … ----

  async function pickFor(list, x, y) {
    const its = list.filter(visual);
    if (!its.length) return A.toast(t("bNoVisual"), false);
    await refreshList();
    A.closeMenus();
    const menu = el("div", "zone-menu p-ctx-menu b-pick-menu");
    menu.appendChild(el("div", "p-more-label", t("bToBoard")));
    for (const info of (B.list || []).slice(0, 12)) menuEntry(menu, info.name, () => addItemsTo(info.name, its));
    if ((B.list || []).length) menu.appendChild(el("div", "p-more-rule"));
    menuEntry(menu, t("bNewBoard") + " …", () => askNew(its));
    menuAt(menu, x, y);
  }

  // Neue Folie mit Index-Vorlage ans Ende; ist das Board offen, gleich zeigen
  async function addItemsTo(name, its, fresh) {
    try {
      items();
      const deck = B.name === name ? B.deck : normalize(JSON.parse(await A.invoke("board_read", { name })), name);
      const ks = its.map((it) => it.hash).filter(Boolean);
      for (const k of ks.slice(0, 1)) await paletteOf(k);
      const base = deck.slides[deck.slides.length - 1];
      const sl = newSlide(ks.length === 1 ? "single" : "index", ks.slice(0, 24), its.length === 1 ? String(its[0].filename).replace(/\.[^.]+$/, "") : its[0].zone.split("/").pop(), base ? { ...base.style, header: true } : null);
      // Ein frisches Board hat nur die leere Titelfolie: ersetzen
      if (fresh && deck.slides.length === 1 && !deck.slides[0].objs.some((o) => o.type === "img")) deck.slides = [sl];
      else deck.slides.push(sl);
      if (B.name === name) {
        snap();
        B.cur = deck.slides.length - 1;
        changed();
      } else await A.invoke("board_write", { name, data: JSON.stringify(deck, null, 1) });
      A.toast(t("bAdded", { n: its.length, name }));
    } catch (e) {
      A.fail(e);
    }
  }

  // ---- Bereich ----

  async function enter() {
    document.body.classList.add("boards");
    host().replaceChildren();
    await refreshList();
    render();
  }

  function leave() {
    closeBoard(false);
    if (presenting) presenting.key({ key: "Escape" });
    document.body.classList.remove("boards", "b-editing");
  }

  function nav(navButton) {
    if (!B.name) return [];
    return [navButton(B.name, true)];
  }

  function brandClick() {
    if (B.name) closeBoard();
  }

  const atHome = () => !B.name;

  function key(e) {
    if (presenting) return presenting.key(e);
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches("input, textarea, [contenteditable=true]")) return false;
    if (!B.name) return false;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z") {
      if (e.shiftKey) redo();
      else undo();
      return true;
    }
    if (mod && k === "d") {
      duplicateSel();
      return true;
    }
    if (mod && e.key === "Enter") {
      present(B.cur);
      return true;
    }
    if (mod || e.altKey) return false;
    if (e.key === "Backspace" || e.key === "Delete") {
      removeSel();
      return true;
    }
    if (e.key === "Escape") {
      if (B.open.insp || B.open.lib || B.open.rail) ["insp", "lib", "rail"].forEach((q) => toggle(q, false));
      else if (B.sel.size) {
        B.sel.clear();
        renderAll();
      } else return false;
      return true;
    }
    if (k === "f") toggle("rail");
    else if (k === "b") toggle("lib");
    else if (k === "e") toggle("insp");
    else if (k === "t") addText();
    else if (k === "p") present(B.cur);
    else if (k === "g") {
      snap();
      slide().style.grid = !slide().style.grid;
      changed();
    } else if (e.key === "[" || e.key === "]") layer(e.key === "]" ? 1 : -1);
    else if (e.key.startsWith("Arrow") && B.sel.size) {
      snap();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
      const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
      slide().objs.forEach((o) => {
        if (B.sel.has(o.id)) {
          o.x += dx;
          o.y += dy;
        }
      });
      slide().tpl = "free";
      changed();
    } else if (e.key.startsWith("Arrow")) go(e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
    else return false;
    return true;
  }

  function refresh() {
    // Bibliothek neu eingelesen: Verweise und Bilderleiste nachziehen
    if (!active()) return;
    if (B.name) renderAll();
    else refreshList().then(render);
  }

  function init(api) {
    A = api;
    addEventListener("resize", () => {
      if (active() && B.name) renderAll(true);
    });
    addEventListener("beforeunload", () => save(true));
  }

  window.ArchiverBoards = { init, enter, leave, render, refresh, key, nav, brandClick, atHome, pickFor, isEditing: () => !!B.name };
})();
