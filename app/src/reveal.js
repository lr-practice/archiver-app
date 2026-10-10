// reveal.js
// Licht-Öffnung nach der Einstiegstour: ein WebGL-Shader über dem Fenster.
// Aus dem Dunkel öffnet sich die Oberfläche, weich von der Mitte aus (Welle,
// Standard) oder als Lid aus einer Lichtlinie.
// Elemente erscheinen, wenn das Licht sie erreicht. Zum Schluss leuchtet der
// Fensterrand kurz von innen. Ruhig und langsam, zusammen etwa 3,5 s.

(() => {
  const COLORS = {
    g1: [0x86, 0xa2, 0xff], // Lichtkante
    g2: [0x2d, 0x5a, 0xeb], // Glow, Archiver-Akzent
    deep: [0x04, 0x06, 0x0d], // Dunkel vor dem Öffnen
  };
  const ELEMENT_GLOW = "#6f8fff";

  const VERT = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  // Alles in CSS-Pixeln (u_scale = devicePixelRatio). Licht wird über das
  // Dunkel gelegt: Farbe = Dunkel × Abdeckung + Licht, Deckkraft entsprechend.
  const FRAG = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_scale;
    uniform float u_mode;   // 0 Welle, 1 Lid
    uniform float u_r;      // Welle: Radius des Rings
    uniform float u_ring;   // Stärke des Rings
    uniform float u_open;   // Lid: halbe Öffnung in px
    uniform float u_frame;  // Fensterrand
    uniform float u_time;
    uniform vec3 u_g1;
    uniform vec3 u_g2;
    uniform vec3 u_deep;

    float hash(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 px = gl_FragCoord.xy / u_scale;
      vec2 res = u_res / u_scale;
      vec2 c = res * 0.5;
      float cover;
      float edge;
      if (u_mode < 0.5) {
        float d = distance(px, c);
        cover = smoothstep(u_r - 320.0, u_r + 80.0, d);
        edge = d - u_r;
      } else {
        float d = abs(px.y - c.y);
        cover = smoothstep(u_open - 2.0, u_open + 2.0, d);
        edge = d - u_open;
      }
      // Licht an der Kante: feiner Kern, weicher breiter Hof
      float core = exp(-pow(edge / 3.0, 2.0));
      float halo = exp(-pow(edge / 38.0, 2.0)) * 0.55 + exp(-abs(edge) / 140.0) * 0.18;
      // Auf der freigelegten Seite nur ein Hauch, damit die Oberfläche ruhig bleibt
      halo *= edge < 0.0 ? 0.3 : 1.0;
      float ring = u_ring;
      vec3 light = (u_g1 * core * 0.9 + u_g2 * halo) * ring;

      // Fensterrand leuchtet kurz von innen
      float e = min(min(px.x, px.y), min(res.x - px.x, res.y - px.y));
      vec3 frame = u_g2 * (exp(-e / 26.0) * 0.8 + exp(-e / 110.0) * 0.35) * u_frame;

      vec3 add = light + frame;
      // leichtes Korn im Licht
      float grain = (hash(px + fract(u_time)) - 0.5) * 0.06;
      add *= 1.0 + grain;

      float la = clamp(max(max(add.r, add.g), add.b), 0.0, 1.0);
      float a = clamp(cover + la * (1.0 - cover), 0.0, 1.0);
      vec3 col = u_deep * cover * (1.0 - la) + add;
      // vormultipliert: Farbe nie heller als die Deckkraft
      gl_FragColor = vec4(min(col, vec3(a)), a);
    }
  `;

  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // cubic-bezier(.65,0,.35,1) angenähert: ruhiger als kubisch
  const easeLid = (t) => {
    let lo = 0;
    let hi = 1;
    const bez = (u, a, b) => 3 * u * (1 - u) * (1 - u) * a + 3 * u * u * (1 - u) * b + u * u * u;
    for (let k = 0; k < 20; k++) {
      const m = (lo + hi) / 2;
      if (bez(m, 0.65, 0.35) < t) lo = m;
      else hi = m;
    }
    return bez((lo + hi) / 2, 0, 1);
  };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function setupGl(canvas) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const n of ["res", "scale", "mode", "r", "ring", "open", "frame", "time", "g1", "g2", "deep"])
      u[n] = gl.getUniformLocation(prog, "u_" + n);
    const rgb = (c) => c.map((v) => v / 255);
    gl.uniform3fv(u.g1, rgb(COLORS.g1));
    gl.uniform3fv(u.g2, rgb(COLORS.g2));
    gl.uniform3fv(u.deep, rgb(COLORS.deep));
    return { gl, u };
  }

  // Elemente glühen weich auf, wenn das Licht sie erreicht, und kühlen ab.
  function revealElement(node, delay) {
    const from = { opacity: 0, filter: "blur(4px) brightness(1.25)", boxShadow: `0 0 22px 2px ${ELEMENT_GLOW}33` };
    const mid = { ...from, opacity: 1, offset: 0.3 };
    const to = { opacity: 1, filter: "blur(0px) brightness(1)", boxShadow: "0 0 0 0 transparent" };
    const a = node.animate([from, mid, to], {
      duration: 1800,
      delay: Math.max(0, delay),
      easing: "cubic-bezier(.45,0,.25,1)",
      fill: "backwards",
    });
    return a.finished.catch(() => {});
  }

  /**
   * play({ mode: "wave" | "lid", targets: Element[], onStart })
   * Die Oberfläche ist beim Aufruf schon fertig gezeichnet, aber verdeckt.
   */
  function play({ mode = "wave", targets = [], onStart } = {}) {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const layer = document.createElement("div");
    layer.className = "reveal";
    const canvas = document.createElement("canvas");
    layer.append(canvas);
    document.body.appendChild(layer);

    if (still) {
      if (onStart) onStart();
      return layer
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: "ease-out", fill: "forwards" })
        .finished.then(() => layer.remove());
    }

    let ctx = null;
    try {
      ctx = setupGl(canvas);
    } catch (e) {
      console.warn(e);
    }
    const W = innerWidth;
    const H = innerHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (!ctx) {
      // Ohne WebGL: nur weich einblenden
      if (onStart) onStart();
      return layer
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: "ease-out", fill: "forwards" })
        .finished.then(() => layer.remove());
    }
    const { gl, u } = ctx;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.scale, dpr);
    gl.uniform1f(u.mode, mode === "lid" ? 1 : 0);

    const lid = mode === "lid";
    const START = lid ? 1000 : 300;
    const DUR = lid ? 2000 : 2600;
    const TOTAL = START + DUR + 600;
    const Rmax = Math.hypot(W / 2, H / 2) + 120;
    const Omax = H / 2 + 60;

    // Wann erreicht das Licht ein Element? Zeitpunkt über die Kurve zurückgerechnet
    const ease = lid ? easeLid : easeInOutCubic;
    const timeAt = (dist, max) => {
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 18; k++) {
        const m = (lo + hi) / 2;
        if (ease(m) * max < dist) lo = m;
        else hi = m;
      }
      return START + hi * DUR;
    };
    const jobs = targets.map((node) => {
      const r = node.getBoundingClientRect();
      let dist;
      if (lid) {
        dist = r.top < H / 2 && r.bottom > H / 2 ? 0 : Math.min(Math.abs(r.top - H / 2), Math.abs(r.bottom - H / 2));
        return revealElement(node, timeAt(dist, Omax) - 120);
      }
      const nx = Math.max(r.left, Math.min(W / 2, r.right));
      const ny = Math.max(r.top, Math.min(H / 2, r.bottom));
      dist = Math.hypot(nx - W / 2, ny - H / 2);
      return revealElement(node, timeAt(dist, Rmax) - 200);
    });

    if (onStart) onStart();

    const frameAt = START + DUR * (lid ? 0.5 : 0.6);
    const frameDur = 2400;
    const smooth = (t) => t * t * (3 - 2 * t);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const draw = (now) => {
        const ms = now - t0;
        const t = Math.max(0, Math.min(1, (ms - START) / DUR));
        const e = ease(t);
        gl.uniform1f(u.time, ms / 1000);
        if (lid) {
          gl.uniform1f(u.open, e * Omax);
          // Lichtlinie erscheint vor dem Öffnen, verglimmt zum Ende
          const pre = Math.min(1, Math.max(0, (ms - START + 600) / 600));
          gl.uniform1f(u.ring, smooth(pre) * (t < 0.6 ? 0.7 : (0.7 * (1 - t)) / 0.4));
        } else {
          // Ohne sichtbaren Ring: das Dunkel weicht weich von der Mitte aus
          gl.uniform1f(u.r, e * (Rmax + 320));
          gl.uniform1f(u.ring, 0);
        }
        const f = (ms - frameAt) / frameDur;
        gl.uniform1f(u.frame, f <= 0 || f >= 1 ? 0 : 0.55 * (f < 0.35 ? smooth(f / 0.35) : smooth((1 - f) / 0.65)));
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (ms < Math.max(TOTAL, frameAt + frameDur)) requestAnimationFrame(draw);
        else resolve();
      };
      requestAnimationFrame(draw);
    })
      .then(() => Promise.all(jobs))
      .then(() => {
        const ext = gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
        layer.remove();
      });
  }

  window.ArchiverReveal = { play };
})();
