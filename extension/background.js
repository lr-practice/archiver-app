// background.js
// Service Worker: führt Downloads aus (mit oder ohne Unterordner), schickt eine
// kurze Text-Bestätigung zurück, verschiebt Bilder zwischen Zonen und beantwortet
// Galerie-Anfragen. Die Tastenkombination zum Ein-/Ausblenden des Overlays gibt
// es doppelt: frei wählbar im Content-Script und als Chrome-Befehl
// ("toggle-overlay", änderbar unter chrome://extensions/shortcuts).
//
// Bild-Index (seit v3.2.0): chrome.storage.local Key "archiveIndex"
//   { [folderKey]: [ { id, url, filename, ts, pageUrl, pageTitle } ] }   (neueste zuerst)
// pageUrl/pageTitle (seit v3.3.0): Seite, auf der das Bild gesichert wurde.
// Speichert die Metadaten selbst, statt nur Download-IDs. Dadurch bleibt die
// Galerie auch dann gefüllt, wenn der Chrome-Download-Verlauf gelöscht wird.
// Data-URLs (Dateien vom Desktop) werden nicht im Index abgelegt (zu groß),
// für sie bleibt der Download-Verlauf die Bildquelle.
// Alle Index-Änderungen laufen über eine Warteschlange (withIndex), damit
// parallele Aktionen (z. B. Mehrfach-Verschieben) sich nicht gegenseitig
// überschreiben.
//
// Brücke zur Desktop-App (seit v3.6.0): Ist die Archiver-App installiert und
// eine Bibliothek eingerichtet, kommen Zonen und Galerie aus der Bibliothek,
// und gesicherte Bilder landen direkt dort. Ohne App bleibt alles wie bisher.

const MAX_ITEMS_PER_FOLDER = 500;

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const INDEX_KEY = "archiveIndex";
const LEGACY_INDEX_KEY = "downloadsByFolder"; // bis v3.1.1: nur IDs, max. 60
const DOWNLOAD_TIMEOUT_MS = 60000;

// ---- Promise-Helfer für die Callback-APIs ----

const storageGet = (defaults) => new Promise((res) => chrome.storage.local.get(defaults, res));
const storageSet = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));
const storageRemove = (key) => new Promise((res) => chrome.storage.local.remove(key, res));
const searchDownloads = (query) => new Promise((res) => chrome.downloads.search(query, (r) => res(r || [])));
const eraseDownload = (id) => new Promise((res) => chrome.downloads.erase({ id }, () => res()));
const removeFile = (id) =>
  new Promise((res) =>
    chrome.downloads.removeFile(id, () => {
      void chrome.runtime.lastError; // Datei evtl. schon weg — kein Fehler fürs UI
      res();
    })
  );

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Download nicht gestartet"));
      } else {
        resolve(id);
      }
    });
  });
}

// Wartet, bis ein Download fertig ("complete") oder abgebrochen ("interrupted") ist.
// chrome.downloads.download meldet nur den Start — Fehler wie 403/404 kommen später.
function waitForDownload(id) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (state, item) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve({ state, item });
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        searchDownloads({ id }).then((r) => finish(delta.state.current, r[0]));
      }
    };
    const timer = setTimeout(() => finish("timeout"), DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    // Falls der Download schon fertig war, bevor der Listener hing:
    searchDownloads({ id }).then((r) => {
      const item = r[0];
      if (item && (item.state === "complete" || item.state === "interrupted")) finish(item.state, item);
    });
  });
}

// ---- Index mit Warteschlange ----

let indexQueue = Promise.resolve();

// fn(index) darf den Index verändern und einen Wert zurückgeben; danach wird gespeichert.
function withIndex(fn) {
  const run = indexQueue.then(async () => {
    const index = await loadIndex();
    const result = await fn(index);
    await storageSet({ [INDEX_KEY]: index });
    await storageRemove(LEGACY_INDEX_KEY); // alten Index erst nach erfolgreichem Speichern entfernen
    return result;
  });
  indexQueue = run.catch(() => {});
  return run;
}

async function loadIndex() {
  const data = await storageGet({ [INDEX_KEY]: null, [LEGACY_INDEX_KEY]: null });
  if (data[INDEX_KEY]) return data[INDEX_KEY];
  // Einmalige Migration aus dem alten ID-Index (v3.1.1)
  const index = {};
  const legacy = data[LEGACY_INDEX_KEY];
  if (legacy && typeof legacy === "object") {
    const all = await searchDownloads({});
    const byId = new Map(all.map((d) => [d.id, d]));
    for (const [folderKey, ids] of Object.entries(legacy)) {
      if (!Array.isArray(ids)) continue;
      index[folderKey] = ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((d) => makeEntry(d.id, d.url, d.filename, d.startTime ? Date.parse(d.startTime) : Date.now()));
    }
  }
  return index;
}

function makeEntry(id, url, filename, ts = Date.now(), source = {}) {
  return {
    id,
    url: url && !String(url).startsWith("data:") ? url : null,
    filename: filename || "",
    ts,
    pageUrl: cleanPageUrl(source.pageUrl),
    pageTitle: source.pageTitle ? String(source.pageTitle).slice(0, 300) : null,
  };
}

