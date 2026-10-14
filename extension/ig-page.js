// Instagram: liest passiv mit, was Instagram selbst an Beitragsdaten in den
// Browser lädt (eigene Abrufe der Seite und eingebettete Daten). Archiver
// stellt keine eigene Anfrage. Läuft in der Welt der Seite (world: MAIN),
// weil nur dort die Antworten der Seite sichtbar sind, und reicht gefundene
// Medien als Text an content.js weiter („archiver:ig-media“).
(() => {
  if (window.__archiverIgPage) return;
  window.__archiverIgPage = true;

  const DATA_URL = /\/(api|graphql)\b/;
  const HINT = /video_versions|image_versions2/;

  const urlsOf = (list) => (Array.isArray(list) ? list.map((v) => ({ url: v && v.url })).filter((v) => typeof v.url === "string") : undefined);

  function slim(m) {
    const out = {
      code: m.code || undefined,
      pk: m.pk != null ? String(m.pk) : undefined,
      product_type: m.product_type || undefined,
      video_duration: typeof m.video_duration === "number" ? m.video_duration : undefined,
      video_versions: urlsOf(m.video_versions),
      image_versions2: m.image_versions2 ? { candidates: urlsOf(m.image_versions2.candidates) || [] } : undefined,
      user: m.user && m.user.username ? { username: String(m.user.username) } : undefined,
    };
    if (Array.isArray(m.carousel_media)) out.carousel_media = m.carousel_media.filter((c) => c && typeof c === "object").map(slim);
    return out;
  }

  function walk(node, out, depth) {
    if (!node || typeof node !== "object" || depth > 60) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, out, depth + 1);
      return;
    }
    if ((node.code || node.pk != null) && (node.video_versions || node.image_versions2 || node.carousel_media)) out.push(slim(node));
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, out, depth + 1);
    }
  }

  function scanText(text) {
    if (typeof text !== "string" || !HINT.test(text)) return;
    const body = text.replace(/^for \(;;\);/, "");
    const out = [];
    try {
      walk(JSON.parse(body), out, 0);
    } catch {
      // Gestückelte Antworten: ein JSON-Objekt pro Zeile
      for (const line of body.split(/\r?\n/)) {
        const s = line.trim();
        if (s[0] !== "{" && s[0] !== "[") continue;
        try {
          walk(JSON.parse(s), out, 0);
        } catch {}
      }
    }
    if (out.length) document.dispatchEvent(new CustomEvent("archiver:ig-media", { detail: JSON.stringify(out) }));
  }

  // Abrufe der Seite: Antwort kopieren und mitlesen, die Seite bekommt das Original
  const pageFetch = window.fetch;
  window.fetch = function (...args) {
    const p = pageFetch.apply(this, args);
    p.then(
      (res) => {
        try {
          if (DATA_URL.test(res.url) && !/^(image|video|audio)\//.test(res.headers.get("content-type") || "")) res.clone().text().then(scanText, () => {});
        } catch {}
      },
      () => {}
    );
    return p;
  };

  const xhrUrl = new WeakMap();
  const pageOpen = XMLHttpRequest.prototype.open;
  const pageSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrUrl.set(this, String(url));
    return pageOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (DATA_URL.test(xhrUrl.get(this) || "")) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") scanText(this.responseText);
          else if (this.responseType === "json" && this.response) scanText(JSON.stringify(this.response));
        } catch {}
      });
    }
    return pageSend.apply(this, args);
  };

  // Eingebettete Daten beim Öffnen eines Beitrags und später nachgeladene
  const seen = new WeakSet();
  function scanScripts(root) {
    for (const s of root.querySelectorAll ? root.querySelectorAll('script[type="application/json"]') : []) {
      if (seen.has(s)) continue;
      seen.add(s);
      scanText(s.textContent);
    }
  }
  document.addEventListener("DOMContentLoaded", () => scanScripts(document));
  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "SCRIPT") {
          if (n.type === "application/json" && !seen.has(n)) {
            seen.add(n);
            scanText(n.textContent);
          }
        } else if (n.querySelector && n.querySelector('script[type="application/json"]')) scanScripts(n);
      }
  }).observe(document, { childList: true, subtree: true });
})();
