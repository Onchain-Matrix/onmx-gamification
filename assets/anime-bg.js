/* ONMX dashboard — decorative anime "digital rain" background layer.
 * Purely visual: no text, data, or logic. Original art; not affiliated with Warner Bros. or The Matrix films.
 * - Never runs when prefers-reduced-motion: reduce (and stops if the setting changes).
 * - Light on CPU: ~20 fps cap, DPR 1, sparse columns, pauses when the tab is hidden.
 */
(function () {
  "use strict";
  var cv = document.getElementById("animeRain");
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext("2d");
  if (!ctx) return;
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var GLYPHS = "0123456789ABCDEFONMXアイウエオカキクケコサシスセソタチツテトナニヌネノ◇◆△▽○□✦✧";
  var COLORS = ["#07E9FB", "#5887F4", "#8B4FF5", "#00ff88", "#07E9FB", "#B8F7FF"];
  var FRAME_MS = 50; // ~20 fps
  var W = 0, H = 0, step = 22, cols = [], sparks = [], raf = 0, last = 0, running = false, rsz = 0;

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function glyph() { return GLYPHS.charAt((Math.random() * GLYPHS.length) | 0); }

  function setup() {
    W = cv.width = Math.max(1, window.innerWidth | 0);
    H = cv.height = Math.max(1, window.innerHeight | 0);
    step = W < 640 ? 26 : 22;
    var n = Math.ceil(W / step);
    cols = [];
    for (var i = 0; i < n; i++) {
      if (Math.random() < 0.45) continue; // sparse: leave gaps
      cols.push({ x: i * step + step / 2, y: rnd(-H, 0), v: rnd(0.6, 1.6), c: COLORS[(Math.random() * COLORS.length) | 0], s: rnd(12, 17) | 0 });
    }
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
  }

  function spark(x, y, r, a, col) {
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r); ctx.quadraticCurveTo(x, y, x - r, y);
    ctx.quadraticCurveTo(x, y, x, y - r); ctx.fill();
  }

  function frame(t) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (t - last < FRAME_MS) return;
    last = t;
    // fade previous glyphs to transparent (keeps the art underneath visible)
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(0,0,0,0.14)";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      ctx.font = "700 " + c.s + "px Orbitron, Inter, monospace";
      ctx.globalAlpha = 0.55; ctx.fillStyle = c.c;
      ctx.fillText(glyph(), c.x, c.y - c.s * 1.2);
      ctx.globalAlpha = 0.95; ctx.fillStyle = "#F4FBFF";
      ctx.fillText(glyph(), c.x, c.y);
      c.y += c.s * c.v;
      if (c.y > H + 40) { c.y = rnd(-H * 0.5, -20); c.v = rnd(0.6, 1.6); c.c = COLORS[(Math.random() * COLORS.length) | 0]; }
    }
    // anime twinkle sparkles
    if (sparks.length < 6 && Math.random() < 0.08) sparks.push({ x: rnd(0, W), y: rnd(0, H * 0.7), r: rnd(6, 14), life: 0, max: rnd(14, 26) | 0, c: COLORS[(Math.random() * 3) | 0] });
    for (var j = sparks.length - 1; j >= 0; j--) {
      var s = sparks[j]; s.life++;
      var k = s.life / s.max, a = Math.sin(Math.PI * k);
      spark(s.x, s.y, s.r * (0.4 + 0.6 * a), a * 0.9, "#ffffff");
      spark(s.x, s.y, s.r * 0.45 * a, a, s.c);
      if (s.life >= s.max) sparks.splice(j, 1);
    }
    ctx.globalAlpha = 1;
  }

  function start() {
    if (running || (mq && mq.matches) || document.hidden) return;
    running = true; last = 0; raf = requestAnimationFrame(frame);
  }
  function stop(clear) {
    running = false; if (raf) cancelAnimationFrame(raf); raf = 0;
    if (clear) ctx.clearRect(0, 0, W, H);
  }

  setup();
  start();
  window.addEventListener("resize", function () { clearTimeout(rsz); rsz = setTimeout(function () { setup(); }, 200); }, { passive: true });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(false); else start(); });
  if (mq) {
    var onChange = function () { if (mq.matches) stop(true); else start(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }
})();