// Nur echte Webseiten als Quelle merken (keine chrome://-, file:- oder Data-URLs).
function cleanPageUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function addEntry(index, folderKey, entry) {
  const list = Array.isArray(index[folderKey]) ? index[folderKey].filter((e) => e.id !== entry.id) : [];
  list.unshift(entry);
  if (list.length > MAX_ITEMS_PER_FOLDER) list.length = MAX_ITEMS_PER_FOLDER;
  index[folderKey] = list;
}

function removeEntry(index, folderKey, id) {
  if (Array.isArray(index[folderKey])) index[folderKey] = index[folderKey].filter((e) => e.id !== id);
}

// ---- Brücke zur Desktop-App (Chrome Native Messaging) ----
// Die App meldet sich bei Chrome als Host "app.archiver.bridge" an. Eine
// Verbindung bleibt offen, solange Anfragen laufen, und schließt nach 30 s Ruhe.
// Speichern: Chrome lädt das Bild wie gewohnt, aber in Downloads/Archiver-Transfer;
// die App verschiebt es von dort in die Zone und merkt sich die Quelle.

const HOST_NAME = "app.archiver.bridge";
const TRANSFER_DIR = "Archiver-Transfer";
const HOST_TIMEOUT_MS = 20000;
const BRIDGE_CACHE_MS = 5000;
const PREVIEW_CACHE_MAX = 1500;

let hostPort = null;
let hostSeq = 1;
const hostPending = new Map();
let hostIdleTimer = null;
let bridgeCache = { at: 0, info: null };
const previewCache = new Map(); // hash -> data-URL

function hostCall(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!hostPort) {
      let port;
      try {
        port = chrome.runtime.connectNative(HOST_NAME);
      } catch (err) {
        reject(err);
        return;
      }
      port.onMessage.addListener((msg) => {
        const pending = msg && hostPending.get(msg.id);
        if (!pending) return;
        hostPending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg);
        else pending.reject(new Error(msg.error || "App-Fehler"));
      });
      port.onDisconnect.addListener(() => {
        const err = new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "App getrennt");
        if (hostPort === port) hostPort = null;
        for (const pending of hostPending.values()) {
          clearTimeout(pending.timer);
          pending.reject(err);
        }
        hostPending.clear();
      });
      hostPort = port;
    }
    const id = hostSeq++;
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new Error("App antwortet nicht"));
    }, HOST_TIMEOUT_MS);
    hostPending.set(id, { resolve, reject, timer });
    hostPort.postMessage({ id, cmd, ...args });
    clearTimeout(hostIdleTimer);
    hostIdleTimer = setTimeout(closeHostWhenIdle, 30000);
  });
}

function closeHostWhenIdle() {
  if (hostPending.size) {
    hostIdleTimer = setTimeout(closeHostWhenIdle, 30000);
    return;
  }
  if (hostPort) hostPort.disconnect();
  hostPort = null;
}

// Infos zur App (Bibliotheksname) oder null, wenn keine App bzw. keine Bibliothek.
async function appBridge() {
  if (Date.now() - bridgeCache.at < BRIDGE_CACHE_MS) return bridgeCache.info;
  let info = null;
  try {
    // ext: eigene Version, damit die App einen Hinweis zeigen kann, wenn sie veraltet ist
    const r = await hostCall("hello", { ext: chrome.runtime.getManifest().version });
    if (r.library) info = { library: r.library, name: r.name || "Archiver", version: r.version, libraries: Array.isArray(r.libraries) ? r.libraries : [] };
  } catch {}
  bridgeCache = { at: Date.now(), info };
  return info;
}

// Zonen der Bibliothek in der Reihenfolge der App. Die ersten vier („hot“)
// legt die Übersicht der App fest; nur sie erscheinen beim Ziehen.
// Das Ergebnis liegt zusätzlich in storage.local "appZones", damit offene
// Oberflächen neu zeichnen, wenn sich etwas ändert.
let bridgeDefaultZone = null; // Standard-Zone der App (Standard: Unsorted)
let bridgeFolders = {}; // Zone → Ordner darin (bis zwei Ebenen), fürs Rechtsklickmenü

// Zonen einer anderen Bibliothek (⇧ beim Ziehen): nur die Active Zones zählen
async function libraryZones(library) {
  const info = await appBridge();
  if (!info) return { app: false };
  const libraries = info.libraries || [];
  const r = await hostCall("zones", { library: library || null });
  const zones = (r.zones || []).map((z) => z.path);
  const hot = Array.isArray(r.hot) && r.hot.length ? r.hot.filter((n) => zones.includes(n)) : zones.slice(0, 4);
  return { app: true, libraries, library: library || null, zones, hot, alpha: typeof r.alpha === "number" ? r.alpha : null };
}

