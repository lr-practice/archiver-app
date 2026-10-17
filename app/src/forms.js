// forms.js — Ansicht „Form“ (0.40.0): die Objekte einer Zone als eine Figur.
// Vier Formen nach Lukas' Wahl (17.10.): Ring (Name in der Mitte), Sonnenblume
// (goldener Winkel, erstes Objekt groß in der Mitte), Karussell (gekippter
// Ring, dreht langsam) und Fächer (bis 30 Objekte, Drehpunkt unten).
// Klick öffnet die Lightbox. Siehe DESIGN.md 4.26.

(function () {
  const TAU = Math.PI * 2;
  const SHAPES = ["ring", "sun", "carousel", "fan"];
  const LIMIT = { ring: 160, sun: 400, carousel: 72, fan: 30 };
  const reduce = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Position (0–1 der Fläche), Größe (Anteil der kürzeren Seite), Drehung, Tiefe
  const POS = {
    ring(i, n) {
      const a = (i / n) * TAU - Math.PI / 2;
      const r = 0.41;
      return { x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a), s: Math.min(0.09, ((TAU * r) / n) * 0.82) };
    },
    sun(i, n) {
      if (i === 0) return { x: 0.5, y: 0.5, s: 0.2, z: 1 };
      const r = 0.13 + 0.33 * Math.sqrt(i / n);
      const a = i * 2.39996;
      return { x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a), s: Math.min(0.075, 2.8 / n + 0.012) * (1.15 - (0.4 * i) / n) };
    },
    carousel(i, n, t) {
      const a = (i / n) * TAU + t * 0.06;
      const z = Math.sin(a);
      return { x: 0.5 + 0.4 * Math.cos(a), y: 0.5 + 0.2 * z, s: Math.min(0.13, 4.2 / n) * (0.6 + 0.3 * (z + 1)), z: (z + 1) / 2, o: 0.4 + 0.3 * (z + 1) };
    },
    fan(i, n) {
      const spread = Math.min(140, 30 + n * 5);
      const a = n > 1 ? ((-spread / 2 + (spread * i) / (n - 1)) * Math.PI) / 180 : 0;
      return { x: 0.5 + 0.3 * Math.sin(a), y: 0.84 - 0.3 * Math.cos(a), s: 0.19, rot: (a * 180) / Math.PI, z: i / n };
    },
  };

  function render(list, opts) {
    const shape = SHAPES.includes(opts.shape) ? opts.shape : "ring";
    const items = list.slice(0, LIMIT[shape]);
    const stage = document.createElement("div");
    stage.className = "p-form p-form-" + shape;
    if (shape === "ring") {
      const c = document.createElement("div");
      c.className = "p-form-center";
      const title = document.createElement("div");
      title.className = "p-form-title";
      title.textContent = opts.title || "";
      const count = document.createElement("div");
      count.className = "p-form-count";
      count.textContent = opts.countText || String(list.length);
      c.append(title, count);
      stage.appendChild(c);
    }
    const nodes = items.map((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "p-form-item";
      b.title = item.filename || "";
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      img.src = opts.thumbSrc(item);
      b.appendChild(img);
      b.addEventListener("click", () => opts.open(item));
      stage.appendChild(b);
      const ar = item.width && item.height ? Math.max(0.5, Math.min(2, item.width / item.height)) : 1;
      return { b, ar };
    });
    if (list.length > items.length) {
      const more = document.createElement("div");
      more.className = "p-form-more";
      more.textContent = opts.moreText ? opts.moreText(items.length, list.length) : `${items.length} / ${list.length}`;
      stage.appendChild(more);
    }

    let W = 0, H = 0;
    function place(t) {
      const side = Math.min(W, H);
      const ox = (W - side) / 2, oy = (H - side) / 2;
      const n = nodes.length;
      nodes.forEach((nd, i) => {
        const q = POS[shape](i, n, t);
        const base = q.s * side;
        const w = base * Math.sqrt(nd.ar), h = base / Math.sqrt(nd.ar);
        const st = nd.b.style;
        st.width = w + "px";
        st.height = h + "px";
        st.transform = `translate(${ox + q.x * side - w / 2}px, ${oy + q.y * side - h / 2}px) rotate(${q.rot || 0}deg)`;
        if (q.z != null) st.zIndex = String(Math.round(q.z * 100));
        if (q.o != null) st.opacity = String(q.o);
      });
    }
    const ro = new ResizeObserver(() => {
      W = stage.clientWidth;
      H = stage.clientHeight;
      place(t0());
    });
    ro.observe(stage);

    // Karussell dreht, solange die Fläche im Dokument ist; beim Überfahren hält es an
    let tt = 0;
    const t0 = () => tt;
    if (shape === "carousel" && !reduce()) {
      let last = performance.now();
      const born = last;
      const loop = (now) => {
        if (!stage.isConnected && now - born > 1000) return ro.disconnect();
        if (!stage.matches(":hover")) tt += (now - last) / 1000;
        last = now;
        place(tt);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    return stage;
  }

  window.ArchiverForms = { SHAPES, render };
})();
