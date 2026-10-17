// projects.js — Projekte (0.40.0): leichtes Projektmanagement als eigener
// Bereich neben Archiver. Ersetzt Works. Daten aus projects.rs; app.js schaltet
// nur um (Navigation, Tasten, Ziehen) und reicht ihre Bausteine herein.
//
// Ebenen: Übersicht aller Projekte (Phase, nächste Frist) → Projekt mit Ordnern
// links, Inhalt in der Mitte und dem Projektblatt rechts (Kunde, Kürzel, Fristen,
// offene Punkte, Notiz). Archiver liest die Ordner und verändert keine Datei;
// Ablegen kopiert in den offenen Ordner. Siehe DESIGN.md 4.23.

(function () {
  const { t, lang } = window.ArchiverI18n;
  let A = null; // Bausteine aus app.js (init)

  const PHASES = [0, 1, 2, 3, 4];
  // Phase → Ordner der Vorlage, der beim Öffnen gezeigt wird
  const PHASE_FOLDER = ["01", "02", "03", "06", "07"];
  const VISUAL = new Set(["image", "pdf", "work", "doc", "font", "video"]);
  const WEB_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "bmp"]);

  const P = {
    root: undefined, // undefined = noch nicht gefragt, null = keine Wurzel
    rootError: null,
    list: null, // Übersicht (projects_scan)
    status: "open", // open | archived | all
    path: null, // offenes Projekt
    project: null, // projects_project
    folder: null, // relativer Ordner im Projekt, "" = lose Dateien
    files: [],
    sel: null, // gewählte Datei (Pfad)
    lb: null, // { list, i }
    savedAt: 0,
  };

  const $ = (id) => document.getElementById(id);
  const host = () => $("zones");
  const el = (tag, cls, text) => A.el(tag, cls, text);
  const DAY = 864e5;

  // ---- Hilfen ----

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function dayOf(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  function dateText(iso) {
    const d = new Date(dayOf(iso));
    const opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", opts);
  }

  // Frist: „heute“, „in 3 T.“, „3 T. drüber“; ab 14 Tagen das Datum
  function dueText(iso) {
    if (!iso) return null;
    const diff = Math.round((dayOf(iso) - dayOf(todayIso())) / DAY);
    if (diff === 0) return { text: t("pjDueToday"), soon: true };
    if (diff < 0) return { text: t("pjDueOver", { n: -diff }), late: true };
    if (diff < 14) return { text: t("pjDueIn", { n: diff }), soon: diff <= 3 };
    return { text: dateText(iso) };
  }

  // Die nächste Frist eines Projekts: nächste Frist oder Abgabe, was früher kommt
  function nextDue(meta) {
    const all = [];
    if (meta.next && meta.next.date) all.push({ date: meta.next.date, label: meta.next.label || t("pjNext") });
    if (meta.deadline) all.push({ date: meta.deadline, label: t("pjDelivery") });
    all.sort((a, b) => (a.date < b.date ? -1 : 1));
    return all[0] || null;
  }

  function phaseName(i) {
    return t("pjPhase_" + i);
  }

  function sizeText(bytes) {
    const dec = (n) => n.toFixed(1).replace(".", lang === "de" ? "," : ".");
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    if (bytes < 1024 * 1024 * 1024) return dec(bytes / 1024 / 1024) + " MB";
    return dec(bytes / 1024 / 1024 / 1024) + " GB";
  }

  function fail(e) {
    const code = String(e && e.message ? e.message : e);
    const key = "pjErr_" + code.replace(/[^a-z-]/g, "").replace(/-/g, "_");
    const msg = t(key);
    if (msg !== key) A.toast(msg, false, 4200);
    else A.fail(e);
  }

  // ---- Vorschauen: zwischengespeichert, höchstens drei zugleich ----

  const thumbs = new Map(); // path|mtime|size → { url, file } | null
  const queue = [];
  let active = 0;
  let observer = null;

  const thumbKey = (f, size) => f.path + "|" + (f.mtime || 0) + "|" + size;

  function pump() {
    while (active < 3 && queue.length) {
      const job = queue.shift();
      if (!job.img.isConnected) continue;
      const key = thumbKey(job.f, job.size);
      if (thumbs.has(key)) {
        applyThumb(job.img, thumbs.get(key));
        continue;
      }
      active++;
      A.invoke("projects_thumb", { path: job.f.path, size: job.size })
        .then((file) => {
          const v = file ? { url: A.fileSrc(file), file } : null;
          thumbs.set(key, v);
          applyThumb(job.img, v);
        })
        .catch(() => applyThumb(job.img, null))
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function applyThumb(img, v) {
    const box = img.parentElement;
    if (!v) {
      img.remove();
      if (box) box.classList.add("pj-noimg");
      return;
    }
    img.onload = () => box && box.classList.add("pj-loaded");
    img.src = v.url;
  }

  function wantThumb(img) {
    const job = img._job;
    if (!job) return;
    img._job = null;
    const key = thumbKey(job.f, job.size);
    if (thumbs.has(key)) return applyThumb(img, thumbs.get(key));
    queue.push({ ...job, img });
    pump();
  }

  // Bildfläche einer Datei: Vorschau, sobald sie sichtbar wird, bis dahin die Endung
  function media(f, size, cls) {
    const box = el("div", "pj-media" + (cls ? " " + cls : ""));
    box.appendChild(el("span", "pj-ext", f.ext || "?"));
    if (!VISUAL.has(f.kind)) {
      box.classList.add("pj-noimg");
      return box;
    }
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img._job = { f, size };
    box.appendChild(img);
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries)
            if (e.isIntersecting) {
              observer.unobserve(e.target);
              wantThumb(e.target);
            }
        },
        { root: host(), rootMargin: "600px 0px" }
      );
    }
    observer.observe(img);
    return box;
  }

  // ---- Laden ----

  async function loadRoot() {
    try {
      P.root = await A.invoke("projects_get");
      P.rootError = null;
    } catch (e) {
      P.root = null;
      if (String(e) !== "projects-none") P.rootError = String(e);
    }
  }

  async function loadList() {
    P.list = await A.invoke("projects_scan");
  }

  function folderPath(rel) {
    return rel ? P.path + "/" + rel : P.path;
  }

  function defaultFolder(p) {
    const tops = p.folders.filter((f) => f.depth === 0 && !/^08/.test(f.name));
    const want = PHASE_FOLDER[p.summary.meta.phase] || "01";
    const hit = tops.find((f) => f.name.startsWith(want));
    return hit ? hit.rel : tops[0] ? tops[0].rel : "";
  }

  async function loadProject(path) {
    const p = await A.invoke("projects_project", { path });
    if (P.path !== path) P.folder = null;
    P.path = path;
    P.project = p;
    if (P.folder == null || (P.folder && !p.folders.some((f) => f.rel === P.folder))) P.folder = defaultFolder(p);
    P.files = await A.invoke("projects_files", { path: folderPath(P.folder) }).catch(() => []);
    if (P.folder === "") P.files = P.files.filter((f) => !f.dir);
  }

  // ---- Ein- und Austritt (app.js) ----

  async function enter() {
    document.body.classList.add("projects");
    if (P.root === undefined) await loadRoot();
    render();
    await refresh();
  }

  function leave() {
    closeLightbox();
    closeMenus();
    document.body.classList.remove("projects");
  }

  async function refresh() {
    if (P.root === undefined) await loadRoot();
    if (!P.root) return render();
    try {
      if (P.path) {
        try {
          await loadProject(P.path);
        } catch (e) {
          // Projekt weg (umbenannt, verschoben, gelöscht): zurück zur Übersicht
          P.path = null;
          P.project = null;
        }
      }
      await loadList();
    } catch (e) {
      if (String(e) === "projects-missing" || String(e) === "projects-none") {
        P.rootError = String(e) === "projects-missing" ? String(e) : null;
        P.root = null;
      }
      fail(e);
    }
    render(true);
  }

  const isActive = () => document.body.classList.contains("projects");

  // ---- Zeichnen ----

  function render(keepScroll) {
    if (!isActive()) return;
    const box = host();
    const top = box.scrollTop;
    closeMenus();
    let page;
    if (!P.root) page = renderSetup();
    else if (P.path && P.project) page = renderProject();
    else page = renderList();
    box.replaceChildren(page);
    box.scrollTop = keepScroll ? top : 0;
    A.renderToolbar();
  }

  function head(title, text) {
    const h = el("h1", "p-head pj-title");
    h.appendChild(el("span", "p-head-title", title));
    if (text) {
      h.appendChild(document.createTextNode(" "));
      h.appendChild(el("span", "p-head-text", text));
    }
    return h;
  }

  // Ohne Wurzel: Vorlage zeigen, Ordner wählen oder anlegen
  function renderSetup() {
    const wrap = el("div", "p-page pj-page pj-setup");
    wrap.appendChild(head(t("pjTitle"), t("pjSetupText")));
    const tree = el("div", "pj-tree");
    tree.appendChild(el("div", "p-mono strong", t("pjTitle")));
    tree.appendChild(el("div", "p-mono", "└ " + t("pjSetupProject")));
    for (const name of ["01_Briefing", "02_Recherche", "03_Entwurf", "04_Arbeitsdateien", "05_Assets", "06_Reinzeichnung", "07_Ausgabe", "08_Admin"])
      tree.appendChild(el("div", "p-mono dim", "   · " + name));
    tree.appendChild(el("div", "p-mono", "└ " + t("pjSetupArchive")));
    wrap.appendChild(tree);
    wrap.appendChild(el("p", "pj-note", t("pjSetupNote")));
    const row = el("div", "pj-actions");
    row.appendChild(A.button("btn primary", t("pjChoose"), () => choose(false)));
    row.appendChild(A.button("btn", t("pjCreateRoot"), () => choose(true)));
    wrap.appendChild(row);
    if (P.rootError) wrap.appendChild(el("p", "pj-error", t("pjErr_" + P.rootError.replace(/-/g, "_"))));
    return wrap;
  }

  async function choose(create) {
    try {
      const root = await A.invoke("projects_choose", { create, name: t("pjTitle") });
      if (!root) return;
      P.root = root;
      P.rootError = null;
      P.path = null;
      P.project = null;
      thumbs.clear();
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  // ---- Übersicht ----

  function listed() {
    const all = P.list || [];
    return all
      .filter((p) => (P.status === "all" ? true : P.status === "archived" ? p.archived : !p.archived))
      .sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        // laufend: nächste Frist zuerst, ohne Frist nach Ordnername (JJJJ-MM vorn) neu → alt
        const da = !a.archived && nextDue(a.meta);
        const db = !b.archived && nextDue(b.meta);
        if (da && db && da.date !== db.date) return da.date < db.date ? -1 : 1;
        if (!!da !== !!db) return da ? -1 : 1;
        return a.folder < b.folder ? 1 : -1;
      });
  }

  function renderList() {
    const wrap = el("div", "p-page pj-page pj-list");
    const all = P.list || [];
    const open = all.filter((p) => !p.archived);
    let text = t("pjListEmpty");
    if (all.length) {
      text = t(open.length === 1 ? "pjListText1" : "pjListText", { n: open.length });
      const soon = open.map((p) => ({ p, d: nextDue(p.meta) })).filter((x) => x.d).sort((a, b) => (a.d.date < b.d.date ? -1 : 1))[0];
      if (soon) text += " " + t("pjListNext", { name: soon.p.meta.name, d: dueText(soon.d.date).text });
    }
    wrap.appendChild(head(t("pjTitle"), text));
    const bar = el("div", "p-bar pj-bar");
    for (const [id, key] of [["open", "pjRunning"], ["archived", "pjArchived"], ["all", "pjAll"]])
      bar.appendChild(
        A.chip("(" + t(key) + ")", P.status === id, () => {
          P.status = id;
          render();
        })
      );
    wrap.appendChild(bar);

    const grid = el("div", "pj-grid");
    for (const p of listed()) grid.appendChild(projectCard(p));
    if (P.status !== "archived") grid.appendChild(newCard());
    wrap.appendChild(grid);
    return wrap;
  }

  // Fünf Striche: erledigt / aktuell / offen
  function phaseBar(phase, done) {
    const bar = el("div", "pj-phasebar");
    for (const i of PHASES) bar.appendChild(el("span", done || i < phase ? "done" : i === phase ? "current" : ""));
    return bar;
  }

  // Mosaik aus bis zu drei Bildern der Recherche: eins groß, zwei gestapelt
  function cover(p) {
    const box = el("div", "pj-cover pj-cover-" + Math.max(1, p.cover.length));
    if (!p.cover.length) {
      box.classList.add("pj-noimg");
      box.appendChild(el("span", "pj-cover-code p-mono", p.meta.code || ""));
      return box;
    }
    for (const path of p.cover) {
      const ext = (path.split(".").pop() || "").toLowerCase();
      box.appendChild(media({ path, ext, kind: "image", mtime: p.mtime }, 560));
    }
    return box;
  }

  function projectCard(p) {
    const card = el("article", "p-card pj-card" + (p.archived ? " pj-archived" : ""));
    card.dataset.path = p.path;
    card.appendChild(cover(p));
    card.appendChild(phaseBar(p.meta.phase, p.archived));
    const body = el("div", "pj-card-body");
    const top = el("div", "pj-card-top");
    top.appendChild(el("div", "zone-card-name", p.meta.name));
    const d = !p.archived && nextDue(p.meta);
    const due = d && dueText(d.date);
    if (due) top.appendChild(el("span", "p-mono" + (due.late ? " pj-late" : due.soon ? " strong" : ""), due.text));
    body.appendChild(top);
    body.appendChild(el("div", "p-card-meta", [p.meta.client, p.meta.code].filter(Boolean).join(" · ") || p.folder));
    const line = [p.archived ? t("pjArchivedOne") : phaseName(p.meta.phase)];
    if (d) line.push(d.label);
    if (p.openTodos) line.push(t(p.openTodos === 1 ? "pjOpenTodos1" : "pjOpenTodos", { n: p.openTodos }));
    body.appendChild(el("div", "p-card-meta pj-card-phase", line.join(" · ")));
    card.appendChild(body);
    card.addEventListener("click", () => openProject(p.path));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menuAt(e.clientX, e.clientY, [
        [t("pjOpenProject"), () => openProject(p.path)],
        [t("reveal"), () => A.invoke("projects_reveal", { path: p.path }).catch(fail)],
        null,
        [p.archived ? t("pjUnarchive") : t("pjArchive"), () => setArchived(p.path, !p.archived)],
      ]);
    });
    return card;
  }

  // Neues Projekt: wie die Neue-Zone-Karte, gestrichelt mit Plus (4.4)
  function newCard() {
    const card = el("button", "p-card p-new pj-card pj-new");
    card.type = "button";
    card.appendChild(el("span", "p-new-plus"));
    card.appendChild(el("span", "pj-new-text", t("pjNew")));
    card.addEventListener("click", () => askNewProject());
    return card;
  }

  function askNewProject() {
    const dialog = el("div", "dialog confirm pj-dialog");
    dialog.appendChild(el("h3", null, t("pjNew")));
    dialog.appendChild(el("p", null, t("pjNewText")));
    const field = (ph) => {
      const i = el("input", "p-input note-field pj-input");
      i.placeholder = ph;
      i.spellcheck = false;
      return i;
    };
    const name = field(t("pjName"));
    const client = field(t("pjClient"));
    const code = field(t("pjCode"));
    const list = el("datalist");
    list.id = "pjClients";
    for (const c of new Set((P.list || []).map((p) => p.meta.client).filter(Boolean))) {
      const o = el("option");
      o.value = c;
      list.appendChild(o);
    }
    client.setAttribute("list", "pjClients");
    // Vorschau des Ordnernamens, wie projects.rs ihn bildet
    const preview = el("div", "p-mono dim pj-preview");
    const clean = (s) => s.trim().replace(/[/\\:*?"<>|]/g, "-").split(/\s+/).filter(Boolean).join("-");
    const update = () => {
      preview.textContent = [todayIso().slice(0, 7), clean(client.value), clean(name.value) || t("pjName"), clean(code.value)].filter(Boolean).join("_");
    };
    for (const i of [name, client, code]) i.addEventListener("input", update);
    update();
    const fields = el("div", "pj-fields");
    fields.append(name, client, list, code, preview);
    dialog.appendChild(fields);
    const go = async () => {
      if (!name.value.trim()) return name.focus();
      try {
        const path = await A.invoke("projects_create", { client: client.value, name: name.value, code: code.value, today: todayIso() });
        A.closeModal();
        A.toast(t("pjCreated"));
        P.status = "open";
        P.path = path;
        P.folder = null;
        await refresh();
      } catch (e) {
        fail(e);
      }
    };
    const foot = el("div", "confirm-foot");
    foot.appendChild(A.button("btn", t("cancel"), A.closeModal));
    foot.appendChild(A.button("btn primary", t("pjCreate"), go));
    dialog.appendChild(foot);
    A.openModal(dialog, go);
    setTimeout(() => name.focus(), 30);
  }

  // ---- Projekt ----

  function renderProject() {
    const p = P.project;
    const s = p.summary;
    const m = s.meta;
    const wrap = el("div", "p-page pj-page pj-project");

    const top = el("div", "pj-head");
    const left = el("div", "pj-head-main");
    const sub = [m.client, m.code].filter(Boolean).join(" · ");
    if (sub) left.appendChild(el("div", "p-mono pj-client", sub));
    const d = !s.archived && nextDue(m);
    const due = d && dueText(d.date);
    const h = head(m.name, s.archived ? t("pjArchivedOne") : d ? d.label + " " + due.text : "");
    if (due && due.late) h.querySelector(".p-head-text").classList.add("pj-late");
    left.appendChild(h);
    top.appendChild(left);
    const side = el("div", "pj-head-side");
    side.appendChild(A.button("btn", t("reveal"), () => A.invoke("projects_reveal", { path: s.path }).catch(fail)));
    side.appendChild(A.button("btn", s.archived ? t("pjUnarchive") : t("pjArchive"), () => setArchived(s.path, !s.archived)));
    top.appendChild(side);
    wrap.appendChild(top);

    // Phasen: Beschriftung über dem Strich, Klick setzt die Phase
    const phases = el("div", "pj-phases");
    for (const i of PHASES) {
      const b = el("button", "pj-phase" + (i < m.phase ? " done" : i === m.phase ? " current" : ""));
      b.type = "button";
      b.appendChild(el("span", "pj-phase-label", phaseName(i)));
      b.appendChild(el("span", "pj-phase-line"));
      b.addEventListener("click", () => {
        m.phase = i;
        save(true);
      });
      phases.appendChild(b);
    }
    wrap.appendChild(phases);

    const layout = el("div", "pj-layout");
    layout.appendChild(renderFolders(p));
    layout.appendChild(renderContent());
    layout.appendChild(renderSheet(m));
    wrap.appendChild(layout);
    return wrap;
  }

  function renderFolders(p) {
    const nav = el("nav", "pj-folders");
    const add = (rel, name, count, depth) => {
      const b = el("button", "pj-folder" + (depth ? " sub" : "") + (P.folder === rel ? " active" : ""));
      b.type = "button";
      b.dataset.folder = rel;
      b.appendChild(el("span", "pj-folder-name", name));
      b.appendChild(el("span", "p-mono pj-folder-count", count ? String(count) : ""));
      b.addEventListener("click", () => setFolder(rel));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        menuAt(e.clientX, e.clientY, [[t("reveal"), () => A.invoke("projects_reveal", { path: folderPath(rel) }).catch(fail)]]);
      });
      nav.appendChild(b);
    };
    for (const f of p.folders) {
      // 08_Admin (Rechnungen, Verträge) bleibt im Finder
      if (/^08/.test(f.rel)) continue;
      // Unterordner nur unter dem offenen Hauptordner
      if (f.depth && !(P.folder === f.rel.split("/")[0] || (P.folder || "").startsWith(f.rel.split("/")[0] + "/"))) continue;
      add(f.rel, f.name, f.count, f.depth);
    }
    if (p.loose) add("", t("pjLoose"), p.loose, 0);
    return nav;
  }

  function currentFolder() {
    return (P.project.folders || []).find((f) => f.rel === P.folder);
  }

  function renderContent() {
    const box = el("div", "pj-content");
    box.dataset.drop = "content";
    const f = currentFolder();
    const visual = f ? f.visual : false;
    if (!P.files.length) {
      box.appendChild(el("p", "pj-note", t("pjEmptyFolder")));
      return box;
    }
    if (visual) {
      const grid = el("div", "pj-tiles");
      for (const file of P.files) grid.appendChild(tile(file));
      box.appendChild(grid);
    } else {
      for (const file of P.files) box.appendChild(line(file));
    }
    return box;
  }

  function tile(f) {
    const fig = el("figure", "pj-tile" + (P.sel === f.path ? " selected" : ""));
    fig.dataset.path = f.path;
    fig.appendChild(media(f, 560));
    const cap = el("figcaption");
    cap.appendChild(el("span", "pj-tile-name", f.name));
    if (f.dir) cap.appendChild(el("span", "pj-tile-dir", f.dir));
    fig.appendChild(cap);
    bindFile(fig, f);
    return fig;
  }

  function line(f) {
    const row = el("div", "pj-line" + (P.sel === f.path ? " selected" : ""));
    row.dataset.path = f.path;
    row.appendChild(el("span", "p-mono dim pj-line-kind", f.ext));
    row.appendChild(el("span", "pj-line-name", f.name));
    if (f.dir) row.appendChild(el("span", "pj-line-meta", f.dir));
    row.appendChild(el("span", "pj-line-meta", sizeText(f.size)));
    row.appendChild(el("span", "pj-line-meta pj-line-date", A.recentDate(f.mtime)));
    bindFile(row, f);
    return row;
  }

  function bindFile(node, f) {
    node.addEventListener("click", () => select(f.path));
    node.addEventListener("dblclick", () => openFile(f));
    node.addEventListener("pointerdown", (e) => dragOut(e, f));
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      select(f.path);
      menuAt(e.clientX, e.clientY, [
        [t("pjPreview"), () => openLightbox(f.path), "␣"],
        [t("pjOpenApp"), () => openFile(f), "↩"],
        [t("reveal"), () => A.invoke("projects_reveal", { path: f.path }).catch(fail)],
      ]);
    });
  }

  // ---- Projektblatt: speichert beim Tippen (verzögert) und beim Verlassen ----

  function renderSheet(m) {
    const sheet = el("aside", "pj-sheet");
    const row = (label, ...nodes) => {
      const r = el("div", "pj-field");
      r.appendChild(el("div", "p-mono pj-field-label", label));
      const v = el("div", "pj-field-value");
      v.append(...nodes);
      r.appendChild(v);
      sheet.appendChild(r);
      return r;
    };
    const input = (value, ph, set, type) => {
      const i = el("input", "note-field pj-input");
      if (type) i.type = type;
      i.value = value || "";
      i.placeholder = ph || "";
      i.spellcheck = false;
      i.addEventListener("input", () => {
        set(i.value);
        save(false);
      });
      i.addEventListener("change", () => save("quiet"));
      return i;
    };
    row(t("pjClient"), input(m.client, "–", (v) => (m.client = v)));
    row(t("pjCode"), input(m.code, "–", (v) => (m.code = v)));
    row(t("pjStart"), input(m.start, "", (v) => (m.start = v), "date"));
    m.next = m.next || { date: "", label: "" };
    const nextDate = input(m.next.date, "", (v) => (m.next.date = v), "date");
    const nextLabel = input(m.next.label, t("pjNextLabel"), (v) => (m.next.label = v));
    nextLabel.classList.add("pj-next-label");
    row(t("pjNext"), nextDate, nextLabel);
    row(t("pjDelivery"), input(m.deadline, "", (v) => (m.deadline = v), "date"));

    // Offene Punkte
    const todos = el("div", "pj-todos");
    m.todos = m.todos || [];
    m.todos.forEach((td, i) => {
      const r = el("div", "pj-todo" + (td.done ? " done" : ""));
      const check = el("button", "pj-check");
      check.type = "button";
      check.title = td.done ? t("pjTodoUndo") : t("pjTodoDone");
      check.addEventListener("click", () => {
        td.done = !td.done;
        save(true);
      });
      const text = input(td.text, "", (v) => (td.text = v));
      text.classList.add("pj-todo-text");
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter") text.blur();
      });
      const del = A.button("pj-todo-del", "×", () => {
        m.todos.splice(i, 1);
        save(true);
      });
      del.title = t("pjTodoRemove");
      r.append(check, text, del);
      todos.appendChild(r);
    });
    const add = el("input", "note-field pj-input pj-todo-add");
    add.placeholder = t("pjTodoAdd");
    add.spellcheck = false;
    add.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      m.todos.push({ text: add.value.trim(), done: false });
      add.value = "";
      save(true, ".pj-todo-add");
    });
    todos.appendChild(add);
    const open = m.todos.filter((x) => !x.done).length;
    row(t("pjTodos") + (open ? " " + open : ""), todos).classList.add("pj-field-block");

    const note = el("textarea", "note-field pj-note-field");
    note.value = m.note || "";
    note.placeholder = t("pjNotePlaceholder");
    note.rows = 6;
    note.addEventListener("input", () => {
      m.note = note.value;
      save(false);
    });
    note.addEventListener("change", () => save("quiet"));
    row(t("pjNote"), note).classList.add("pj-field-block");
    return sheet;
  }

  let saveTimer = null;
  // true: sofort speichern und neu zeichnen (Klicks); "quiet": sofort speichern,
  // gezeichnet wird erst, wenn der Fokus das Blatt verlassen hat; sonst nach einer Pause
  function save(now, refocus) {
    clearTimeout(saveTimer);
    const path = P.path;
    const meta = P.project && P.project.summary.meta;
    if (!path || !meta) return;
    const run = () => {
      P.savedAt = Date.now();
      return A.invoke("projects_save_meta", { path, meta }).catch(fail);
    };
    if (!now) {
      saveTimer = setTimeout(run, 600);
      return;
    }
    run();
    if (now === "quiet") {
      setTimeout(() => {
        if (!typing() && P.path === path) render(true);
      }, 0);
      return;
    }
    render(true);
    if (refocus) {
      const n = host().querySelector(refocus);
      if (n) n.focus();
    }
  }

  const typing = () => {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest(".pj-sheet, .pj-dialog"));
  };

  async function setArchived(path, archived) {
    try {
      const dest = await A.invoke("projects_archive", { path, archived, today: todayIso() });
      A.toast(archived ? t("pjArchivedDone", { y: todayIso().slice(0, 4) }) : t("pjReopened"));
      if (P.path === path) P.path = dest;
      thumbs.clear();
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  // ---- Handlungen ----

  function openProject(path) {
    P.path = path;
    P.folder = null;
    P.sel = null;
    loadProject(path)
      .then(() => render())
      .catch((e) => {
        P.path = null;
        fail(e);
      });
  }

  function closeProject() {
    clearTimeout(saveTimer);
    P.path = null;
    P.project = null;
    P.sel = null;
    render();
    if (P.root) loadList().then(() => render(true)).catch(() => {});
  }

  function setFolder(rel) {
    if (P.folder === rel) return;
    P.folder = rel;
    P.sel = null;
    A.invoke("projects_files", { path: folderPath(rel) })
      .then((files) => {
        P.files = rel === "" ? files.filter((f) => !f.dir) : files;
        render();
      })
      .catch(fail);
  }

  function select(path) {
    P.sel = path;
    for (const n of host().querySelectorAll(".pj-tile, .pj-line")) n.classList.toggle("selected", n.dataset.path === path);
  }

  function openFile(f) {
    A.invoke("projects_open", { path: f.path }).catch(fail);
  }

  function findFile(path) {
    return P.files.find((f) => f.path === path) || null;
  }

  function visibleFiles() {
    return [...host().querySelectorAll(".pj-tile[data-path], .pj-line[data-path]")].map((n) => n.dataset.path);
  }

  // ---- Menüs ----

  function closeMenus() {
    for (const m of document.querySelectorAll(".pj-menu")) m.remove();
  }

  function menuAt(x, y, items) {
    A.closeMenus();
    closeMenus();
    const menu = el("div", "zone-menu p-ctx-menu pj-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    for (const it of items) {
      if (!it) {
        menu.appendChild(el("div", "pj-menu-sep"));
        continue;
      }
      const [label, fn, key] = it;
      const b = A.button("zone-menu-item", label, () => {
        closeMenus();
        fn();
      });
      if (key) b.appendChild(el("span", "p-ctx-key", key));
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }

  function rootMenu(x, y) {
    menuAt(x, y, [
      [t("pjRevealRoot"), () => A.invoke("projects_reveal", { path: P.root }).catch(fail)],
      [t("pjNew") + " …", askNewProject],
      null,
      [t("pjChangeRoot"), () => choose(false)],
      [
        t("pjForgetRoot"),
        async () => {
          await A.invoke("projects_forget").catch(fail);
          P.root = null;
          P.list = null;
          P.path = null;
          P.project = null;
          render();
        },
      ],
    ]);
  }

  // ---- Groß ansehen ----

  function openLightbox(path) {
    const list = visibleFiles().map(findFile).filter(Boolean);
    const i = Math.max(0, list.findIndex((f) => f.path === path));
    if (!list.length) return;
    P.lb = { list, i };
    renderLightbox();
  }

  function lbSrc(f, done) {
    if (WEB_IMAGE.has(f.ext)) return done(A.fileSrc(f.path));
    const key = thumbKey(f, 2000);
    if (thumbs.has(key)) return done(thumbs.get(key) && thumbs.get(key).url);
    A.invoke("projects_thumb", { path: f.path, size: 2000 })
      .then((file) => {
        const v = file ? { url: A.fileSrc(file), file } : null;
        thumbs.set(key, v);
        done(v && v.url);
      })
      .catch(() => done(null));
  }

  function renderLightbox() {
    let box = document.querySelector(".pj-lb");
    if (!P.lb) {
      if (box) box.remove();
      document.body.classList.remove("pj-lb-open");
      return;
    }
    if (!box) {
      box = el("div", "pj-lb");
      box.addEventListener("click", (e) => {
        if (e.target === box || e.target.classList.contains("pj-lb-stage")) closeLightbox();
      });
      document.body.appendChild(box);
    }
    document.body.classList.add("pj-lb-open");
    const { list, i } = P.lb;
    const f = list[i];
    const stage = el("div", "pj-lb-stage");
    const layer = el("div", "pj-lb-layer");
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    lbSrc(f, (url) => {
      if (url) img.src = url;
      else layer.appendChild(el("span", "pj-ext big", f.ext));
    });
    layer.appendChild(img);
    stage.appendChild(layer);
    const bar = el("nav", "lb-bar pj-lb-bar");
    if (list.length > 1) {
      bar.appendChild(A.button("lb-btn lb-arrow", "‹", () => lbStep(-1)));
      bar.appendChild(el("span", "lb-count", i + 1 + " / " + list.length));
      bar.appendChild(A.button("lb-btn lb-arrow", "›", () => lbStep(1)));
      bar.appendChild(el("span", "lb-sep"));
    }
    bar.appendChild(el("span", "lb-name", f.name));
    bar.appendChild(A.button("lb-btn", t("pjOpenApp"), () => openFile(f)));
    box.replaceChildren(stage, bar);
  }

  function lbStep(d) {
    const lb = P.lb;
    if (!lb) return;
    lb.i = (lb.i + d + lb.list.length) % lb.list.length;
    select(lb.list[lb.i].path);
    renderLightbox();
  }

  function closeLightbox() {
    if (!P.lb) return;
    P.lb = null;
    renderLightbox();
  }

  // ---- Ziehen: hinaus in Finder, Mail, InDesign; hinein kopiert in den Ordner ----

  function dragOut(e, f) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      cleanup();
      startDrag(f);
    };
    const cleanup = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", cleanup);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", cleanup);
  }

  async function startDrag(f) {
    let icon = null;
    for (const size of [560, 2000]) {
      const v = thumbs.get(thumbKey(f, size));
      if (v) {
        icon = v.file;
        break;
      }
    }
    if (!icon) icon = await A.invoke("projects_thumb", { path: f.path, size: 256 }).catch(() => null);
    if (!icon) return; // ohne Bild kein Ziehen, das Plugin braucht eins
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = () => {};
    P.dragging = f.path;
    A.invoke("plugin:drag|start_drag", { item: [f.path], image: icon, onEvent: channel })
      .catch(fail)
      .finally(() => setTimeout(() => (P.dragging = null), 400));
  }

  // Ziel beim Ablegen: der Ordner links unter dem Zeiger, sonst der offene Ordner
  function dropTarget(x, y) {
    if (x != null && x >= 0) {
      const hit = document.elementFromPoint(x, y);
      const f = hit && hit.closest("[data-folder]");
      if (f) return { rel: f.dataset.folder, node: f };
    }
    return { rel: P.folder, node: host().querySelector(".pj-content") };
  }

  let dropPaths = [];
  function drop(p, x, y) {
    const clear = () => {
      for (const n of document.querySelectorAll(".pj-drop")) n.classList.remove("pj-drop");
    };
    if (!P.path || !P.project) {
      if (p.type === "drop" && p.paths && p.paths.length) A.toast(t("pjDropOpenProject"), false);
      return;
    }
    if (p.type === "leave") {
      dropPaths = [];
      return clear();
    }
    if (p.paths) dropPaths = p.paths;
    const target = dropTarget(x, y);
    if (p.type === "enter" || p.type === "over") {
      clear();
      if (target.node) target.node.classList.add("pj-drop");
      return;
    }
    if (p.type === "drop") {
      clear();
      const paths = dropPaths.filter((path) => path !== P.dragging);
      dropPaths = [];
      if (!paths.length || target.rel == null) return;
      const name = target.rel ? target.rel.split("/").pop() : P.project.summary.folder;
      A.invoke("projects_import", { dir: folderPath(target.rel), paths })
        .then((n) => {
          if (n) A.toast(t(n === 1 ? "pjImported1" : "pjImported", { n, f: name }));
          return refresh();
        })
        .catch(fail);
    }
  }

  // ---- Tasten (app.js reicht sie durch, solange Projekte offen ist) ----

  function key(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (P.lb) {
      if (e.key === "Escape" || e.key === " ") closeLightbox();
      else if (e.key === "ArrowLeft") lbStep(-1);
      else if (e.key === "ArrowRight") lbStep(1);
      else if (e.key === "Enter") openFile(P.lb.list[P.lb.i]);
      else return false;
      return true;
    }
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) {
      if (e.key === "Escape") e.target.blur();
      return e.key === "Escape";
    }
    if (document.querySelector(".pj-menu") && e.key === "Escape") {
      closeMenus();
      return true;
    }
    const hit = P.sel ? findFile(P.sel) : null;
    if (mod && (e.key === "r" || e.key === "R")) {
      thumbs.clear();
      refresh();
      return true;
    }
    if (mod && e.key === "ArrowUp" && P.path) {
      closeProject();
      return true;
    }
    if (mod && (e.key === "o" || e.key === "O") && hit) {
      openFile(hit);
      return true;
    }
    if (mod && (e.key === "n" || e.key === "N") && P.root) {
      askNewProject();
      return true;
    }
    if (mod) return false;
    if (e.key === "Escape") {
      if (P.sel) select(null);
      else if (P.path) closeProject();
      else return false;
      return true;
    }
    if (!P.path) return false;
    if (e.key === " " && hit) openLightbox(hit.path);
    else if (e.key === "Enter" && hit) openFile(hit);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      const all = visibleFiles();
      if (!all.length) return false;
      const i = all.indexOf(P.sel);
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
      const next = i < 0 ? 0 : Math.min(all.length - 1, Math.max(0, i + (fwd ? 1 : -1)));
      select(all[next]);
      const node = [...host().querySelectorAll("[data-path]")].find((n) => n.dataset.path === all[next]);
      if (node) node.scrollIntoView({ block: "nearest" });
    } else if (/^[1-7]$/.test(e.key)) {
      // 1–7: Hauptordner 01–07
      const top = P.project.folders.find((f) => !f.depth && f.name.startsWith("0" + e.key));
      if (!top) return false;
      setFolder(top.rel);
    } else return false;
    return true;
  }

  // ---- Navigation: Projekte › Projektname ----

  function nav(navButton) {
    if (!P.root || !P.path || !P.project) return [];
    const b = navButton(P.project.summary.meta.name, true);
    b.classList.add("p-nav-zone");
    return [b];
  }

  function brandClick() {
    closeLightbox();
    if (P.path) closeProject();
  }

  function brandMenu(e) {
    if (!P.root) return;
    e.preventDefault();
    rootMenu(e.clientX, e.clientY);
  }

  let changed = null;
  function init(api) {
    A = api;
    const T = window.__TAURI__;
    if (T && T.event)
      T.event.listen("projects-changed", () => {
        clearTimeout(changed);
        changed = setTimeout(() => {
          // Eigenes Speichern löst den Watcher aus: nicht mitten ins Tippen zeichnen
          if (isActive() && !typing() && Date.now() - P.savedAt > 1500) refresh();
        }, 300);
      });
    window.addEventListener("focus", () => {
      if (isActive() && !typing() && P.root) refresh();
    });
  }

  // „Projekte“ in der Leiste ist nur auf der Übersicht aktiv, wie „Archiver“ auf der Startseite
  const atHome = () => !P.path;

  window.ArchiverProjects = { init, enter, leave, render, refresh, key, drop, nav, brandClick, brandMenu, closeLightbox, atHome, isOpen: () => !!P.lb };
})();