// Zuletzt genutzte Zonen (oben im Rechtsklickmenü)
async function rememberRecent(zone) {
  if (!zone) return;
  const { recentZones } = await storageGet({ recentZones: [] });
  const list = [zone, ...(Array.isArray(recentZones) ? recentZones : []).filter((z) => z !== zone)].slice(0, 3);
  if (JSON.stringify(list) !== JSON.stringify(recentZones)) {
    await storageSet({ recentZones: list });
    buildMenus();
  }
}

async function getZones() {
  const info = await appBridge();
  if (info) {
    try {
      const r = await hostCall("zones");
      const zones = (r.zones || []).map((z) => z.path);
      bridgeDefaultZone = r.default || null;
      const hot = Array.isArray(r.hot) ? r.hot.filter((n) => zones.includes(n)) : zones.slice(0, 4);
      bridgeFolders = r.folders && typeof r.folders === "object" ? r.folders : {};
      await publishAppZones({ zones, hot });
      const alpha = typeof r.alpha === "number" ? r.alpha : null;
      const { appZoneAlpha } = await storageGet({ appZoneAlpha: null });
      if (appZoneAlpha !== alpha) await storageSet({ appZoneAlpha: alpha });
      // Ecken aus der App (square, soft, round, xl), gelten in Overlay und Galerie
      const radius = typeof r.radius === "string" ? r.radius : null;
      const { appRadius } = await storageGet({ appRadius: null });
      if (appRadius !== radius) await storageSet({ appRadius: radius });
      return { app: true, library: info.name, zones, hot };
    } catch {}
  }
  await publishAppZones(null);
  return { app: false };
}

async function publishAppZones(zones) {
  const { appZones } = await storageGet({ appZones: null });
  if (JSON.stringify(appZones) !== JSON.stringify(zones)) await storageSet({ appZones: zones });
}

async function saveToApp(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId;
  // ohne Zone entscheidet die App (Standard-Zone, sonst Unsorted)
  const zone = message.folder ? sanitizePath(message.folder) : null;
  const filename = buildFilename(message.url, message.suggestedName, TRANSFER_DIR);

  let id;
  try {
    id = await startDownload({ url: message.url, filename, saveAs: false, conflictAction: "uniquify" });
  } catch (err) {
    console.warn("[Archiver] Download fehlgeschlagen:", err.message);
    sendFeedback(tabId, frameId, t("downloadFailed"), false);
    return { ok: false };
  }
  const { state, item } = await waitForDownload(id);
  if (state !== "complete" || !item) {
    if (state === "interrupted") await eraseDownload(id);
    sendFeedback(tabId, frameId, t("downloadFailed"), false);
    return { ok: false };
  }
  try {
    const r = await hostCall("save", {
      file: item.filename,
      name: filename.split("/").pop(),
      zone,
      imageUrl: message.url && !String(message.url).startsWith("data:") ? message.url : null,
      pageUrl: cleanPageUrl(message.pageUrl),
      pageTitle: message.pageTitle ? String(message.pageTitle).slice(0, 300) : null,
      quote: message.quote ? String(message.quote).slice(0, 20000) : null,
      tone: message.tone || null,
      caption: message.caption ? String(message.caption).slice(0, 2000) : null,
      capturedAt: Date.now(),
      library: message.library || null,
    });
    if (!message.library) rememberRecent(zone || bridgeDefaultZone);
    await eraseDownload(id); // Datei liegt jetzt in der Bibliothek, Eintrag im Verlauf wäre tot
    // Gleiches Bild schon in der Bibliothek: nicht doppelt ablegen, sagen wo es liegt
    const where = String(r.path || "").split("/").slice(0, -1).pop() || "Unsorted";
    if (r.duplicate) sendFeedback(tabId, frameId, t("duplicateIn", [where]), true);
    else if (!message.quiet) sendFeedback(tabId, frameId, t("savedIn", [where]), true);
    return { ok: true, id: r.path };
  } catch (err) {
    console.warn("[Archiver] Übergabe an die App fehlgeschlagen:", err.message);
    bridgeCache.at = 0;
    sendFeedback(tabId, frameId, t("appSaveFailed"), false);
    return { ok: false };
  }
}

async function listAppFolder(zone) {
  const r = await hostCall("list", { zone: zone || null });
  const items = await Promise.all(
    (r.items || []).map(async (it) => ({
      id: it.path,
      url: it.quote ? textPreview(it.quote, it.tone, it.hash) : (await appPreview(it)) || it.imageUrl || "",
      filename: it.path,
      inHistory: true,
      pageUrl: it.pageUrl || null,
      pageTitle: it.pageTitle || null,
      ts: it.ts || null,
    }))
  );
  return { items };
}

