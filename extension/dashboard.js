// dashboard.js
// Vollansicht: eigene Extension-Seite, identisch zum Seiten-Overlay (Galerie,
// Toolbar und Panels aus ui.js), nur mit solidem statt halbtransparentem
// Hintergrund.

const { loadZones, t } = ArchiverShared;
const UI = ArchiverUI;
UI.watchTheme(document.documentElement);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t("dashboardTitle");

const gallery = UI.createGallery({ mount: document.body, acceptExternalDrops: true });
document.getElementById("galleryHost").appendChild(gallery.el);
const panels = UI.createPanelController(document.getElementById("panelHost"));
const toolbar = UI.buildToolbar(gallery, document.documentElement);
toolbar.appendChild(UI.buildPanelButtons(panels));
document.getElementById("toolbarHost").appendChild(toolbar);
document.getElementById("toolbarHost").appendChild(toolbar.libTab);

document.addEventListener("keydown", (e) => {
  if (gallery.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === "Escape" && panels.mode) panels.close();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "feedback") UI.showToast(document.body, message.text, message.ok);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (ArchiverShared.zonesChanged(changes, area)) loadZones(renderActive);
});

// Mit App nur die vier Active Zones, alles Weitere in der App
function renderActive(list, info) {
  gallery.render(info && info.app && Array.isArray(info.hot) && info.hot.length ? info.hot : list, info || null);
}

loadZones(renderActive);
