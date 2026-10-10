// viewer.js — Betrachter: ein Bild aus dem Finder, Blättern im Ordner,
// Zoom, Info, Sichern in eine Zone und der Weg in die App.

(function () {
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
  const fileSrc = (path) => TAURI.core.convertFileSrc(path);
  const { t, lang } = window.ArchiverI18n;
  const $ = (id) => document.getElementById(id);
  const Media = window.ArchiverMedia;

  document.documentElement.lang = lang;
  if (/Mac/.test(navigator.userAgent)) document.documentElement.classList.add("mac");

  const state = {
    files: [],
    index: 0,
    zones: null,
    library: null,
    rel: null, // relativer Pfad in der Bibliothek, wenn das Bild schon drin ist
    rootName: "Archiver",
    infoOpen: false,
  };

  const baseName = (p) => p.split(/[\\/]/).pop();
  const dirName = (p) => p.split(/[\\/]/).slice(0, -1).join("/");
  const current = () => state.files[state.index];
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function zoneLabel(path) {
    return path === "" ? state.rootName : path.split("/").join(" / ");
  }

  function toast(text) {
    const node = $("toast");
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
  }

  // ---- Zoom ----
  // Das Bild liegt absolut im Fenster und wird per transform skaliert und
  // verschoben. „Einpassen“ nutzt die Fläche zwischen Titelleiste und Leiste.

  const PAD = { top: 44, bottom: 84, side: 32 };
  const view = { w: 0, h: 0, scale: 1, x: 0, y: 0, fitted: true };

  function area() {
    const right = state.infoOpen ? $("info").offsetWidth : 0;
    return { width: window.innerWidth - right, height: window.innerHeight };
  }

  function fitBox() {
    const a = area();
    return {
      left: PAD.side,
      top: PAD.top,
      width: Math.max(1, a.width - PAD.side * 2),
      height: Math.max(1, a.height - PAD.top - PAD.bottom),
    };
  }

  function fitScale() {
    if (!view.w || !view.h) return 1;
    const box = fitBox();
    return Math.min(box.width / view.w, box.height / view.h, 1);
  }

  function apply(animate) {
    const img = $("img");
    img.classList.toggle("anim", !!animate);
    img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    $("stage").classList.toggle("zoomed", !view.fitted);
    $("zoom").textContent = "(" + (view.fitted ? t("viewerFit") : `${Math.round(view.scale * 100)} %`) + ")";
  }

  // Kleiner als die Fläche: mittig. Größer: Ränder nicht ins Fenster ziehen.
  function clamp() {
    const a = area();
    const box = fitBox();
    const w = view.w * view.scale;
    const h = view.h * view.scale;
    view.x = w <= a.width ? box.left + (box.width - w) / 2 : Math.min(0, Math.max(a.width - w, view.x));
    view.y = h <= a.height ? box.top + (box.height - h) / 2 : Math.min(0, Math.max(a.height - h, view.y));
  }

  function fit(animate) {
    view.scale = fitScale();
    view.fitted = true;
    clamp();
    apply(animate);
  }

  // Rauszoomen geht bis auf ein Fünftel der eingepassten Größe;
  // nahe „Einpassen“ rastet der Zoom dort ein.
  function zoomAt(scale, cx, cy, animate) {
    const fitS = fitScale();
    const next = Math.min(16, Math.max(fitS * 0.2, scale));
    if (Math.abs(next - fitS) / fitS < 0.03) return fit(animate);
    view.x = cx - (cx - view.x) * (next / view.scale);
    view.y = cy - (cy - view.y) * (next / view.scale);
    view.scale = next;
    view.fitted = false;
    clamp();
    apply(animate);
  }

  function center() {
    const a = area();
    return [a.width / 2, a.height / 2];
  }

  // Einpassen ↔ Originalgröße (bei kleinen Bildern doppelt)
  function toggleZoom(cx, cy) {
    if (mode === "pdf" && pdf) return pdf.setZoom(pdf.fitted() ? 2 : 1);
    if (mode === "video" && vzoom) return vzoom.toggle(cx, cy);
    if (mode !== "image") return;
    if (!view.fitted) return fit(true);
    const target = fitScale() >= 1 ? 2 : 1;
    zoomAt(target, cx ?? center()[0], cy ?? center()[1], true);
  }

  // ---- Anzeige ----

  // ---- PDF und Video ----

  let mode = "image";
  let pdf = null;

  function pdfChanged(v) {
    const n = v.count();
    const page = n ? t("pdfPageOf", { n: v.current(), total: n }) : "PDF";
    $("zoom").textContent = `(${page} · ${v.fitted() ? t("viewerFit") : Math.round(v.zoom * 100) + " %"})`;
    if (state.infoOpen && n && !state.pages) {
      state.pages = n;
      renderInfo();
    }
  }

  // Eigener Player für Audio und Video: obere Reihe der Navigationsleiste
  let player = null;
  function setPlayer(media) {
    if (player) player.destroy();
    player = media ? Media.player(media) : null;
    if (player) $("nav").prepend(player.row);
    document.body.classList.toggle("has-player", !!player);
  }

  // Video: Zoom-Knopf zeigt „Einpassen“ bzw. die Stufe, wie bei Bildern
  let vzoom = null;
  function videoZoomed(scale) {
    $("zoom").textContent = "(" + (scale > 1 ? `${Math.round(scale * 100)} %` : t("viewerFit")) + ")";
  }

  // PDF oder Video statt des Bildes zeigen; false = Bild
  function showMedia(path) {
    const k = Media.kind(path);
    const box = $("media");
    mode = k;
    vzoom = null;
    setPlayer(null);
    document.body.classList.toggle("media", k !== "image");
    if (pdf) pdf.destroy();
    pdf = null;
    box.replaceChildren();
    state.pages = null;
    state.duration = null;
    if (k === "image") {
      box.hidden = true;
      $("img").hidden = false;
      return false;
    }
    $("img").hidden = true;
    $("img").removeAttribute("src");
    box.hidden = false;
    view.w = view.h = 0;
    if (k === "audio") {
      const wrap = Media.audioEl(fileSrc(path), null, baseName(path), "");
      const a = wrap.querySelector("audio");
      a.addEventListener("loadedmetadata", () => {
        state.duration = a.duration;
        if (state.infoOpen) renderInfo();
      });
      box.appendChild(wrap);
      setPlayer(a);
      $("zoom").textContent = "";
    } else if (k === "video") {
      const v = Media.videoEl(fileSrc(path));
      v.addEventListener("loadedmetadata", () => {
        view.w = v.videoWidth;
        view.h = v.videoHeight;
        state.duration = v.duration;
        if (state.infoOpen) renderInfo();
      });
      box.appendChild(v);
      vzoom = Media.zoomable(v, videoZoomed);
      setPlayer(v);
      videoZoomed(1);
    } else {
      pdf = new Media.PdfView(box, { padTop: PAD.top, padBottom: PAD.bottom, onChange: pdfChanged });
      pdf.open(fileSrc(path)).catch((e) => toast(t("error", { msg: String((e && e.message) || e) })));
      pdfChanged(pdf);
    }
    return true;
  }

  function show() {
    const path = current();
    if (!path) return;
    const img = $("img");
    img.classList.add("loading");
    img.onload = () => {
      if (current() !== path) return;
      view.w = img.naturalWidth;
      view.h = img.naturalHeight;
      img.style.width = view.w + "px";
      img.style.height = view.h + "px";
      // Beim Blättern bleibt die Zoomstufe; das neue Bild steht mittig.
      if (view.fitted) fit(false);
      else {
        const [cx, cy] = center();
        view.x = cx - (view.w * view.scale) / 2;
        view.y = cy - (view.h * view.scale) / 2;
        clamp();
        apply(false);
      }
      img.classList.remove("loading");
      if (state.infoOpen) renderInfo();
    };
    if (!showMedia(path)) img.src = fileSrc(path);
    $("name").textContent = baseName(path);
    $("name").title = baseName(path);
    document.title = baseName(path);
    renderCount();
    closeZones();
    state.rel = null;
    renderAction();
    if (state.infoOpen) renderInfo();
    invoke("viewer_lookup", { path }).then((rel) => {
      if (current() !== path) return;
      state.rel = rel;
      renderAction();
      if (state.infoOpen) renderInfo();
    });
    preload();
  }

  function renderCount() {
    const many = state.files.length > 1;
    $("browse").hidden = !many;
    $("count").textContent = many ? `${state.index + 1} / ${state.files.length}` : "";
  }

  // Nachbarn vorladen, damit das Blättern ohne Wartezeit läuft
  function preload() {
    const n = state.files.length;
    if (n < 2) return;
    for (const d of [1, -1]) {
      const f = state.files[(state.index + d + n) % n];
      if (Media.kind(f) === "image") new Image().src = fileSrc(f);
    }
  }

  // „● Archiver“: grau = noch nicht in der Bibliothek (Klick: Ablegen in),
  // blau = schon abgelegt (Klick: in der App zeigen).
  function renderAction() {
    const btn = $("action");
    btn.replaceChildren(el("span", "v-dot"), document.createTextNode("Archiver"));
    btn.classList.toggle("saved", state.rel != null);
    btn.title = state.rel != null ? t("viewerShow") : state.library ? t("dropBar") : t("viewerApp");
  }

  function step(dir) {
    if (state.files.length < 2) return;
    state.index = (state.index + dir + state.files.length) % state.files.length;
    show();
  }

  // ---- Info ----

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1).replace(".", lang === "de" ? "," : ".")} MB`;
  }

  function shortPath(path) {
    return String(path || "").replace(/^\/(Users|home)\/[^/]+/, "~");
  }

  function row(label, value) {
    const r = el("div", "v-row");
    r.appendChild(el("span", "v-row-label", label));
    const v = el("span", "v-row-value");
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value;
    r.appendChild(v);
    return r;
  }

  async function renderInfo() {
    const path = current();
    const box = $("info");
    if (!path) return;
    let file = null;
    try {
      file = await invoke("viewer_file", { path });
    } catch (e) {}
    if (current() !== path || !state.infoOpen) return;
    const ext = (path.split(".").pop() || "").toUpperCase();

    const inner = el("div", "v-info-inner");
    const head = el("div", "v-info-head");
    head.appendChild(el("span", null, baseName(path) + " "));
    const lead = [mode === "pdf" ? "" : view.w ? `${view.w} × ${view.h} px` : "", file ? formatBytes(file.bytes) : ""].filter(Boolean).join(", ");
    if (lead) head.appendChild(el("span", "lead", lead + "."));
    inner.appendChild(head);

    const fileBlock = el("section", "v-block");
    fileBlock.appendChild(el("div", "v-block-title", t("viewerFile")));
    if (mode === "pdf" && pdf && pdf.count()) fileBlock.appendChild(row(t("pages"), String(pdf.count())));
    if ((mode === "video" || mode === "audio") && state.duration) fileBlock.appendChild(row(t("duration"), Media.duration(state.duration)));
    if (view.w && mode !== "pdf") fileBlock.appendChild(row(t("viewerSize"), `${view.w} × ${view.h} px`));
    if (file) fileBlock.appendChild(row(t("viewerBytes"), formatBytes(file.bytes)));
    fileBlock.appendChild(row(t("viewerFormat"), ext === "JPG" ? "JPEG" : ext));
    if (file && file.modified)
      fileBlock.appendChild(
        row(
          t("viewerModified"),
          new Date(file.modified).toLocaleString(lang, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
        )
      );
    fileBlock.appendChild(row(t("viewerFolder"), shortPath(dirName(path))));
    inner.appendChild(fileBlock);

    if (state.library) {
      const lib = el("section", "v-block");
      lib.appendChild(el("div", "v-block-title", "Archiver"));
      const zone = state.rel != null ? state.rel.split("/").slice(0, -1).join("/") : null;
      lib.appendChild(row(t("viewerInLibrary"), zone != null ? zoneLabel(zone) : t("viewerNotInLibrary")));
      inner.appendChild(lib);
    }

    const reveal = el("button", "v-link", t("viewerReveal"));
    reveal.type = "button";
    reveal.addEventListener("click", () => invoke("reveal", { path }));
    inner.appendChild(reveal);

    box.replaceChildren(inner);
  }

  function toggleInfo() {
    state.infoOpen = !state.infoOpen;
    document.body.classList.toggle("info-open", state.infoOpen);
    $("infoBtn").classList.toggle("active", state.infoOpen);
    if (state.infoOpen) renderInfo();
    if (mode !== "image") return;
    if (view.fitted) fit(true);
    else {
      clamp();
      apply(true);
    }
  }

  // ---- Zonen ----
  // Wie in der App: beim Ziehen (oder Klick auf „In Archiver sichern“)
  // klappt über der Leiste „Ablegen in“ mit allen Zonen auf.

  // Eckenrundung wie in der App (Einstellungen › Anzeige › Radien)
  {
    const r = pref("radius", "round");
    if (r !== "round") document.documentElement.dataset.radius = r;
  }

  function pref(key, fallback) {
    try {
      const v = localStorage.getItem("archiver." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  // Gleiche Auswahl und Reihenfolge wie in der App (Einstellungen › Zonen)
  function arrange(zones) {
    zones = zones.filter((z) => z.count > 0 || !zones.some((o) => o.path.startsWith(z.path + "/")));
    const order = pref("zoneOrder", []);
    const rank = (z) => {
      const i = order.indexOf(z.path);
      return i < 0 ? order.length : i;
    };
    return zones.map((z, i) => [z, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([z]) => z);
  }

  async function ensureZones() {
    if (!state.zones) state.zones = arrange(await invoke("viewer_zones").catch(() => []));
    return state.zones;
  }

  function zoneNameEl(path) {
    const name = el("span", "v-zone-name");
    if (path.includes("/")) {
      const parts = path.split("/");
      name.appendChild(el("span", "parent", parts.slice(0, -1).join(" / ") + " / "));
      name.appendChild(document.createTextNode(parts[parts.length - 1]));
    } else name.textContent = zoneLabel(path);
    return name;
  }

  async function openZones() {
    const zones = await ensureZones();
    const bar = $("zones");
    const chips = zones.map((zone, i) => {
      const c = el("button", "v-drop-chip");
      c.type = "button";
      c.dataset.zone = zone.path;
      if (i < 4) c.appendChild(el("span", "v-drop-key", String(i + 1)));
      c.appendChild(zoneNameEl(zone.path));
      c.addEventListener("click", () => saveTo([current()], zone.path));
      return c;
    });
    bar.replaceChildren(el("span", "v-mono", t("dropBar")), ...chips);
    bar.hidden = false;
    $("action").classList.add("active");
  }

  function closeZones() {
    $("zones").hidden = true;
    $("action").classList.remove("active");
    clearDropUi();
  }

  function clearDropUi() {
    for (const n of document.querySelectorAll(".drop-active")) n.classList.remove("drop-active");
  }

  async function saveTo(paths, zone) {
    closeZones();
    const shown = current();
    try {
      for (const path of paths) {
        const rel = await invoke("viewer_save", { path, zone });
        if (path === shown && current() === shown) state.rel = rel;
      }
      state.zones = null;
      renderAction();
      if (state.infoOpen) renderInfo();
      toast(t("viewerSaved", { zone: zoneLabel(zone) }));
    } catch (e) {
      toast(t("error", { msg: String(e) }));
    }
  }

  function action() {
    if (state.rel != null || !state.library) return invoke("show_in_app", { path: state.rel });
    if ($("zones").hidden) openZones();
    else closeZones();
  }

  // Bild aus dem Fenster ziehen: echtes Ziehen (in Finder, Figma …) und
  // gleichzeitig Ablegen auf einer Zone der Leiste.
  async function startNativeDrag() {
    const path = current();
    if (!path) return;
    if (state.library) openZones();
    const channel = new TAURI.core.Channel();
    channel.onmessage = () => closeZones();
    const icon = (await invoke("viewer_drag_icon", { path }).catch(() => null)) || placeholderIcon();
    invoke("plugin:drag|start_drag", { item: [path], image: icon, onEvent: channel }).catch(() => closeZones());
  }

  function placeholderIcon() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#3a3a3a";
    g.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/png");
  }

  let dragPaths = [];
  function onDragDrop(event) {
    const p = event.payload;
    if (!state.library) return;
    if (p.type === "leave") {
      dragPaths = [];
      return clearDropUi();
    }
    if (p.type === "enter" && $("zones").hidden) openZones();
    if (p.paths) dragPaths = p.paths;
    // macOS meldet die Position schon in Punkten, andere Systeme in Pixeln
    const ratio = document.documentElement.classList.contains("mac") ? 1 : window.devicePixelRatio || 1;
    const hit = p.position ? document.elementFromPoint(p.position.x / ratio, p.position.y / ratio) : null;
    const target = hit ? hit.closest("[data-zone]") : null;
    if (p.type === "enter" || p.type === "over") {
      clearDropUi();
      if (target) target.classList.add("drop-active");
      return;
    }
    if (p.type === "drop") {
      const paths = dragPaths;
      dragPaths = [];
      if (target && paths.length) saveTo(paths, target.dataset.zone);
      else closeZones();
    }
  }

  // ---- Laden ----
  // Erst das angeklickte Bild, dann im Hintergrund der Ordner.

  async function load(path) {
    const s = await invoke("viewer_state");
    const target = path || s.path;
    if (!target) return;
    state.library = s.library;
    state.rootName = s.library ? baseName(s.library) : "Archiver";
    state.zones = null;
    state.files = [target];
    state.index = 0;
    show();
    const sib = await invoke("viewer_siblings", { path: target }).catch(() => null);
    if (!sib || current() !== target || !sib.current) return;
    const files = sib.files.slice().sort((a, b) => collator.compare(baseName(a), baseName(b)));
    state.files = files.map((f) => (f === sib.current ? target : f));
    state.index = Math.max(0, state.files.indexOf(target));
    renderCount();
    preload();
  }

  // ---- Bedienung ----

  $("infoBtn").textContent = t("viewerInfo");
  $("prev").addEventListener("click", () => step(-1));
  $("next").addEventListener("click", () => step(1));
  $("action").addEventListener("click", action);
  $("zoom").addEventListener("click", () => toggleZoom());
  $("infoBtn").addEventListener("click", toggleInfo);

  const stage = $("stage");

  // Zwei-Finger-Zoom kommt als wheel mit ctrlKey, ⌘ + Scrollen ebenso.
  // Ohne Taste wird ein vergrößertes Bild verschoben.
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const d = Math.max(-50, Math.min(50, e.deltaY));
        zoomAt(view.scale * Math.exp(-d * 0.01), e.clientX, e.clientY);
      } else if (!view.fitted) {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        clamp();
        apply();
      }
    },
    { passive: false }
  );

  // Safari-Gesten (WebKit auf dem Mac)
  let gestureBase = 1;
  stage.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureBase = view.scale;
  });
  stage.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    zoomAt(gestureBase * e.scale, e.clientX, e.clientY);
  });
  stage.addEventListener("gestureend", (e) => e.preventDefault());

  // Ziehen verschiebt das vergrößerte Bild
  let drag = null;
  let pressed = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (view.fitted) {
      if (e.target === $("img")) pressed = { x: e.clientX, y: e.clientY };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 5) {
      pressed = null;
      startNativeDrag();
      return;
    }
    if (!drag) return;
    view.x = drag.vx + e.clientX - drag.x;
    view.y = drag.vy + e.clientY - drag.y;
    clamp();
    apply();
  });
  const endDrag = () => {
    pressed = null;
    drag = null;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("click", closeZones);
  $("media").addEventListener("click", closeZones);
  $("media").addEventListener(
    "wheel",
    (e) => {
      if (!pdf || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const d = Math.max(-50, Math.min(50, e.deltaY));
      pdf.setZoom(pdf.zoom * Math.exp(-d * 0.01));
    },
    { passive: false }
  );
  stage.addEventListener("dblclick", (e) => toggleZoom(e.clientX, e.clientY));

  window.addEventListener("resize", () => {
    if (view.fitted) fit(false);
    else {
      clamp();
      apply();
    }
  });

  document.addEventListener("keydown", (e) => {
    const [cx, cy] = center();
    if ((e.metaKey || e.ctrlKey) && mode === "pdf" && pdf && /^[=+\-0]$/.test(e.key)) {
      pdf.setZoom(e.key === "0" ? 1 : e.key === "-" ? pdf.zoom / 1.25 : pdf.zoom * 1.25);
      e.preventDefault();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && mode === "video" && vzoom && /^[=+\-0]$/.test(e.key)) {
      if (e.key === "0") vzoom.reset();
      else vzoom.zoomBy(e.key === "-" ? 1 / 1.25 : 1.25);
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if (e.key === "=" || e.key === "+") zoomAt(view.scale * 1.25, cx, cy, true);
      else if (e.key === "-") zoomAt(view.scale / 1.25, cx, cy, true);
      else if (e.key === "0") fit(true);
      else if (e.key === "c" && current()) {
        invoke("copy_images", { paths: [current()] })
          .then(() => toast(t("copiedOne")))
          .catch(() => {});
      } else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (mode === "pdf" && pdf && (e.key === "ArrowDown" || e.key === "ArrowUp")) pdf.step(e.key === "ArrowDown" ? 1 : -1);
    else if ((mode === "video" || mode === "audio") && e.key === " ") Media.togglePlay();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === " ") toggleZoom();
    else if (e.key === "Enter") action();
    else if (e.key === "i" || e.key === "I") toggleInfo();
    else if (e.key === "Escape") {
      if (!$("zones").hidden) closeZones();
      else if (mode === "pdf" && pdf && !pdf.fitted()) pdf.setZoom(1);
      else if (mode === "image" && !view.fitted) fit(true);
      else if (mode === "video" && vzoom && vzoom.scale() > 1) vzoom.reset();
      else TAURI.window.getCurrentWindow().close();
    } else if (/^[1-4]$/.test(e.key) && state.library) {
      if (state.rel != null) return;
      ensureZones().then((zones) => {
        const zone = zones[Number(e.key) - 1];
        if (zone) saveTo([current()], zone.path);
      });
    } else return;
    e.preventDefault();
  });

  TAURI.event.listen("viewer-open", (e) => load(e.payload));
  TAURI.webview.getCurrentWebview().onDragDropEvent(onDragDrop);
  apply();
  load();
})();