// Textkarte (.txt) für die Galerie: kleines SVG in der Kartenfarbe (content.js CARD_TONES)
const PREVIEW_TONES = {
  red: ["#ff0000", "#5c0000"],
  green: ["#00b050", "#003d1c"],
  violet: ["#7030a0", "#e2c8f5"],
  cyan: ["#00b0f0", "#003d54"],
  yellow: ["#ffff00", "#5c5c00"],
  white: ["#f4f3ef", "#141414"],
};
function textPreview(quote, tone, hash) {
  const keys = Object.keys(PREVIEW_TONES).slice(0, 5);
  let h = 0;
  for (const c of String(hash || quote)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [bg, fg] = PREVIEW_TONES[tone] || PREVIEW_TONES[keys[h % keys.length]];
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const words = String(quote).trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 22) {
      lines.push(line.trim());
      line = w;
      if (lines.length === 7) break;
    } else line += " " + w;
  }
  if (lines.length < 7 && line.trim()) lines.push(line.trim());
  const text = lines.map((l, i) => `<tspan x="24" dy="${i ? 30 : 0}">${esc(l)}</tspan>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
    `<rect width="300" height="300" fill="${bg}"/>` +
    `<text x="24" y="52" fill="${fg}" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="24" font-weight="500">${text}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

async function appPreview(it) {
  if (previewCache.has(it.hash)) return previewCache.get(it.hash);
  try {
    const r = await hostCall("preview", { path: it.path });
    if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value);
    previewCache.set(r.hash, r.dataUrl);
    return r.dataUrl;
  } catch {
    return null;
  }
}

async function moveInApp(path, targetZone) {
  try {
    const r = await hostCall("move", { paths: [path], zone: targetZone || bridgeDefaultZone || "Unsorted" });
    return { ok: true, newId: (r.moved || [])[0] || path };
  } catch (err) {
    return { ok: false, error: err.message || t("moveFailed") };
  }
}

async function createAppZone(name) {
  const r = await hostCall("create_zone", { name });
  bridgeCache.at = 0;
  return r.zone;
}

// ---- Chrome-Befehl: Overlay im aktiven Tab umschalten (nur Top-Frame) ----

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab || tab.id == null) return;
  if (command === "toggle-overlay") chrome.tabs.sendMessage(tab.id, { type: "toggle-overlay" }, { frameId: 0 }).catch(() => {});
  if (command === "capture-area") chrome.tabs.sendMessage(tab.id, { type: "capture-start" }, { frameId: 0 }).catch(() => {});
});

// ---- Rechtsklick: „Ablegen in“ › Zone, dazu „Ausschnitt sichern…“ ----
// Die Seite (content.js) entscheidet, was gesichert wird: das Bild unter dem
// Mauszeiger (auch Hintergrundbilder und Bilder hinter Overlays), markierter
// Text oder ein Link als Karte, sonst ein Bildschirmfoto der Seite.

const MENU_CONTEXTS = ["page", "image", "selection", "link", "frame", "video", "audio"];
let menuZones = [];
let menuBuild = Promise.resolve();

async function menuZoneList() {
  const z = await getZones().catch(() => ({ app: false }));
  if (z.app) return z.zones.map((name) => ({ name, folder: name, folders: bridgeFolders[name] || [] }));
  const { zones } = await new Promise((r) => chrome.storage.sync.get({ zones: null, projects: null }, r));
  const names = (Array.isArray(zones) && zones.length ? zones : ["Projekt 1", "Projekt 2", "Projekt 3", "Downloads"]).filter(Boolean);
  return names.map((name) => ({ name, folder: String(name).trim().toLowerCase() === "downloads" ? null : name }));
}

function lastName(path) {
  return String(path).split("/").pop();
}

