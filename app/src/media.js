// media.js — PDF und Video für App (Lightbox) und Betrachter.
// PDFs zeichnet pdf.js (vendor/pdfjs) Seite für Seite untereinander in eine
// scrollbare Fläche; Videos spielt das <video>-Element ab, Audio das
// <audio>-Element unter Cover bzw. Wellenform.

(function (global) {
  const PDF_EXTS = ["pdf"];
  const VIDEO_EXTS = ["mp4", "m4v", "mov", "webm"];
  const AUDIO_EXTS = ["wav", "mp3", "aif", "aiff", "m4a", "flac"];

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
    return m ? m[1].toLowerCase() : String(name || "").toLowerCase();
  }

  // "pdf" | "video" | "audio" | "image" — aus Dateiname, Pfad oder Format
  function kind(nameOrFormat) {
    const ext = extOf(nameOrFormat);
    if (PDF_EXTS.includes(ext)) return "pdf";
    if (VIDEO_EXTS.includes(ext)) return "video";
    if (AUDIO_EXTS.includes(ext)) return "audio";
    return "image";
  }

  // 83 → "1:23", 3723 → "1:02:03"
  function duration(sec) {
    if (sec == null || !isFinite(sec)) return "";
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  }

  // Platzhalter, solange (oder falls) es kein Vorschaubild gibt
  function placeholder(label) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">` +
      `<rect width="300" height="400" fill="#2a2a2a"/>` +
      `<text x="150" y="212" fill="#8c8c8c" font-family="Menlo, monospace" font-size="22" text-anchor="middle">${label}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // Audio ohne Cover: dieselbe Platte wie das Vorschaubild aus library.rs
  function audioPlaceholder() {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">` +
      `<rect width="600" height="600" fill="#2a2a2a"/>` +
      `<circle cx="300" cy="300" r="180" fill="none" stroke="#8c8c8c" stroke-width="1.6"/>` +
      `<circle cx="300" cy="300" r="13.2" fill="#8c8c8c"/></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // ---- PDF ----

  let pdfjs = null;
  function loadPdfjs() {
    if (!pdfjs) {
      pdfjs = import("./vendor/pdfjs/pdf.min.mjs").then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", document.baseURI).href;
        return lib;
      });
    }
    return pdfjs;
  }

  const PDF_GAP = 16;

  // Eine PDF-Ansicht: Seiten untereinander, eingepasst auf die Breite der
  // Fläche (höchstens so breit, dass Seite 1 ganz zu sehen ist), zoombar.
  class PdfView {
    constructor(host, opts = {}) {
      this.host = host;
      this.opts = opts; // { padTop, padBottom, onChange }
      this.scroll = document.createElement("div");
      this.scroll.className = "pdf-scroll";
      this.pagesEl = document.createElement("div");
      this.pagesEl.className = "pdf-pages";
      this.scroll.appendChild(this.pagesEl);
      host.appendChild(this.scroll);
      this.doc = null;
      this.pages = []; // { el, canvas, w, h, drawn }
      this.zoom = 1; // Faktor relativ zu „Einpassen“
      this.token = 0;
      this.scroll.addEventListener("scroll", () => {
        this.drawVisible();
        this.focus();
        this.changed();
      });
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.scroll);
    }

    async open(url) {
      const token = ++this.token;
      this.clear();
      const lib = await loadPdfjs();
      const doc = await lib.getDocument({ url, isEvalSupported: false, disableRange: true, disableStream: true }).promise;
      if (token !== this.token) return doc.destroy();
      this.doc = doc;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (token !== this.token) return;
        const vp = page.getViewport({ scale: 1 });
        const el = document.createElement("div");
        el.className = "pdf-page";
        const canvas = document.createElement("canvas");
        el.appendChild(canvas);
        this.pagesEl.appendChild(el);
        this.pages.push({ page, el, canvas, w: vp.width, h: vp.height, drawn: 0 });
        if (i === 1 || i === doc.numPages) this.layout();
      }
      this.changed();
    }

    clear() {
      for (const p of this.pages) p.page.cleanup && p.page.cleanup();
      this.pages = [];
      this.pagesEl.replaceChildren();
      if (this.doc) this.doc.destroy();
      this.doc = null;
      this.zoom = 1;
      this.scroll.scrollTop = 0;
    }

    destroy() {
      this.token++;
      this.clear();
      this.observer.disconnect();
      this.scroll.remove();
    }

    // Grundmaß: Seite 1 passt ganz in die Fläche
    baseScale() {
      const first = this.pages[0];
      if (!first) return 1;
      const padTop = this.opts.padTop || 0;
      const padBottom = this.opts.padBottom || 0;
      const w = this.scroll.clientWidth - 48;
      const h = this.scroll.clientHeight - padTop - padBottom;
      return Math.max(0.05, Math.min(w / first.w, h / first.h));
    }

    scale() {
      return this.baseScale() * this.zoom;
    }

    layout() {
      if (!this.pages.length) return;
      const s = this.scale();
      this.pagesEl.style.paddingTop = (this.opts.padTop || 0) + "px";
      this.pagesEl.style.paddingBottom = (this.opts.padBottom || 0) + "px";
      this.pagesEl.style.gap = PDF_GAP + "px";
      for (const p of this.pages) {
        p.el.style.width = Math.round(p.w * s) + "px";
        p.el.style.height = Math.round(p.h * s) + "px";
      }
      this.drawVisible();
      this.focus();
      this.changed();
    }

    // Die Seite in der Mitte ist im Fokus; Seiten, die oben und unten
    // hereinragen, sind abgedunkelt und unscharf, je weiter weg, desto mehr.
    focus() {
      const view = this.scroll.clientHeight;
      if (!view) return;
      const mid = this.scroll.scrollTop + view / 2;
      for (const p of this.pages) {
        const top = p.el.offsetTop;
        const bottom = top + p.el.offsetHeight;
        // Abstand der Bildschirmmitte zur Seite (0, solange die Mitte auf der Seite liegt)
        const dist = mid < top ? top - mid : mid > bottom ? mid - bottom : 0;
        const k = Math.min(1, dist / (view * 0.35));
        if (k === p.focusK) continue;
        p.focusK = k;
        p.el.style.filter = k > 0.01 ? `brightness(${(1 - 0.55 * k).toFixed(3)}) blur(${(k * 4).toFixed(2)}px)` : "";
      }
    }

    // Nur sichtbare Seiten (plus Nachbarn) in Bildschirmauflösung zeichnen
    drawVisible() {
      const top = this.scroll.scrollTop - this.scroll.clientHeight;
      const bottom = this.scroll.scrollTop + this.scroll.clientHeight * 2;
      const s = this.scale() * (window.devicePixelRatio || 1);
      for (const p of this.pages) {
        const y = p.el.offsetTop;
        const visible = y + p.el.offsetHeight > top && y < bottom;
        if (!visible || Math.abs(p.drawn - s) < 0.01 || p.rendering) continue;
        p.rendering = true;
        const vp = p.page.getViewport({ scale: s });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        // Auf volle Pixel gerundet bleibt sonst rechts und unten ein Rest
        // leer und der weiße Seitengrund blitzt als Linie durch: strecken.
        const fit = [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0];
        const task = p.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: fit });
        task.promise
          .then(() => {
            p.el.replaceChildren(canvas);
            p.canvas = canvas;
            p.drawn = s;
          })
          .catch(() => {})
          .finally(() => {
            p.rendering = false;
            if (Math.abs(this.scale() * (window.devicePixelRatio || 1) - s) > 0.01) this.drawVisible();
          });
      }
    }

    // Seite, deren Mitte der Mitte der Fläche am nächsten ist (1-basiert)
    current() {
      if (!this.pages.length) return 0;
      const mid = this.scroll.scrollTop + this.scroll.clientHeight / 2;
      let best = 0;
      let dist = Infinity;
      this.pages.forEach((p, i) => {
        const d = Math.abs(p.el.offsetTop + p.el.offsetHeight / 2 - mid);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      return best + 1;
    }

    count() {
      return this.doc ? this.doc.numPages : 0;
    }

    goTo(n, smooth = true) {
      const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, n - 1))];
      if (!p) return;
      const top = p.el.offsetTop - (this.scroll.clientHeight - p.el.offsetHeight) / 2;
      this.scroll.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
    }

    step(delta) {
      this.goTo(this.current() + delta);
    }

    // Zoom um die Mitte der Fläche; 1 = Einpassen
    setZoom(z) {
      const before = this.scroll.scrollTop + this.scroll.clientHeight / 2;
      const ratio = before / Math.max(1, this.scroll.scrollHeight);
      const left = (this.scroll.scrollLeft + this.scroll.clientWidth / 2) / Math.max(1, this.scroll.scrollWidth);
      this.zoom = Math.min(8, Math.max(0.25, z));
      if (Math.abs(this.zoom - 1) < 0.03) this.zoom = 1;
      this.layout();
      this.scroll.scrollTop = ratio * this.scroll.scrollHeight - this.scroll.clientHeight / 2;
      this.scroll.scrollLeft = left * this.scroll.scrollWidth - this.scroll.clientWidth / 2;
    }

    fitted() {
      return this.zoom === 1;
    }

    changed() {
      if (this.opts.onChange) this.opts.onChange(this);
    }
  }

  // ---- Video ----

  // poster: Vorschaubild, falls vorhanden. Ohne Vorschau zeigt WebKit bis
  // zum Abspielen nur den Play-Knopf; ein kleiner Sprung lädt das erste Bild.
  function videoEl(src, poster) {
    const v = document.createElement("video");
    v.className = "media-video";
    v.controls = true;
    v.preload = "auto";
    v.playsInline = true;
    if (poster) v.poster = poster;
    v.addEventListener(
      "loadedmetadata",
      () => {
        if (v.paused && v.currentTime === 0) v.currentTime = Math.min(0.05, (v.duration || 1) / 2);
      },
      { once: true }
    );
    v.src = src;
    return v;
  }

  // Audio: Cover (ohne Cover der Platzhalter) groß, darunter Titel und Player.
  function audioEl(src, cover, title, sub) {
    const wrap = document.createElement("div");
    wrap.className = "media-audio";
    const img = document.createElement("img");
    img.className = "media-audio-cover";
    img.src = cover || audioPlaceholder();
    img.draggable = false;
    wrap.appendChild(img);
    const meta = document.createElement("div");
    meta.className = "media-audio-meta";
    const t = document.createElement("div");
    t.className = "media-audio-title";
    t.textContent = title || "";
    meta.appendChild(t);
    if (sub) {
      const s = document.createElement("div");
      s.className = "media-audio-sub";
      s.textContent = sub;
      meta.appendChild(s);
    }
    wrap.appendChild(meta);
    // ohne eigene Steuerung: abgespielt wird über player() in der Leiste
    const a = document.createElement("audio");
    a.className = "media-audio-player";
    a.preload = "metadata";
    a.src = src;
    wrap.appendChild(a);
    return wrap;
  }

  // 96000, 24, 2 → "96 kHz · 24 Bit · Stereo"
  function audioFormat(rate, bits, channels) {
    const parts = [];
    if (rate) parts.push((rate % 1000 ? (rate / 1000).toFixed(1) : rate / 1000) + " kHz");
    if (bits) parts.push(bits + " Bit");
    if (channels) parts.push(channels === 1 ? "Mono" : channels === 2 ? "Stereo" : channels + " ch");
    return parts.join(" · ");
  }

  // ---- Eigener Player (Variante C): obere Reihe der Navigationsleiste ----
  // Play/Pause, Zeit, Zeitlinie zum Ziehen, Dauer, Ton an/aus.

  const ICON_PLAY = '<svg width="12" height="13" viewBox="0 0 12 13"><path d="M1 0.8v11.4L11 6.5z" fill="currentColor"/></svg>';
  const ICON_PAUSE =
    '<svg width="11" height="12" viewBox="0 0 11 12"><rect x="0.5" width="3.4" height="12" rx=".6" fill="currentColor"/><rect x="7.1" width="3.4" height="12" rx=".6" fill="currentColor"/></svg>';
  const ICON_VOL =
    '<svg width="15" height="12" viewBox="0 0 15 12"><path d="M0.5 4h2.6L7 0.8v10.4L3.1 8H0.5z" fill="currentColor"/><path d="M9.5 3.3a3.6 3.6 0 0 1 0 5.4M11.6 1.3a6.4 6.4 0 0 1 0 9.4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>';
  const ICON_MUTE =
    '<svg width="15" height="12" viewBox="0 0 15 12"><path d="M0.5 4h2.6L7 0.8v10.4L3.1 8H0.5z" fill="currentColor"/><path d="M9.6 3.8l4 4.4M13.6 3.8l-4 4.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

  function player(media) {
    media.controls = false;
    const row = document.createElement("div");
    row.className = "mp-row";
    const mk = (tag, cls, html) => {
      const n = document.createElement(tag);
      n.className = cls;
      if (html) n.innerHTML = html;
      if (tag === "button") {
        // kein Fokus: die Leertaste bleibt beim Tastaturkürzel (Play/Pause)
        n.type = "button";
        n.tabIndex = -1;
        n.addEventListener("mousedown", (e) => e.preventDefault());
      }
      return n;
    };
    const play = mk("button", "mp-btn mp-play", ICON_PLAY);
    const cur = mk("span", "mp-time");
    const track = mk("div", "mp-track");
    const fill = mk("i", "mp-fill");
    const knob = mk("b", "mp-knob");
    track.append(fill, knob);
    const total = mk("span", "mp-time");
    const vol = mk("button", "mp-btn mp-vol", ICON_VOL);
    row.append(play, cur, track, total, vol);

    let seeking = false;
    let raf = 0;
    const draw = () => {
      const d = media.duration;
      const f = d && isFinite(d) ? Math.min(1, media.currentTime / d) : 0;
      fill.style.width = f * 100 + "%";
      knob.style.left = f * 100 + "%";
      cur.textContent = duration(media.currentTime) || "0:00";
      total.textContent = duration(d) || "–:––";
    };
    const loop = () => {
      draw();
      raf = media.paused || !row.isConnected ? 0 : requestAnimationFrame(loop);
    };
    const state = () => {
      play.innerHTML = media.paused ? ICON_PLAY : ICON_PAUSE;
      row.classList.toggle("playing", !media.paused);
      if (!media.paused && !raf) raf = requestAnimationFrame(loop);
      draw();
    };
    const toggle = () => (media.paused ? media.play() : media.pause());
    play.addEventListener("click", toggle);
    if (media.tagName === "VIDEO") media.addEventListener("click", toggle);
    vol.addEventListener("click", () => {
      media.muted = !media.muted;
      vol.innerHTML = media.muted ? ICON_MUTE : ICON_VOL;
      vol.classList.toggle("muted", media.muted);
    });
    for (const ev of ["play", "pause", "ended", "loadedmetadata", "durationchange", "seeked"]) media.addEventListener(ev, state);
    media.addEventListener("timeupdate", () => !raf && draw());

    // Zeitlinie: klicken oder ziehen
    const seekTo = (x) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (x - r.left) / r.width));
      if (media.duration && isFinite(media.duration)) media.currentTime = f * media.duration;
      draw();
    };
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      seeking = true;
      row.classList.add("seeking");
      track.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
    });
    track.addEventListener("pointermove", (e) => seeking && seekTo(e.clientX));
    const end = () => {
      seeking = false;
      row.classList.remove("seeking");
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    state();
    return {
      row,
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        media.pause();
        row.remove();
      },
    };
  }

  // Leertaste: laufendes Video/Audio anhalten bzw. starten. false = nichts da.
  function togglePlay(root) {
    const m = (root || document).querySelector(".media-video, .media-audio-player");
    if (!m) return false;
    m.paused ? m.play() : m.pause();
    return true;
  }

  global.ArchiverMedia = { kind, duration, placeholder, PdfView, videoEl, audioEl, audioPlaceholder, audioFormat, togglePlay, player, loadPdfjs };
})(window);
