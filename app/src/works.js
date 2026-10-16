// works.js — Works (0.38.0): laufende Kundenprojekte als eigener Bereich neben
// Archiver. Daten aus works.rs; app.js schaltet nur um (Navigation, Tasten,
// Ziehen) und reicht über window.ArchiverApp ihre Bausteine herein.
//
// Ebenen: Liste aller Projekte → Projekt mit Reitern (Übersicht, fünf Phasen,
// Post, Assets). Archiver liest den Ordner, verschiebt nie eine Datei. Neue
// Stände sind Kopien mit nächster Kennung, Ablegen kopiert in den Phasenordner.

(function () {
  const { t, lang } = window.ArchiverI18n;
  let A = null; // Bausteine aus app.js (init)

  const PHASES = ["brief", "research", "layout", "final", "delivery"];
  const TABS = ["overview", ...PHASES, "post", "assets"];
  const VISUAL = new Set(["image", "pdf", "work", "doc", "font", "video"]);
  const WEB_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "bmp"]);

  const W = {
    root: undefined, // undefined = noch nicht gefragt, null = keine Wurzel
    overview: null,
    project: null, // offenes Projekt (works_project)
    path: null, // Pfad des offenen Projekts
    tab: "overview",
    status: "open", // Liste: open | done | all
    client: null, // Liste: nur dieser Kunde
    sel: null, // gewählte Datei (Pfad)
    editing: false, // brief.md im Editor
    lb: null, // { list, i, cmp: Index | null, pos }
    loading: false,
  };

  const $ = (id) => document.getElementById(id);
  const host = () => $("zones");

  // ---- Hilfen ----

  function el(tag, cls, text) {
    return A.el(tag, cls, text);
  }

  function slotName(slot) {
    return t("wSlot_" + slot);
  }

  const DAY = 864e5;

  function today() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function dayOf(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  // Termin: „heute“, „in 3 T.“, „3 T. drüber“; ab 14 Tagen das Datum
  function dueText(iso) {
    if (!iso) return null;
    const diff = Math.round((dayOf(iso) - today()) / DAY);
    if (diff === 0) return { text: t("wDueToday"), late: false, soon: true };
    if (diff < 0) return { text: t("wDueOver", { n: -diff }), late: true };
    if (diff < 14) return { text: t("wDueIn", { n: diff }), late: false, soon: diff <= 3 };
    const d = new Date(dayOf(iso));
    return { text: d.toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short" }), late: false };
  }

  function dateText(ms) {
    return A.recentDate(ms);
  }

  function money(cents) {
    if (cents == null) return "–";
    return new Intl.NumberFormat(lang === "de" ? "de-DE" : "en-GB", { style: "currency", currency: "EUR" }).format(cents / 100);
  }

  function sizeText(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace(".", lang === "de" ? "," : ".") + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1).replace(".", lang === "de" ? "," : ".") + " GB";
  }

  function daysSince(ms) {
    return Math.max(0, Math.floor((today() - ms) / DAY) + 1);
  }

  function fail(e) {
    const code = String(e && e.message ? e.message : e);
    const key = "wErr_" + code.replace(/[^a-z-]/g, "").replace(/-/g, "_");
    const msg = t(key);
    if (msg !== key) A.toast(msg, false, 4200);
    else A.fail(e);
  }

  // ---- Vorschauen: zwischengespeichert, höchstens drei zugleich ----

  const thumbs = new Map(); // path|mtime|size → { url, file } | null
  const queue = [];
  let active = 0;
  let observer = null;

  function thumbKey(f, size) {
    return f.path + "|" + f.mtime + "|" + size;
  }

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
      A.invoke("works_thumb", { path: job.f.path, size: job.size })
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
      if (box) box.classList.add("w-noimg");
      return;
    }
    img.onload = () => box && box.classList.add("w-loaded");
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

  // Bildfläche einer Datei: Vorschau, wenn sie sichtbar wird, sonst die Endung
  function media(f, size, cls) {
    const box = el("div", "w-media" + (cls ? " " + cls : ""));
    box.appendChild(el("span", "w-ext", f.ext || "?"));
    if (!VISUAL.has(f.kind)) {
      box.classList.add("w-noimg");
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
      W.root = await A.invoke("works_get");
    } catch (e) {
      W.root = null;
      if (String(e) !== "works-none") W.rootError = String(e);
    }
  }

  async function loadOverview() {
    W.overview = await A.invoke("works_scan");
  }

  async function loadProject(path) {
    W.project = await A.invoke("works_project", { path });
    W.path = path;
  }

  // ---- Ein- und Austritt (app.js) ----

  async function enter() {
    if (W.root === undefined) await loadRoot();
    render();
    await refresh();
  }

  async function refresh() {
    if (W.root === undefined) await loadRoot();
    if (!W.root) return render();
    W.loading = true;
    try {
      if (W.path) {
        try {
          await loadProject(W.path);
        } catch (e) {
          // Projekt weg (umbenannt, gelöscht): zurück zur Liste
          W.path = null;
          W.project = null;
        }
      }
      await loadOverview();
    } catch (e) {
      if (String(e) === "works-missing" || String(e) === "works-none") W.root = null;
      fail(e);
    } finally {
      W.loading = false;
    }
    render(true);
  }

  function active_() {
    return document.body.classList.contains("works");
  }

  // ---- Zeichnen ----

  function render(keepScroll) {
    if (!active_()) return;
    const box = host();
    const top = box.scrollTop;
    closeMenus();
    let page;
    if (!W.root) page = renderSetup();
    else if (W.path && W.project) page = renderProject();
    else page = renderList();
    box.replaceChildren(page);
    box.scrollTop = keepScroll ? top : 0;
    A.renderToolbar();
  }

  function head(title, text) {
    const h = el("h1", "p-head w-title");
    h.appendChild(el("span", "p-head-title", title));
    if (text) {
      h.appendChild(document.createTextNode(" "));
      h.appendChild(el("span", "p-head-text", text));
    }
    return h;
  }

  // Ohne Wurzel: erklären, wählen oder anlegen
  function renderSetup() {
    const wrap = el("div", "p-page w-page w-setup");
    wrap.appendChild(head("Works", t("wSetupText")));
    const tree = el("div", "w-tree");
    tree.appendChild(el("div", "p-mono strong", "Works"));
    tree.appendChild(el("div", "p-mono", "└ " + t("wSetupClient")));
    tree.appendChild(el("div", "p-mono dim", "   ├ _Assets"));
    tree.appendChild(el("div", "p-mono", "   └ " + t("wSetupProject")));
    for (const s of ["post", ...PHASES]) tree.appendChild(el("div", "p-mono dim", "      · " + folderName(s)));
    wrap.appendChild(tree);
    wrap.appendChild(el("p", "w-setup-note", t("wSetupNote")));
    const row = el("div", "w-actions");
    row.appendChild(A.button("btn primary", t("wChoose"), () => choose(false)));
    row.appendChild(A.button("btn", t("wCreateRoot"), () => choose(true)));
    row.appendChild(A.button("btn", t("wDemoStart"), () => choose(true, true)));
    wrap.appendChild(row);
    if (W.rootError) wrap.appendChild(el("p", "w-error", t("wErr_" + W.rootError.replace(/-/g, "_"))));
    return wrap;
  }

  function folderName(slot) {
    const de = lang !== "en";
    return {
      post: de ? "00 Post" : "00 Mail",
      brief: "01 Brief",
      research: de ? "02 Recherche" : "02 Research",
      layout: "03 Layout",
      final: de ? "04 Reinzeichnung" : "04 Artwork",
      delivery: de ? "05 Übergabe" : "05 Delivery",
    }[slot];
  }

  async function choose(create, demo) {
    try {
      const root = await A.invoke("works_choose", { create, name: "Works" });
      if (!root) return;
      W.root = root;
      W.rootError = null;
      W.path = null;
      W.project = null;
      thumbs.clear();
      if (demo) await addDemo();
      else await refresh();
    } catch (e) {
      fail(e);
    }
  }

  // Zwei erfundene Kunden zum Ausprobieren (works.rs: create_demo, 0.38.1)
  async function addDemo() {
    try {
      const n = await A.invoke("works_demo");
      A.toast(n ? t(n === 1 ? "wDemoDone1" : "wDemoDone", { n }) : t("wDemoExists"));
    } catch (e) {
      fail(e);
    }
    await refresh();
  }

  // ---- Liste ----

  function listed() {
    const all = (W.overview && W.overview.projects) || [];
    return all
      .filter((p) => (W.status === "all" ? true : W.status === "done" ? p.done : !p.done))
      .filter((p) => W.client == null || p.client === W.client)
      .sort((a, b) => {
        // laufend: nächster Termin zuerst, ohne Termin nach letzter Änderung
        if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
        if (!!a.deadline !== !!b.deadline && !a.done && !b.done) return a.deadline ? -1 : 1;
        return b.modified - a.modified;
      });
  }

  function renderList() {
    const wrap = el("div", "p-page w-page w-list");
    const all = (W.overview && W.overview.projects) || [];
    const open = all.filter((p) => !p.done);
    const clients = new Set(open.map((p) => p.client).filter(Boolean));
    wrap.appendChild(
      head(
        "Works",
        all.length ? t(open.length === 1 ? "wListText1" : "wListText", { n: open.length, c: clients.size }) : t("wListEmpty")
      )
    );
    const bar = el("div", "p-bar w-bar");
    for (const [id, key] of [["open", "wOpen"], ["done", "wDone"], ["all", "wAll"]])
      bar.appendChild(
        A.chip("(" + t(key) + ")", W.status === id, () => {
          W.status = id;
          render();
        })
      );
    const names = (W.overview && W.overview.clients) || [];
    if (names.length > 1) {
      bar.appendChild(el("span", "w-bar-sep"));
      for (const c of names)
        bar.appendChild(
          A.chip("(" + c + ")", W.client === c, () => {
            W.client = W.client === c ? null : c;
            render();
          })
        );
    }
    wrap.appendChild(bar);

    const grid = el("div", "w-grid");
    for (const p of listed()) grid.appendChild(projectCard(p));
    grid.appendChild(newCard());
    wrap.appendChild(grid);
    if (!all.length) {
      const row = el("div", "w-actions");
      row.appendChild(A.button("btn", t("wDemo"), addDemo));
      wrap.appendChild(row);
    }
    return wrap;
  }

  function phaseBar(phase, cls) {
    const bar = el("div", "w-phasebar" + (cls ? " " + cls : ""));
    for (let i = 0; i < 5; i++) {
      const seg = el("span", phase == null ? "" : i < phase ? "done" : i === phase ? "current" : "");
      bar.appendChild(seg);
    }
    return bar;
  }

  function phaseText(p) {
    if (p.phase == null) return t("wNoPhase");
    return slotName(PHASES[p.phase]) + (p.correction ? " · " + t("wCorrection") : "");
  }

  function projectCard(p) {
    const card = el("article", "p-card w-card");
    card.dataset.path = p.path;
    const cover = p.cover ? media(p.cover, 560, "w-cover") : el("div", "w-media w-cover w-noimg");
    card.appendChild(cover);
    card.appendChild(phaseBar(p.done ? 5 : p.phase));
    // Name mit Termin in einer Zeile, darunter Kunde, Phase und offene Rechnungen
    const body = el("div", "w-card-body");
    const top = el("div", "w-card-top");
    top.appendChild(el("div", "zone-card-name", p.name));
    const due = !p.done && dueText(p.deadline);
    if (due) top.appendChild(el("span", "p-mono" + (due.late ? " w-late" : due.soon ? " strong" : ""), due.text));
    body.appendChild(top);
    const meta = el("div", "p-card-meta");
    meta.textContent = [p.client, p.done ? t("wDoneOne") : phaseText(p)].filter(Boolean).join(" · ");
    if (p.openInvoices) meta.appendChild(el("span", "w-card-due", " · " + t(p.openInvoices === 1 ? "wInvoiceOpen1" : "wInvoiceOpen", { n: p.openInvoices })));
    body.appendChild(meta);
    card.appendChild(body);
    card.addEventListener("click", () => openProject(p.path));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menuAt(e.clientX, e.clientY, [
        [t("wOpenProject"), () => openProject(p.path)],
        [t("reveal"), () => A.invoke("works_reveal", { path: p.path }).catch(fail)],
      ]);
    });
    return card;
  }

  function newCard() {
    const card = el("button", "p-card w-card w-new");
    card.type = "button";
    card.appendChild(el("span", "w-new-plus", "+"));
    card.appendChild(el("span", "w-new-text", t("wNewProject")));
    card.addEventListener("click", () => askNewProject());
    return card;
  }

  function askNewProject() {
    const dialog = el("div", "dialog confirm w-dialog");
    dialog.appendChild(el("h3", null, t("wNewProject")));
    dialog.appendChild(el("p", null, t("wNewProjectText")));
    const client = el("input", "p-input note-field w-input");
    client.placeholder = t("wClient");
    client.spellcheck = false;
    client.value = W.client || (W.project && W.project.summary.client) || "";
    const list = el("datalist");
    list.id = "wClients";
    for (const c of (W.overview && W.overview.clients) || []) {
      const o = el("option");
      o.value = c;
      list.appendChild(o);
    }
    client.setAttribute("list", "wClients");
    const name = el("input", "p-input note-field w-input");
    name.placeholder = t("wProjectName");
    name.spellcheck = false;
    const fields = el("div", "w-fields");
    fields.append(client, list, name);
    dialog.appendChild(fields);
    const go = async () => {
      if (!name.value.trim()) return name.focus();
      try {
        const path = await A.invoke("works_create", { client: client.value, name: name.value, lang });
        A.closeModal();
        A.toast(t("wCreated"));
        W.path = path;
        W.tab = "overview";
        await refresh();
      } catch (e) {
        fail(e);
      }
    };
    const foot = el("div", "confirm-foot");
    foot.appendChild(A.button("btn", t("cancel"), A.closeModal));
    foot.appendChild(A.button("btn primary", t("wCreate"), go));
    dialog.appendChild(foot);
    A.openModal(dialog, go);
    setTimeout(() => (client.value ? name : client).focus(), 30);
  }

  // ---- Projekt ----

  function slotOf(slot) {
    return (W.project.slots || []).find((s) => s.slot === slot) || { slot, files: [] };
  }

  function files(slot) {
    return slotOf(slot).files.filter((f) => !(slot === "brief" && f.name.toLowerCase() === "brief.md"));
  }

  // Gruppen gleicher Arbeit (Ordner + Stamm), innen alt → neu, neueste Gruppe zuerst
  function groups(list) {
    const by = new Map();
    for (const f of list) {
      const k = f.dir + "/" + f.key + "." + (f.kind === "work" || f.kind === "pdf" || f.kind === "image" ? "v" : f.ext);
      if (!by.has(k)) by.set(k, { key: k, stem: f.stem, dir: f.dir, items: [] });
      by.get(k).items.push(f);
    }
    const out = [...by.values()];
    for (const g of out) g.items.sort((a, b) => a.mtime - b.mtime);
    return out.sort((a, b) => b.items[b.items.length - 1].mtime - a.items[a.items.length - 1].mtime);
  }

  function nextText(p) {
    const s = p.summary;
    if (s.next) return s.next;
    const post = files("post");
    const late = post.find((f) => f.post && f.post.kind === "invoice" && !f.post.paid && daysSince(f.post.date) > 30);
    if (late) return t("wNextInvoice", { n: late.post.number || late.stem, d: daysSince(late.post.date) });
    if (s.correction) {
      const g = groups([...files("layout"), ...files("final")])[0];
      return t("wNextCorrection", { n: g ? g.stem : "" });
    }
    if (!s.files) return t("wNextStart");
    return "";
  }

  function renderProject() {
    const p = W.project;
    const s = p.summary;
    const wrap = el("div", "p-page w-page w-project");

    const top = el("div", "w-head");
    const left = el("div", "w-head-main");
    if (s.client) {
      const c = A.button("p-mono w-client", s.client, () => {
        W.client = s.client;
        closeProject();
      });
      left.appendChild(c);
    }
    left.appendChild(head(s.name, nextText(p)));
    top.appendChild(left);
    const side = el("div", "w-head-side");
    const due = dueText(s.deadline);
    if (s.done) side.appendChild(el("span", "p-mono", t("wDoneOne")));
    else if (due) side.appendChild(el("span", "p-mono" + (due.late ? " w-late" : " strong"), t("wDue") + " " + due.text));
    const more = A.button("zone-menu-btn w-more", "⋯", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      projectMenu(r.right - 200, r.bottom + 4);
    });
    more.title = t("zoneOptions");
    side.appendChild(more);
    top.appendChild(side);
    wrap.appendChild(top);

    wrap.appendChild(renderTabs(p));
    const body = el("div", "w-body");
    body.dataset.slot = dropSlot();
    if (W.tab === "overview") renderOverview(body);
    else if (W.tab === "post") renderPost(body);
    else if (W.tab === "assets") renderAssets(body);
    else renderSlot(body, W.tab);
    wrap.appendChild(body);
    return wrap;
  }

  // Reiter: Übersicht, die fünf Phasen als Leiste, Post, Assets
  function renderTabs(p) {
    const bar = el("div", "w-tabs");
    bar.appendChild(tabChip("overview", t("wOverview")));
    const phases = el("div", "w-phases");
    const phase = p.summary.done ? 5 : p.summary.phase;
    PHASES.forEach((slot, i) => {
      const n = files(slot).length + (slot === "brief" && p.brief ? 1 : 0);
      const b = A.button(
        "w-phase" + (W.tab === slot ? " active" : "") + (phase != null && i < phase ? " done" : "") + (phase === i ? " current" : ""),
        null,
        () => setTab(slot)
      );
      b.dataset.slot = slot;
      const label = el("span", "w-phase-label", slotName(slot));
      if (n) label.appendChild(el("span", "w-count", " " + n));
      b.appendChild(label);
      b.appendChild(el("span", "w-phase-line"));
      phases.appendChild(b);
    });
    bar.appendChild(phases);
    const post = tabChip("post", t("wSlot_post"), files("post").length);
    post.dataset.slot = "post";
    bar.appendChild(post);
    bar.appendChild(tabChip("assets", t("wAssets"), (p.assets || []).length));
    return bar;
  }

  function tabChip(id, label, n) {
    const c = A.chip("(" + label + (n ? " " + n : "") + ")", W.tab === id, () => setTab(id));
    c.classList.add("w-tab");
    return c;
  }

  function setTab(id) {
    if (W.editing && !confirmLeaveEdit()) return;
    W.tab = id;
    W.sel = null;
    render();
  }

  function section(title, action) {
    const sec = el("section", "w-sec");
    const h = el("div", "w-sec-head");
    h.appendChild(el("span", "p-mono", title));
    if (action) h.appendChild(A.chip("(" + action[0] + ")", false, action[1]));
    sec.appendChild(h);
    return sec;
  }

  // Übersicht: Bild zuerst (neueste Stände, Recherche), dann Brief, Post, Verlauf
  function renderOverview(body) {
    const p = W.project;
    const work = groups([...files("layout"), ...files("final"), ...files("delivery")].filter((f) => VISUAL.has(f.kind)));
    if (work.length) {
      const sec = section(t("wLatest"), [t("wAllStands"), () => setTab(work[0].items[0] && files("final").includes(work[0].items[0]) ? "final" : "layout")]);
      const row = el("div", "w-latest");
      for (const g of work.slice(0, 4)) row.appendChild(tile(g.items[g.items.length - 1], g, "w-tile-big"));
      sec.appendChild(row);
      body.appendChild(sec);
    }
    const research = files("research").filter((f) => f.kind === "image" || f.kind === "pdf");
    const rsec = section(slotName("research"), research.length ? [t("wAll"), () => setTab("research")] : null);
    if (research.length) {
      const strip = el("div", "w-strip");
      for (const f of research.slice(-14).reverse()) strip.appendChild(tile(f, null, "w-tile-strip", true));
      rsec.appendChild(strip);
    } else rsec.appendChild(el("p", "w-hint", t("wResearchEmpty")));
    body.appendChild(rsec);

    const cols = el("div", "w-cols");
    // Brief
    const brief = section(slotName("brief"), [t("wOpenBrief"), () => setTab("brief")]);
    if (p.brief) brief.appendChild(markdown(bodyOf(p.brief.text), 14));
    else brief.appendChild(el("p", "w-hint", t("wBriefMissing")));
    cols.appendChild(brief);
    // Post: offene Rechnungen, Angebote, letzte Mails
    const post = section(t("wSlot_post"), [t("wAll"), () => setTab("post")]);
    const items = files("post")
      .filter((f) => f.post)
      .sort((a, b) => b.post.date - a.post.date);
    const pick = [
      ...items.filter((f) => f.post.kind === "invoice" && !f.post.paid),
      ...items.filter((f) => !(f.post.kind === "invoice" && !f.post.paid)),
    ].slice(0, 5);
    if (pick.length) for (const f of pick) post.appendChild(postLine(f));
    else post.appendChild(el("p", "w-hint", t("wPostEmpty")));
    cols.appendChild(post);
    // Verlauf aus Änderungsdaten
    const hist = section(t("wHistory"));
    const all = [];
    for (const s of p.slots) for (const f of s.files) all.push([s.slot, f]);
    all.sort((a, b) => b[1].mtime - a[1].mtime);
    for (const [slot, f] of all.slice(0, 7)) {
      const line = el("div", "w-line");
      line.appendChild(el("span", "w-line-name", f.name));
      line.appendChild(el("span", "w-line-meta", slotName(slot) + " · " + dateText(f.mtime)));
      line.addEventListener("click", () => {
        W.sel = f.path;
        setTab(slot === "post" ? "post" : slot);
      });
      hist.appendChild(line);
    }
    if (!all.length) hist.appendChild(el("p", "w-hint", t("wHistoryEmpty")));
    if (p.other && p.other.length) {
      hist.appendChild(el("div", "p-mono w-other-title", t("wOther")));
      for (const o of p.other) {
        const line = el("div", "w-line");
        line.appendChild(el("span", "w-line-name", o.name));
        line.appendChild(el("span", "w-line-meta", t(o.files === 1 ? "wFiles1" : "wFiles", { n: o.files })));
        line.addEventListener("click", () => A.invoke("works_reveal", { path: o.path }).catch(fail));
        hist.appendChild(line);
      }
    }
    cols.appendChild(hist);
    body.appendChild(cols);
  }

  function postLine(f) {
    const line = el("div", "w-line w-post-line");
    const k = f.post.kind;
    line.appendChild(el("span", "p-mono dim w-line-kind", t("wPost_" + k)));
    line.appendChild(el("span", "w-line-name", k === "mail" ? f.post.subject || f.name : f.post.number ? f.post.number : f.stem));
    let meta = k === "mail" ? f.post.from || "" : money(f.post.amount);
    const status = el("span", "w-line-meta", meta);
    if (k === "invoice") {
      const d = daysSince(f.post.date);
      const s = f.post.paid ? t("wPaid") : t("wOpenSince", { n: d });
      status.textContent = [f.post.amount != null ? money(f.post.amount) : null, s].filter(Boolean).join(" · ");
      if (!f.post.paid && d > 30) status.classList.add("w-late");
    }
    line.appendChild(status);
    line.addEventListener("click", () => {
      W.sel = f.path;
      setTab("post");
    });
    return line;
  }

  // Eine Datei als Kachel: Vorschau, Kennung, Datum. Klick wählt, Doppelklick öffnet.
  function tile(f, group, cls, bare) {
    const fig = el("figure", "w-tile" + (cls ? " " + cls : "") + (W.sel === f.path ? " selected" : ""));
    fig.dataset.path = f.path;
    fig._file = f;
    fig._group = group;
    fig.appendChild(media(f, cls === "w-tile-strip" ? 320 : cls === "w-tile-research" ? 600 : 900));
    if (!bare) {
      const cap = el("figcaption");
      if (group) {
        cap.appendChild(el("span", "w-tile-name", group.stem));
        cap.appendChild(el("span", "p-mono" + (f.tag.includes("KORR") ? " w-korr" : ""), f.tag || "—"));
      } else {
        cap.appendChild(el("span", "w-tile-name", f.name));
      }
      cap.appendChild(el("span", "w-tile-date", dateText(f.mtime)));
      fig.appendChild(cap);
    }
    bindFile(fig, f);
    return fig;
  }

  function bindFile(node, f) {
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      select(f.path);
    });
    node.addEventListener("dblclick", () => openFile(f));
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      select(f.path);
      fileMenu(f, e.clientX, e.clientY);
    });
    node.addEventListener("pointerdown", (e) => dragOut(e, f));
    node.addEventListener("dragstart", (e) => e.preventDefault());
  }

  function select(path) {
    W.sel = path;
    for (const n of host().querySelectorAll(".w-tile.selected, .w-row.selected")) n.classList.remove("selected");
    if (path) for (const n of host().querySelectorAll("[data-path]")) if (n.dataset.path === path && !n.classList.contains("w-card")) n.classList.add("selected");
  }

  // Phase: Stände-Reihen je Arbeit, alt → neu, der neueste größer
  function renderSlot(body, slot) {
    const s = slotOf(slot);
    if (slot === "brief") renderBrief(body);
    const list = files(slot);
    if (!s.dir && slot !== "brief") {
      body.appendChild(el("p", "w-hint", t("wSlotMissing", { f: folderName(slot) })));
      return;
    }
    if (!list.length) {
      if (slot !== "brief") body.appendChild(el("p", "w-hint", t(slot === "research" ? "wResearchEmpty" : "wSlotEmpty", { f: folderName(slot) })));
      return;
    }
    if (slot === "research") {
      const grid = el("div", "w-research");
      for (const f of [...list].reverse()) grid.appendChild(tile(f, null, "w-tile-research", true));
      body.appendChild(grid);
      return;
    }
    let lastDir = null;
    for (const g of groups(list)) {
      if (g.dir !== lastDir && g.dir) body.appendChild(el("div", "p-mono w-dir", g.dir));
      lastDir = g.dir;
      const row = el("section", "w-stand");
      const h = el("div", "w-stand-head");
      h.appendChild(el("span", "w-stand-name", g.stem));
      h.appendChild(el("span", "p-mono dim", g.items.length === 1 ? t("wStand1") : t("wStands", { n: g.items.length })));
      row.appendChild(h);
      const line = el("div", "w-stand-row");
      g.items.forEach((f, i) => line.appendChild(tile(f, g, i === g.items.length - 1 ? "w-tile-newest" : "")));
      row.appendChild(line);
      body.appendChild(row);
    }
  }

  // ---- Brief: brief.md lesen und bearbeiten ----

  function bodyOf(text) {
    const m = String(text || "").match(/^﻿?---\s*\n[\s\S]*?\n---\s*(\n|$)/);
    return m ? text.slice(m[0].length) : text || "";
  }

  // Kleines Markdown: Überschriften, Listen, Absätze, **fett**; nichts als HTML
  function markdown(text, maxLines) {
    const box = el("div", "w-md");
    let lines = String(text || "").split("\n");
    if (maxLines && lines.filter((l) => l.trim()).length > maxLines) {
      let n = 0;
      lines = lines.filter((l) => !l.trim() || ++n <= maxLines);
    }
    let list = null;
    let para = null;
    const inline = (node, s) => {
      s.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) node.appendChild(el("strong", null, part.slice(2, -2)));
        else if (part) node.appendChild(document.createTextNode(part));
      });
    };
    for (const raw of lines) {
      const l = raw.trimEnd();
      if (!l.trim()) {
        list = para = null;
        continue;
      }
      const h = l.match(/^(#{1,3})\s+(.*)$/);
      const li = l.match(/^\s*[-*•]\s+(.*)$/);
      if (h) {
        list = para = null;
        box.appendChild(el(h[1].length === 1 ? "h3" : "h4", null, h[2]));
      } else if (li) {
        para = null;
        if (!list) box.appendChild((list = el("ul")));
        const item = el("li");
        inline(item, li[1]);
        list.appendChild(item);
      } else {
        list = null;
        if (!para) box.appendChild((para = el("p")));
        else para.appendChild(document.createElement("br"));
        inline(para, l.trim());
      }
    }
    if (!box.firstChild) box.appendChild(el("p", "w-hint", t("wBriefEmpty")));
    return box;
  }

  function renderBrief(body) {
    const p = W.project;
    const sec = el("section", "w-brief");
    if (W.editing) {
      const area = el("textarea", "w-editor");
      area.value = p.brief ? p.brief.text : "";
      area.spellcheck = true;
      area.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          saveBrief(area.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          W.editing = false;
          render(true);
        }
      });
      area.addEventListener("input", () => (area._dirty = true));
      sec.appendChild(area);
      const row = el("div", "w-actions");
      row.appendChild(A.button("btn", t("cancel"), () => {
        W.editing = false;
        render(true);
      }));
      row.appendChild(A.button("btn primary", t("wSave"), () => saveBrief(area.value)));
      row.appendChild(el("span", "p-mono dim", "⌘S"));
      sec.appendChild(row);
      body.appendChild(sec);
      setTimeout(() => area.focus(), 20);
      return;
    }
    if (p.brief) {
      const facts = el("div", "w-facts");
      const b = p.brief;
      const due = dueText(b.deadline);
      for (const [k, v, cls] of [
        [t("wDue"), b.deadline ? new Date(dayOf(b.deadline)).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB") + (due ? " · " + due.text : "") : null, due && due.late && !b.done ? "w-late" : ""],
        [t("wStatus"), b.status, ""],
        [t("wNext"), b.next, ""],
        [t("wContact"), b.contact, ""],
      ]) {
        if (!v) continue;
        const row = el("div", "w-fact");
        row.appendChild(el("span", "p-mono", k));
        row.appendChild(el("span", cls, v));
        facts.appendChild(row);
      }
      if (facts.firstChild) sec.appendChild(facts);
      sec.appendChild(markdown(bodyOf(b.text)));
    } else sec.appendChild(el("p", "w-hint", t("wBriefMissing")));
    const row = el("div", "w-actions");
    row.appendChild(A.button("btn", p.brief ? t("wEdit") : t("wBriefCreate"), () => {
      if (!p.brief) p.brief = { text: briefTemplate(p.summary) };
      W.editing = true;
      render(true);
    }));
    if (p.brief && p.brief.path) row.appendChild(A.button("btn", t("wOpenInEditor"), () => A.invoke("works_open", { path: p.brief.path }).catch(fail)));
    sec.appendChild(row);
    body.appendChild(sec);
  }

  function briefTemplate(s) {
    return lang === "en"
      ? `---\ndeadline: \nstatus: running\nnext step: \ncontact: \n---\n\n# ${s.name}\n\nClient: ${s.client}\n\n## Task\n\n`
      : `---\ntermin: \nstatus: laufend\nnächster schritt: \nansprechpartner: \n---\n\n# ${s.name}\n\nKunde: ${s.client}\n\n## Aufgabe\n\n`;
  }

  async function saveBrief(text) {
    try {
      await A.invoke("works_save_brief", { project: W.path, text, lang });
      W.editing = false;
      A.toast(t("wSaved"));
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  function confirmLeaveEdit() {
    const area = host().querySelector(".w-editor");
    if (!area || !area._dirty) {
      W.editing = false;
      return true;
    }
    // Ungesichertes nicht verlieren: einfach sichern
    saveBrief(area.value);
    return true;
  }

  // ---- Post: Mails, Angebote, Rechnungen ----

  function renderPost(body) {
    const list = files("post")
      .filter((f) => f.post)
      .sort((a, b) => b.post.date - a.post.date);
    if (!slotOf("post").dir) return body.appendChild(el("p", "w-hint", t("wSlotMissing", { f: folderName("post") })));
    if (!list.length) return body.appendChild(el("p", "w-hint", t("wPostEmpty")));
    const sum = (k, f) => list.filter((x) => x.post.kind === k && f(x)).reduce((a, x) => a + (x.post.amount || 0), 0);
    const offered = sum("offer", () => true);
    const open = sum("invoice", (x) => !x.post.paid);
    const paid = sum("invoice", (x) => !!x.post.paid);
    const sums = el("div", "w-sums");
    for (const [k, v, n] of [
      [t("wSumOffered"), offered, list.some((x) => x.post.kind === "offer")],
      [t("wSumOpen"), open, list.some((x) => x.post.kind === "invoice" && !x.post.paid)],
      [t("wSumPaid"), paid, list.some((x) => x.post.kind === "invoice" && x.post.paid)],
    ]) {
      if (!n) continue;
      const s = el("div", "w-sum");
      s.appendChild(el("span", "p-mono", k));
      s.appendChild(el("span", "w-sum-value", money(v)));
      sums.appendChild(s);
    }
    if (sums.firstChild) body.appendChild(sums);

    const table = el("div", "w-table");
    const headRow = el("div", "w-row w-row-head");
    for (const h of [t("wColKind"), t("wColName"), t("wColNumber"), t("wColAmount"), t("wColDate"), t("wColStatus")]) headRow.appendChild(el("span", "p-mono", h));
    table.appendChild(headRow);
    for (const f of list) {
      const k = f.post.kind;
      const row = el("div", "w-row" + (W.sel === f.path ? " selected" : ""));
      row.dataset.path = f.path;
      row.appendChild(el("span", "p-mono", t("wPost_" + k)));
      const name = el("span", "w-row-name");
      name.appendChild(el("span", null, k === "mail" ? f.post.subject || f.name : f.name));
      if (k === "mail" && f.post.from) name.appendChild(el("span", "w-row-sub", f.post.from));
      row.appendChild(name);
      row.appendChild(el("span", "w-row-dim", f.post.number || ""));
      row.appendChild(el("span", "w-row-amount", f.post.amount != null ? money(f.post.amount) : k === "invoice" || k === "offer" ? "–" : ""));
      row.appendChild(el("span", "w-row-dim", dateText(f.post.date)));
      const status = el("span", "w-row-status");
      if (k === "invoice") {
        const d = daysSince(f.post.date);
        const chip = A.chip("(" + (f.post.paid ? t("wPaid") : t("wOpenSince", { n: d })) + ")", !!f.post.paid, (e) => {
          e.stopPropagation();
          setPaid(f, !f.post.paid);
        });
        chip.title = f.post.paid ? t("wMarkOpen") : t("wMarkPaid");
        if (!f.post.paid && d > 30) chip.classList.add("w-late");
        status.appendChild(chip);
      }
      row.appendChild(status);
      bindFile(row, f);
      table.appendChild(row);
    }
    body.appendChild(table);
    body.appendChild(el("p", "w-hint w-foot-hint", t("wPostHint")));
  }

  async function setPaid(f, paid) {
    try {
      await A.invoke("works_set_paid", { path: f.path, paid });
      A.toast(t(paid ? "wMarkedPaid" : "wMarkedOpen"));
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  // ---- Assets des Kunden ----

  function renderAssets(body) {
    const p = W.project;
    if (!p.summary.client) return body.appendChild(el("p", "w-hint", t("wAssetsNoClient")));
    if (!p.assetsDir) {
      body.appendChild(el("p", "w-hint", t("wAssetsMissing", { c: p.summary.client })));
      const row = el("div", "w-actions");
      row.appendChild(A.button("btn", t("wAssetsCreate"), async () => {
        try {
          await A.invoke("works_create_assets", { project: W.path, lang });
          await refresh();
        } catch (e) {
          fail(e);
        }
      }));
      return body.appendChild(row);
    }
    const list = p.assets || [];
    if (!list.length) {
      body.appendChild(el("p", "w-hint", t("wAssetsEmpty")));
      return body.appendChild(A.button("btn", t("reveal"), () => A.invoke("works_reveal", { path: p.assetsDir }).catch(fail)));
    }
    const by = new Map();
    for (const f of list) {
      const top = f.dir.split("/")[0] || "";
      if (!by.has(top)) by.set(top, []);
      by.get(top).push(f);
    }
    for (const [dir, items] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sec = section(dir || "_Assets");
      const visual = items.filter((f) => f.kind === "image" || f.kind === "pdf" || f.kind === "work");
      const rest = items.filter((f) => !visual.includes(f));
      if (visual.length) {
        const grid = el("div", "w-assets");
        for (const f of visual) grid.appendChild(tile(f, null, "w-tile-asset"));
        sec.appendChild(grid);
      }
      for (const f of rest) {
        const row = el("div", "w-line w-file-line" + (W.sel === f.path ? " selected" : ""));
        row.dataset.path = f.path;
        row.appendChild(el("span", "p-mono dim w-line-kind", f.ext));
        row.appendChild(el("span", "w-line-name", f.name));
        row.appendChild(el("span", "w-line-meta", sizeText(f.size)));
        bindFile(row, f);
        sec.appendChild(row);
      }
      body.appendChild(sec);
    }
  }

  // ---- Handlungen ----

  function findFile(path) {
    if (!W.project) return null;
    for (const s of W.project.slots) for (const f of s.files) if (f.path === path) return { f, slot: s.slot };
    for (const f of W.project.assets || []) if (f.path === path) return { f, slot: "assets" };
    return null;
  }

  function openFile(f) {
    A.invoke("works_open", { path: f.path }).catch(fail);
  }

  async function newVersion(f) {
    try {
      const path = await A.invoke("works_new_version", { path: f.path });
      W.sel = path;
      A.toast(t("wNewVersionDone", { n: path.split("/").pop() }));
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  // Kann aus dieser Datei ein neuer Stand werden? Nur Arbeitsdateien in Layout und Reinzeichnung
  function versionable(hit) {
    return hit && (hit.slot === "layout" || hit.slot === "final") && ["work", "pdf", "image", "doc"].includes(hit.f.kind);
  }

  function fileMenu(f, x, y) {
    const hit = findFile(f.path);
    const items = [
      [t("wPreview"), () => openLightbox(f.path), "␣"],
      [t("wOpenApp"), () => openFile(f), "↩"],
      [t("reveal"), () => A.invoke("works_reveal", { path: f.path }).catch(fail)],
    ];
    if (versionable(hit)) {
      items.push(null);
      items.push([t("wNewVersion"), () => newVersion(f), "N"]);
      const g = groupOf(f.path);
      if (g && g.items.length > 1) items.push([t("wCompare"), () => openLightbox(f.path, true), "V"]);
    }
    if (hit && hit.slot === "post" && f.post && f.post.kind === "invoice") {
      items.push(null);
      items.push([f.post.paid ? t("wMarkOpen") : t("wMarkPaid"), () => setPaid(f, !f.post.paid)]);
    }
    menuAt(x, y, items);
  }

  function projectMenu(x, y) {
    const p = W.project;
    const items = [[t("wRevealProject"), () => A.invoke("works_reveal", { path: p.summary.path }).catch(fail)]];
    const tab = W.tab;
    if (PHASES.includes(tab) || tab === "post") {
      const dir = slotOf(tab).dir;
      if (dir) items.push([t("wRevealSlot", { f: slotName(tab) }), () => A.invoke("works_reveal", { path: dir }).catch(fail)]);
    }
    if (p.assetsDir) items.push([t("wRevealAssets"), () => A.invoke("works_reveal", { path: p.assetsDir }).catch(fail)]);
    items.push(null);
    items.push([t("wEditBrief"), () => {
      W.tab = "brief";
      if (!p.brief) p.brief = { text: briefTemplate(p.summary) };
      W.editing = true;
      render();
    }]);
    items.push([t("wNewProject") + "…", askNewProject]);
    items.push(null);
    items.push([t("wChangeRoot"), () => choose(false)]);
    menuAt(x, y, items);
  }

  function rootMenu(x, y) {
    menuAt(x, y, [
      [t("wRevealRoot"), () => A.invoke("works_reveal", { path: W.root }).catch(fail)],
      [t("wNewProject") + "…", askNewProject],
      [t("wDemo"), addDemo],
      null,
      [t("wChangeRoot"), () => choose(false)],
      [t("wForgetRoot"), async () => {
        await A.invoke("works_forget").catch(fail);
        W.root = null;
        W.overview = null;
        W.path = null;
        W.project = null;
        render();
      }],
    ]);
  }

  function closeMenus() {
    for (const m of document.querySelectorAll(".w-menu")) m.remove();
  }

  function menuAt(x, y, items) {
    A.closeMenus();
    closeMenus();
    const menu = el("div", "zone-menu p-ctx-menu w-menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    for (const it of items) {
      if (!it) {
        menu.appendChild(el("div", "w-menu-sep"));
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

  function openProject(path) {
    W.path = path;
    W.tab = "overview";
    W.sel = null;
    W.editing = false;
    const known = W.overview && W.overview.projects.find((p) => p.path === path);
    if (known && (!W.project || W.project.summary.path !== path)) W.project = null;
    loadProject(path)
      .then(() => render())
      .catch((e) => {
        W.path = null;
        fail(e);
      });
  }

  function closeProject() {
    if (W.editing && !confirmLeaveEdit()) return;
    W.path = null;
    W.project = null;
    W.sel = null;
    render();
    if (W.root) loadOverview().then(() => render(true)).catch(() => {});
  }

  // ---- Groß ansehen und vergleichen ----

  function visibleFiles() {
    return [...host().querySelectorAll(".w-tile[data-path], .w-row[data-path], .w-file-line[data-path]")].map((n) => n.dataset.path);
  }

  function groupOf(path) {
    if (!W.project) return null;
    const hit = findFile(path);
    if (!hit || hit.slot === "assets") return null;
    return groups(files(hit.slot)).find((g) => g.items.some((f) => f.path === path)) || null;
  }

  function openLightbox(path, compare) {
    const hit = findFile(path);
    if (!hit) return;
    const g = groupOf(path);
    const list = compare && g ? g.items : visibleFiles().map((p) => findFile(p)).filter(Boolean).map((h) => h.f);
    const i = Math.max(0, list.findIndex((f) => f.path === path));
    let cmp = null;
    if (compare && list.length > 1) cmp = i > 0 ? i - 1 : 1;
    W.lb = { list, i, cmp, pos: 0.5 };
    renderLightbox();
  }

  function lbSrc(f, done) {
    if (WEB_IMAGE.has(f.ext)) return done(A.fileSrc(f.path));
    const key = thumbKey(f, 2000);
    if (thumbs.has(key)) return done(thumbs.get(key) && thumbs.get(key).url);
    A.invoke("works_thumb", { path: f.path, size: 2000 })
      .then((file) => {
        const v = file ? { url: A.fileSrc(file), file } : null;
        thumbs.set(key, v);
        done(v && v.url);
      })
      .catch(() => done(null));
  }

  function renderLightbox() {
    let box = document.querySelector(".w-lb");
    if (!W.lb) {
      if (box) box.remove();
      document.body.classList.remove("w-lb-open");
      return;
    }
    if (!box) {
      box = el("div", "w-lb");
      box.addEventListener("click", (e) => {
        if (e.target === box || e.target.classList.contains("w-lb-stage")) closeLightbox();
      });
      document.body.appendChild(box);
    }
    document.body.classList.add("w-lb-open");
    const { list, i, cmp } = W.lb;
    const f = list[i];
    const stage = el("div", "w-lb-stage" + (cmp != null ? " compare" : ""));
    const front = el("div", "w-lb-layer");
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    lbSrc(f, (url) => {
      if (url) img.src = url;
      else front.appendChild(el("span", "w-ext big", f.ext));
    });
    front.appendChild(img);
    if (cmp != null) {
      const other = list[cmp];
      const back = el("div", "w-lb-layer w-lb-under");
      const img2 = el("img");
      img2.alt = "";
      img2.draggable = false;
      lbSrc(other, (url) => {
        if (url) img2.src = url;
      });
      back.appendChild(img2);
      stage.appendChild(back);
      front.classList.add("w-lb-over");
      const line = el("div", "w-lb-line");
      stage.appendChild(front);
      stage.appendChild(line);
      const set = (pos) => {
        W.lb.pos = Math.min(1, Math.max(0, pos));
        front.style.clipPath = `inset(0 0 0 ${W.lb.pos * 100}%)`;
        line.style.left = W.lb.pos * 100 + "%";
      };
      set(W.lb.pos);
      stage.addEventListener("pointermove", (e) => {
        if (e.buttons || e.pointerType === "mouse") {
          const r = stage.getBoundingClientRect();
          set((e.clientX - r.left) / r.width);
        }
      });
      // Beschriftung: links der ältere, rechts der gewählte Stand
      const labels = el("div", "w-lb-labels");
      labels.appendChild(el("span", "p-mono strong", other.tag || other.name));
      labels.appendChild(el("span", "p-mono strong", f.tag || f.name));
      stage.appendChild(labels);
    } else stage.appendChild(front);

    const bar = el("nav", "lb-bar w-lb-bar");
    if (list.length > 1 && cmp == null) {
      bar.appendChild(A.button("lb-btn lb-arrow", "‹", () => lbStep(-1)));
      bar.appendChild(el("span", "lb-count", i + 1 + " / " + list.length));
      bar.appendChild(A.button("lb-btn lb-arrow", "›", () => lbStep(1)));
      bar.appendChild(el("span", "lb-sep"));
    }
    bar.appendChild(el("span", "lb-name", f.name));
    const g = groupOf(f.path);
    if (g && g.items.length > 1) {
      const b = A.button("lb-btn" + (cmp != null ? " active" : ""), t("wCompare"), () => lbCompare());
      bar.appendChild(b);
    }
    bar.appendChild(A.button("lb-btn", t("wOpenApp"), () => openFile(f)));
    box.replaceChildren(stage, bar);
  }

  function lbStep(d) {
    const lb = W.lb;
    if (!lb) return;
    if (lb.cmp != null) {
      // Im Vergleich: Pfeile wechseln den älteren Stand
      const n = lb.list.length;
      let c = lb.cmp;
      do c = (c + d + n) % n;
      while (c === lb.i);
      lb.cmp = c;
    } else lb.i = (lb.i + d + lb.list.length) % lb.list.length;
    W.sel = lb.list[lb.i].path;
    select(W.sel);
    renderLightbox();
  }

  function lbCompare() {
    const lb = W.lb;
    if (lb.cmp != null) {
      const path = lb.list[lb.i].path;
      W.lb = null;
      return openLightbox(path, false);
    }
    openLightbox(lb.list[lb.i].path, true);
  }

  function closeLightbox() {
    W.lb = null;
    renderLightbox();
  }

  // ---- Ziehen: hinaus in Finder, Mail, InDesign; hinein kopiert in die Phase ----

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
    for (const size of [900, 320, 560, 2000]) {
      const v = thumbs.get(thumbKey(f, size));
      if (v) {
        icon = v.file;
        break;
      }
    }
    if (!icon) icon = await A.invoke("works_thumb", { path: f.path, size: 256 }).catch(() => null);
    if (!icon) return; // ohne Bild kein Ziehen, das Plugin braucht eins
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = () => {};
    W.dragging = f.path;
    A.invoke("plugin:drag|start_drag", { item: [f.path], image: icon, onEvent: channel })
      .catch(fail)
      .finally(() => setTimeout(() => (W.dragging = null), 400));
  }

  // Ziel beim Ablegen: der Phasen-Reiter unter dem Zeiger, sonst der offene Reiter
  function dropSlot(x, y) {
    if (x != null) {
      const hit = document.elementFromPoint(x, y);
      const tab = hit && hit.closest("[data-slot]");
      if (tab && tab.dataset.slot) return tab.dataset.slot;
    }
    if (PHASES.includes(W.tab) || W.tab === "post") return W.tab;
    return "research";
  }

  let dropPaths = [];
  function drop(p, x, y) {
    const target = () => host().querySelector(".w-body");
    const clear = () => {
      for (const n of document.querySelectorAll(".w-drop")) n.classList.remove("w-drop");
    };
    if (!W.path || !W.project || W.tab === "assets") {
      if (p.type === "drop" && p.paths && p.paths.length) A.toast(t(W.path ? "wDropNoAssets" : "wDropOpenProject"), false);
      return;
    }
    if (p.type === "leave") {
      dropPaths = [];
      return clear();
    }
    if (p.paths) dropPaths = p.paths;
    const slot = dropSlot(x, y);
    if (p.type === "enter" || p.type === "over") {
      clear();
      const tabNode = [...host().querySelectorAll("[data-slot]")].find((n) => n.dataset.slot === slot && !n.classList.contains("w-body"));
      if (tabNode) tabNode.classList.add("w-drop");
      const body = target();
      if (body && slot === dropSlot()) body.classList.add("w-drop");
      return;
    }
    if (p.type === "drop") {
      clear();
      const paths = dropPaths.filter((path) => path !== W.dragging || slot !== (findFile(path) || {}).slot);
      dropPaths = [];
      if (!paths.length) return;
      A.invoke("works_import", { project: W.path, slot, paths, lang })
        .then((n) => {
          if (n) A.toast(t(n === 1 ? "wImported1" : "wImported", { n, f: slotName(slot) }));
          return refresh();
        })
        .catch(fail);
    }
  }

  // ---- Tasten (app.js reicht sie durch, solange Works offen ist) ----

  function key(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (W.lb) {
      if (e.key === "Escape" || e.key === " ") closeLightbox();
      else if (e.key === "ArrowLeft") lbStep(-1);
      else if (e.key === "ArrowRight") lbStep(1);
      else if (e.key === "v" || e.key === "V") lbCompare();
      else if (e.key === "Enter") openFile(W.lb.list[W.lb.i]);
      else return false;
      return true;
    }
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return false;
    if (document.querySelector(".w-menu") && e.key === "Escape") {
      closeMenus();
      return true;
    }
    const hit = W.sel ? findFile(W.sel) : null;
    if (mod && (e.key === "r" || e.key === "R")) {
      thumbs.clear();
      refresh();
      return true;
    }
    if (mod && e.key === "ArrowUp" && W.path) {
      closeProject();
      return true;
    }
    if (mod && (e.key === "o" || e.key === "O") && hit) {
      openFile(hit.f);
      return true;
    }
    if (mod && (e.key === "n" || e.key === "N")) {
      askNewProject();
      return true;
    }
    if (mod) return false;
    if (e.key === "Escape") {
      if (W.sel) select(null);
      else if (W.path) closeProject();
      else return false;
      return true;
    }
    if (!W.path) return false;
    if (e.key === " " && hit) openLightbox(hit.f.path);
    else if (e.key === "Enter" && hit) openFile(hit.f);
    else if ((e.key === "n" || e.key === "N") && versionable(hit)) newVersion(hit.f);
    else if ((e.key === "v" || e.key === "V") && versionable(hit)) openLightbox(hit.f.path, true);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const all = visibleFiles();
      if (!all.length) return false;
      const i = all.indexOf(W.sel);
      const next = i < 0 ? 0 : Math.min(all.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)));
      select(all[next]);
      const node = [...host().querySelectorAll("[data-path]")].find((n) => n.dataset.path === all[next]);
      if (node) node.scrollIntoView({ block: "nearest" });
    } else if (/^[1-8]$/.test(e.key)) setTab(TABS[Number(e.key) - 1]);
    else return false;
    return true;
  }

  // ---- Navigation: Works › Kunde › Projekt ----

  function nav(navButton) {
    const out = [];
    if (!W.root) return out;
    if (W.path && W.project) {
      const s = W.project.summary;
      if (s.client) {
        out.push(navButton(s.client, false, () => {
          W.client = s.client;
          closeProject();
        }));
        out.push(el("span", "p-nav-sep", "›"));
      }
      const b = navButton(s.name, true);
      b.classList.add("p-nav-zone");
      out.push(b);
    } else if (W.client) {
      out.push(navButton(W.client, true, () => {
        W.client = null;
        render();
      }));
    }
    return out;
  }

  function brandClick() {
    if (W.lb) closeLightbox();
    if (W.path) closeProject();
    else if (W.client) {
      W.client = null;
      render();
    }
  }

  function brandMenu(e) {
    if (!W.root) return;
    e.preventDefault();
    rootMenu(e.clientX, e.clientY);
  }

  let changed = null;
  function init(api) {
    A = api;
    const T = window.__TAURI__;
    if (T && T.event)
      T.event.listen("works-changed", () => {
        clearTimeout(changed);
        changed = setTimeout(() => {
          if (active_() && !W.editing) refresh();
        }, 300);
      });
    window.addEventListener("focus", () => {
      if (active_() && !W.editing && W.root) refresh();
    });
  }

  // „Works“ in der Leiste ist nur auf der Projektliste aktiv, wie „Archiver“ auf der Startseite
  const atHome = () => !W.path && !W.client;

  window.ArchiverWorks = { init, enter, render, refresh, key, drop, nav, brandClick, brandMenu, closeLightbox, atHome, isOpen: () => !!W.lb };
})();