function buildMenus() {
  menuBuild = menuBuild.then(async () => {
    menuZones = await menuZoneList();
    await new Promise((r) => chrome.contextMenus.removeAll(r));
    chrome.contextMenus.create({ id: "archiver", title: t("menuDropIn"), contexts: MENU_CONTEXTS });
    // Ziele als flache Liste; die Menü-IDs zeigen auf ihren Index
    const zones = menuZones;
    menuZones = [];
    const target = (entry) => menuZones.push(entry) - 1;
    const pretty = (path) => String(path).split("/").join(" / ");
    // Oben die drei zuletzt genutzten Zonen bzw. Ordner
    const { recentZones } = await storageGet({ recentZones: [] });
    const known = new Set(zones.flatMap((z) => [z.folder, ...(z.folders || []).map((f) => z.folder + "/" + f)]));
    const recent = (Array.isArray(recentZones) ? recentZones : []).filter((r) => known.has(r)).slice(0, 3);
    for (const r of recent) {
      chrome.contextMenus.create({ id: "zone:" + target({ name: r, folder: r }), parentId: "archiver", title: pretty(r), contexts: MENU_CONTEXTS });
    }
    if (recent.length) chrome.contextMenus.create({ id: "sep-recent", parentId: "archiver", type: "separator", contexts: MENU_CONTEXTS });
    // Darunter alle Zonen, Zonen mit Ordnern klappen auf (Zone selbst, dann Ordner › Unterordner)
    zones.forEach((zone, zi) => {
      const label = pretty(zone.name);
      const folders = zone.folders || [];
      if (!folders.length) {
        chrome.contextMenus.create({ id: "zone:" + target(zone), parentId: "archiver", title: label, contexts: MENU_CONTEXTS });
        return;
      }
      const parent = "group:" + zi;
      chrome.contextMenus.create({ id: parent, parentId: "archiver", title: label, contexts: MENU_CONTEXTS });
      chrome.contextMenus.create({ id: "zone:" + target(zone), parentId: parent, title: t("menuZoneItself", [lastName(zone.name)]), contexts: MENU_CONTEXTS });
      chrome.contextMenus.create({ id: parent + ":sep", parentId: parent, type: "separator", contexts: MENU_CONTEXTS });
      const tops = folders.filter((f) => !f.includes("/"));
      for (const top of tops) {
        const subs = folders.filter((f) => f.startsWith(top + "/"));
        const entry = { name: zone.name + "/" + top, folder: zone.folder + "/" + top };
        if (!subs.length) {
          chrome.contextMenus.create({ id: "zone:" + target(entry), parentId: parent, title: top, contexts: MENU_CONTEXTS });
          continue;
        }
        const sub = parent + ":" + top;
        chrome.contextMenus.create({ id: sub, parentId: parent, title: top, contexts: MENU_CONTEXTS });
        chrome.contextMenus.create({ id: "zone:" + target(entry), parentId: sub, title: t("menuZoneItself", [top]), contexts: MENU_CONTEXTS });
        chrome.contextMenus.create({ id: sub + ":sep", parentId: sub, type: "separator", contexts: MENU_CONTEXTS });
        for (const f of subs) {
          const e = { name: zone.name + "/" + f, folder: zone.folder + "/" + f };
          chrome.contextMenus.create({ id: "zone:" + target(e), parentId: sub, title: f.slice(top.length + 1), contexts: MENU_CONTEXTS });
        }
      }
    });
    chrome.contextMenus.create({ id: "sep", parentId: "archiver", type: "separator", contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: "area", parentId: "archiver", title: t("menuArea"), contexts: MENU_CONTEXTS });
  });
  return menuBuild;
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);
// Gleich beim Laden bei der App melden (Hinweis „Extension fehlt“ verschwindet)
chrome.runtime.onInstalled.addListener(() => appBridge());
chrome.runtime.onStartup.addListener(() => appBridge());
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && changes.zones) || (area === "local" && (changes.appZones || changes.appZoneOrder))) buildMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === "area") {
    chrome.tabs.sendMessage(tab.id, { type: "capture-start" }, { frameId: 0 }).catch(() => {});
    return;
  }
  const m = String(info.menuItemId).match(/^zone:(\d+)$/);
  const zone = m && menuZones[Number(m[1])];
  if (!zone) return;
  // Geöffnetes PDF: Chromes PDF-Ansicht hat kein Content-Script, die Datei direkt sichern
  if (!info.srcUrl && !info.linkUrl && !info.selectionText && isPdfUrl(tab.url)) {
    handleDownload({ url: tab.url, folder: zone.folder, pageUrl: tab.url, pageTitle: tab.title }, { tab, frameId: 0 });
    return;
  }
  const message = {
    type: "context-save",
    folder: zone.folder,
    srcUrl: info.mediaType === "image" ? info.srcUrl : null,
    videoUrl: info.mediaType === "video" || info.mediaType === "audio" ? info.srcUrl || "page" : null,
    linkUrl: info.linkUrl || null,
    selectionText: info.selectionText || null,
  };
  chrome.tabs.sendMessage(tab.id, message, { frameId: info.frameId || 0 }).catch(() => {
    // Seite ohne Content-Script (z. B. frisch installiert): direkt sichern
    if (message.srcUrl) handleDownload({ url: message.srcUrl, folder: zone.folder, pageUrl: tab.url, pageTitle: tab.title }, { tab, frameId: 0 });
    else captureVisible({ folder: zone.folder, pageUrl: tab.url, pageTitle: tab.title }, { tab, frameId: 0 });
  });
});

function isPdfUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /\.(pdf|wav|mp3|aif|aiff|m4a|flac)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// ---- Video-Karten: Titel und Vorschaubild von YouTube bzw. Vimeo (oEmbed) ----

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

async function imageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const type = res.headers.get("content-type") || "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

async function videoInfo(url) {
  const yt = youtubeId(url);
  const endpoint = yt
    ? "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url)
    : "https://vimeo.com/api/oembed.json?width=1280&url=" + encodeURIComponent(url);
  let meta = {};
  try {
    const res = await fetch(endpoint);
    if (res.ok) meta = await res.json();
  } catch {}
  // YouTube: größtes Vorschaubild zuerst (nicht jedes Video hat eins)
  const candidates = yt ? [`https://i.ytimg.com/vi/${yt}/maxresdefault.jpg`, meta.thumbnail_url] : [meta.thumbnail_url];
  let thumb = null;
  for (const c of candidates.filter(Boolean)) {
    try {
      thumb = await imageAsDataUrl(c);
      break;
    } catch {}
  }
  return { title: meta.title || null, thumb };
}

// ---- Bildschirmfoto der sichtbaren Seite, wahlweise nur ein Ausschnitt ----

