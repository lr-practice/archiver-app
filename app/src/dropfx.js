// dropfx.js — Ablegen auf einer Active Zone (DESIGN.md 4.3, 4.13): wie die
// Karte zeigt, dass etwas angekommen ist. Labor › Ablegen wählt die Variante
// (`archiver.lab`: drop, dropLeave). Gleich in der Leiste der App (app.js)
// und der Zonenleiste am ganzen Mac (dropbar.js).

(function () {
  const STYLES = ["mini", "check", "ring", "count", "name", "after", "glow"];
  const EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)"; // --sheet-ease
  const MOVE = 280;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function lab() {
    let l = {};
    try {
      l = JSON.parse(localStorage.getItem("archiver.lab") || "{}") || {};
    } catch {}
    return { style: STYLES.includes(l.drop) ? l.drop : "mini", calm: l.dropLeave === "calm" };
  }

  // Stehzeit nach dem Ablegen, danach 0.18 s ausblenden
  const leaveDelay = (calm) => (calm ? 1200 : 350);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fileName = (p) => p.split("/").pop();

  // Bild der ersten Datei; null, wenn es keins gibt oder es nicht schnell lädt
  async function preview(opts) {
    const path = opts.paths[0];
    try {
      // opts.url: schon bekanntes Vorschaubild (eigene Objekte in der App)
      if (!opts.url && !(await opts.invoke("dropbar_preview", { path }))) return null;
      const img = new Image();
      img.src = opts.url || opts.src(path);
      await Promise.race([img.decode(), new Promise((_, no) => setTimeout(no, 250))]);
      return img;
    } catch {
      return null;
    }
  }

  // Zeile rollt: alter Text hoch, neuer von unten
  function roll(node, text, mono) {
    const from = node.dataset.shown || node.textContent;
    node.dataset.shown = text;
    if (reduced()) {
      node.textContent = text;
      return;
    }
    const h = node.style.height ? parseFloat(node.style.height) : node.getBoundingClientRect().height;
    const col = el("span", "fx-roll");
    col.append(el("span", null, from), el("span", mono ? "fx-mono" : null, text));
    node.replaceChildren(col);
    node.classList.add("fx-rolling");
    node.style.height = h + "px";
    col.animate([{ transform: "none" }, { transform: `translateY(${-h}px)` }], { duration: MOVE, easing: EASE, fill: "forwards" });
  }

  // Miniatur: vom Zeiger (Punkte im Fenster) in die Ecke der Karte
  function stamp(card, img, pos, more) {
    const s = el("div", "fx-stamp");
    s.appendChild(img);
    if (more > 0) s.appendChild(el("span", "fx-mono fx-more", "+" + more));
    card.appendChild(s);
    if (!pos || reduced()) return;
    const r = img.getBoundingClientRect();
    const dx = pos.x - (r.left + r.width / 2);
    const dy = pos.y - (r.top + r.height / 2);
    img.animate([{ transform: `translate(${dx}px, ${dy}px) scale(2.4)` }, { transform: "none" }], { duration: MOVE, easing: EASE });
  }

  function ring(card) {
    const r = card.getBoundingClientRect();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "fx-ring");
    const rect = document.createElementNS(ns, "rect");
    const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
    const attrs = { x: 0.5, y: 0.5, width: r.width + 5, height: r.height + 5, rx: radius + 3, pathLength: 1 };
    for (const [k, v] of Object.entries(attrs)) rect.setAttribute(k, v);
    svg.appendChild(rect);
    card.appendChild(svg);
    if (!reduced()) rect.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: MOVE, easing: EASE, fill: "both" });
  }

  // Beim Loslassen, bevor gesichert ist. parts: { num, name, hint };
  // opts: { paths, pos, invoke, src, url? }. Gibt das Spiel für land() zurück.
  async function begin(card, parts, opts) {
    const { style, calm } = lab();
    const play = { style, calm, card, parts, paths: opts.paths, t0: Date.now() };
    card.classList.add("fx", "fx-is-" + style);
    const img = style === "mini" || style === "after" ? await preview(opts) : null;
    if (img && style === "mini") stamp(card, img, opts.pos, opts.paths.length - 1);
    if (img && style === "after") {
      img.className = "fx-after";
      card.prepend(img);
    }
    if (style === "name") {
      const more = opts.paths.length > 1 ? " +" + (opts.paths.length - 1) : "";
      roll(parts.name, fileName(opts.paths[0]) + more, true);
    }
    return play;
  }

  // Gesichert: Abschluss der Variante, dann darf die Leiste gehen
  async function land(play, zoneLabel) {
    const { style, card, parts } = play;
    card.classList.add("fx-landed");
    if (style === "check") parts.hint.prepend(el("span", "fx-check"));
    if (style === "ring") ring(card);
    if (style === "count") roll(parts.num, "+" + play.paths.length, true);
    if (style === "name") {
      // den Dateinamen lesbar stehen lassen, auch wenn das Sichern schnell war
      await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - play.t0))));
      roll(parts.name, zoneLabel);
    }
    return leaveDelay(play.calm);
  }

  function fail(play) {
    play.card.querySelector(".fx-stamp")?.remove();
    play.card.querySelector(".fx-after")?.remove();
  }

  window.ArchiverDropFx = { lab, begin, land, fail, leaveDelay };
})();
