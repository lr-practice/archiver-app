// dropbar.js — Active-Zones-Leiste am ganzen Mac (system.rs blendet sie ein,
// sobald irgendwo Dateien gezogen werden und ⌥ gehalten wird). Loslassen auf
// einer Zone sichert die Dateien dort: Dateien von außen werden importiert,
// Dateien aus der eigenen Bibliothek verschoben.
//
// 0.40.21: Die Karten stehen schon fertig im (unsichtbaren) Fenster, bevor
// gezogen wird. Beim Einblenden wird nichts mehr geladen; vorher kam die Leiste
// leer oder spät, und ein Drop auf die leere Leiste sicherte nichts.

(function () {
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
  const { t, lang } = window.ArchiverI18n;
  const $ = (id) => document.getElementById(id);
  const HOT = 4;

  document.documentElement.lang = lang;

  const state = { snap: null, dirty: true, zones: [], target: null, visible: false };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function pref(key, fallback) {
    try {
      const v = localStorage.getItem("archiver." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  const zoneName = (path) => (path === "" ? (state.snap && state.snap.name) || "Archiver" : path.split("/").join(" / "));

  // Reihenfolge wie in der App: die ersten vier sind die Active Zones
  function orderZones(zones) {
    zones = zones.filter((z) => z.count > 0 || !zones.some((o) => o.path.startsWith(z.path + "/")));
    const order = pref("zoneOrder", []);
    if (!order.length) return zones;
    const rank = (z) => {
      let i = order.indexOf(z.path);
      if (i < 0 && z.path) i = order.findIndex((p) => p.startsWith(z.path + "/"));
      return i < 0 ? order.length : i;
    };
    return zones.map((z, i) => [z, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([z]) => z);
  }

  async function load() {
    // Ecken wie in der App (Einstellungen › Darstellung), Werte aus palette.css
    const radius = pref("radius", "soft");
    if (radius && radius !== "round") document.documentElement.dataset.radius = radius;
    else delete document.documentElement.dataset.radius;
    if (!state.dirty && state.snap) return;
    try {
      state.snap = await invoke("snapshot");
    } catch {
      state.snap = null;
    }
    state.dirty = false;
    state.zones = state.snap ? orderZones(state.snap.zones).slice(0, HOT) : [];
  }

  function render() {
    const bar = $("bar");
    bar.classList.remove("leaving");
    bar.style.removeProperty("--leave-delay");
    bar.replaceChildren(
      ...state.zones.map((zone, i) => {
        const c = el("div", "db-hot");
        c.dataset.zone = zone.path;
        c.appendChild(el("span", "pal-mono pal-dim", String(i + 1).padStart(2, "0")));
        const text = el("div");
        text.appendChild(el("div", "db-name", zoneName(zone.path)));
        text.appendChild(el("div", "db-hint", t("hotRelease")));
        c.appendChild(text);
        return c;
      })
    );
  }

  // Karte unter dem Zeiger; in den Lücken und am Rand die Karte in derselben Spalte
  function cardAt(pos) {
    if (!pos) return null;
    const ratio = window.devicePixelRatio || 1;
    const x = pos.x / ratio;
    const hit = document.elementFromPoint(x, pos.y / ratio);
    const card = hit ? hit.closest(".db-hot") : null;
    if (card) return card;
    const cards = [...document.querySelectorAll(".db-hot")];
    let best = null;
    let dist = Infinity;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < dist) {
        dist = d;
        best = c;
      }
    }
    return best;
  }

  function mark(card) {
    for (const n of document.querySelectorAll(".drop-active")) n.classList.remove("drop-active");
    if (card) card.classList.add("drop-active");
    state.target = card;
  }

  const hold = (ms) => invoke("dropbar_hold", { ms }).catch(() => {});

  // Ablegen (4.13, Labor › Ablegen): wie die Karte das Ankommen zeigt und wie
  // schnell die Leiste danach geht. Ab Werk Miniatur und schnell.
  const DROP_STYLES = ["mini", "check", "ring", "count", "name", "after", "glow"];
  function dropLab() {
    const l = pref("lab", null) || {};
    return {
      style: DROP_STYLES.includes(l.drop) ? l.drop : "mini",
      calm: l.dropLeave === "calm",
    };
  }
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SHEET = "cubic-bezier(0.2, 0.7, 0.2, 1)";
  const fileName = (p) => p.split("/").pop();

  // Bild der ersten Datei, sobald es gezeigt werden darf (sonst null)
  async function preview(paths) {
    for (const p of paths.slice(0, 1)) {
      try {
        if (!(await invoke("dropbar_preview", { path: p }))) return null;
        const img = new Image();
        img.src = TAURI.core.convertFileSrc(p);
        await Promise.race([img.decode(), new Promise((_, no) => setTimeout(no, 250))]);
        return img;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Miniatur: das Bild fliegt vom Zeiger in die Ecke der Karte und bleibt dort
  function stamp(card, img, pos, more) {
    const s = el("div", "db-stamp");
    s.appendChild(img);
    if (more > 0) s.appendChild(el("span", "pal-mono db-more", "+" + more));
    card.appendChild(s);
    if (!pos || reduced()) return;
    const ratio = window.devicePixelRatio || 1;
    const r = img.getBoundingClientRect();
    const dx = pos.x / ratio - (r.left + r.width / 2);
    const dy = pos.y / ratio - (r.top + r.height / 2);
    img.animate([{ transform: `translate(${dx}px, ${dy}px) scale(2.4)` }, { transform: "none" }], {
      duration: 280,
      easing: SHEET,
    });
  }

  // Zeile rollt: alter Text hoch, neuer von unten (Nummer, Name)
  function roll(node, text, mono) {
    const from = node.dataset.shown || node.textContent;
    node.dataset.shown = text;
    if (reduced()) {
      node.textContent = text;
      return;
    }
    const h = node.style.height ? parseFloat(node.style.height) : node.getBoundingClientRect().height;
    const col = el("span", "db-roll");
    col.append(el("span", null, from), el("span", mono ? "pal-mono" : null, text));
    node.replaceChildren(col);
    node.style.height = h + "px";
    col.animate([{ transform: "none" }, { transform: `translateY(${-h}px)` }], {
      duration: 280,
      easing: SHEET,
      fill: "forwards",
    });
  }

  function drawRing(card) {
    const r = card.getBoundingClientRect();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "db-ring");
    const rect = document.createElementNS(ns, "rect");
    const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
    for (const [k, v] of Object.entries({ x: 0.5, y: 0.5, width: r.width + 5, height: r.height + 5, rx: radius + 3 })) {
      rect.setAttribute(k, v);
    }
    rect.setAttribute("pathLength", "1");
    svg.appendChild(rect);
    card.appendChild(svg);
    if (!reduced()) {
      rect.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 280, easing: SHEET, fill: "both" });
    }
  }

  function leave(calm) {
    hold(calm ? 1600 : 700);
    const bar = $("bar");
    bar.style.setProperty("--leave-delay", calm ? "1.2s" : "0.35s");
    bar.classList.add("leaving");
  }

  // „Gesichert“ erst, wenn es wirklich gesichert ist (0.31.0). Bis dahin bleibt
  // die Leiste stehen; ein Fehler bleibt lesbar stehen, bevor sie ausblendet.
  async function drop(paths, card, pos) {
    mark(null);
    if (!card || !paths.length || !state.snap) return;
    const zone = card.dataset.zone;
    const hint = card.querySelector(".db-hint");
    const name = card.querySelector(".db-name");
    const num = card.querySelector(".pal-mono");
    const { style, calm } = dropLab();
    hold(60000);
    const t0 = Date.now();
    card.classList.add("busy", "db-s-" + style);
    hint.textContent = t("dropBusy");
    // Bild zuerst greifen: Eigene Dateien werden gleich verschoben
    const img = style === "mini" || style === "after" ? await preview(paths) : null;
    if (img && style === "mini") stamp(card, img, pos, paths.length - 1);
    if (img && style === "after") {
      img.className = "db-after";
      card.prepend(img);
    }
    if (style === "name") roll(name, paths.length > 1 ? fileName(paths[0]) + " +" + (paths.length - 1) : fileName(paths[0]), true);
    const root = state.snap.root + "/";
    const own = paths.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length));
    const foreign = paths.filter((p) => !p.startsWith(root));
    try {
      if (own.length) await invoke("move_items", { paths: own, zone });
      if (foreign.length) await invoke("import_files", { paths: foreign, zone });
      card.classList.replace("busy", "landed");
      hint.textContent = t("dropSaved", { zone: zoneName(zone) });
      if (style === "check") {
        hint.prepend(el("span", "db-check"));
      }
      if (style === "ring") drawRing(card);
      if (style === "count") roll(num, "+" + paths.length, true);
      if (style === "name") {
        // den Dateinamen lesbar stehen lassen, auch wenn das Sichern schnell war
        await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))));
        roll(name, zoneName(zone));
      }
      leave(calm);
    } catch (e) {
      invoke("log_error", { area: "dropbar", msg: String(e) }).catch(() => {});
      card.classList.replace("busy", "failed");
      card.querySelector(".db-stamp")?.remove();
      hint.textContent = t("dropFailed", { msg: String(e) });
      hold(3000);
      setTimeout(() => $("bar").classList.add("leaving"), 2500);
    }
  }

  TAURI.webview.getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") return mark(cardAt(p.position));
    if (p.type === "leave") return mark(null);
    if (p.type === "drop") return drop(p.paths || [], cardAt(p.position) || state.target, p.position);
  });

  // Zonen im Hintergrund nachladen, solange die Leiste nicht zu sehen ist
  let refreshTimer = 0;
  function stale() {
    state.dirty = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // steht die Leiste noch (Drop läuft, Bestätigung), später noch einmal
      if (state.visible || document.querySelector(".busy, .landed, .failed")) return stale();
      load().then(() => !state.visible && render());
    }, 400);
  }

  TAURI.event.listen("library-changed", stale);
  TAURI.event.listen("library-switched", stale);
  TAURI.event.listen("dropbar-show", () => {
    state.visible = true;
    // Stand von eben zeigen; nur wenn noch nie geladen wurde, jetzt laden
    // (render baut die Karten neu, ihr Einblenden läuft damit jedes Mal)
    if (!state.snap) load().then(render);
    else render();
  });
  TAURI.event.listen("dropbar-release", () => {
    // ohne Drop sofort weg
    if (!document.querySelector(".landed, .busy, .failed")) {
      $("bar").style.setProperty("--leave-delay", "0s");
      $("bar").classList.add("leaving");
    }
    // nach dem Ausblenden den neuen Stand vorbereiten (der Drop hat Zonen gefüllt)
    setTimeout(() => {
      state.visible = false;
      if (state.dirty) stale();
    }, 1500);
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "archiver.zoneOrder" || e.key === "archiver.radius") stale();
  });

  load().then(render);
})();
