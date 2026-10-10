// popup.js
// Toolbar-Popup: dieselben Einstellungen und dieselbe Information wie im
// Overlay und in der Vollansicht (aus ui.js), nur ohne eigene Kopfzeile.

const { applyI18n } = ArchiverShared;
const UI = ArchiverUI;
UI.watchTheme(document.documentElement);

document.documentElement.lang = chrome.i18n.getUILanguage();
applyI18n(document);

const settingsTab = document.getElementById("tabSettings");
const infoTab = document.getElementById("tabInfo");
const infoBtn = document.getElementById("infoBtn");

settingsTab.appendChild(UI.buildSettingsPanel().el);
infoTab.appendChild(UI.buildInfoPanel().el);

infoBtn.addEventListener("click", () => {
  const showingInfo = infoTab.classList.contains("active");
  infoTab.classList.toggle("active", !showingInfo);
  settingsTab.classList.toggle("active", showingInfo);
  infoBtn.classList.toggle("active", !showingInfo);
});

document.getElementById("closeBtn").addEventListener("click", () => window.close());

// Ohne App: Vollansicht im Tab. Mit App: die App selbst öffnen.
const mainBtn = document.getElementById("dashboardBtn");
let withApp = false;
ArchiverShared.loadZones((list, info) => {
  withApp = !!(info && info.app);
  if (!withApp) return;
  mainBtn.textContent = chrome.i18n.getMessage("openApp") + " ↗";
  mainBtn.title = chrome.i18n.getMessage("openAppTitle");
});
mainBtn.addEventListener("click", () => {
  if (withApp) chrome.runtime.sendMessage({ type: "open-app" });
  else chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
});

// Auf einem Pinterest-Board: alle Pins in eine Zone mit dem Board-Namen holen
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const m = tab && tab.url && tab.url.match(/^https:\/\/([a-z]+\.)?pinterest\.[a-z.]+\/([^/]+)\/([^/?#]+)\/?(\?|#|$)/);
  if (!m || ["pin", "search", "ideas", "today", "_saved", "_created"].includes(m[2]) || m[3].startsWith("_")) return;
  const name = decodeURIComponent(m[3]).replace(/-/g, " ");
  const block = UI.block("Pinterest");
  const row = document.createElement("div");
  row.className = "block-row popup-board";
  row.appendChild(document.createElement("span")).textContent = name;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini-action";
  btn.textContent = chrome.i18n.getMessage("importBoard") || "Board importieren";
  btn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "pinterest-import", tabId: tab.id });
    window.close();
  });
  row.appendChild(btn);
  block.appendChild(row);
  settingsTab.prepend(block);
});
