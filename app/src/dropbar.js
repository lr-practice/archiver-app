// dropbar.js — Active-Zones-Leiste am ganzen Mac (system.rs blendet sie ein,
// sobald irgendwo Dateien gezogen werden). Loslassen auf einer Zone sichert die
// Dateien dort: Dateien von außen werden importiert, Dateien aus der eigenen
// Bibliothek verschoben.

(function () {
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
  const { t, lang } = window.ArchiverI18n;
  const $ = (id) => document.getElementById(id);
  const HOT = 4;

  document.documentElement.lang = lang;

  const state = { snap: null, dirty: true, zones: [], target: null };

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
    // Ecken wie in der App (Einstellungen › Aussehen), Werte aus palette.css
    const radius = pref("radius", "round");
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

  function cardAt(pos) {
    if (!pos) return null;
    const ratio = window.devicePixelRatio || 1;
    const hit = document.elementFromPoint(pos.x / ratio, pos.y / ratio);
    return hit ? hit.closest(".db-hot") : null;
  }

  function mark(card) {
    for (const n of document.querySelectorAll(".drop-active")) n.classList.remove("drop-active");
    if (card) card.classList.add("drop-active");
    state.target = card;
  }

  async function drop(paths, card) {
    mark(null);
    if (!card || !paths.length || !state.snap) return;
    const zone = card.dataset.zone;
    card.classList.add("landed");
    card.querySelector(".db-hint").textContent = t("dropSaved", { zone: zoneName(zone) });
    $("bar").classList.add("leaving");
    const root = state.snap.root + "/";
    const own = paths.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length));
    const foreign = paths.filter((p) => !p.startsWith(root));
    try {
      if (own.length) await invoke("move_items", { paths: own, zone });
      if (foreign.length) await invoke("import_files", { paths: foreign, zone });
    } catch (e) {
      console.error(e);
    }
  }

  TAURI.webview.getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") return mark(cardAt(p.position));
    if (p.type === "leave") return mark(null);
    if (p.type === "drop") return drop(p.paths || [], cardAt(p.position) || state.target);
  });

  TAURI.event.listen("library-changed", () => (state.dirty = true));
  TAURI.event.listen("library-switched", () => (state.dirty = true));
  TAURI.event.listen("dropbar-show", async () => {
    await load();
    render();
  });
  TAURI.event.listen("dropbar-release", () => {
    if (!document.querySelector(".landed")) $("bar").classList.add("leaving");
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "archiver.zoneOrder") state.dirty = true;
  });

  load().then(render);
})();