async function captureVisible(message, sender) {
  const tab = sender.tab;
  if (!tab) return { ok: false };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    sendFeedback(tab.id, sender.frameId, t("captureFailed"), false);
    return { ok: false };
  }
  const r = message.rect;
  if (r && r.w > 2 && r.h > 2) {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // Skalierung aus dem echten Foto statt devicePixelRatio (Zoomstufe der Seite)
    const scale = bitmap.width / (r.vw || bitmap.width);
    const sx = Math.max(0, Math.round(r.x * scale));
    const sy = Math.max(0, Math.round(r.y * scale));
    const sw = Math.min(bitmap.width - sx, Math.round(r.w * scale));
    const sh = Math.min(bitmap.height - sy, Math.round(r.h * scale));
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    dataUrl = await new Promise((res) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.readAsDataURL(blob);
    });
  }
  const base = String(message.pageTitle || tab.title || "Seite").replace(/\s+/g, " ").trim().slice(0, 80) || "Seite";
  const name = (r ? t("captureNameArea") + " " : "") + base + ".png";
  return handleDownload(
    { url: dataUrl, suggestedName: name, folder: message.folder, library: message.library || null, pageUrl: message.pageUrl || tab.url, pageTitle: message.pageTitle || tab.title },
    sender
  );
}

// ---- Nachrichten ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "download-image" && message.url) {
    handleDownload(message, sender).then(sendResponse);
    return true;
  }

  // ⇧ beim Ziehen: Liste der Bibliotheken und Active Zones der gewählten
  if (message.type === "library-zones") {
    libraryZones(message.library).then(sendResponse, () => sendResponse({ app: false }));
    return true;
  }

  if (message.type === "video-info" && message.url) {
    videoInfo(message.url).then(sendResponse, () => sendResponse(null));
    return true;
  }

  // Pinterest-Board importieren: Popup → Seite sammelt → hier ablegen
  if (message.type === "pinterest-import" && message.tabId != null) {
    chrome.tabs.sendMessage(message.tabId, { type: "pinterest-collect" }, { frameId: 0 }).catch(() => {});
    return;
  }
  if (message.type === "pinterest-pins" && Array.isArray(message.pins)) {
    importPinterestPins(message, sender);
    return;
  }

  if (message.type === "capture-visible") {
    captureVisible(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "get-zones") {
    getZones().then(sendResponse, () => sendResponse({ app: false }));
    return true;
  }


  if (message.type === "create-app-zone" && message.name) {
    createAppZone(String(message.name)).then(
      (zone) => sendResponse({ ok: true, zone }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  }

  if (message.type === "list-folder-downloads") {
    appBridge()
      .then((info) => (info ? listAppFolder(message.folder) : listFolder(message.folder ? sanitizePath(message.folder) : "")))
      .then(sendResponse, () => sendResponse({ items: [] }));
    return true;
  }

  // Bilder aus der App-Bibliothek haben ihren Pfad als ID (Text statt Zahl).
  if (message.type === "show-download" && typeof message.id === "string") {
    hostCall("reveal", { path: message.id }).catch(() => {});
    return;
  }

  if (message.type === "move-download" && typeof message.id === "string") {
    if ((message.sourceFolder || "") === (message.targetFolder || "")) {
      sendResponse({ ok: true, unchanged: true });
      return;
    }
    moveInApp(message.id, message.targetFolder).then(sendResponse);
    return true;
  }

  if (message.type === "show-download" && message.id != null) {
    searchDownloads({ id: message.id }).then((r) => {
      if (r[0] && r[0].exists !== false) chrome.downloads.show(message.id);
      else chrome.downloads.showDefaultFolder(); // nicht mehr im Verlauf → wenigstens den Ordner öffnen
    });
    return;
  }

  if (message.type === "open-chrome-page") {
    const pages = { downloads: "chrome://settings/downloads", shortcuts: "chrome://extensions/shortcuts" };
    if (pages[message.page]) chrome.tabs.create({ url: pages[message.page] });
    return;
  }

  if (message.type === "export-for-app") {
    exportForApp().then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "open-app") {
    hostCall("open_app").catch(() => {});
    return;
  }

  if (message.type === "open-dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    return;
  }

  if (message.type === "move-download" && message.id != null) {
    moveDownload(message.id, message.sourceFolder || "", message.targetFolder || "").then(sendResponse, (err) =>
      sendResponse({ ok: false, error: err.message || t("moveFailed") })
    );
    return true;
  }
});

// ---- Export für die Desktop-App ----
// Schreibt Downloads/archiver-export.json: alle Zonen und jedes Bild aus dem
// Index mit echtem Speicherort (aus dem Download-Verlauf) und Quelle. Die App
// importiert damit Bilder samt Quellen in ihre Bibliothek.

async function exportForApp() {
  const sync = await new Promise((res) => chrome.storage.sync.get({ zones: null, projects: null }, res));
  const names = (Array.isArray(sync.zones) && sync.zones.length ? sync.zones : sync.projects || []).filter(Boolean);
  const zoneKey = (name) => (String(name).trim().toLowerCase() === "downloads" ? "" : sanitizePath(name));

  const index = await loadIndex();
  const all = await searchDownloads({});
  const byId = new Map(all.map((d) => [d.id, d]));
  const items = [];
  for (const [folderKey, entries] of Object.entries(index)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      const d = byId.get(e.id);
      if (!d || d.state !== "complete" || d.exists === false || !d.filename) continue;
      items.push({
        zone: folderKey,
        file: d.filename,
        url: e.url || null,
        pageUrl: e.pageUrl || null,
        pageTitle: e.pageTitle || null,
        ts: e.ts || null,
      });
    }
  }

  const doc = { version: 1, exportedAt: new Date().toISOString(), zones: names.map(zoneKey), items };
  const json = JSON.stringify(doc, null, 2);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const url = "data:application/json;base64," + btoa(binary);
  await startDownload({ url, filename: "archiver-export.json", saveAs: false, conflictAction: "overwrite" });
  return { ok: true, count: items.length };
}

