// palette.js — Palette am ganzen Mac (system.rs). Drei Zustände:
//   Start   Active Zones als Karten, darunter der Index (übrige Zonen)
//   Zone    Objekte einer Zone, oben die Active Zones als Reiter (1–4)
//   Suche   passende Zonen als Karten, darunter passende Objekte
// Objekte zieht man heraus, z. B. in einen InDesign-Rahmen; währenddessen ist
// die Palette fast unsichtbar und durchklickbar. ↵ kopiert, ⌘↵ zeigt im Finder.

(function () {
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
  const fileSrc = (path) => TAURI.core.convertFileSrc(path);
  const { t, lang } = window.ArchiverI18n;
  const Media = window.ArchiverMedia;
  const $ = (id) => document.getElementById(id);

  document.documentElement.lang = lang;

  const HOT = 4;
  const state = {
    snap: null,
    dirty: true,
    zones: [], // geordnet wie in der App
    view: "start", // start | zone | search
    zone: null,
    sel: 0, // Index im aktuellen Fokusbereich
    area: "cards", // cards | objects (welcher Bereich die Pfeiltasten hat)
    cards: [], // sichtbare Karten (Zonen)
    objects: [], // sichtbare Objekte
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function mono(text, cls) {
    return el("span", "pal-mono" + (cls ? " " + cls : ""), text);
  }

  function pref(key, fallback) {
    try {
      const v = localStorage.getItem("archiver." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function toast(text) {
    const node = $("toast");
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 1600);
  }

  const countText = (n) => (n === 1 ? t("countImage") : t("countImages", { n }));
  const zoneName = (path) => (path === "" ? (state.snap && state.snap.name) || "Archiver" : path.split("/").join(" / "));

  // ---- Daten ----

  // Wie app.js: leere Elternordner ohne eigene Karte, Reihenfolge aus den Einstellungen
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
    if (!state.dirty && state.snap) return;
    try {
      state.snap = await invoke("snapshot");
    } catch {
      state.snap = null;
    }
    state.dirty = false;
    state.zones = state.snap ? orderZones(state.snap.zones) : [];
  }

  function itemsOf(zone) {
    const list = state.snap.items.filter((i) => i.zone === zone);
    const order = state.snap.order && state.snap.order[zone];
    if (!order || !order.length) return list;
    const pos = new Map(order.map((h, i) => [h, i]));
    const at = (item) => (pos.has(item.hash) ? pos.get(item.hash) : -1);
    return list.sort((a, b) => at(a) - at(b));
  }

  function kindOf(item) {
    if (item.quote) return "text";
    return Media.kind(item.format || item.filename);
  }

  function thumbSrc(item) {
    if (item.thumb) return fileSrc(item.thumb);
    if (kindOf(item) === "audio") return Media.audioPlaceholder();
    if (kindOf(item) !== "image") return Media.placeholder((item.format || "").toUpperCase());
    return fileSrc(item.abs);
  }

  // Suchtext eines Objekts: Name, Zone, Quelle, Notiz, erkannter Inhalt und Text
  function haystack(item) {
    return [item.filename, item.zone, item.pageTitle, item.pageUrl, item.note, item.labels, item.text, item.quote, item.title, item.artist]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const zones = state.zones.filter((z) => words.every((w) => zoneName(z.path).toLowerCase().includes(w)));
    const items = state.snap.items.filter((i) => {
      const h = haystack(i);
      return words.every((w) => h.includes(w));
    });
    return { zones, items };
  }

  // ---- Darstellung ----

  function card(zone, i, flat) {
    const node = el("article", "pal-card" + (flat ? " flat" : ""));
    const items = itemsOf(zone.path).filter((it) => kindOf(it) !== "text");
    const trio = items.length >= 3;
    const cover = el("div", "pal-cover" + (trio ? " trio" : ""));
    for (const item of items.slice(0, trio ? 3 : 1)) {
      const img = el("img");
      img.src = thumbSrc(item);
      img.loading = "lazy";
      img.draggable = false;
      cover.appendChild(img);
    }
    node.appendChild(cover);
    if (i < HOT) {
      const key = el("div", "pal-key");
      key.appendChild(mono(String(i + 1).padStart(2, "0")));
      key.appendChild(mono(t("palActive")));
      node.appendChild(key);
    }
    const body = el("div", "pal-card-body");
    body.appendChild(el("div", "pal-card-name", zoneName(zone.path)));
    body.appendChild(el("div", "pal-card-meta", zone.count ? countText(zone.count) : t("emptyShort")));
    node.appendChild(body);
    node.addEventListener("click", () => openZone(zone.path));
    return node;
  }

  function obj(item) {
    const node = el("div", "pal-obj");
    const img = el("img");
    img.src = thumbSrc(item);
    img.loading = "lazy";
    img.draggable = false;
    node.appendChild(img);
    node.title = item.filename;
    node.addEventListener("mousedown", (e) => pressObject(e, item));
    return node;
  }

  function label(text) {
    return mono(text, "pal-label");
  }

  function keys(list) {
    const foot = $("keys");
    foot.replaceChildren();
    for (const [k, text] of list) {
      const s = el("span", "pal-mono");
      s.appendChild(el("span", "pal-kbd", k));
      s.appendChild(document.createTextNode(text));
      foot.appendChild(s);
    }
    const esc = el("span", "pal-mono pal-flex");
    esc.appendChild(el("span", "pal-kbd", "esc"));
    foot.appendChild(esc);
  }

  function render() {
    const body = $("body");
    body.replaceChildren();
    state.cards = [];
    state.objects = [];
    $("crumb").hidden = state.view !== "zone";
    $("hits").textContent = "";

    if (!state.snap) {
      body.appendChild(el("div", "pal-empty", t("palNoLibrary")));
      keys([]);
      return;
    }

    if (state.view === "start") {
      const hot = state.zones.slice(0, HOT);
      const rest = state.zones.slice(HOT);
      body.appendChild(label("(" + t("hotLabel") + ") (" + hot.length + ")"));
      const row = el("div", "pal-cards");
      hot.forEach((z, i) => row.appendChild(card(z, i)));
      body.appendChild(row);
      if (rest.length) {
        body.appendChild(label(t("indexLabel") + " (" + rest.length + ")"));
        const more = el("div", "pal-cards");
        rest.forEach((z, i) => more.appendChild(card(z, HOT + i, true)));
        body.appendChild(more);
      }
      state.cards = state.zones.map((z) => z.path);
      state.area = "cards";
      $("hits").textContent = "⌥ SPACE";
      keys([["←→", t("palZone")], ["↵", t("palOpen")], ["1–4", t("palActive")]]);
    }

    if (state.view === "zone") {
      renderCrumb();
      const items = itemsOf(state.zone);
      if (!items.length) body.appendChild(el("div", "pal-empty", t("palZoneEmpty")));
      const grid = el("div", "pal-grid");
      for (const item of items) grid.appendChild(obj(item));
      body.appendChild(grid);
      state.objects = items;
      state.area = "objects";
      keys([["↵", t("palCopy")], ["⌘↵", t("palFinder")], ["1–4", t("palZone")], ["⌫", t("palBack")]]);
    }

    if (state.view === "search") {
      const { zones, items } = search($("q").value);
      $("hits").textContent = zones.length
        ? t("palHitsZones", { n: items.length, z: zones.length })
        : t("palHits", { n: items.length });
      if (zones.length) {
        body.appendChild(label("(" + t("palZones") + ")"));
        const row = el("div", "pal-cards");
        for (const z of zones.slice(0, 8)) row.appendChild(card(z, state.zones.indexOf(z), true));
        body.appendChild(row);
      }
      if (items.length) {
        body.appendChild(label("(" + t("palObjects") + ")"));
        const grid = el("div", "pal-grid");
        for (const item of items.slice(0, 120)) grid.appendChild(obj(item));
        body.appendChild(grid);
      }
      if (!zones.length && !items.length) body.appendChild(el("div", "pal-empty", t("palEmpty")));
      state.cards = zones.slice(0, 8).map((z) => z.path);
      state.objects = items.slice(0, 120);
      if (state.area === "cards" && !state.cards.length) state.area = "objects";
      if (state.area === "objects" && !state.objects.length) state.area = "cards";
      keys([["↵", t("palCopy")], ["⌘↵", t("palFinder")], ["tab", t("palSwitch")]]);
    }
    markSel();
  }

  function renderCrumb() {
    const crumb = $("crumb");
    crumb.replaceChildren();
    const head = el("div", "pal-crumb-head");
    const back = mono("← " + t("palZones"), "pal-crumb-back");
    back.addEventListener("click", goStart);
    head.appendChild(back);
    head.appendChild(el("span", "pal-crumb-name", zoneName(state.zone)));
    const zone = state.zones.find((z) => z.path === state.zone);
    const i = state.zones.indexOf(zone);
    let meta = zone ? countText(zone.count) : "";
    if (i >= 0 && i < HOT) meta += " · " + t("palActive") + " " + String(i + 1).padStart(2, "0");
    head.appendChild(el("span", "pal-crumb-meta", meta));
    crumb.appendChild(head);
    const tabs = el("div", "pal-tabs");
    state.zones.slice(0, HOT).forEach((z, n) => {
      const tab = el("div", "pal-tab" + (z.path === state.zone ? " on" : ""));
      tab.appendChild(mono(String(n + 1).padStart(2, "0")));
      tab.appendChild(document.createTextNode(zoneName(z.path)));
      tab.addEventListener("click", () => openZone(z.path));
      tabs.appendChild(tab);
    });
    crumb.appendChild(tabs);
  }

  function markSel() {
    for (const n of document.querySelectorAll(".sel")) n.classList.remove("sel");
    const nodes = document.querySelectorAll(state.area === "cards" ? ".pal-card" : ".pal-obj");
    if (!nodes.length) return;
    state.sel = Math.max(0, Math.min(state.sel, nodes.length - 1));
    const node = nodes[state.sel];
    node.classList.add("sel");
    node.scrollIntoView({ block: "nearest" });
  }

  // ---- Wechsel ----

  function goStart() {
    state.view = "start";
    state.zone = null;
    state.sel = 0;
    $("q").value = "";
    render();
    $("q").focus();
  }

  function openZone(path) {
    state.view = "zone";
    state.zone = path;
    state.sel = 0;
    $("q").value = "";
    render();
    $("q").focus();
  }

  function onInput() {
    const q = $("q").value.trim();
    if (!q) return goStart();
    state.view = "search";
    state.sel = 0;
    state.area = "cards";
    render();
  }

  // Spalten im aktuellen Bereich (für ↑↓)
  function columns() {
    if (state.area === "objects") return 6;
    return 4;
  }

  function move(dx, dy) {
    const total = state.area === "cards" ? state.cards.length : state.objects.length;
    if (!total) return;
    let next = state.sel + dx + dy * columns();
    if (state.view === "search" && dy) {
      // ↓ aus den Zonen in die Objekte, ↑ zurück
      if (next >= total && state.area === "cards" && state.objects.length) {
        state.area = "objects";
        state.sel = 0;
        return markSel();
      }
      if (next < 0 && state.area === "objects" && state.cards.length) {
        state.area = "cards";
        state.sel = 0;
        return markSel();
      }
    }
    state.sel = Math.max(0, Math.min(total - 1, next));
    markSel();
  }

  function selected() {
    if (state.area === "cards") return { zone: state.cards[state.sel] };
    return { item: state.objects[state.sel] };
  }

  async function copyItem(item) {
    try {
      await invoke("copy_images", { paths: [item.abs], text: item.quote || null });
      toast(t("palCopied"));
    } catch (e) {
      toast(String(e));
    }
  }

  function hide() {
    invoke("palette_hide").catch(() => {});
  }

  function onKey(e) {
    const q = $("q").value;
    if (e.key === "Escape") {
      e.preventDefault();
      if (state.view !== "start") return goStart();
      return hide();
    }
    if (e.key === "Backspace" && !q && state.view === "zone") {
      e.preventDefault();
      return goStart();
    }
    // 1–4: Active Zone öffnen, solange nichts getippt ist
    if (!q && /^[1-4]$/.test(e.key) && !e.metaKey && !e.altKey) {
      const zone = state.zones[Number(e.key) - 1];
      if (zone) {
        e.preventDefault();
        return openZone(zone.path);
      }
    }
    if (e.key === "Tab" && state.view === "search") {
      e.preventDefault();
      const other = state.area === "cards" ? "objects" : "cards";
      if ((other === "cards" ? state.cards : state.objects).length) {
        state.area = other;
        state.sel = 0;
        markSel();
      }
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      // ←→ im Suchfeld bewegen den Cursor, solange Text drin ist
      if (q && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      e.preventDefault();
      return move(...arrows[e.key]);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const s = selected();
      if (s.zone != null) return openZone(s.zone);
      if (!s.item) return;
      if (e.metaKey) return invoke("reveal", { path: s.item.abs }).then(hide).catch(() => {});
      return copyItem(s.item);
    }
  }

  // ---- Herausziehen ----
  // Wie in der App über das Drag-Plugin (echte Datei, InDesign verknüpft sie).
  // Ab dem Losziehen ist die Palette fast unsichtbar und durchklickbar.

  function pressObject(e, item) {
    if (e.button !== 0) return;
    const index = state.objects.indexOf(item);
    if (index >= 0) {
      state.area = "objects";
      state.sel = index;
      markSel();
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    const onMove = (m) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      done();
      startDrag(item);
    };
    const done = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", done);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", done);
  }

  async function startDrag(item) {
    const channel = new TAURI.core.Channel();
    channel.onmessage = () => invoke("palette_ghost", { on: false }).catch(() => {});
    const icon =
      (await invoke("drag_icon", { hash: item.hash, path: item.thumb || item.abs, color: null }).catch(() => null)) ||
      item.thumb ||
      item.abs;
    invoke("palette_ghost", { on: true }).catch(() => {});
    invoke("plugin:drag|start_drag", { item: [item.abs], image: icon, onEvent: channel }).catch(() =>
      invoke("palette_ghost", { on: false }).catch(() => {})
    );
  }

  // ---- Start ----

  $("q").placeholder = t("palSearch");
  $("q").addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);

  TAURI.event.listen("library-changed", () => (state.dirty = true));
  TAURI.event.listen("palette-open", async () => {
    await load();
    goStart();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "archiver.zoneOrder") state.dirty = true;
  });

  load().then(goStart);
})();
