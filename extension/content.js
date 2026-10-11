// content.js
// Zeigt beim Ziehen eines Bildes eine frei konfigurierbare Anzahl Ablage-Zonen am
// unteren Bildschirmrand an. Eine Zone namens "Downloads" (Groß-/Kleinschreibung
// egal) speichert ohne Unterordner direkt im normalen Downloads-Ordner, alle
// anderen Zonennamen werden als (Unter-)Ordnerpfad verwendet. Ermittelt beim Start
// des Drags nach Möglichkeit die höchstaufgelöste Bildquelle statt der sichtbaren
// Thumbnail-URL und zeigt nach dem Download eine kurze Text-Bestätigung.
//
// Per Tastenkombination (eigene oder Chrome-Befehl) öffnet sich das Overlay:
// dieselbe Ansicht wie die Vollansicht (ui.js), nur halbtransparent über der
// Seite. Die Zonenleiste gibt es nur während eines Drags. Alles Sichtbare lebt
// in einem eigenen Shadow DOM, damit Seiten-CSS und unsere Styles sich nicht
// gegenseitig beeinflussen.

(function () {
  const ZONE_HEIGHT_VH = 32; // muss zu .zones-bar in overlay.css passen
  const { DEFAULT_ZONES, DEFAULT_SHORTCUT, isRootZoneName, loadZones, debugLog, currentPageSource, extractDroppedImage, t } =
    ArchiverShared;
  const UI = ArchiverUI;

  let zones = DEFAULT_ZONES.slice();
  // Leiste beim Ziehen: mit App die vier Hot Zones aus der Übersicht, sonst alle Zonen
  let barZones = zones;
  const hotOf = (list, info) => (info && Array.isArray(info.hot) && info.hot.length ? info.hot.slice() : list);
  let shortcut = DEFAULT_SHORTCUT;
  let dragCounter = 0;
  let manualOpen = false; // true, wenn per Tastenkombination geöffnet (nicht durch Drag)
  let recordingShortcut = false; // true, während in den Einstellungen eine neue Kombination aufgenommen wird
  let fallbackImageUrl = null; // beim dragstart ermittelte (möglichst hochauflösende) Bildquelle

  // ---- Shadow-DOM-Host ----
  // Wird beim ersten Bedarf angelegt (erster Drag, Tastenkombination oder
  // Bestätigung). Die Styles werden einmal geladen und als Constructable
  // Stylesheet übernommen; das umgeht auch strenge CSP-Regeln der Seite.

  let overlayReady = null;
  let shadow = null;
  let rootEl = null;

  let zonesBarEl = null;
  let zoneEls = [];
  let galleryPanelEl = null;
  let gallery = null;
  let panelHostEl = null;
  let panels = null;

  function ensureOverlay() {
    if (!overlayReady) {
      overlayReady = Promise.all(
        ["gallery.css", "panel.css", "overlay.css"].map((file) => fetch(chrome.runtime.getURL(file)).then((r) => r.text()))
      ).then((texts) => {
        const host = document.createElement("archiver-overlay");
        ["position:fixed", "top:0", "left:0", "width:0", "height:0", "display:block", "z-index:2147483647"].forEach((rule) => {
          const [prop, value] = rule.split(":");
          host.style.setProperty(prop, value, "important");
        });
        shadow = host.attachShadow({ mode: "open" });
        UI.watchTheme(host);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(texts.join("\n"));
        shadow.adoptedStyleSheets = [sheet];
        rootEl = UI.el("div", "root");
        shadow.appendChild(rootEl);
        document.documentElement.appendChild(host);
      });
    }
    return overlayReady;
  }

  // ---- Einstellungen aus dem Speicher ----

  function loadShortcut(cb) {
    if (!chrome.storage || !chrome.storage.sync) {
      cb(DEFAULT_SHORTCUT);
      return;
    }
    chrome.storage.sync.get({ shortcut: null }, (data) => {
      const s = data.shortcut;
      cb(s && s.key ? s : DEFAULT_SHORTCUT);
    });
  }

  loadShortcut((s) => (shortcut = s));
  // Deckkraft der Zonen beim Ziehen, eingestellt in der App
  let zoneAlpha = null;
  const loadAlpha = () =>
    chrome.storage &&
    chrome.storage.local &&
    chrome.storage.local.get({ appZoneAlpha: null }, (d) => (zoneAlpha = typeof d.appZoneAlpha === "number" ? d.appZoneAlpha : null));
  loadAlpha();
  loadZones((list, info) => {
    zones = list;
    barZones = hotOf(list, info);
  });

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (ArchiverShared.zonesChanged(changes, area)) {
        loadZones((list, info) => {
          zones = list;
          barZones = hotOf(list, info);
          if (zonesBarEl) removeZones(); // Zonenanzahl kann sich geändert haben
          if (gallery) gallery.render(barZones);
        });
      }
      if (area === "sync" && changes.shortcut) loadShortcut((s) => (shortcut = s));
      if (area === "local" && changes.appZoneAlpha) loadAlpha();
    });
  }

  // ---- Tastatur ----

  function matchesShortcut(e, combo) {
    if (!combo || !combo.key) return false;
    if (!!e.altKey !== !!combo.alt) return false;
    if (!!e.shiftKey !== !!combo.shift) return false;
    if (!!e.ctrlKey !== !!combo.ctrl) return false;
    if (!!e.metaKey !== !!combo.meta) return false;
    if (e.key.toLowerCase() === combo.key.toLowerCase()) return true;
    // macOS: Option verändert e.key (Option+Shift+A ergibt "Å"), daher
    // zusätzlich die physische Taste vergleichen.
    const code =
      combo.code ||
      (/^[a-z]$/i.test(combo.key) ? `Key${combo.key.toUpperCase()}` : /^[0-9]$/.test(combo.key) ? `Digit${combo.key}` : null);
    return !!code && e.code === code;
  }

  // composedPath statt activeElement, damit auch Eingabefelder im Shadow DOM zählen.
  function isTypingTarget(e) {
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    if (!target || target.nodeType !== 1) return false;
    if (target.isContentEditable) return true;
    return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
  }

  document.addEventListener("keydown", (e) => {
    if (recordingShortcut) return; // nimmt das Einstellungen-Panel selbst entgegen

    if (manualOpen) {
      if (gallery && gallery.handleKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (panels && panels.mode) panels.close();
        else closeManualOverlay();
        return;
      }
    }

    if (isTypingTarget(e)) return;

    if (matchesShortcut(e, shortcut)) {
      e.preventDefault();
      toggleManualOverlay();
    }
  });

  // ---- Nachrichten aus background.js ----

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "feedback") {
      ensureOverlay().then(() => UI.showToast(rootEl, message.text, message.ok));
    } else if (message.type === "toggle-overlay") {
      toggleManualOverlay(); // Chrome-Befehl, kommt nur im Top-Frame an
    } else if (message.type === "pinterest-collect" && window === window.top) {
      collectPinterestBoard().then((result) => chrome.runtime.sendMessage({ type: "pinterest-pins", ...result }));
    } else if (message.type === "context-save") {
      contextSave(message);
    } else if (message.type === "capture-start" && window === window.top) {
      startAreaCapture();
    }
  });

  // ---- Rechtsklick „Ablegen in“ ----
  // Merkt sich, worauf zuletzt rechts geklickt wurde. Gesichert wird das Bild
  // dort (auch unter Overlays), sonst markierter Text oder ein Link als Karte,
  // sonst ein Bildschirmfoto der sichtbaren Seite.

  let lastContext = null;
  document.addEventListener(
    "contextmenu",
    (e) => {
      lastContext = { target: e.target, x: e.clientX, y: e.clientY };
    },
    true
  );

  function imageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === document.documentElement || el === document.body) continue;
      if (el.tagName === "VIDEO" && el.poster) return el.poster;
      const url = el.tagName === "IMG" || el.tagName === "PICTURE" ? findBestImageUrl(el) : bgImageOf(el);
      if (url) return url;
      if (el.querySelector) {
        const img = [...el.querySelectorAll("img")].find((i) => {
          const r = i.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        });
        if (img) return findBestImageUrl(img);
      }
    }
    return null;
  }

  function bgImageOf(el) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }

  function saveCard(card, folder, source) {
    chrome.runtime.sendMessage({ type: "download-image", url: card.dataUrl, suggestedName: card.name, folder, tone: card.tone, ...source });
  }

  // Farben der Textkarten, gleiche Werte wie in der App (app.js QUOTE_TONES):
  // Hintergrund, Schrift Ton in Ton, Deckkraft für Kennung und Fuß
  const CARD_TONES = {
    red: ["#e0594b", "#4d120b", 0.62],
    green: ["#4ea56f", "#0f3420", 0.62],
    violet: ["#8c69c3", "#22103e", 0.62],
    cyan: ["#4db3dd", "#0b3447", 0.62],
    yellow: ["#ecd552", "#403807", 0.62],
  };
  // Die Farbe wird zu Beginn jeder Markierung zufällig bestimmt (nie zweimal
  // dieselbe hintereinander) und gilt, bis neu markiert wird
  let markTone = null;
  function newTone() {
    const keys = Object.keys(CARD_TONES).filter((k) => k !== markTone);
    markTone = keys[Math.floor(Math.random() * keys.length)];
    return markTone;
  }
  function toneFor() {
    return markTone || newTone();
  }

  // Markierung in der Farbe der späteren Textkarte, schon während des Markierens
  let toneStyle = null;
  function showTone() {
    if (!toneStyle) {
      toneStyle = document.createElement("style");
      toneStyle.setAttribute("data-archiver-tone", "");
      (document.head || document.documentElement).appendChild(toneStyle);
    }
    const [bg, fg] = CARD_TONES[toneFor()];
    toneStyle.textContent = `::selection{background:${bg}!important;color:${fg}!important}`;
  }

  // ---- PDF, Video und Audio ----
  // Links auf PDFs, Video- und Audiodateien werden als Datei gesichert, nicht als
  // Karte. YouTube und Vimeo lassen sich nicht laden: dort entsteht eine
  // Karte mit Vorschaubild, Titel und Domain.

  const MEDIA_FILE = /\.(pdf|mp4|m4v|mov|webm|wav|mp3|aif|aiff|m4a|flac)$/i;
  const AUDIO_FILE = /\.(wav|mp3|aif|aiff|m4a|flac)$/i;

  function isMediaFileUrl(url) {
    try {
      const u = new URL(url, location.href);
      return /^https?:$/.test(u.protocol) && MEDIA_FILE.test(u.pathname);
    } catch {
      return false;
    }
  }

  // Direkt geöffnete Datei (PDF oder Audio): als Datei sichern
  function isPdfPage() {
    const type = document.contentType || "";
    return type === "application/pdf" || /^audio\//.test(type) || /\.pdf$/i.test(location.pathname) || AUDIO_FILE.test(location.pathname);
  }

  // Adresse einer YouTube- oder Vimeo-Seite, sonst null
  function videoPageUrl(url) {
    try {
      const u = new URL(url, location.href);
      const host = u.hostname.replace(/^(www|m)\./, "");
      if (host === "youtube.com" && ((u.pathname === "/watch" && u.searchParams.get("v")) || /^\/shorts\/[\w-]+/.test(u.pathname))) return u.href;
      if (host === "youtu.be" && u.pathname.length > 1) return u.href;
      if (host === "vimeo.com" && /^\/\d+/.test(u.pathname)) return u.href;
    } catch {}
    return null;
  }

  function saveMediaFile(url, folder, source) {
    chrome.runtime.sendMessage({ type: "download-image", url: resolveUrl(url), folder, ...source });
  }

  async function saveVideoCard(url, folder, fallbackTitle) {
    const info = await chrome.runtime.sendMessage({ type: "video-info", url }).catch(() => null);
    const title = (info && info.title) || fallbackTitle || "";
    const card = await videoCard(title, url, info && info.thumb);
    saveCard(card, folder, { pageUrl: url, pageTitle: title || url });
  }

  // Link oder Adresse sichern: Datei, Video-Karte oder Link-Karte
  function saveLink(link, title, folder) {
    const video = videoPageUrl(link);
    if (isMediaFileUrl(link)) saveMediaFile(link, folder, currentPageSource());
    else if (video) saveVideoCard(video, folder, title);
    else saveCard(linkCard(title, link), folder, { pageUrl: link, pageTitle: title || link });
  }

  // Die geöffnete Seite selbst: PDF als Datei, Video als Karte, sonst Bildschirmfoto
  function savePage(folder, source) {
    const video = videoPageUrl(location.href);
    if (isPdfPage()) saveMediaFile(location.href, folder, { pageUrl: location.href, pageTitle: document.title || null });
    else if (video) saveVideoCard(video, folder, document.title.replace(/ - YouTube$/, ""));
    else chrome.runtime.sendMessage({ type: "capture-visible", folder, ...source });
  }

  function contextSave(msg) {
    const source = currentPageSource();
    const ctx = lastContext;
    const folder = msg.folder;
    const selection = String(window.getSelection() || "").trim() || msg.selectionText;
    if (msg.videoUrl && /^https?:/.test(msg.videoUrl)) {
      saveMediaFile(msg.videoUrl, folder, source);
    } else if (msg.videoUrl && videoPageUrl(location.href)) {
      savePage(folder, source);
    } else if (msg.srcUrl) {
      const best = ctx && ctx.target && ctx.target.tagName === "IMG" ? findBestImageUrl(ctx.target) : null;
      chrome.runtime.sendMessage({ type: "download-image", url: resolveUrl(best || msg.srcUrl), folder, ...source });
    } else if (selection) {
      saveCard(textCard(selection, source), folder, { ...source, quote: selection });
    } else if (msg.linkUrl) {
      const a = ctx && ctx.target && ctx.target.closest && ctx.target.closest("a[href]");
      const title = ((a && (a.textContent || a.title)) || "").replace(/\s+/g, " ").trim();
      saveLink(msg.linkUrl, title, folder);
    } else if (isPdfPage() || videoPageUrl(location.href)) {
      savePage(folder, source);
    } else {
      const url = ctx ? imageAt(ctx.x, ctx.y) : null;
      if (url) chrome.runtime.sendMessage({ type: "download-image", url: resolveUrl(url), folder, ...source });
      else chrome.runtime.sendMessage({ type: "capture-visible", folder, ...source });
    }
  }

  // ---- Karten für Text und Links: typografisch gesetzt, als PNG ----
  // So bleiben auch Zitate und Links Objekte in der Zone, mit Quelle.

  const CARD_W = 1400;
  const CARD_PAD = 110;
  const SANS = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
  const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

  function wrapLines(ctx, text, width, maxLines) {
    const lines = [];
    for (const para of text.split(/\n+/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + " " + word : word;
        if (ctx.measureText(test).width > width && line) {
          lines.push(line);
          line = word;
        } else line = test;
      }
      if (line) lines.push(line);
      if (lines.length >= maxLines) break;
    }
    if (lines.length > maxLines) lines.length = maxLines;
    const full = text.replace(/\s+/g, " ").trim();
    if (lines.join(" ").length < full.length - 1) lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, "") + " …";
    return lines;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function renderCard(draw, height, bg) {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg || "#f4f3ef";
    ctx.fillRect(0, 0, CARD_W, height);
    ctx.fillStyle = "#141414";
    ctx.textBaseline = "top";
    draw(ctx);
    return canvas.toDataURL("image/png");
  }

  function cardName(text, fallback) {
    const words = text.replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");
    return ((words || fallback).slice(0, 80).replace(/[.,;:!?…\s]+$/, "") || fallback) + ".png";
  }

  function textCard(text, source) {
    const tone = toneFor();
    const [bg, fg, dim] = CARD_TONES[tone];
    const measure = document.createElement("canvas").getContext("2d");
    const size = text.length < 140 ? 64 : text.length < 400 ? 46 : 36;
    measure.font = `500 ${size}px ${SANS}`;
    const lines = wrapLines(measure, text, CARD_W - CARD_PAD * 2, 22);
    const lh = Math.round(size * 1.28);
    const height = CARD_PAD * 2 + 80 + lines.length * lh + 60;
    const date = new Date().toLocaleDateString(document.documentElement.lang || undefined);
    const dataUrl = renderCard((ctx) => {
      ctx.fillStyle = fg;
      ctx.font = `400 22px ${MONO}`;
      ctx.globalAlpha = dim;
      ctx.fillText(t("cardText").toUpperCase(), CARD_PAD, CARD_PAD);
      ctx.globalAlpha = 1;
      ctx.font = `500 ${size}px ${SANS}`;
      lines.forEach((l, i) => ctx.fillText(l, CARD_PAD, CARD_PAD + 80 + i * lh));
      ctx.font = `400 22px ${MONO}`;
      ctx.globalAlpha = dim;
      ctx.fillText([hostOf(source.pageUrl), date].filter(Boolean).join("  ·  "), CARD_PAD, height - CARD_PAD + 10);
      ctx.globalAlpha = 1;
    }, height, bg);
    return { dataUrl, name: cardName(text, "Text"), tone };
  }

  function linkCard(title, url) {
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `600 72px ${SANS}`;
    const lines = wrapLines(measure, title || hostOf(url) || url, CARD_W - CARD_PAD * 2, 4);
    const height = Math.max(640, CARD_PAD * 2 + 80 + lines.length * 88 + 90);
    const dataUrl = renderCard((ctx) => {
      ctx.font = `400 22px ${MONO}`;
      ctx.fillStyle = "#8a8a85";
      ctx.fillText((t("cardLink") + "  ·  " + hostOf(url)).toUpperCase(), CARD_PAD, CARD_PAD);
      ctx.fillStyle = "#141414";
      ctx.font = `600 72px ${SANS}`;
      lines.forEach((l, i) => ctx.fillText(l, CARD_PAD, CARD_PAD + 80 + i * 88));
      ctx.font = `400 24px ${MONO}`;
      ctx.fillStyle = "#2d5aeb";
      const short = url.length > 90 ? url.slice(0, 89) + "…" : url;
      ctx.fillText(short, CARD_PAD, height - CARD_PAD + 6);
    }, height);
    return { dataUrl, name: cardName(title || hostOf(url), "Link") };
  }

  // Video-Karte: Vorschaubild oben (16:9) mit Abspiel-Zeichen, darunter
  // „VIDEO · youtube.com“ und der Titel.
  function videoCard(title, url, thumbDataUrl) {
    return new Promise((resolve) => {
      const draw = (img) => {
        const measure = document.createElement("canvas").getContext("2d");
        measure.font = `600 64px ${SANS}`;
        const lines = wrapLines(measure, title || hostOf(url) || url, CARD_W - CARD_PAD * 2, 3);
        const thumbH = Math.round((CARD_W * 9) / 16);
        const height = thumbH + CARD_PAD + 30 + lines.length * 78 + CARD_PAD - 10;
        const dataUrl = renderCard((ctx) => {
          ctx.fillStyle = "#1c1c1c";
          ctx.fillRect(0, 0, CARD_W, thumbH);
          if (img) {
            const s = Math.max(CARD_W / img.width, thumbH / img.height);
            const w = img.width * s;
            const h = img.height * s;
            ctx.drawImage(img, (CARD_W - w) / 2, (thumbH - h) / 2, w, h);
          }
          const cx = CARD_W / 2;
          const cy = thumbH / 2;
          ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
          ctx.beginPath();
          ctx.arc(cx, cy, 64, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.moveTo(cx - 20, cy - 32);
          ctx.lineTo(cx + 34, cy);
          ctx.lineTo(cx - 20, cy + 32);
          ctx.closePath();
          ctx.fill();
          ctx.font = `400 22px ${MONO}`;
          ctx.fillStyle = "#8a8a85";
          ctx.fillText((t("cardVideo") + "  ·  " + hostOf(url)).toUpperCase(), CARD_PAD, thumbH + CARD_PAD - 30);
          ctx.fillStyle = "#141414";
          ctx.font = `600 64px ${SANS}`;
          lines.forEach((l, i) => ctx.fillText(l, CARD_PAD, thumbH + CARD_PAD + 30 + i * 78));
        }, height);
        resolve({ dataUrl, name: cardName(title || hostOf(url), "Video") });
      };
      if (!thumbDataUrl) return draw(null);
      const img = new Image();
      img.onload = () => draw(img);
      img.onerror = () => draw(null);
      img.src = thumbDataUrl;
    });
  }

  // ---- Ausschnitt sichern: Rahmen aufziehen, dann Zone wählen ----

  let areaEl = null;

  function startAreaCapture() {
    if (areaEl) return;
    ensureOverlay().then(() => {
      if (manualOpen) closeManualOverlay();
      areaEl = UI.el("div", "area-layer");
      const hint = UI.el("div", "area-hint", t("areaHint"));
      const box = UI.el("div", "area-box");
      areaEl.append(hint, box);
      rootEl.appendChild(areaEl);
      let start = null;
      let rect = null;
      const draw = (r) => {
        box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;display:block`;
      };
      areaEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest(".area-pick")) return;
        e.preventDefault();
        const old = areaEl.querySelector(".area-pick");
        if (old) old.remove();
        start = { x: e.clientX, y: e.clientY };
      });
      areaEl.addEventListener("mousemove", (e) => {
        if (!start) return;
        rect = {
          x: Math.min(start.x, e.clientX),
          y: Math.min(start.y, e.clientY),
          w: Math.abs(e.clientX - start.x),
          h: Math.abs(e.clientY - start.y),
        };
        draw(rect);
      });
      areaEl.addEventListener("mouseup", () => {
        if (!start) return;
        start = null;
        if (rect && rect.w > 8 && rect.h > 8) showAreaPicker(rect);
      });
      document.addEventListener("keydown", areaKey, true);
    });
  }

  function endAreaCapture() {
    document.removeEventListener("keydown", areaKey, true);
    if (areaEl) areaEl.remove();
    areaEl = null;
  }

  function areaKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      endAreaCapture();
      return;
    }
    const pick = areaEl && areaEl.querySelector(".area-pick");
    if (pick && /^[1-9]$/.test(e.key)) {
      const chip = pick.querySelectorAll(".area-chip")[Number(e.key) - 1];
      if (chip) {
        e.preventDefault();
        e.stopPropagation();
        chip.click();
      }
    }
  }

  function showAreaPicker(rect) {
    const pick = UI.el("div", "area-pick");
    pick.appendChild(UI.el("span", "area-pick-label", t("areaPick")));
    zones.forEach((name, i) => {
      const chip = UI.el("button", "area-chip");
      chip.type = "button";
      if (i < 9) chip.appendChild(UI.el("span", "area-key", String(i + 1)));
      chip.appendChild(document.createTextNode(String(name).split("/").pop()));
      chip.addEventListener("click", () => captureArea(rect, isRootZoneName(name) ? null : name));
      pick.appendChild(chip);
    });
    const below = rect.y + rect.h + 12;
    pick.style.left = Math.max(12, Math.min(rect.x, window.innerWidth - 420)) + "px";
    pick.style.top = (below + 54 < window.innerHeight ? below : Math.max(12, rect.y - 56)) + "px";
    areaEl.appendChild(pick);
  }

  function captureArea(rect, folder) {
    endAreaCapture();
    // zwei Frames warten, damit Rahmen und Leiste nicht mit aufs Foto kommen
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          chrome.runtime.sendMessage({
            type: "capture-visible",
            folder,
            rect: { ...rect, vw: window.innerWidth },
            ...currentPageSource(),
          });
        }, 60)
      )
    );
  }

  // ---- Pinterest-Board einsammeln (Entwicklungshilfe) ----
  // Scrollt das Board durch und merkt sich jeden Pin. Pinterest blendet Pins
  // außerhalb des Bildschirms aus, deshalb wird beim Scrollen gesammelt.
  // Schluss ist bei der Pin-Zahl des Boards oder bei „Mehr Ideen“.

  function bestPinImage(img) {
    const set = (img.getAttribute("srcset") || "").split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    const url = set.length ? set[set.length - 1] : img.src;
    return url.includes("/originals/") ? url : url.replace(/\/\d+x(\d+)?\//, "/736x/");
  }

  async function collectPinterestBoard() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const toast = (text) => ensureOverlay().then(() => UI.showToast(rootEl, text, true));
    const h1 = document.querySelector("h1");
    const board = ((h1 && h1.textContent) || decodeURIComponent(location.pathname.split("/")[2] || "Pinterest")).trim();
    const countEl = [...document.querySelectorAll("div, span")].find((n) => /^\s*[\d.,]+\s+Pins?\s*$/i.test(n.textContent));
    const expected = countEl ? parseInt(countEl.textContent.replace(/[^\d]/g, ""), 10) : Infinity;
    const stopHeading = () =>
      [...document.querySelectorAll("h2, h3")].find((h) => /mehr ideen|weitere ideen|more ideas|more like this/i.test(h.textContent));
    const pins = new Map();
    window.scrollTo(0, 0);
    await sleep(800);
    let idle = 0;
    while (idle < 5 && pins.size < expected) {
      const stop = stopHeading();
      const before = pins.size;
      for (const a of document.querySelectorAll('a[href*="/pin/"]')) {
        if (stop && stop.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
        const img = a.querySelector('img[src*="pinimg.com"]');
        const id = (a.getAttribute("href").match(/\/pin\/([^/?#]+)/) || [])[1];
        if (!img || !id || pins.has(id)) continue;
        pins.set(id, { url: bestPinImage(img), pageUrl: `https://www.pinterest.com/pin/${id}/`, pageTitle: img.alt || board });
      }
      idle = pins.size === before ? idle + 1 : 0;
      if (pins.size !== before) toast(`Pinterest: ${pins.size}${expected !== Infinity ? " / " + expected : ""} Pins gefunden`);
      if (stop && stop.getBoundingClientRect().top < window.innerHeight) break;
      window.scrollBy(0, window.innerHeight * 0.8);
      await sleep(900);
    }
    return { board, pins: [...pins.values()].slice(0, expected) };
  }

  // ---- Manuell geöffnetes Overlay ----

  function toggleManualOverlay() {
    if (manualOpen) closeManualOverlay();
    else openManualOverlay();
  }

  function openManualOverlay() {
    if (manualOpen) return;
    manualOpen = true;
    ensureOverlay().then(() => {
      if (!manualOpen) return;
      removeZones();
      if (!galleryPanelEl) buildGalleryPanel();
      debugLog("Overlay manuell geöffnet");
    });
  }

  function closeManualOverlay() {
    manualOpen = false;
    removeGalleryPanel();
    debugLog("Overlay geschlossen");
  }

  // Wie die Vollansicht: Toolbar mit Filter, Größe, Einstellungen, Information,
  // darunter alle Zonen. Bilder vom Desktop lassen sich direkt auf eine Zone ziehen.
  function buildGalleryPanel() {
    galleryPanelEl = UI.el("div", "overlay-gallery");
    gallery = UI.createGallery({ mount: rootEl, root: shadow, acceptExternalDrops: true });

    const dashboardBtn = UI.button("mini-action", t("fullView"), () => chrome.runtime.sendMessage({ type: "open-dashboard" }));
    dashboardBtn.title = t("fullViewTitle");
    panelHostEl = UI.el("div", "panel-host");
    panels = UI.createPanelController(panelHostEl, {
      settingsHeaderExtras: [dashboardBtn],
      onRecordingChange: (on) => (recordingShortcut = on),
    });

    const toolbar = UI.buildToolbar(gallery, galleryPanelEl);
    toolbar.appendChild(UI.buildPanelButtons(panels));

    galleryPanelEl.appendChild(toolbar);
    galleryPanelEl.appendChild(gallery.el);
    rootEl.appendChild(galleryPanelEl);
    rootEl.appendChild(panelHostEl);
    gallery.render(barZones);
  }

  function removeGalleryPanel() {
    if (panels) panels.close();
    if (gallery) gallery.destroy();
    if (galleryPanelEl) galleryPanelEl.remove();
    if (panelHostEl) panelHostEl.remove();
    panels = gallery = galleryPanelEl = panelHostEl = null;
    recordingShortcut = false;
  }

  // ---- Zonenleiste (nur während eines Drags auf der Seite) ----

  function showZones() {
    refreshZones();
    ensureOverlay().then(() => {
      if (zonesBarEl || manualOpen || dragCounter <= 0) return; // schon da, Overlay offen oder Drag vorbei

      zonesBarEl = UI.el("div", "zones-bar");
      if (zoneAlpha != null) zonesBarEl.style.setProperty("--zone-alpha", String(zoneAlpha));
      zoneEls = barZones.map((name, i) => {
        const zone = UI.el("div", "zone" + (isRootZoneName(name) ? " root" : ""));
        zone.dataset.index = String(i);
        // Schwebende Karte wie in der App: Name oben links, Unterzone mit grauem Elternteil
        const label = UI.el("div", "zone-label");
        const parts = String(name).split("/");
        if (parts.length > 1) label.appendChild(UI.el("span", "zone-parent", parts.slice(0, -1).join(" / ") + " / "));
        label.appendChild(document.createTextNode(parts[parts.length - 1]));
        zone.appendChild(label);
        zone.appendChild(UI.el("div", "zone-hint", t("dropRelease")));
        zonesBarEl.appendChild(zone);
        return zone;
      });
      rootEl.appendChild(zonesBarEl);
      debugLog("Zonen angezeigt:", barZones);
    });
  }

  // Zonen bei jedem Drag frisch holen (App kann inzwischen gestartet oder
  // eine Zone angelegt worden sein). Ändert sich etwas, wird die Leiste neu gebaut.
  let zonesRefreshedAt = 0;
  function refreshZones() {
    if (Date.now() - zonesRefreshedAt < 2000) return;
    zonesRefreshedAt = Date.now();
    loadZones((list, info) => {
      const hot = hotOf(list, info);
      if (list.join("\n") === zones.join("\n") && hot.join("\n") === barZones.join("\n")) return;
      zones = list;
      barZones = hot;
      if (zonesBarEl) {
        zonesBarEl.remove();
        zonesBarEl = null;
        zoneEls = [];
        showZones();
      }
    });
  }

  function removeZones() {
    if (zonesBarEl) {
      zonesBarEl.remove();
      zonesBarEl = null;
      zoneEls = [];
    }
    dragCounter = 0;
  }

  // Abgelegt: Die Zielkarte glüht kurz von hinten nach, dann blendet die Leiste aus.
  function landZones(idx) {
    const bar = zonesBarEl;
    const zone = zoneEls[idx];
    if (!bar || !zone) return removeZones();
    zonesBarEl = null;
    zoneEls = [];
    dragCounter = 0;
    zone.classList.remove("active");
    zone.classList.add("landed");
    bar.classList.add("leaving");
    setTimeout(() => bar.remove(), 900);
  }

  // Liefert den Zonen-Index unter x/y, oder -1 wenn außerhalb aller Zonen
  function getZoneIndex(x, y) {
    if (!barZones.length) return -1;
    const zoneHeight = (window.innerHeight * ZONE_HEIGHT_VH) / 100;
    if (y < window.innerHeight - zoneHeight) return -1;
    const zoneWidth = window.innerWidth / barZones.length;
    const idx = Math.floor(x / zoneWidth);
    return Math.min(Math.max(idx, 0), barZones.length - 1);
  }

  // ---- Bildquelle ermitteln (High-Res statt Thumbnail) ----

  function parseSrcsetBest(srcset) {
    if (!srcset) return null;
    const candidates = srcset
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split(/\s+/);
        const url = parts[0];
        let score = 0;
        if (parts[1]) {
          const d = parts[1];
          if (d.endsWith("w")) score = parseInt(d, 10) || 0;
          else if (d.endsWith("x")) score = (parseFloat(d) || 1) * 1000;
        }
        return { url, score };
      });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].url;
  }

  const LAZY_ATTRS = ["data-src", "data-original", "data-full", "data-large", "data-hi-res", "data-zoom-image", "data-large-src", "data-lazy-src"];

  function bestFromImg(img) {
    if (!img) return null;

    const picture = img.closest ? img.closest("picture") : null;
    if (picture) {
      let best = null;
      picture.querySelectorAll("source[srcset]").forEach((source) => {
        const url = parseSrcsetBest(source.getAttribute("srcset"));
        if (url) best = url; // im Markup steht die hochauflösendste Quelle meist zuletzt
      });
      if (best) return best;
    }

    const srcsetBest = parseSrcsetBest(img.getAttribute("srcset"));
    if (srcsetBest) return srcsetBest;

    for (const attr of LAZY_ATTRS) {
      const val = img.getAttribute(attr);
      if (val) return val;
    }

    return img.src || null;
  }

  function findBestImageUrl(el) {
    if (!el) return null;

    // Lightbox-Pattern: <a href="grosses-bild.jpg"><img src="thumbnail.jpg"></a>
    const anchor = el.closest ? el.closest("a[href]") : null;
    if (anchor) {
      const href = anchor.getAttribute("href");
      if (href && /\.(jpe?g|png|webp|gif|avif|svg)(\?.*)?$/i.test(href)) {
        return href;
      }
    }

    if (el.tagName === "IMG") {
      const best = bestFromImg(el);
      if (best) return best;
    }

    const nestedImg = el.querySelector && el.querySelector("img");
    if (nestedImg) {
      const best = bestFromImg(nestedImg);
      if (best) return best;
    }

    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const bg = getComputedStyle(node).backgroundImage;
      const match = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match) return match[1];
      node = node.parentElement;
    }

    const nestedSvgImage = el.querySelector && el.querySelector("image[href], image[*|href]");
    if (nestedSvgImage) {
      const href = nestedSvgImage.getAttribute("href") || nestedSvgImage.getAttribute("xlink:href");
      if (href) return href;
    }

    return null;
  }

  // ---- Markierten Text ziehen ----
  // Manche Seiten lassen eine Markierung nicht nativ ziehen (ein neuer Klick
  // markiert neu). Archiver übernimmt deshalb das Ziehen selbst: Drücken auf
  // die Markierung und Ziehen blendet die Zonen ein, Loslassen auf einer Zone
  // sichert den Text als Karte. Ein einfacher Klick hebt die Markierung auf.

  const TEXT_DRAG_THRESHOLD = 5;
  let textDrag = null; // { x, y, text, moving, ghost }

  function selectedText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (node && node.closest && node.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return "";
    return String(sel).trim();
  }

  // ---- Markierung im Fokus ----
  // Sobald Text markiert ist (ab 3 Zeichen, nicht in Eingabefeldern), legt
  // sich eine gestrichelte Outline um den markierten Block, der Rest der Seite
  // wird dunkler (wie beim Bereich-Auswählen). Das Blau der Markierung
  // verschwindet. Der Block lässt sich als Ganzes in eine Zone ziehen.

  const SPOT_PAD = 8;
  let spotEl = null;
  let spotFrame = 0;
  let spotRect = null; // sichtbarer Block, für das Ziehen

  // Umriss aller Zeilen der Markierung
  function selectionBlock() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || selectedText().length < 3) return null;
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) return null;
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const r of rects) {
      box.left = Math.min(box.left, r.left);
      box.top = Math.min(box.top, r.top);
      box.right = Math.max(box.right, r.right);
      box.bottom = Math.max(box.bottom, r.bottom);
    }
    box.left -= SPOT_PAD;
    box.top -= SPOT_PAD;
    box.right += SPOT_PAD;
    box.bottom += SPOT_PAD;
    return box;
  }

  function hideSpotlight() {
    spotRect = null;
    if (spotEl) spotEl.style.opacity = "0";
  }

  function updateSpotlight() {
    spotFrame = 0;
    if (window !== window.top && window.innerWidth < 200) return; // kleine Frames (Werbung) auslassen
    const box = selectionBlock();
    if (!box) return hideSpotlight();
    if (!spotEl) {
      spotEl = document.createElement("div");
      spotEl.setAttribute("data-archiver-spotlight", "");
      spotEl.style.cssText =
        "position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;" +
"opacity:0;";
      document.documentElement.appendChild(spotEl);
      spotEl.getBoundingClientRect();
    }
    spotEl.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`;
    spotEl.style.width = Math.round(box.right - box.left) + "px";
    spotEl.style.height = Math.round(box.bottom - box.top) + "px";
    spotEl.style.opacity = "1";
    spotRect = box;
  }

  function scheduleSpotlight() {
    if (!spotFrame) spotFrame = requestAnimationFrame(updateSpotlight);
  }

  // Erst nach dem Loslassen der Maus einblenden, nicht während des Markierens
  let selecting = false;
  document.addEventListener("mousedown", (e) => {
    if (e.button === 0 && spotRect && insideBlock(e.clientX, e.clientY)) return; // Ziehen des Blocks
    selecting = true;
    hideSpotlight();
    // Neue Markierung beginnt: neue Farbe, sofort sichtbar
    if (e.button === 0) {
      newTone();
      showTone();
    }
  }, true);
  showTone();
  document.addEventListener("mouseup", () => {
    selecting = false;
    setTimeout(scheduleSpotlight, 0);
  }, true);
  document.addEventListener("selectionchange", () => {
    if (selecting || textDrag) return;
    if (!selectionBlock()) hideSpotlight();
    else scheduleSpotlight();
  });
  window.addEventListener("scroll", () => spotRect && scheduleSpotlight(), true);
  window.addEventListener("resize", () => spotRect && scheduleSpotlight());

  function insideBlock(x, y) {
    const r = spotRect;
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function insideSelection(x, y) {
    if (insideBlock(x, y)) return true;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    return [...sel.getRangeAt(0).getClientRects()].some(
      (r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2
    );
  }

  // Abbild des Blocks am Zeiger: dieselbe Größe, dieselbe Outline, darin der
  // markierte Inhalt in der Schrift der Seite.
  function blockGhost(rect) {
    const ghost = document.createElement("div");
    ghost.setAttribute("data-archiver-spotlight", "");
    const w = Math.round(rect.right - rect.left);
    const h = Math.round(rect.bottom - rect.top);
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    let host = range && range.commonAncestorContainer;
    if (host && host.nodeType !== 1) host = host.parentElement;
    const cs = host ? getComputedStyle(host) : null;
    let bg = "#fff";
    for (let n = host; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) {
        bg = c;
        break;
      }
    }
    ghost.style.cssText =
      `position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:${w}px;height:${h}px;` +
      `box-sizing:border-box;padding:${SPOT_PAD}px;overflow:hidden;outline:1.5px dashed #fff;` +
      `background:${bg};opacity:.92;box-shadow:0 18px 50px rgba(0,0,0,.45);` +
      `transform-origin:0 0;transition:scale .18s ease;` +
      (cs ? `font:${cs.font};color:${cs.color};line-height:${cs.lineHeight};text-align:${cs.textAlign};` : "");
    if (range) {
      const inner = document.createElement("div");
      // erste Zeile beginnt dort, wo die Markierung beginnt
      const first = range.getClientRects()[0];
      const indent = first ? Math.max(0, Math.round(first.left - rect.left - SPOT_PAD)) : 0;
      inner.style.cssText = `pointer-events:none;text-indent:${indent}px;`;
      inner.appendChild(range.cloneContents());
      ghost.appendChild(inner);
    }
    return ghost;
  }

  function endTextDrag() {
    if (!textDrag) return;
    if (textDrag.ghost) textDrag.ghost.remove();
    document.removeEventListener("mousemove", onTextDragMove, true);
    document.removeEventListener("mouseup", onTextDragUp, true);
    document.removeEventListener("keydown", onTextDragKey, true);
    if (textDrag.moving) removeZones();
    textDrag = null;
    scheduleSpotlight();
  }

  function onTextDragMove(e) {
    const d = textDrag;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < TEXT_DRAG_THRESHOLD) return;
      d.moving = true;
      dragCounter = 1;
      showZones();
      const block = d.rect ? blockGhost(d.rect) : null; // jetzt, solange die Markierung steht
      ensureOverlay().then(() => {
        if (textDrag !== d) return;
        // in der Überlagerung, damit der Block über den Zonen liegt
        d.ghost = block || UI.el("div", "text-ghost", d.text.length > 80 ? d.text.slice(0, 80) + " …" : d.text);
        rootEl.appendChild(d.ghost);
        moveGhost(d, d.lastX ?? e.clientX, d.lastY ?? e.clientY);
      });
    }
    e.preventDefault();
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    moveGhost(d, e.clientX, e.clientY);
    const active = getZoneIndex(e.clientX, e.clientY);
    zoneEls.forEach((el, i) => el.classList.toggle("active", i === active));
  }

  function moveGhost(d, x, y) {
    if (!d.ghost) return;
    if (d.rect) {
      // Block bleibt dort gegriffen, wo man ihn angefasst hat, und schrumpft
      // bei großen Blöcken, damit die Zonen sichtbar bleiben
      const w = d.rect.right - d.rect.left;
      const h = d.rect.bottom - d.rect.top;
      const k = Math.min(1, 420 / w, 260 / h);
      const ox = (d.x - d.rect.left) * k;
      const oy = (d.y - d.rect.top) * k;
      d.ghost.style.transform = `translate(${x - ox}px, ${y - oy}px) scale(${k})`;
      return;
    }
    // am rechten und unteren Rand auf die andere Seite des Zeigers
    const w = d.ghost.offsetWidth;
    const h = d.ghost.offsetHeight;
    const left = x + 14 + w > window.innerWidth ? x - 14 - w : x + 14;
    const top = y + 14 + h > window.innerHeight ? y - 14 - h : y + 14;
    d.ghost.style.transform = `translate(${left}px, ${top}px)`;
  }

  function onTextDragUp(e) {
    const d = textDrag;
    if (!d.moving) {
      // nur geklickt: wie gewohnt Markierung aufheben
      window.getSelection().removeAllRanges();
    } else {
      e.preventDefault();
      e.stopPropagation();
      const idx = getZoneIndex(e.clientX, e.clientY);
      if (idx !== -1) {
        const name = barZones[idx];
        landZones(idx);
        const source = currentPageSource();
        saveCard(textCard(d.text, source), isRootZoneName(name) ? null : name, { ...source, quote: d.text });
      }
    }
    endTextDrag();
  }

  function onTextDragKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    endTextDrag();
  }

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0 || manualOpen || textDrag) return;
      const text = selectedText();
      if (!text || !insideSelection(e.clientX, e.clientY)) return;
      // Kein neues Markieren und kein natives Ziehen: Archiver zieht selbst.
      e.preventDefault();
      textDrag = { x: e.clientX, y: e.clientY, text, moving: false, ghost: null, rect: spotRect ? { ...spotRect } : null };
      document.addEventListener("mousemove", onTextDragMove, true);
      document.addEventListener("mouseup", onTextDragUp, true);
      document.addEventListener("keydown", onTextDragKey, true);
    },
    true
  );

  document.addEventListener(
    "dragstart",
    (e) => {
      fallbackImageUrl = findBestImageUrl(e.target);
      debugLog("dragstart, target:", e.target, "erkannte Quelle:", fallbackImageUrl);
    },
    true
  );

  // ---- Ziehen auf Seiten, die Bilder unter einer Fläche verstecken (Instagram u. a.) ----
  // Beim Drücken auf etwas Nicht-Ziehbares (Fläche über dem Bild, Bild mit
  // draggable="false", Karussell, Video): liegt darunter ein Bild oder Video,
  // wird das gedrückte Element kurz ziehbar. Bild: trägt die Bildadresse.
  // Video ohne Standbild: beim Ablegen wird das aktuelle Bild abfotografiert.
  let hiddenDrag = null;

  function clearHiddenDrag() {
    if (!hiddenDrag) return;
    if (hiddenDrag.prev == null) hiddenDrag.el.removeAttribute("draggable");
    else hiddenDrag.el.setAttribute("draggable", hiddenDrag.prev);
    hiddenDrag = null;
  }

  function videoAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      const v = el.tagName === "VIDEO" ? el : el.querySelector && [...el.querySelectorAll("video")].find((n) => {
        const r = n.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (v) return v;
    }
    return null;
  }

  function armHiddenDrag(e) {
    clearHiddenDrag();
    if (e.button !== 0 || manualOpen || textDrag) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest("input, textarea, select, button, [contenteditable=''], [contenteditable='true']")) return;
    // Echt ziehbare Bilder und Links laufen wie bisher
    if (t.closest("[draggable='true']") || (t.tagName === "IMG" && t.getAttribute("draggable") !== "false")) return;
    if (selectedText() && insideSelection(e.clientX, e.clientY)) return;
    const video = videoAt(e.clientX, e.clientY);
    const url = video && video.poster && !IG ? video.poster : video ? null : imageAt(e.clientX, e.clientY);
    if (!url && !video) return;
    if (IG) return startMediaDrag(e, t, url, url ? null : video);
    hiddenDrag = { el: t, prev: t.getAttribute("draggable"), url, video: url ? null : video };
    t.setAttribute("draggable", "true");
    // Karussells verhindern sonst das Ziehen (eigene Wisch-Geste beim Drücken)
    e.stopImmediatePropagation();
  }

  window.addEventListener("pointerdown", armHiddenDrag, true);
  window.addEventListener(
    "mousedown",
    (e) => {
      if (hiddenDrag && hiddenDrag.el === e.target) e.stopImmediatePropagation();
    },
    true
  );
  document.addEventListener("mouseup", () => setTimeout(clearHiddenDrag, 0), true);
  document.addEventListener(
    "dragend",
    () =>
      setTimeout(() => {
        clearHiddenDrag();
        dragSource = null;
      }, 0),
    true
  );

  document.addEventListener(
    "dragstart",
    (e) => {
      dragSource = e.target instanceof Element ? e.target : null;
      if (!hiddenDrag || !e.dataTransfer || !(e.target === hiddenDrag.el || hiddenDrag.el.contains(e.target))) return;
      e.dataTransfer.effectAllowed = "copy";
      if (hiddenDrag.video) {
        fallbackImageUrl = null;
        e.dataTransfer.setData("application/x-archiver-video", "1");
        e.dataTransfer.setData("text/plain", location.href);
        return;
      }
      const url = resolveUrl(hiddenDrag.url);
      fallbackImageUrl = url;
      e.dataTransfer.setData("text/uri-list", url);
      e.dataTransfer.setData("text/plain", url);
      e.dataTransfer.setData("text/html", `<img src="${url.replace(/"/g, "&quot;")}">`);
      // Vorschau beim Ziehen: das Bild selbst statt der leeren Fläche
      const img = [...document.elementsFromPoint(e.clientX, e.clientY)].find((n) => n.tagName === "IMG");
      if (img) {
        const r = img.getBoundingClientRect();
        e.dataTransfer.setDragImage(img, Math.min(e.clientX - r.left, r.width), Math.min(e.clientY - r.top, r.height));
      }
    },
    true
  );

  // Instagram: eigenes Ziehen mit Zeiger-Ereignissen statt des Browser-Ziehens,
  // das Instagram unterbindet. Erst ab ein paar Pixeln Bewegung, sonst bleibt
  // es ein normaler Klick.
  let mediaDrag = null;

  function startMediaDrag(e, el, url, video) {
    mediaDrag = { x: e.clientX, y: e.clientY, el, url, video, moving: false, ghost: null };
    window.addEventListener("pointermove", onMediaDragMove, true);
    window.addEventListener("pointerup", onMediaDragUp, true);
    window.addEventListener("keydown", onMediaDragKey, true);
  }

  function endMediaDrag() {
    if (!mediaDrag) return;
    if (mediaDrag.ghost) mediaDrag.ghost.remove();
    window.removeEventListener("pointermove", onMediaDragMove, true);
    window.removeEventListener("pointerup", onMediaDragUp, true);
    window.removeEventListener("keydown", onMediaDragKey, true);
    if (mediaDrag.moving) removeZones();
    mediaDrag = null;
  }

  function onMediaDragMove(e) {
    const d = mediaDrag;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      d.moving = true;
      dragCounter = 1;
      showZones();
      const g = document.createElement("div");
      const thumb = d.url || d.video.poster;
      g.style.cssText =
        "position:fixed;left:0;top:0;z-index:2147483647;width:120px;height:120px;border-radius:10px;pointer-events:none;" +
        "background:#222 center/cover no-repeat;box-shadow:0 12px 32px rgba(0,0,0,.4);opacity:.92;color:#fff;" +
        "font:600 12px/120px -apple-system,sans-serif;text-align:center";
      if (thumb) g.style.backgroundImage = `url("${String(thumb).replace(/"/g, "%22")}")`;
      else g.textContent = "▶ Video";
      document.documentElement.appendChild(g);
      d.ghost = g;
      window.getSelection && window.getSelection().removeAllRanges();
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    d.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    const active = getZoneIndex(e.clientX, e.clientY);
    zoneEls.forEach((z, i) => z.classList.toggle("active", i === active));
  }

  function onMediaDragUp(e) {
    const d = mediaDrag;
    if (!d.moving) return endMediaDrag();
    e.preventDefault();
    e.stopImmediatePropagation();
    // Den Klick nach dem Ziehen schlucken, sonst öffnet oder liked Instagram
    window.addEventListener(
      "click",
      (c) => {
        c.preventDefault();
        c.stopImmediatePropagation();
      },
      { capture: true, once: true }
    );
    const idx = getZoneIndex(e.clientX, e.clientY);
    if (idx !== -1) landZones(idx);
    endMediaDrag();
    if (idx === -1) return;
    const name = barZones[idx];
    dropInstagram(d.el, d.video, d.url, isRootZoneName(name) ? null : name);
  }

  function onMediaDragKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    endMediaDrag();
  }

  // Video abgelegt: hat das Video eine echte Dateiadresse, wird die Datei
  // gesichert. Instagram streamt (blob:): dort fragt die Extension wie gängige
  // Downloader die Beitragsdaten bei Instagram ab (mit der Anmeldung im
  // Browser) und lädt die fertige MP4 mit Ton im Hintergrund. Klappt das
  // nicht, wird das aktuelle Bild des Videos fotografiert.
  async function dropHiddenVideo(folder) {
    const video = hiddenDrag.video;
    const src = video.currentSrc || video.src || "";
    clearHiddenDrag();
    removeZones();
    const source = currentPageSource();
    if (/^https?:/.test(src)) return saveMediaFile(src, folder, source);
    photographVideo(video, folder);
  }

  function photographVideo(video, folder) {
    const r = video.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    captureArea({ x, y, w: Math.min(window.innerWidth, r.right) - x, h: Math.min(window.innerHeight, r.bottom) - y }, folder);
  }

  // ---- Instagram: Bilder und Videos in Originalgröße aus den Beitragsdaten ----
  // Wie gängige Downloader: Beitragscode → Medien-ID → /api/v1/media/ID/info/
  // (mit der Anmeldung im Browser). Bei Karussells wird das gezogene Bild über
  // den Dateinamen, ein Video über seine Länge zugeordnet.
  const IG = /(^|\.)instagram\.com$/.test(location.hostname);
  let dragSource = null;
  const igCache = new Map();

  function postCodeNear(el) {
    const loc = location.pathname.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/);
    if (loc && !(el.closest && el.closest("article"))) return loc[1];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const a = n.querySelector && n.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      const hit = a && a.getAttribute("href").match(/\/(?:p|reel)\/([\w-]+)/);
      if (hit) return hit[1];
      if (n.tagName === "ARTICLE") break;
    }
    return loc ? loc[1] : null;
  }

  function mediaIdOf(code) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const ch of code.slice(0, 11)) id = id * 64n + BigInt(abc.indexOf(ch));
    return id.toString();
  }

  async function igItem(code) {
    if (!igCache.has(code)) {
      igCache.set(
        code,
        fetch(`/api/v1/media/${mediaIdOf(code)}/info/`, {
          credentials: "include",
          headers: { "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest" },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => (j && j.items && j.items[0]) || null)
          .catch(() => null)
      );
    }
    return igCache.get(code);
  }

  const fileNameOf = (url) => {
    try {
      return new URL(url, location.href).pathname.split("/").pop();
    } catch {
      return "";
    }
  };

  function igPick(item, video, imageUrl) {
    const list = item.carousel_media && item.carousel_media.length ? item.carousel_media : [item];
    const vid = (m) => (m.video_versions && m.video_versions.length ? m.video_versions[0].url : null);
    const img = (m) => m.image_versions2 && m.image_versions2.candidates && m.image_versions2.candidates[0] && m.image_versions2.candidates[0].url;
    if (video) {
      const vids = list.filter(vid);
      const match = vids.find((m) => m.video_duration && isFinite(video.duration) && Math.abs(m.video_duration - video.duration) < 0.6);
      const m = match || (vids.length === 1 ? vids[0] : null);
      return m ? { url: vid(m), ext: "mp4" } : null;
    }
    const name = fileNameOf(imageUrl || "");
    const m =
      (name && list.find((x) => ((x.image_versions2 && x.image_versions2.candidates) || []).some((c) => fileNameOf(c.url) === name))) ||
      (list.length === 1 ? list[0] : null);
    return m && img(m) ? { url: img(m), ext: "jpg" } : null;
  }

  // Quelle ist der Beitrag selbst, nicht der Feed, auf dem gezogen wurde.
  function igSource(code, item) {
    const reel = item ? item.product_type === "clips" : /\/reels?\//.test(location.pathname);
    const user = item && item.user && item.user.username;
    return {
      pageUrl: `https://www.instagram.com/${reel ? "reel" : "p"}/${code}/`,
      pageTitle: user ? `@${user} · Instagram` : "Instagram",
    };
  }

  async function dropInstagram(el, video, imageUrl, folder) {
    clearHiddenDrag();
    removeZones();
    fallbackImageUrl = null;
    const code = el ? postCodeNear(el) : null;
    const item = code ? await igItem(code) : null;
    const source = code ? igSource(code, item) : currentPageSource();
    const hit = item ? igPick(item, video, imageUrl) : null;
    if (hit) {
      chrome.runtime.sendMessage({ type: "download-image", url: hit.url, suggestedName: `instagram-${code}-${fileNameOf(hit.url).slice(0, 40)}`.replace(/\.(jpe?g|mp4|webp|heic)$/i, "") + "." + hit.ext, folder, toDownloads: shiftDrop, ...source });
    } else if (video) {
      photographVideo(video, folder);
    } else if (imageUrl) {
      chrome.runtime.sendMessage({ type: "download-image", url: resolveUrl(imageUrl), folder, toDownloads: shiftDrop, ...source });
    }
  }

  // ---- Drag & Drop auf der Seite ----

  function looksLikeImageDrop(dt) {
    if (dt.files && [...dt.files].some((f) => f.type.startsWith("image/"))) return true;
    if (/<img[\s>]/i.test(dt.getData("text/html") || "")) return true;
    const uri = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
    return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(uri.trim());
  }

  function resolveUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  // Priorität: beim dragstart ermittelte (möglichst hochauflösende) Quelle,
  // sonst was der Drop selbst mitbringt.
  function extractImageUrl(dataTransfer) {
    if (fallbackImageUrl) return resolveUrl(fallbackImageUrl);
    const result = extractDroppedImage(dataTransfer);
    return typeof result === "string" ? resolveUrl(result) : result;
  }

  // Shift beim Loslassen: Bild landet in ~/Downloads statt in der Zone
  let shiftDrop = false;

  document.addEventListener(
    "dragenter",
    (e) => {
      if (!e.dataTransfer || manualOpen) return; // im offenen Overlay übernehmen die Zonen-Karten
      dragCounter++;
      showZones();
    },
    true
  );

  document.addEventListener(
    "dragover",
    (e) => {
      if (!e.dataTransfer || manualOpen) return;
      e.preventDefault(); // notwendig, damit "drop" überhaupt feuert
      e.dataTransfer.dropEffect = "copy";
      // Mit Shift geht das Bild am Archiv vorbei in den Download-Ordner
      if (zonesBarEl && zonesBarEl.classList.contains("to-downloads") !== e.shiftKey) {
        zonesBarEl.classList.toggle("to-downloads", e.shiftKey);
        const hint = t(e.shiftKey ? "dropDownloads" : "dropRelease");
        zoneEls.forEach((el) => (el.querySelector(".zone-hint").textContent = hint));
      }
      if (zoneEls.length) {
        const activeIdx = getZoneIndex(e.clientX, e.clientY);
        zoneEls.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
      }
    },
    true
  );

  document.addEventListener(
    "dragleave",
    () => {
      if (manualOpen) return;
      dragCounter--;
      if (dragCounter <= 0) removeZones();
    },
    true
  );

  document.addEventListener(
    "drop",
    (e) => {
      if (manualOpen) return;
      const zoneIdx = getZoneIndex(e.clientX, e.clientY);
      shiftDrop = e.shiftKey;
      debugLog("drop, zoneIdx:", zoneIdx, "types:", e.dataTransfer.types);

      if (zoneIdx === -1) {
        debugLog("Drop außerhalb aller Zonen, ignoriert.");
        removeZones();
        fallbackImageUrl = null;
        return;
      }

      const zoneName = barZones[zoneIdx];
      const folder = isRootZoneName(zoneName) ? null : zoneName;
      landZones(zoneIdx);

      if (IG && (hiddenDrag || dragSource)) {
        const el = hiddenDrag ? hiddenDrag.el : dragSource;
        const video = hiddenDrag && hiddenDrag.video;
        const img = video ? null : fallbackImageUrl || (hiddenDrag && hiddenDrag.url);
        if (video || img) {
          e.preventDefault();
          e.stopPropagation();
          dropInstagram(el, video, img, folder);
          return;
        }
      }
      if (hiddenDrag && hiddenDrag.video) {
        e.preventDefault();
        e.stopPropagation();
        dropHiddenVideo(folder);
        return;
      }

      // Kein Bild im Spiel: Link, Adresszeile oder markierter Text
      if (!fallbackImageUrl && !looksLikeImageDrop(e.dataTransfer)) {
        const uri = (e.dataTransfer.getData("text/uri-list") || "").split("\n").find((l) => l && !l.startsWith("#"));
        const text = e.dataTransfer.getData("text/plain").trim();
        const link = (uri || (/^https?:\/\/\S+$/.test(text) ? text : "")).trim();
        if (link || text) {
          e.preventDefault();
          e.stopPropagation();
          const source = currentPageSource();
          if (link && link.split("#")[0] === location.href.split("#")[0]) {
            savePage(folder, source);
          } else if (link) {
            const html = e.dataTransfer.getData("text/html");
            const title = (html ? new DOMParser().parseFromString(html, "text/html").body.textContent : "").replace(/\s+/g, " ").trim();
            saveLink(link, title && title !== link ? title : "", folder);
          } else {
            saveCard(textCard(text, source), folder, { ...source, quote: text });
          }
          removeZones();
          return;
        }
      }

      const result = extractImageUrl(e.dataTransfer);
      debugLog("erkanntes Ergebnis:", result, "Ordner:", folder || "(Downloads-Root)");

      if (result) {
        e.preventDefault();
        e.stopPropagation();

        if (result.file) {
          const reader = new FileReader();
          reader.onload = () => {
            chrome.runtime.sendMessage({ type: "download-image", url: reader.result, suggestedName: result.file.name, folder, toDownloads: shiftDrop });
          };
          reader.readAsDataURL(result.file);
        } else {
          chrome.runtime.sendMessage({ type: "download-image", url: result, folder, toDownloads: shiftDrop, ...currentPageSource() });
        }
      }
      removeZones();
      fallbackImageUrl = null;
    },
    true
  );

  document.addEventListener(
    "dragend",
    () => {
      fallbackImageUrl = null;
    },
    true
  );
})();