// ---- Download ----

// Mit Shift abgelegt: schlicht in den Download-Ordner, ohne Archiv und Galerie
async function saveToDownloads(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId;
  const filename = buildFilename(message.url, message.suggestedName, "");
  let id;
  try {
    id = await startDownload({ url: message.url, filename, saveAs: false, conflictAction: "uniquify" });
  } catch (err) {
    console.warn("[Archiver] Download fehlgeschlagen:", err.message);
    sendFeedback(tabId, frameId, t("downloadFailed"), false);
    return { ok: false };
  }
  const { state } = await waitForDownload(id);
  if (state !== "complete") {
    if (state === "interrupted") await eraseDownload(id);
    sendFeedback(tabId, frameId, t("downloadFailed"), false);
    return { ok: false };
  }
  sendFeedback(tabId, frameId, t("savedIn", ["Downloads"]), true);
  return { ok: true };
}

// Textkarte als reine Textdatei: im Finder lesbar, Archiver zeigt sie als farbige Karte.
// Ohne App bleibt es die Bildkarte, damit die Galerie der Extension sie zeigen kann.
function asTextFile(message) {
  if (!message.textCard || !message.quote) return message;
  const base = String(message.suggestedName || "Text").replace(/\.png$/i, "");
  return { ...message, url: "data:text/plain;charset=utf-8," + encodeURIComponent(String(message.quote).trim() + "\n"), suggestedName: base + ".txt" };
}

async function handleDownload(message, sender) {
  if (message.toDownloads) return saveToDownloads(message, sender);
  if (await appBridge()) return saveToApp(asTextFile(message), sender);
  const folderKey = message.folder ? sanitizePath(message.folder) : "";
  const filename = buildFilename(message.url, message.suggestedName, folderKey);
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId;
  const label = folderKey || "Downloads";

  let id;
  try {
    id = await startDownload({ url: message.url, filename, saveAs: false, conflictAction: "uniquify" });
  } catch (err) {
    console.warn("[Archiver] Download fehlgeschlagen:", err.message);
    sendFeedback(tabId, frameId, t("downloadFailed"), false);
    return { ok: false };
  }

  // Sofort eintragen, damit die Galerie das Bild direkt zeigt …
  const source = { pageUrl: message.pageUrl, pageTitle: message.pageTitle };
  await withIndex((index) => addEntry(index, folderKey, makeEntry(id, message.url, filename, Date.now(), source)));
  if (!message.quiet) sendFeedback(tabId, frameId, t("savedIn", [label]), true);

  // … und wieder austragen, falls der Download doch scheitert (z. B. 403).
  const { state, item } = await waitForDownload(id);
  if (state === "interrupted") {
    await withIndex((index) => removeEntry(index, folderKey, id));
    await eraseDownload(id);
    sendFeedback(tabId, frameId, t("downloadFailed"), false);
    return { ok: false };
  }
  if (state === "complete" && item) {
    // tatsächlichen Dateinamen übernehmen (uniquify kann " (1)" anhängen)
    await withIndex((index) => {
      const entry = (index[folderKey] || []).find((e) => e.id === id);
      if (entry) entry.filename = item.filename;
    });
  }
  return { ok: true, id };
}

function sendFeedback(tabId, frameId, text, ok) {
  if (tabId == null) return;
  const message = { type: "feedback", text, ok };
  const promise = frameId != null ? chrome.tabs.sendMessage(tabId, message, { frameId }) : chrome.tabs.sendMessage(tabId, message);
  promise.catch(() => {});
}

// ---- Galerie ----

// Läuft über die Warteschlange, damit eine evtl. nötige Migration gespeichert
// wird und im Finder gelöschte Dateien direkt aus dem Index fliegen.
function listFolder(folderKey) {
  return withIndex(async (index) => {
    const entries = Array.isArray(index[folderKey]) ? index[folderKey] : [];
    if (!entries.length) return { items: [] };

    const all = await searchDownloads({});
    const byId = new Map(all.map((d) => [d.id, d]));
    const items = [];

    for (const entry of entries) {
      const d = byId.get(entry.id);
      if (d && d.exists === false && d.state === "complete") {
        removeEntry(index, folderKey, entry.id); // im Finder gelöscht → aus der Galerie nehmen
        continue;
      }
      items.push({
        id: entry.id,
        url: (d && d.url) || entry.url || "",
        filename: (d && d.filename) || entry.filename,
        inHistory: !!d,
        pageUrl: entry.pageUrl || null,
        pageTitle: entry.pageTitle || null,
      });
    }
    return { items };
  });
}

