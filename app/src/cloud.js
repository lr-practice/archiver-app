// cloud.js — Wolke (0.39.1, neu gedacht 0.41.0): Am offenen Objekt weitere
// Referenzen andocken und sie wie auf einem Tisch ordnen. Neun Ansichten:
// Wolke, Fokus, Raster, Spalten, Spektrum, Strang, Stapel, Vergleich, Frei.
// Jede Ansicht rechnet ihre Lage einmal aus, die Objekte gleiten per CSS
// dorthin. Mehrfachauswahl (⇧/⌘, Lasso, ⌘A), Größe S M L XL, Gruppen (G),
// groß ansehen (Leertaste), Fäden zu den ähnlichsten beim Überfahren.
// Ziehen legt Objekte frei ab und schaltet auf „Frei“.
//
// Gespeichert wird nur, wer zur Wolke gehört (Hash, Größe, Gruppe), die freie
// Lage und die Fläche, lokal unter archiver.clouds. Siehe DESIGN.md 4.25.

(function () {
  const { t } = window.ArchiverI18n;
  let A = null; // Bausteine aus app.js (init)

  const VIEWS = ["cloud", "focus", "grid", "masonry", "spectrum", "strand", "piles", "compare", "free"];
  // Modi bis 0.40: gehen in den neuen Ansichten auf
  const OLD_VIEWS = { orbit: "focus", magnet: "spectrum", constellation: "strand" };
  const GAPS = { tight: 12, mid: 26, wide: 44 };
  const STEPS = ["S", "M", "L", "XL"];
  const SCALE = [0.62, 1, 1.45, 2.05];
  // Fläche: Lightbox wie bisher, Schwarz, Weiß, die fünf Farben der Textkarten, Auto aus dem Objekt
  const TONES = ["lightbox", "black", "white", "red", "green", "violet", "cyan", "yellow", "auto"];
  const COLOR_NAMES = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "black", "gray", "white"];
  const HUES = { red: 0, orange: 28, yellow: 55, green: 125, teal: 175, blue: 215, purple: 275, pink: 330, brown: 24 };
  const NEUTRAL = ["white", "gray", "black"];
  const MAX_CLOUDS = 300;
  const reduce = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const C = {
    root: null,
    focus: null, // Objekt aus der Bibliothek
    view: "cloud",
    gap: "mid",
    tone: "lightbox",
    nodes: [], // [0] ist das offene Objekt
    sel: new Set(),
    center: null, // Mitte in Fokus, Strang und Vergleich (ab Werk das offene Objekt)
    free: new Map(), // Schlüssel → [x, y] als Anteil der Fläche
    fan: null, // Stapel: aufgefächerte Zone
    shuffle: 0,
    gid: 0,
    hover: null,
    drag: null,
    look: null, // { list, at }
    picker: false,
    query: "",
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => A.el(tag, cls, text);

  // ---- Speichern ----

  function load() {
    try {
      return JSON.parse(localStorage.getItem("archiver.clouds") || "{}") || {};
    } catch {
      return {};
    }
  }

  function save() {
    if (!C.focus) return;
    const all = load();
    const key = keyOf(C.focus);
    const refs = C.nodes.slice(1).map((n) => [keyOf(n.item), n.step, 0, n.group || 0]);
    const free = {};
    for (const [k, p] of C.free) free[k] = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
    if (refs.length) all[key] = { m: C.view, g: C.gap, t: C.tone, s: C.nodes[0].step, r: refs, p: free, at: Date.now() };
    else delete all[key];
    const keys = Object.keys(all);
    if (keys.length > MAX_CLOUDS) keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - MAX_CLOUDS).forEach((k) => delete all[k]);
    try {
      localStorage.setItem("archiver.clouds", JSON.stringify(all));
      localStorage.setItem("archiver.cloudMode", JSON.stringify(C.view));
      localStorage.setItem("archiver.cloudGap", JSON.stringify(C.gap));
      localStorage.setItem("archiver.cloudTone", JSON.stringify(C.tone));
    } catch {}
  }

  function lastPref(key, ok, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem("archiver." + key));
      return ok(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }

  const viewOf = (m) => (VIEWS.includes(m) ? m : OLD_VIEWS[m] || null);

  const keyOf = (item) => item.hash || item.path;
  function byKey() {
    const map = new Map();
    for (const it of A.items()) {
      if (it.hash) map.set(it.hash, it);
      map.set(it.path, it);
    }
    return map;
  }

  // ---- Ähnlichkeit: Farbanteile (Bildanalyse) und Zone ----

  function colorVec(item) {
    const v = new Array(COLOR_NAMES.length).fill(0);
    for (const part of String(item.colors || "").split(" ")) {
      const [name, share] = part.split(":");
      const i = COLOR_NAMES.indexOf(name);
      if (i >= 0) v[i] = Number(share) || 0;
    }
    return v;
  }

  function vecOf(n) {
    return n.vec || (n.vec = colorVec(n.item));
  }

  function colorSim(a, b) {
    const va = vecOf(a);
    const vb = vecOf(b);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.length; i++) {
      dot += va[i] * vb[i];
      na += va[i] * va[i];
      nb += vb[i] * vb[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0.3;
  }

  // Stärkste bunte Farbe eines Bildes, sonst null (unbunt)
  function mainHue(n) {
    const v = vecOf(n);
    let best = null, share = 0.12;
    COLOR_NAMES.forEach((name, i) => {
      if (HUES[name] != null && v[i] > share) {
        share = v[i];
        best = name;
      }
    });
    return best;
  }

  function suggestions() {
    const focus = { item: C.focus };
    const inCloud = new Set(C.nodes.map((n) => keyOf(n.item)));
    const q = C.query.trim().toLowerCase();
    return A.items()
      .filter((it) => A.kindOf(it) === "image" && !inCloud.has(keyOf(it)))
      .filter((it) => !q || [it.filename, it.zone, it.pageTitle, it.pageUrl, it.tags && it.tags.join(" ")].join(" ").toLowerCase().includes(q))
      .map((it) => ({ it, s: colorSim(focus, { item: it }) * 0.7 + (it.zone === C.focus.zone ? 0.3 : 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 80)
      .map((x) => x.it);
  }

  // ---- Knoten ----

  function ratio(item) {
    return Math.max(0.4, Math.min(2.5, item.width && item.height ? item.width / item.height : 1));
  }

  function makeNode(item, step) {
    const box = el("div", "cl-ref");
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    img.src = A.thumbSrc(item);
    box.appendChild(img);
    box.title = item.filename || "";
    const n = { item, el: box, step: Math.max(0, Math.min(3, step)), ar: ratio(item), x: 0, y: 0, w: 0, h: 0, group: 0 };
    $("clStage").appendChild(box);
    return n;
  }

  function addRef(item, opts = {}) {
    if (!item || C.nodes.some((n) => keyOf(n.item) === keyOf(item))) return null;
    const n = makeNode(item, opts.step != null ? opts.step : 1);
    n.group = opts.group || 0;
    const from = C.nodes[0];
    if (from) {
      n.x = from.x;
      n.y = from.y;
    }
    C.nodes.push(n);
    if (!opts.quiet) {
      place(n);
      layout();
      save();
      if (C.picker) renderPicker();
    }
    return n;
  }

  // Neues Objekt erst ohne Übergang an seinen Startpunkt setzen, dann gleitet es
  function place(n) {
    n.el.classList.add("still");
    n.el.style.transform = `translate(${n.x - 10}px, ${n.y - 10}px)`;
    n.el.style.width = n.el.style.height = "20px";
    void n.el.offsetWidth;
    n.el.classList.remove("still");
  }

  function removeRefs(list) {
    const gone = list.filter((n) => n && n !== C.nodes[0]);
    if (!gone.length) return;
    for (const n of gone) {
      n.el.remove();
      C.sel.delete(n);
      C.free.delete(keyOf(n.item));
      if (C.center === n) C.center = null;
    }
    C.nodes = C.nodes.filter((x) => !gone.includes(x));
    layout();
    save();
    if (C.picker) renderPicker();
  }

  // ---- Auswahl ----

  function selected() {
    return C.nodes.filter((n) => C.sel.has(n));
  }

  function selectOnly(n) {
    C.sel = new Set(n ? [n] : []);
    paint();
    renderBar();
  }

  function toggle(n) {
    if (C.sel.has(n)) C.sel.delete(n);
    else C.sel.add(n);
    paint();
    renderBar();
  }

  function resize(step) {
    const list = C.sel.size ? selected() : [C.nodes[0]];
    for (const n of list) n.step = Math.max(0, Math.min(3, step));
    layout();
    save();
  }

  function nudge(d) {
    const list = C.sel.size ? selected() : [C.nodes[0]];
    for (const n of list) n.step = Math.max(0, Math.min(3, n.step + d));
    layout();
    save();
  }

  function group() {
    const list = selected();
    if (list.length < 2) return;
    const g = ++C.gid;
    for (const n of list) n.group = g;
    A.toast(t("cloudGrouped", { n: g }));
    layout();
    save();
  }

  function ungroup() {
    for (const n of selected()) n.group = 0;
    layout();
    save();
  }

  // ---- Lage: jede Ansicht setzt x, y (Mitte), w, h ----

  function bounds() {
    const r = C.root.getBoundingClientRect();
    const top = $("clTop").getBoundingClientRect().bottom - r.top + 24;
    const lower = C.picker ? $("clPicker") : $("clNav");
    const bottom = lower.getBoundingClientRect().top - r.top - 24;
    const side = 24;
    return { x: side, y: top, w: r.width - 2 * side, h: Math.max(120, bottom - top), W: r.width, H: r.height };
  }

  function base(b) {
    return Math.max(56, Math.min(140, Math.min(b.W, b.H) / 8));
  }

  function sizeOf(n, s) {
    const v = s * SCALE[n.step];
    n.w = v * Math.sqrt(n.ar);
    n.h = v / Math.sqrt(n.ar);
  }

  const gapPx = () => GAPS[C.gap];
  const kOf = (n) => SCALE[n.step] / SCALE[1];

  // Reihenfolge: Mischen tauscht fest (gleiche Zahl, gleiche Lage)
  function ordered(list) {
    if (!C.shuffle) return list.slice();
    const k = C.shuffle;
    const h = (n) => {
      const s = keyOf(n.item) + k;
      let v = 0;
      for (let i = 0; i < s.length; i++) v = (v * 31 + s.charCodeAt(i)) >>> 0;
      return v;
    };
    return list.slice().sort((a, b) => h(a) - h(b));
  }

  function centerNode() {
    return C.nodes.includes(C.center) ? C.center : C.nodes[0];
  }

  function layout() {
    if (!C.root || C.root.hidden || !C.nodes.length) return;
    const b = bounds();
    for (const n of C.nodes) {
      n.dim = false;
      n.z = 0;
    }
    C.labels = [];
    C.chain = null;
    const f = LAYOUTS[C.view] || LAYOUTS.cloud;
    f(C.nodes, b, base(b));
    paint();
    renderBar();
  }

  // Wolke: alles sammelt sich dicht um die Mitte, Gruppen halten zusammen
  function cloudLayout(ns, b, s) {
    const gap = gapPx();
    const c = centerNode();
    const list = [c, ...ordered(ns.filter((n) => n !== c))];
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    list.forEach((n, k) => {
      sizeOf(n, s);
      const a = k * 2.399, r = k ? Math.sqrt(k) * s * 0.9 : 0;
      n.x = cx + Math.cos(a) * r;
      n.y = cy + Math.sin(a) * r;
    });
    const rounds = list.length > 120 ? 90 : 220;
    const settle = 40; // zum Schluss nur noch Abstand halten, die Mitte steht
    for (let it = 0; it < rounds + settle; it++) {
      const last = it >= rounds;
      const groups = new Map();
      for (const n of list) {
        if (!n.group) continue;
        const v = groups.get(n.group) || { x: 0, y: 0, k: 0 };
        v.x += n.x;
        v.y += n.y;
        v.k++;
        groups.set(n.group, v);
      }
      for (const n of last ? [] : list) {
        const pull = n === c ? 0.2 : 0.02;
        n.x += (cx - n.x) * pull;
        n.y += (cy - n.y) * pull * 1.25;
        const g = n.group && groups.get(n.group);
        if (g && g.k > 1) {
          n.x += (g.x / g.k - n.x) * 0.06;
          n.y += (g.y / g.k - n.y) * 0.06;
        }
      }
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i], q = list[j];
          const ox = (p.w + q.w) / 2 + gap - Math.abs(p.x - q.x);
          const oy = (p.h + q.h) / 2 + gap - Math.abs(p.y - q.y);
          if (ox <= 0 || oy <= 0) continue;
          const fixed = last ? 0 : 0.05;
          const wp = p === c ? fixed : q === c && last ? 1 : 0.5, wq = q === c ? fixed : p === c && last ? 1 : 0.5;
          if (ox < oy) {
            const d = Math.sign(p.x - q.x) || (i % 2 ? 1 : -1);
            p.x += d * ox * wp;
            q.x -= d * ox * wq;
          } else {
            const d = Math.sign(p.y - q.y) || (j % 2 ? 1 : -1);
            p.y += d * oy * wp;
            q.y -= d * oy * wq;
          }
        }
    }
    fit(list, b);
  }

  // Alles in die Fläche skalieren, nie größer
  function fit(ns, b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      x0 = Math.min(x0, n.x - n.w / 2);
      y0 = Math.min(y0, n.y - n.h / 2);
      x1 = Math.max(x1, n.x + n.w / 2);
      y1 = Math.max(y1, n.y + n.h / 2);
    }
    const k = Math.min(1, b.w / (x1 - x0 || 1), b.h / (y1 - y0 || 1));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const n of ns) {
      n.x = b.x + b.w / 2 + (n.x - cx) * k;
      n.y = b.y + b.h / 2 + (n.y - cy) * k;
      n.w *= k;
      n.h *= k;
    }
  }

  // Zeilen gleicher Grundhöhe, Größe S–XL skaliert je Objekt; so groß, wie es passt
  function rows(ns, b, maxH, snake) {
    const gap = Math.min(gapPx(), 26);
    const pack = (h) => {
      const out = [[]];
      let x = 0;
      for (const n of ns) {
        const w = n.ar * h * kOf(n);
        if (x && x + w > b.w) {
          out.push([]);
          x = 0;
        }
        out[out.length - 1].push(n);
        x += w + gap;
      }
      const hs = out.map((r) => Math.max(...r.map((n) => h * kOf(n))));
      return { out, hs, H: hs.reduce((a, v) => a + v, 0) + gap * (out.length - 1) };
    };
    let lo = 8, hi = maxH, best = null;
    for (let k = 0; k < 22; k++) {
      const h = (lo + hi) / 2;
      const p = pack(h);
      if (p.H <= b.h) {
        best = { h, p };
        lo = h;
      } else hi = h;
    }
    if (!best) best = { h: lo, p: pack(lo) };
    const { out, hs, H } = best.p;
    let y = b.y + (b.h - H) / 2;
    out.forEach((row, ri) => {
      const ws = row.map((n) => n.ar * best.h * kOf(n));
      let x = b.x + (b.w - (ws.reduce((a, v) => a + v, 0) + gap * (row.length - 1))) / 2;
      const seq = snake && ri % 2 ? row.slice().reverse() : row;
      for (const n of seq) {
        n.h = best.h * kOf(n);
        n.w = n.ar * n.h;
        n.x = x + n.w / 2;
        n.y = y + hs[ri] / 2;
        x += n.w + gap;
      }
      y += hs[ri] + gap;
    });
  }

  const LAYOUTS = {
    cloud: cloudLayout,

    // Fokus: ein Objekt groß in der Mitte, die anderen im Kreis darum
    focus(ns, b, s) {
      const c = centerNode();
      const rest = ordered(ns.filter((n) => n !== c));
      c.h = b.h * 0.5;
      c.w = c.h * c.ar;
      if (c.w > b.w * 0.42) {
        c.w = b.w * 0.42;
        c.h = c.w / c.ar;
      }
      c.x = b.x + b.w / 2;
      c.y = b.y + b.h / 2;
      const around = 2 * Math.PI * Math.sqrt((b.w * b.w + b.h * b.h) / 8);
      const sm = Math.max(28, Math.min(s * 0.62 * 1.2, around / Math.max(1, rest.length) / 1.5));
      const rx = b.w / 2 - sm * 0.7, ry = b.h / 2 - sm * 0.6;
      rest.forEach((n, k) => {
        const a = -Math.PI / 2 + (k / rest.length) * Math.PI * 2;
        n.w = sm * Math.sqrt(n.ar);
        n.h = sm / Math.sqrt(n.ar);
        n.x = c.x + Math.cos(a) * rx;
        n.y = c.y + Math.sin(a) * ry;
      });
    },

    // Raster: gleiche Zellen, ruhig zum Sichten
    grid(ns, b) {
      const list = ordered(ns);
      const gap = Math.min(gapPx(), 26);
      const cols = Math.max(2, Math.round(Math.sqrt((list.length * b.w) / b.h)));
      const lines = Math.ceil(list.length / cols);
      const cw = (b.w - gap * (cols - 1)) / cols, ch = (b.h - gap * (lines - 1)) / lines;
      const cell = Math.min(cw, ch);
      const top = b.y + (b.h - (lines * cell + gap * (lines - 1))) / 2;
      const left = b.x + (b.w - (cols * cell + gap * (cols - 1))) / 2;
      list.forEach((n, k) => {
        const side = cell * Math.min(1, 0.7 + 0.3 * kOf(n) * 0.5);
        n.w = n.ar >= 1 ? side : side * n.ar;
        n.h = n.ar >= 1 ? side / n.ar : side;
        n.x = left + (k % cols) * (cell + gap) + cell / 2;
        n.y = top + Math.floor(k / cols) * (cell + gap) + cell / 2;
      });
    },

    // Spalten: gleich breit, unterschiedlich hoch
    masonry(ns, b) {
      const list = ordered(ns);
      const gap = Math.min(gapPx(), 26);
      let best = null;
      for (let cols = 2; cols <= 10; cols++) {
        const cw = (b.w - gap * (cols - 1)) / cols;
        const hs = new Array(cols).fill(0);
        const pos = list.map((n) => {
          const c = hs.indexOf(Math.min(...hs));
          const h = cw / n.ar;
          const p = [c, hs[c], h];
          hs[c] += h + gap;
          return p;
        });
        const H = Math.max(...hs) - gap;
        const k = Math.min(1, b.h / H);
        if (!best || k * cw > best.score) best = { cols, cw, pos, H, k, score: k * cw };
      }
      const { cols, cw, pos, H, k } = best;
      const x0 = b.x + (b.w - (cols * cw + gap * (cols - 1)) * k) / 2, y0 = b.y + (b.h - H * k) / 2;
      list.forEach((n, i) => {
        const [c, y, h] = pos[i];
        n.w = cw * k;
        n.h = h * k;
        n.x = x0 + c * (cw + gap) * k + n.w / 2;
        n.y = y0 + y * k + n.h / 2;
      });
    },

    // Spektrum: nach Farbton, Unbuntes von Weiß nach Schwarz am Ende
    spectrum(ns, b) {
      const key = (n) => {
        const h = mainHue(n);
        if (h) return (HUES[h] + 15) % 360;
        const v = vecOf(n);
        return 400 + NEUTRAL.reduce((a, name, i) => a + v[COLOR_NAMES.indexOf(name)] * i * 30, 0);
      };
      rows(ns.slice().sort((p, q) => key(p) - key(q)), b, b.h / 2.2);
    },

    // Strang: jedes Objekt hängt am ähnlichsten, ein Faden läuft durch
    strand(ns, b) {
      const start = centerNode();
      const left = new Set(ns.filter((n) => n !== start));
      const chain = [start];
      while (left.size) {
        const last = chain[chain.length - 1];
        let next = null, best = -1;
        for (const n of left) {
          const v = colorSim(last, n);
          if (v > best) {
            best = v;
            next = n;
          }
        }
        chain.push(next);
        left.delete(next);
      }
      C.chain = chain;
      rows(chain, b, b.h / 3, true);
    },

    // Stapel: je Zone ein Stapel; Klick fächert einen auf
    piles(ns, b, s) {
      const zones = [...new Set(ns.map((n) => n.item.zone || ""))];
      if (C.fan != null && zones.includes(C.fan)) {
        const fan = ns.filter((n) => (n.item.zone || "") === C.fan);
        rows(fan, { ...b, h: b.h * 0.74 }, b.h * 0.45);
        const rest = zones.filter((z) => z !== C.fan);
        const sm = s * 0.5;
        rest.forEach((z, k) => {
          const px = b.x + (b.w * (k + 1)) / (rest.length + 1), py = b.y + b.h * 0.9;
          ns.filter((n) => (n.item.zone || "") === z).forEach((n, j) => {
            n.w = sm * Math.sqrt(n.ar);
            n.h = sm / Math.sqrt(n.ar);
            n.x = px + Math.min(j, 6) * 3;
            n.y = py - Math.min(j, 6) * 3;
            n.z = j + 1;
          });
          C.labels.push({ text: zoneName(z), x: px, y: py + sm * 0.55 + 6, zone: z });
        });
        return;
      }
      // So viele Spalten, dass die Stapel am größten werden
      let cols = 1, lines = 1, pw = 0;
      for (let k = 1; k <= zones.length; k++) {
        const l = Math.ceil(zones.length / k);
        const v = Math.min(s * 1.3, (b.h / l) * 0.6, (b.w / k) * 0.6);
        if (v > pw + 0.5) [cols, lines, pw] = [k, l, v];
      }
      zones.forEach((z, k) => {
        const px = b.x + (b.w * ((k % cols) + 0.5)) / cols;
        const py = b.y + (b.h * (Math.floor(k / cols) + 0.5)) / lines - 10;
        ns.filter((n) => (n.item.zone || "") === z).forEach((n, j) => {
          const off = Math.min(j, 8) * 6;
          n.w = pw * Math.sqrt(n.ar);
          n.h = pw / Math.sqrt(n.ar);
          n.x = px + off - 20;
          n.y = py - off + 20;
          n.z = j + 1;
        });
        C.labels.push({ text: zoneName(z), x: px, y: py + pw * 0.62 + 26, zone: z });
      });
    },

    // Vergleich: zwei bis vier gewählte groß nebeneinander, der Rest klein darunter
    compare(ns, b, s) {
      let pick = selected().slice(0, 4);
      if (pick.length < 2) {
        const c = centerNode();
        pick = [c, ...ns.filter((n) => n !== c).sort((p, q) => colorSim(c, q) - colorSim(c, p)).slice(0, 2)];
      }
      const rest = ns.filter((n) => !pick.includes(n));
      const saved = pick.map((n) => n.step);
      pick.forEach((n) => (n.step = 1));
      rows(pick, { ...b, h: rest.length ? b.h * 0.78 : b.h }, b.h * 0.76);
      pick.forEach((n, i) => (n.step = saved[i]));
      const sm = Math.min(s * 0.42, b.w / Math.max(1, rest.length * 1.25));
      let x = b.x + (b.w - rest.length * sm * 1.2) / 2 + sm * 0.6;
      for (const n of rest) {
        n.w = sm * Math.sqrt(n.ar);
        n.h = sm / Math.sqrt(n.ar);
        n.x = x;
        n.y = b.y + b.h - sm * 0.55;
        x += sm * 1.2;
        n.dim = true;
      }
    },

    // Frei: was gezogen wurde, bleibt liegen; der Rest steht wie in der Wolke
    free(ns, b, s) {
      cloudLayout(ns, b, s);
      for (const n of ns) {
        const p = C.free.get(keyOf(n.item));
        if (!p) continue;
        sizeOf(n, s);
        n.x = b.x + p[0] * b.w;
        n.y = b.y + p[1] * b.h;
      }
    },
  };

  function zoneName(z) {
    return (z || "").split("/").pop() || "—";
  }

  // ---- Zeichnen ----

  function paint() {
    for (const n of C.nodes) {
      const s = n.el.style;
      s.width = n.w + "px";
      s.height = n.h + "px";
      s.transform = `translate(${n.x - n.w / 2}px, ${n.y - n.h / 2}px)`;
      s.opacity = n.dim ? 0.4 : "";
      s.zIndex = n.z ? String(n.z) : "";
      n.el.classList.toggle("selected", C.sel.has(n));
      n.el.classList.toggle("center", n === centerNode() && (C.view === "focus" || C.view === "strand"));
      let tag = n.el.querySelector(".cl-group");
      if (n.group && (C.view === "cloud" || C.view === "free")) {
        if (!tag) n.el.appendChild((tag = el("span", "cl-group")));
        tag.textContent = "G" + n.group;
      } else if (tag) tag.remove();
    }
    const box = $("clLabels");
    box.replaceChildren(
      ...C.labels.map((l) => {
        const d = el("span", "cl-pile-label", l.text);
        d.style.transform = `translate(${l.x}px, ${l.y}px) translateX(-50%)`;
        return d;
      })
    );
    threads();
  }

  function threads() {
    const svg = $("clLinks");
    svg.replaceChildren();
    const ns = "http://www.w3.org/2000/svg";
    if (C.view === "strand" && C.chain && C.chain.length > 1) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", "M" + C.chain.map((n) => n.x + " " + n.y).join(" L"));
      svg.appendChild(p);
    }
    for (const n of C.nodes) n.el.classList.remove("near");
    const h = C.hover;
    if (!h || C.drag || !C.nodes.includes(h)) return;
    C.nodes
      .filter((n) => n !== h)
      .sort((p, q) => colorSim(h, q) - colorSim(h, p))
      .slice(0, 3)
      .forEach((n) => {
        const l = document.createElementNS(ns, "line");
        l.setAttribute("x1", h.x);
        l.setAttribute("y1", h.y);
        l.setAttribute("x2", n.x);
        l.setAttribute("y2", n.y);
        svg.appendChild(l);
        n.el.classList.add("near");
      });
  }

  function applyTone() {
    const root = C.root;
    root.dataset.tone = C.tone;
    let bg = "", fg = "";
    const tones = A.tones || {};
    if (tones[C.tone]) [bg, fg] = tones[C.tone];
    else if (C.tone === "auto") {
      const h = mainHue(C.nodes[0] || { item: C.focus });
      if (h) {
        bg = `hsl(${HUES[h]} 32% 13%)`;
        fg = "#ededed";
      }
    }
    root.style.setProperty("--cl-bg", bg || "var(--lightbox-bg)");
    root.style.setProperty("--cl-fg", fg || "var(--p-text, var(--ink))");
  }

  // ---- Oberfläche ----

  function build() {
    const root = el("div", "cloud");
    root.id = "cloud";
    root.hidden = true;
    const stage = el("div", "cl-stage");
    stage.id = "clStage";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "clLinks";
    svg.classList.add("cl-links");
    const labels = el("div", "cl-labels");
    labels.id = "clLabels";
    const lasso = el("div", "cl-lasso");
    lasso.id = "clLasso";
    lasso.hidden = true;
    stage.append(svg, labels, lasso);
    const top = el("nav", "lb-bar cl-top");
    top.id = "clTop";
    const picker = el("div", "cl-picker");
    picker.id = "clPicker";
    picker.hidden = true;
    const nav = el("nav", "lb-bar cl-nav");
    nav.id = "clNav";
    const look = el("div", "cl-look");
    look.id = "clLook";
    look.hidden = true;
    root.append(stage, top, picker, nav, look);
    document.body.appendChild(root);
    C.root = root;
    bindPointer(stage);
    bindLook(look);
    window.addEventListener("resize", () => {
      if (isOpen()) layout();
    });
  }

  function lbBtn(label, on, fn, title) {
    const b = A.button("lb-btn" + (on ? " active" : ""), label, fn);
    if (title) b.title = title;
    return b;
  }

  function sep() {
    return el("span", "lb-sep");
  }

  function setView(v) {
    if (!VIEWS.includes(v)) return;
    C.view = v;
    if (v !== "piles") C.fan = null;
    layout();
    save();
  }

  function setTone(k) {
    C.tone = k;
    applyTone();
    renderBar();
    save();
  }

  function renderBar() {
    const top = $("clTop");
    top.replaceChildren();
    for (const v of VIEWS) top.appendChild(lbBtn(t("cloudView_" + v), C.view === v, () => setView(v), t("cloudViewTitle_" + v)));
    top.appendChild(sep());
    top.appendChild(el("span", "cl-label", t("cloudGap")));
    for (const g of Object.keys(GAPS))
      top.appendChild(
        lbBtn(t("cloudGap_" + g), C.gap === g, () => {
          C.gap = g;
          layout();
          save();
        })
      );

    const nav = $("clNav");
    nav.replaceChildren();
    const sel = selected();
    if (sel.length) {
      nav.appendChild(el("span", "cl-count", t("cloudSelected", { n: sel.length })));
      nav.appendChild(sep());
      const same = sel.every((n) => n.step === sel[0].step) ? sel[0].step : -1;
      STEPS.forEach((s, i) => nav.appendChild(lbBtn(s, same === i, () => resize(i))));
      nav.appendChild(sep());
      nav.appendChild(lbBtn(t("cloudLook"), false, () => openLook(sel[0]), "␣"));
      if (sel.length > 1) {
        nav.appendChild(lbBtn(t("cloudGroup"), false, group, "G"));
        nav.appendChild(lbBtn(t("cloudCompare"), C.view === "compare", () => setView("compare")));
      } else
        nav.appendChild(
          lbBtn(t("cloudCenter"), false, () => {
            C.center = sel[0];
            setView(C.view === "focus" || C.view === "strand" ? C.view : "focus");
          })
        );
      if (sel.some((n) => n.group)) nav.appendChild(lbBtn(t("cloudUngroup"), false, ungroup));
      nav.appendChild(el("span", "cl-flex"));
      if (sel.some((n) => n !== C.nodes[0])) nav.appendChild(lbBtn(t("cloudRemove"), false, () => removeRefs(sel), "⌫"));
      nav.appendChild(lbBtn("×", false, () => selectOnly(null), "esc"));
      return;
    }
    nav.appendChild(lbBtn("+ " + t("cloudAdd"), C.picker, togglePicker, t("cloudAddTitle")));
    nav.appendChild(lbBtn(t("cloudSimilar"), false, addSimilar, t("cloudSimilarTitle")));
    nav.appendChild(
      lbBtn(t("cloudShuffle"), false, () => {
        C.shuffle++;
        if (C.view === "free") C.free.clear();
        layout();
        save();
      }, t("cloudShuffleTitle"))
    );
    nav.appendChild(sep());
    nav.appendChild(el("span", "cl-label", t("cloudSizeFocus")));
    STEPS.forEach((s, i) => nav.appendChild(lbBtn(s, C.nodes[0] && C.nodes[0].step === i, () => resize(i))));
    nav.appendChild(sep());
    nav.appendChild(el("span", "cl-count", String(C.nodes.length - 1)));
    nav.appendChild(el("span", "cl-flex"));
    const tones = el("span", "cl-tones");
    for (const k of TONES) {
      const b = A.button("cl-tone" + (C.tone === k ? " active" : ""), "", () => setTone(k));
      b.dataset.tone = k;
      if (A.tones && A.tones[k]) b.style.setProperty("--sw", A.tones[k][0]);
      b.title = t("cloudTone_" + k);
      b.setAttribute("aria-label", t("cloudTone_" + k));
      tones.appendChild(b);
    }
    nav.appendChild(tones);
    nav.appendChild(sep());
    nav.appendChild(lbBtn(t("cloudClose"), false, close, "esc"));
  }

  function renderPicker() {
    const box = $("clPicker");
    box.hidden = !C.picker;
    if (!C.picker) return;
    let input = box.querySelector("input");
    if (!input) {
      input = el("input", "cl-search");
      input.type = "search";
      input.placeholder = t("cloudSearch");
      input.addEventListener("input", () => {
        C.query = input.value;
        renderStrip();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          togglePicker();
        }
      });
      box.appendChild(input);
      box.appendChild(el("div", "cl-strip"));
    }
    renderStrip();
  }

  function renderStrip() {
    const strip = $("clPicker").querySelector(".cl-strip");
    strip.replaceChildren();
    const list = suggestions();
    if (!list.length) strip.appendChild(el("span", "cl-empty", t("cloudNone")));
    for (const it of list) {
      const b = A.button("cl-thumb", "", () => addRef(it));
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      img.src = A.thumbSrc(it);
      b.appendChild(img);
      b.title = it.filename || "";
      strip.appendChild(b);
    }
  }

  function togglePicker() {
    C.picker = !C.picker;
    if (!C.picker) C.query = "";
    renderPicker();
    renderBar();
    layout();
    if (C.picker) {
      const input = $("clPicker").querySelector("input");
      input.value = C.query;
      input.focus();
    }
  }

  function addSimilar() {
    const list = suggestions().slice(0, 5);
    for (const it of list) {
      const n = addRef(it, { quiet: true });
      if (n) place(n);
    }
    layout();
    save();
    if (C.picker) renderPicker();
  }

  // ---- Groß ansehen (Leertaste) ----

  function openLook(n) {
    const sel = selected();
    const list = sel.length > 1 ? sel : C.nodes.slice();
    C.look = { list, at: Math.max(0, list.indexOf(n)) };
    showLook();
    $("clLook").hidden = false;
  }

  function showLook() {
    const box = $("clLook");
    const n = C.look.list[C.look.at];
    let img = box.querySelector("img");
    if (!img) {
      img = el("img");
      img.alt = "";
      img.draggable = false;
      const prev = A.button("cl-look-nav prev", "←", () => stepLook(-1));
      const next = A.button("cl-look-nav next", "→", () => stepLook(1));
      box.append(img, prev, next, el("div", "cl-look-cap"));
    }
    img.src = A.fullSrc(n.item);
    const many = C.look.list.length > 1;
    box.querySelectorAll(".cl-look-nav").forEach((b) => (b.hidden = !many));
    box.querySelector(".cl-look-cap").textContent = [zoneName(n.item.zone), n.item.filename, many ? C.look.at + 1 + " / " + C.look.list.length : ""].filter(Boolean).join("  ·  ");
  }

  function stepLook(d) {
    const L = C.look;
    L.at = (L.at + d + L.list.length) % L.list.length;
    showLook();
  }

  function closeLook() {
    C.look = null;
    $("clLook").hidden = true;
  }

  function bindLook(box) {
    box.addEventListener("click", (e) => {
      if (!e.target.closest(".cl-look-nav")) closeLook();
    });
  }

  // ---- Zeiger: Klick wählt, ⇧/⌘ mehrere, Lasso auf freier Fläche, Ziehen legt frei ab ----

  function bindPointer(stage) {
    const at = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const nodeOf = (e) => {
      const box = e.target.closest(".cl-ref");
      return box ? C.nodes.find((x) => x.el === box) : null;
    };
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = at(e);
      const n = nodeOf(e);
      const multi = e.shiftKey || e.metaKey || e.ctrlKey;
      if (C.picker && !n) togglePicker();
      if (n) {
        if (C.view === "piles" && C.fan == null) {
          C.fan = n.item.zone || "";
          layout();
          return;
        }
        if (multi) toggle(n);
        else if (!C.sel.has(n)) selectOnly(n);
        C.drag = { mode: "move", n, p, moved: false, start: selected().map((m) => ({ m, x: m.x, y: m.y })) };
      } else {
        if (C.view === "piles" && C.fan != null) {
          C.fan = null;
          layout();
          return;
        }
        if (!multi) selectOnly(null);
        C.drag = { mode: "lasso", p, base: new Set(C.sel) };
      }
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      const d = C.drag;
      if (!d) {
        const n = nodeOf(e);
        if (n !== C.hover) {
          C.hover = n;
          threads();
        }
        return;
      }
      const p = at(e);
      const dx = p.x - d.p.x, dy = p.y - d.p.y;
      if (d.mode === "move") {
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) {
          d.moved = true;
          C.hover = null;
          if (C.view !== "free") {
            // Was gerade zu sehen ist, wird zur freien Lage
            const b = bounds();
            for (const m of C.nodes) C.free.set(keyOf(m.item), [(m.x - b.x) / b.w, (m.y - b.y) / b.h]);
            C.view = "free";
            C.fan = null;
            renderBar();
            A.toast(t("cloudFreeHint"));
          }
          C.root.classList.add("dragging");
        }
        for (const s of d.start) {
          s.m.x = s.x + dx;
          s.m.y = s.y + dy;
        }
        paint();
      } else {
        const x0 = Math.min(p.x, d.p.x), y0 = Math.min(p.y, d.p.y), x1 = Math.max(p.x, d.p.x), y1 = Math.max(p.y, d.p.y);
        const box = $("clLasso");
        box.hidden = Math.hypot(dx, dy) < 4;
        Object.assign(box.style, { left: x0 + "px", top: y0 + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" });
        C.sel = new Set(d.base);
        for (const n of C.nodes) if (n.x + n.w / 2 > x0 && n.x - n.w / 2 < x1 && n.y + n.h / 2 > y0 && n.y - n.h / 2 < y1) C.sel.add(n);
        paint();
      }
    });
    const end = () => {
      const d = C.drag;
      C.drag = null;
      $("clLasso").hidden = true;
      C.root.classList.remove("dragging");
      if (!d) return;
      if (d.mode === "move" && d.moved) {
        const b = bounds();
        for (const s of d.start) C.free.set(keyOf(s.m.item), [(s.m.x - b.x) / b.w, (s.m.y - b.y) / b.h]);
        save();
      } else if (d.mode === "move" && C.view === "focus" && d.n !== centerNode() && C.sel.size === 1) {
        C.center = d.n; // Klick im Fokus tauscht in die Mitte
        layout();
      }
      renderBar();
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("pointerleave", () => {
      if (C.drag || !C.hover) return;
      C.hover = null;
      threads();
    });
    stage.addEventListener("dblclick", (e) => {
      const n = nodeOf(e);
      if (n) openLook(n);
    });
  }

  // ---- Öffnen und Schließen ----

  function open(item) {
    if (!item) return;
    if (!C.root) build();
    if (C.focus) save();
    for (const n of C.nodes) n.el.remove();
    C.nodes = [];
    C.sel = new Set();
    C.center = null;
    C.fan = null;
    C.hover = null;
    C.focus = item;
    closeLook();
    const stored = load()[keyOf(item)];
    C.view = (stored && viewOf(stored.m)) || viewOf(lastPref("cloudMode", (v) => !!viewOf(v), "cloud"));
    C.gap = stored && GAPS[stored.g] ? stored.g : lastPref("cloudGap", (v) => !!GAPS[v], "mid");
    C.tone = stored && TONES.includes(stored.t) ? stored.t : lastPref("cloudTone", (v) => TONES.includes(v), "lightbox");
    C.free = new Map(stored && stored.p ? Object.entries(stored.p) : []);
    C.shuffle = 0;
    C.root.hidden = false;
    document.body.classList.add("cloud-open");
    renderBar();
    renderPicker();
    const f = makeNode(item, stored ? stored.s : 3);
    f.el.classList.add("focus");
    C.nodes.push(f);
    C.gid = 0;
    if (stored) {
      const map = byKey();
      for (const [k, s, , g] of stored.r) {
        const it = map.get(k);
        if (it) addRef(it, { quiet: true, step: s, group: g || 0 });
        if (g) C.gid = Math.max(C.gid, g);
      }
    }
    applyTone();
    const b = bounds();
    for (const n of C.nodes) {
      n.x = b.x + b.w / 2;
      n.y = b.y + b.h / 2;
      place(n);
    }
    layout();
  }

  function close() {
    if (!C.root || C.root.hidden) return;
    save();
    closeLook();
    C.picker = false;
    C.query = "";
    C.root.hidden = true;
    document.body.classList.remove("cloud-open");
  }

  function isOpen() {
    return !!C.root && !C.root.hidden;
  }

  // true = Taste verbraucht
  function key(e, mod) {
    if (!isOpen()) return false;
    if (e.target && e.target.tagName === "INPUT") return false;
    if (C.look) {
      if (e.key === "Escape" || e.key === " ") closeLook();
      else if (e.key === "ArrowRight") stepLook(1);
      else if (e.key === "ArrowLeft") stepLook(-1);
      return true;
    }
    if (mod) {
      if (e.key === "a" || e.key === "A") {
        C.sel = new Set(C.nodes);
        paint();
        renderBar();
        return true;
      }
      return e.key !== "q" && e.key !== "w" && e.key !== "h" && e.key !== "m";
    }
    const sel = selected();
    if (e.key === "Escape") {
      if (C.picker) togglePicker();
      else if (sel.length) selectOnly(null);
      else if (C.fan != null) {
        C.fan = null;
        layout();
      } else close();
    } else if (e.key === "w" || e.key === "W") close();
    else if (e.key === " ") openLook(sel[0] || centerNode());
    else if (/^[1-4]$/.test(e.key)) resize(Number(e.key) - 1);
    else if (e.key === "+" || e.key === "=") nudge(1);
    else if (e.key === "-") nudge(-1);
    else if (e.key === "Backspace" || e.key === "Delete") removeRefs(sel);
    else if (e.key === "a" || e.key === "A") togglePicker();
    else if (e.key === "g" || e.key === "G") group();
    else if (e.key === "Tab") {
      const i = VIEWS.indexOf(C.view);
      setView(VIEWS[(i + (e.shiftKey ? VIEWS.length - 1 : 1)) % VIEWS.length]);
    } else if (e.key === "Enter" && sel.length === 1 && sel[0] !== C.nodes[0]) open(sel[0].item);
    return true;
  }

  function init(api) {
    A = api;
  }

  window.ArchiverCloud = { init, open, close, isOpen, key };
})();
