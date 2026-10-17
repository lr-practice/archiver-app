// cloud.js — Wolke (0.39.1): Am offenen Objekt weitere Referenzen andocken.
// Sie ziehen sich per Physik an, halten Abstand und bilden ein Moodboard für
// genau dieses Objekt. Sechs Modi zum Ausprobieren: Wolke, Orbit, Strang,
// Farbe, Konstellation, Raster. Jedes Objekt hat vier Größen (S M L XL).
//
// Gespeichert wird nur, wer zur Wolke gehört (Hash, Größe, Anker), lokal unter
// archiver.clouds. Lagen rechnet die Physik bei jedem Öffnen neu. Siehe
// DESIGN.md 4.25.

(function () {
  const { t } = window.ArchiverI18n;
  let A = null; // Bausteine aus app.js (init)

  const MODES = ["cloud", "orbit", "strand", "magnet", "constellation", "grid"];
  const GAPS = { tight: 12, mid: 26, wide: 44 };
  const STEPS = ["S", "M", "L", "XL"];
  const SCALE = [0.62, 1, 1.45, 2.05];
  const COLOR_NAMES = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "black", "gray", "white"];
  const MAX_CLOUDS = 300;
  const reduce = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const C = {
    root: null,
    focus: null, // Objekt aus der Bibliothek
    mode: "cloud",
    gap: "mid",
    nodes: [], // [0] ist das offene Objekt
    sel: null,
    drag: null,
    raf: 0,
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
    const refs = C.nodes.slice(1).map((n) => [keyOf(n.item), n.step, n.parent ? C.nodes.indexOf(n.parent) : 0]);
    if (refs.length) all[key] = { m: C.mode, g: C.gap, s: C.nodes[0].step, r: refs, at: Date.now() };
    else delete all[key];
    const keys = Object.keys(all);
    if (keys.length > MAX_CLOUDS) keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - MAX_CLOUDS).forEach((k) => delete all[k]);
    try {
      localStorage.setItem("archiver.clouds", JSON.stringify(all));
      localStorage.setItem("archiver.cloudMode", JSON.stringify(C.mode));
      localStorage.setItem("archiver.cloudGap", JSON.stringify(C.gap));
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

  function colorSim(a, b) {
    const va = a.vec || (a.vec = colorVec(a.item));
    const vb = b.vec || (b.vec = colorVec(b.item));
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.length; i++) {
      dot += va[i] * vb[i];
      na += va[i] * va[i];
      nb += vb[i] * vb[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0.3;
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

  function base() {
    const r = C.root.getBoundingClientRect();
    return Math.max(56, Math.min(140, Math.min(r.width, r.height) / 8));
  }

  function setStep(n, step) {
    n.step = Math.max(0, Math.min(3, step));
    const ar = Math.max(0.5, Math.min(2, n.item.width && n.item.height ? n.item.width / n.item.height : 1));
    const b = base() * SCALE[n.step];
    n.w = Math.round(b * Math.sqrt(ar));
    n.h = Math.round(b / Math.sqrt(ar));
    n.r = Math.hypot(n.w, n.h) / 2;
    n.el.style.width = n.w + "px";
    n.el.style.height = n.h + "px";
  }

  function makeNode(item, step, fresh) {
    const box = el("div", "cl-ref" + (fresh && !reduce() ? " new" : ""));
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    img.src = A.thumbSrc(item);
    box.appendChild(img);
    box.title = item.filename || "";
    const n = { item, el: box, x: 0, y: 0, vx: 0, vy: 0, parent: null, line: null };
    setStep(n, step);
    $("clStage").appendChild(box);
    return n;
  }

  function link(n) {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    $("clLinks").appendChild(l);
    n.line = l;
  }

  function wantsLine(n) {
    return !!n.parent && (C.mode === "strand" || (C.mode === "constellation" && n.parent !== C.nodes[0]));
  }

  function relink() {
    $("clLinks").replaceChildren();
    for (const n of C.nodes) {
      n.line = null;
      if (wantsLine(n)) link(n);
    }
  }

  function addRef(item, opts = {}) {
    if (!item || C.nodes.some((n) => keyOf(n.item) === keyOf(item))) return null;
    const focus = C.nodes[0];
    let from = focus;
    if (C.mode === "strand") from = C.sel || C.nodes[C.nodes.length - 1];
    if (C.mode === "constellation") from = C.sel || focus;
    if (opts.parent) from = opts.parent;
    const n = makeNode(item, opts.step != null ? opts.step : 1, !opts.quiet);
    const a = Math.random() * Math.PI * 2;
    const gap = GAPS[C.gap];
    n.x = from.x + Math.cos(a) * (from.r + n.r + gap);
    n.y = from.y + Math.sin(a) * (from.r + n.r + gap);
    if (C.mode === "strand") {
      n.x = from.x + (Math.random() - 0.5) * 20;
      n.y = from.y + from.h / 2 + n.h / 2 + gap;
    }
    n.vx = Math.cos(a) * 2;
    n.vy = Math.sin(a) * 2;
    n.parent = from;
    C.nodes.push(n);
    if (wantsLine(n)) link(n);
    if (!opts.quiet) {
      if (C.mode === "strand" && C.sel) select(n);
      save();
      renderBar();
      if (C.picker) renderPicker();
    }
    return n;
  }

  function removeRef(n) {
    if (!n || n === C.nodes[0]) return;
    for (const m of C.nodes) if (m.parent === n) m.parent = n.parent || C.nodes[0];
    n.el.remove();
    C.nodes = C.nodes.filter((x) => x !== n);
    if (C.sel === n) C.sel = null;
    relink();
    save();
    renderBar();
    if (C.picker) renderPicker();
  }

  function select(n) {
    if (C.sel) C.sel.el.classList.remove("selected");
    C.sel = n || null;
    if (C.sel) C.sel.el.classList.add("selected");
    renderBar();
  }

  function resize(step) {
    const n = C.sel || C.nodes[0];
    if (!n) return;
    setStep(n, step);
    for (const m of C.nodes) {
      m.vx += (Math.random() - 0.5) * 0.6;
      m.vy += (Math.random() - 0.5) * 0.6;
    }
    save();
    renderBar();
  }

  // ---- Physik ----

  function bounds() {
    const r = C.root.getBoundingClientRect();
    const top = $("clTop").getBoundingClientRect().bottom - r.top + 16;
    const lower = C.picker ? $("clPicker") : $("clNav");
    const bottom = lower.getBoundingClientRect().top - r.top - 16;
    return { W: r.width, top, bottom: Math.max(top + 120, bottom) };
  }

  function center(b) {
    const f = C.nodes[0];
    if (C.mode === "strand") return { x: b.W / 2, y: b.top + f.h / 2 + 12 };
    return { x: b.W / 2, y: (b.top + b.bottom) / 2 };
  }

  function gridSlots(c, gap) {
    const focus = C.nodes[0];
    const cell = Math.max(40, ...C.nodes.slice(1).map((n) => Math.max(n.w, n.h))) + gap;
    const fx = Math.ceil((focus.w + gap) / cell / 2);
    const fy = Math.ceil((focus.h + gap) / cell / 2);
    const slots = [];
    for (let ring = 1; slots.length < C.nodes.length && ring < 14; ring++)
      for (let gx = -fx - ring + 1; gx <= fx + ring - 1; gx++)
        for (let gy = -fy - ring + 1; gy <= fy + ring - 1; gy++) {
          if (Math.abs(gx) !== fx + ring - 1 && Math.abs(gy) !== fy + ring - 1) continue;
          if (Math.abs(gx) <= fx - 1 && Math.abs(gy) <= fy - 1) continue;
          slots.push({ x: c.x + gx * cell, y: c.y + gy * cell, d: Math.hypot(gx, gy * 1.2) });
        }
    return slots.sort((a, b) => a.d - b.d);
  }

  function step() {
    const nodes = C.nodes;
    if (!nodes.length) return;
    const b = bounds();
    const gap = GAPS[C.gap];
    const focus = nodes[0];
    const c = center(b);
    focus.x = c.x;
    focus.y = c.y;
    const held = (n) => n === focus || (C.drag && C.drag.n === n && C.drag.moved);
    const slots = C.mode === "grid" ? gridSlots(c, gap) : null;
    for (let i = 1; i < nodes.length; i++) {
      const n = nodes[i];
      if (held(n)) continue;
      let fx = 0, fy = 0;
      if (C.mode === "cloud") {
        fx += (focus.x - n.x) * 0.004;
        fy += (focus.y - n.y) * 0.004;
      } else if (C.mode === "orbit") {
        const want = focus.r + n.r + gap + (1 - colorSim(n, focus)) * 170;
        const dx = n.x - focus.x, dy = n.y - focus.y, d = Math.hypot(dx, dy) || 1;
        const k = (want - d) * 0.015;
        fx += (dx / d) * k;
        fy += (dy / d) * k;
        if (!reduce()) {
          fx += (-dy / d) * 0.03;
          fy += (dx / d) * 0.03;
        }
      } else if (C.mode === "strand") {
        const p = n.parent || focus;
        const want = (p.r + n.r) * 0.85 + gap;
        const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy) || 1;
        const k = (want - d) * 0.04;
        fx += (dx / d) * k;
        fy += (dy / d) * k + 0.18;
      } else if (C.mode === "magnet") {
        fx += (focus.x - n.x) * 0.0018;
        fy += (focus.y - n.y) * 0.0018;
        for (let j = 1; j < nodes.length; j++) {
          if (j === i) continue;
          const m = nodes[j];
          const dx = m.x - n.x, dy = m.y - n.y, d = Math.hypot(dx, dy) || 1;
          const pull = (colorSim(n, m) - 0.55) * 0.05 * Math.min(1, 220 / d);
          fx += (dx / d) * pull;
          fy += (dy / d) * pull;
        }
      } else if (C.mode === "constellation") {
        const p = n.parent || focus;
        const want = p.r + n.r + gap * 1.2 + (p === focus ? 70 : 0);
        const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy) || 1;
        const k = (want - d) * 0.02;
        fx += (dx / d) * k;
        fy += (dy / d) * k;
        if (p === focus) {
          const kids = nodes.filter((m) => m.parent === n).length;
          fx += (dx / d) * kids * 0.05;
          fy += (dy / d) * kids * 0.05;
        }
      } else if (C.mode === "grid") {
        const s = slots[i - 1];
        if (s) {
          fx += (s.x - n.x) * 0.03;
          fy += (s.y - n.y) * 0.03;
        }
      }
      const damp = C.mode === "strand" ? 0.93 : 0.85;
      n.vx = (n.vx + fx) * damp;
      n.vy = (n.vy + fy) * damp;
    }
    for (let i = 1; i < nodes.length; i++) {
      const n = nodes[i];
      if (!held(n)) {
        n.x += n.vx;
        n.y += n.vy;
      }
      const mx = n.w / 2 + 12;
      if (n.x < mx) (n.x = mx), (n.vx *= -0.3);
      if (n.x > b.W - mx) (n.x = b.W - mx), (n.vx *= -0.3);
      if (n.y < b.top + n.h / 2) (n.y = b.top + n.h / 2), (n.vy *= -0.3);
      if (n.y > b.bottom - n.h / 2) (n.y = b.bottom - n.h / 2), (n.vy *= -0.3);
    }
    // Abstand halten: Rechtecke plus Abstand überlappen nie
    const soft = C.mode === "grid" ? 0.3 : 0.5;
    for (let pass = 0; pass < 4; pass++)
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], o = nodes[j];
          const dx = o.x - a.x, dy = o.y - a.y;
          const ox = (a.w + o.w) / 2 + gap - Math.abs(dx);
          const oy = (a.h + o.h) / 2 + gap - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          const push = ox < oy ? [Math.sign(dx || Math.random() - 0.5) * ox, 0] : [0, Math.sign(dy || Math.random() - 0.5) * oy];
          const wa = held(a) ? 0 : 1, wb = held(o) ? 0 : 1, s = wa + wb || 1;
          a.x -= ((push[0] * wa) / s) * soft;
          a.y -= ((push[1] * wa) / s) * soft;
          o.x += ((push[0] * wb) / s) * soft;
          o.y += ((push[1] * wb) / s) * soft;
        }
    for (let i = 1; i < nodes.length; i++) clampIn(nodes[i], b);
  }

  function clampIn(n, b) {
    n.x = Math.max(n.w / 2 + 12, Math.min(b.W - n.w / 2 - 12, n.x));
    n.y = Math.max(b.top + n.h / 2, Math.min(b.bottom - n.h / 2, n.y));
  }

  function draw() {
    for (const n of C.nodes) n.el.style.transform = `translate(${n.x - n.w / 2}px, ${n.y - n.h / 2}px)`;
    for (const n of C.nodes)
      if (n.line && n.parent) {
        n.line.setAttribute("x1", n.parent.x);
        n.line.setAttribute("y1", n.parent.y);
        n.line.setAttribute("x2", n.x);
        n.line.setAttribute("y2", n.y);
      }
  }

  function loop() {
    step();
    draw();
    C.raf = requestAnimationFrame(loop);
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
    stage.appendChild(svg);
    const top = el("nav", "lb-bar cl-top");
    top.id = "clTop";
    const picker = el("div", "cl-picker");
    picker.id = "clPicker";
    picker.hidden = true;
    const nav = el("nav", "lb-bar cl-nav");
    nav.id = "clNav";
    root.append(stage, top, picker, nav);
    document.body.appendChild(root);
    C.root = root;
    bindPointer(stage);
  }

  function lbBtn(label, on, fn, title) {
    const b = A.button("lb-btn" + (on ? " active" : ""), label, fn);
    if (title) b.title = title;
    return b;
  }

  function sep() {
    return el("span", "lb-sep");
  }

  function renderBar() {
    const top = $("clTop");
    top.replaceChildren();
    for (const m of MODES)
      top.appendChild(
        lbBtn(t("cloudMode_" + m), C.mode === m, () => setMode(m), t("cloudModeTitle_" + m))
      );
    top.appendChild(sep());
    top.appendChild(el("span", "cl-label", t("cloudGap")));
    for (const g of Object.keys(GAPS)) top.appendChild(lbBtn(t("cloudGap_" + g), C.gap === g, () => setGap(g)));

    const nav = $("clNav");
    nav.replaceChildren();
    nav.appendChild(lbBtn("+ " + t("cloudAdd"), C.picker, togglePicker, t("cloudAddTitle")));
    nav.appendChild(lbBtn(t("cloudSimilar"), false, addSimilar, t("cloudSimilarTitle")));
    nav.appendChild(sep());
    const target = C.sel || C.nodes[0];
    nav.appendChild(el("span", "cl-label", t(C.sel ? "cloudSizeSel" : "cloudSizeFocus")));
    STEPS.forEach((s, i) => nav.appendChild(lbBtn(s, target && target.step === i, () => resize(i))));
    nav.appendChild(sep());
    nav.appendChild(el("span", "cl-count", String(C.nodes.length - 1)));
    nav.appendChild(el("span", "cl-flex"));
    if (C.sel) nav.appendChild(lbBtn(t("cloudRemove"), false, () => removeRef(C.sel), "⌫"));
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
    if (C.picker) {
      const input = $("clPicker").querySelector("input");
      input.value = C.query;
      input.focus();
    }
  }

  function addSimilar() {
    for (const it of suggestions().slice(0, 5)) addRef(it);
  }

  function setMode(m) {
    // Strang: hängt alles nur an der Mitte, wird daraus eine Kette in der Reihenfolge des Hinzufügens
    if (m === "strand" && C.nodes.slice(1).every((n) => n.parent === C.nodes[0]))
      C.nodes.forEach((n, i) => i > 1 && (n.parent = C.nodes[i - 1]));
    C.mode = m;
    relink();
    for (const n of C.nodes) {
      n.vx += (Math.random() - 0.5) * 2;
      n.vy += (Math.random() - 0.5) * 2;
    }
    save();
    renderBar();
  }

  function setGap(g) {
    C.gap = g;
    save();
    renderBar();
  }

  // Klick wählt, Ziehen wirft, Doppelklick macht ein Objekt zur Mitte
  function bindPointer(stage) {
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const n = C.nodes.find((x) => x.el === e.target.closest(".cl-ref"));
      if (!n) {
        select(null);
        if (C.picker) togglePicker();
        return;
      }
      const r = stage.getBoundingClientRect();
      C.drag = { n, dx: e.clientX - r.left - n.x, dy: e.clientY - r.top - n.y, lx: e.clientX, ly: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      const d = C.drag;
      if (!d) return;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
      if (!d.moved || d.n === C.nodes[0]) return;
      const r = stage.getBoundingClientRect();
      d.n.x = e.clientX - r.left - d.dx;
      d.n.y = e.clientY - r.top - d.dy;
      d.n.vx = (e.clientX - d.lx) * 0.8;
      d.n.vy = (e.clientY - d.ly) * 0.8;
      d.lx = e.clientX;
      d.ly = e.clientY;
    });
    stage.addEventListener("pointerup", () => {
      const d = C.drag;
      C.drag = null;
      if (d && !d.moved) select(C.sel === d.n ? null : d.n);
    });
    stage.addEventListener("pointercancel", () => (C.drag = null));
    stage.addEventListener("dblclick", (e) => {
      const n = C.nodes.find((x) => x.el === e.target.closest(".cl-ref"));
      if (n && n !== C.nodes[0]) open(n.item);
    });
  }

  // ---- Öffnen und Schließen ----

  function open(item) {
    if (!item) return;
    if (!C.root) build();
    if (C.focus) save();
    cancelAnimationFrame(C.raf);
    for (const n of C.nodes) n.el.remove();
    $("clLinks").replaceChildren();
    C.nodes = [];
    C.sel = null;
    C.focus = item;
    const stored = load()[keyOf(item)];
    C.mode = stored && MODES.includes(stored.m) ? stored.m : lastPref("cloudMode", (v) => MODES.includes(v), "cloud");
    C.gap = stored && GAPS[stored.g] ? stored.g : lastPref("cloudGap", (v) => !!GAPS[v], "mid");
    C.root.hidden = false;
    document.body.classList.add("cloud-open");
    renderBar();
    renderPicker();
    const f = makeNode(item, stored ? stored.s : 3, false);
    f.el.classList.add("focus");
    const b = bounds();
    const c = center(b);
    f.x = c.x;
    f.y = c.y;
    C.nodes.push(f);
    if (stored) {
      const map = byKey();
      for (const [k, s, p] of stored.r) {
        const it = map.get(k);
        if (it) addRef(it, { quiet: true, step: s, parent: C.nodes[p] || f });
      }
    }
    renderBar();
    if (reduce()) for (let i = 0; i < 300; i++) step();
    loop();
  }

  function close() {
    if (!C.root || C.root.hidden) return;
    save();
    cancelAnimationFrame(C.raf);
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
    if (mod) return e.key !== "q" && e.key !== "w" && e.key !== "h" && e.key !== "m";
    if (e.key === "Escape") {
      if (C.picker) togglePicker();
      else if (C.sel) select(null);
      else close();
    } else if (e.key === "w" || e.key === "W") close();
    else if (/^[1-4]$/.test(e.key)) resize(Number(e.key) - 1);
    else if (e.key === "+" || e.key === "=") resize((C.sel || C.nodes[0]).step + 1);
    else if (e.key === "-") resize((C.sel || C.nodes[0]).step - 1);
    else if (e.key === "Backspace" || e.key === "Delete") removeRef(C.sel);
    else if (e.key === "a" || e.key === "A") togglePicker();
    else if (e.key === "Tab") {
      const i = MODES.indexOf(C.mode);
      setMode(MODES[(i + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]);
    } else if (e.key === "Enter" && C.sel) open(C.sel.item);
    return true;
  }

  function init(api) {
    A = api;
  }

  window.ArchiverCloud = { init, open, close, isOpen, key };
})();