// ---- Verschieben ----
// Extensions können Dateien nicht direkt verschieben. Deshalb: Datei im Zielordner
// neu aus derselben Quelle anlegen, ABWARTEN bis sie vollständig da ist, erst dann
// das Original löschen. Scheitert der neue Download (Quelle offline, Link
// abgelaufen), bleibt das Original unangetastet und das UI bekommt einen Grund.

async function moveDownload(oldId, sourceFolderRaw, targetFolderRaw) {
  const sourceFolderKey = sourceFolderRaw ? sanitizePath(sourceFolderRaw) : "";
  const targetFolderKey = targetFolderRaw ? sanitizePath(targetFolderRaw) : "";
  if (sourceFolderKey === targetFolderKey) return { ok: true, unchanged: true };

  const [item] = await searchDownloads({ id: oldId });
  if (!item) {
    return { ok: false, error: t("moveNotInHistory") };
  }

  const baseName = (item.filename || "").split(/[\\/]/).pop() || `image-${Date.now()}.jpg`;
  const newFilename = targetFolderKey ? `${targetFolderKey}/${baseName}` : baseName;

  let newId;
  try {
    newId = await startDownload({ url: item.url, filename: newFilename, saveAs: false, conflictAction: "uniquify" });
  } catch (err) {
    console.warn("[Archiver] Verschieben fehlgeschlagen:", err.message);
    return { ok: false, error: t("moveSourceUnreachable") };
  }

  const { state, item: newItem } = await waitForDownload(newId);
  if (state !== "complete") {
    if (state === "interrupted") await eraseDownload(newId);
    return {
      ok: false,
      error: state === "timeout" ? t("moveTimeout") : t("moveSourceUnreachable"),
    };
  }

  await withIndex((index) => {
    const old = (index[sourceFolderKey] || []).find((e) => e.id === oldId) || {};
    removeEntry(index, sourceFolderKey, oldId);
    addEntry(
      index,
      targetFolderKey,
      makeEntry(newId, item.url, newItem ? newItem.filename : newFilename, old.ts || Date.now(), old)
    );
  });
  await removeFile(oldId);
  await eraseDownload(oldId);
  return { ok: true, newId };
}

// ---- Dateinamen ----

function buildFilename(url, suggestedName, folder) {
  const prefix = folder ? `${folder}/` : "";

  if (suggestedName) {
    return `${prefix}${sanitizeSegment(suggestedName)}`;
  }
  try {
    const u = new URL(url);
    if (u.protocol === "data:") throw new Error("data-url");
    let name = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (!name) name = "image";
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(name)) {
      name += ".jpg";
    }
    return `${prefix}${sanitizeSegment(name)}`;
  } catch {
    const ext = url.startsWith("data:image/png") ? "png" : url.startsWith("data:image/webp") ? "webp" : "jpg";
    return `${prefix}image-${Date.now()}.${ext}`;
  }
}

// Erlaubt verschachtelte Pfade wie "Kunden/Projekt-A", relativ zum Chrome-Downloads-Ordner.
function sanitizePath(pathStr) {
  return (
    pathStr
      .split("/")
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .map(sanitizeSegment)
      .join("/") || "Archiver"
  );
}

function sanitizeSegment(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 150);
}

// ---- Pinterest-Board importieren (Entwicklungshilfe) ----
// Legt alle Pins eines Boards in einer Zone mit dem Namen des Boards ab,
// drei Downloads gleichzeitig, mit Zwischenstand als Meldung auf der Seite.

async function importPinterestPins({ board, pins }, sender) {
  const tabId = sender.tab && sender.tab.id;
  let zone = sanitizePath(String(board || "Pinterest").replace(/\//g, "-")) || "Pinterest";
  if (await appBridge()) {
    const { zones } = await getZones();
    if (!(zones || []).includes(zone)) zone = await createAppZone(zone).catch(() => zone);
  } else {
    const { zones } = await new Promise((r) => chrome.storage.sync.get({ zones: [] }, r));
    if (!zones.includes(zone)) await new Promise((r) => chrome.storage.sync.set({ zones: [...zones, zone] }, r));
  }
  const quietSender = { tab: tabId != null ? { id: tabId } : null, frameId: 0 };
  let done = 0;
  let failed = 0;
  const queue = pins.slice();
  const worker = async () => {
    while (queue.length) {
      const pin = queue.shift();
      const r = await handleDownload({ ...pin, folder: zone, quiet: true }, quietSender).catch(() => ({ ok: false }));
      if (r && r.ok) done++;
      else failed++;
      if ((done + failed) % 10 === 0) sendFeedback(tabId, 0, `Pinterest: ${done + failed} / ${pins.length}`, true);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  sendFeedback(tabId, 0, `${zone}: ${done} abgelegt${failed ? `, ${failed} fehlgeschlagen` : ""}`, failed === 0);
}
