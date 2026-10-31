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

