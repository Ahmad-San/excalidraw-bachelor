/**
 * web-profiler.js
 * ─────────────────────────────────────────────────────────────
 * Lightweight web profiler for constrained browsers (Tizen 5.2+)
 * No dependencies. Single file drop-in.
 *
 * Measures:
 *  1. Input latency      — stylus/touch pointerdown → first render frame
 *  2. FPS                — frames per second during interaction
 *  3. Canvas call timing — how long each canvas API call takes
 *  4. Memory usage       — JS heap if browser supports it
 *
 * USAGE:
 *   <script src="web-profiler.js"></script>
 *   <script> WebProfiler.init(); </script>
 * ─────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  // ── Internal state ──────────────────────────────────────────
  const state = {
    active: false,
    options: {},

    // input latency
    latencySamples: [],
    pointerDownTime: 0,
    rafPending: false,

    // FPS
    fps: 0,
    fpsFrames: 0,
    fpsLastTime: performance.now(),
    rafLoop: null,

    // canvas timing
    canvasTimings: {},   // { methodName: [ms, ms, ...] }

    // memory
    memorySamples: [],
    memoryInterval: null,
  };

  // ── Utilities ───────────────────────────────────────────────
  function avg(arr) {
    return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function colorFor(ms) {
    if (ms < 30) return '#00e5ff';
    if (ms < 80) return '#ffb300';
    return '#ff3d71';
  }
  function fpsColor(fps) {
    if (fps >= 50) return '#00e5ff';
    if (fps >= 30) return '#ffb300';
    return '#ff3d71';
  }
  function mb(bytes) { return (bytes / 1048576).toFixed(1); }

  // ── 1. Input Latency ────────────────────────────────────────
  function onPointerDown(e) {
    if (state.options.stylusOnly && e.pointerType === 'mouse') return;
    state.pointerDownTime = performance.now();
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(function () {
      const latency = Math.round(performance.now() - state.pointerDownTime);
      state.rafPending = false;
      state.latencySamples.push({ ms: latency, pointerType: e.pointerType, timestamp: new Date().toISOString() });
      if (state.options.logToConsole) {
        console.log('[WebProfiler] Input latency: ' + latency + 'ms (' + e.pointerType + ')');
      }
      if (typeof state.options.onLatency === 'function') state.options.onLatency(latency);
      updateHUD();
    });
  }

  // ── 2. FPS Loop ─────────────────────────────────────────────
  function fpsTick() {
    state.fpsFrames++;
    const now = performance.now();
    const elapsed = now - state.fpsLastTime;
    if (elapsed >= 1000) {
      state.fps = Math.round((state.fpsFrames * 1000) / elapsed);
      state.fpsFrames = 0;
      state.fpsLastTime = now;
      updateHUD();
    }
    state.rafLoop = requestAnimationFrame(fpsTick);
  }

  // ── 3. Canvas API Wrapping ──────────────────────────────────
  // These are the canvas methods most relevant to drawing apps
  const CANVAS_METHODS = [
    'stroke', 'fill', 'beginPath', 'moveTo', 'lineTo',
    'bezierCurveTo', 'quadraticCurveTo', 'arc',
    'drawImage', 'putImageData', 'clearRect', 'fillRect',
  ];

  function wrapCanvasAPI() {
    const proto = CanvasRenderingContext2D.prototype;
    CANVAS_METHODS.forEach(function (method) {
      if (!proto[method]) return;
      const original = proto[method];
      state.canvasTimings[method] = [];
      proto[method] = function () {
        const t = performance.now();
        const result = original.apply(this, arguments);
        const elapsed = performance.now() - t;
        state.canvasTimings[method].push(elapsed);
        // keep last 200 samples per method to avoid memory bloat
        if (state.canvasTimings[method].length > 200) {
          state.canvasTimings[method].shift();
        }
        return result;
      };
      proto[method].__wrapped = true;
    });
    if (state.options.logToConsole) console.log('[WebProfiler] Canvas API wrapped.');
  }

  function unwrapCanvasAPI() {
    // We can't easily unwrap without storing originals separately
    // So we just stop collecting — originals are gone after wrap
    // For thesis purposes this is fine
    if (state.options.logToConsole) console.log('[WebProfiler] Canvas unwrap skipped (reload page to reset).');
  }

  function getCanvasStats() {
    const result = {};
    CANVAS_METHODS.forEach(function (method) {
      const samples = state.canvasTimings[method];
      if (!samples || !samples.length) return;
      result[method] = {
        calls: samples.length,
        avgMs: parseFloat((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3)),
        maxMs: parseFloat(Math.max.apply(null, samples).toFixed(3)),
        totalMs: parseFloat(samples.reduce((a, b) => a + b, 0).toFixed(3)),
      };
    });
    return result;
  }

  // ── 4. Memory Sampling ──────────────────────────────────────
  function startMemorySampling() {
    if (!performance.memory) {
      if (state.options.logToConsole) console.log('[WebProfiler] performance.memory not available in this browser.');
      return;
    }
    state.memoryInterval = setInterval(function () {
      state.memorySamples.push({
        usedMB: parseFloat(mb(performance.memory.usedJSHeapSize)),
        totalMB: parseFloat(mb(performance.memory.totalJSHeapSize)),
        timestamp: new Date().toISOString(),
      });
    }, 2000);
  }

  // ── HUD ─────────────────────────────────────────────────────
  let hud = null;

  function createHUD() {
    const el = document.createElement('div');
    el.id = '__web_profiler_hud__';
    el.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:20px',
      'z-index:2147483647',
      'background:rgba(8,8,14,0.93)',
      'border:1px solid #2a2a3a',
      'border-radius:10px',
      'padding:14px 18px',
      'font-family:monospace',
      'font-size:11px',
      'color:#e8e8f0',
      'min-width:220px',
      'backdrop-filter:blur(8px)',
      'box-shadow:0 4px 32px rgba(0,0,0,0.6)',
      'user-select:none',
      'cursor:move',
    ].join(';');

    el.innerHTML = [
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">',
        '<span style="color:#00e5ff;font-weight:700;font-size:10px;letter-spacing:0.08em">⬡ WEB PROFILER</span>',
        '<div style="display:flex;gap:5px">',
          '<button id="__wp_export__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CSV</button>',
          '<button id="__wp_clear__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CLR</button>',
        '</div>',
      '</div>',

      // FPS + Latency row
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">',
        '<div>',
          '<div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:2px">FPS</div>',
          '<div id="__wp_fps__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
        '</div>',
        '<div>',
          '<div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:2px">AVG LAT</div>',
          '<div id="__wp_lat__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
          '<div style="color:#555570;font-size:9px">ms</div>',
        '</div>',
        '<div>',
          '<div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:2px">MEM</div>',
          '<div id="__wp_mem__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
          '<div style="color:#555570;font-size:9px">MB</div>',
        '</div>',
      '</div>',

      // Canvas timing table
      '<div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:4px">CANVAS CALLS (avg ms)</div>',
      '<div id="__wp_canvas__" style="display:flex;flex-direction:column;gap:3px;margin-bottom:10px"></div>',

      // Mini latency bar
      '<div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:4px">LAST 8 STROKES</div>',
      '<div id="__wp_bars__" style="display:flex;align-items:flex-end;gap:3px;height:24px;margin-bottom:6px"></div>',

      // status
      '<div style="display:flex;align-items:center;gap:6px">',
        '<div id="__wp_dot__" style="width:6px;height:6px;border-radius:50%;background:#555570"></div>',
        '<div id="__wp_status__" style="color:#555570;font-size:10px">waiting…</div>',
      '</div>',
    ].join('');

    document.body.appendChild(el);

    el.querySelector('#__wp_export__').addEventListener('click', function (e) {
      e.stopPropagation();
      WebProfiler.exportCSV();
    });
    el.querySelector('#__wp_clear__').addEventListener('click', function (e) {
      e.stopPropagation();
      WebProfiler.clear();
    });

    makeDraggable(el);
    return el;
  }

  function updateHUD() {
    if (!hud) return;

    // FPS
    const fpsEl = hud.querySelector('#__wp_fps__');
    if (fpsEl) {
      fpsEl.textContent = state.fps;
      fpsEl.style.color = fpsColor(state.fps);
    }

    // Latency
    const latEl = hud.querySelector('#__wp_lat__');
    if (latEl && state.latencySamples.length) {
      const avgLat = avg(state.latencySamples.map(function (s) { return s.ms; }));
      latEl.textContent = avgLat;
      latEl.style.color = colorFor(avgLat);
    }

    // Memory
    const memEl = hud.querySelector('#__wp_mem__');
    if (memEl && performance.memory) {
      memEl.textContent = mb(performance.memory.usedJSHeapSize);
    }

    // Canvas timing — show top 5 most-called methods
    const canvasEl = hud.querySelector('#__wp_canvas__');
    if (canvasEl) {
      const stats = getCanvasStats();
      const entries = Object.keys(stats)
        .sort(function (a, b) { return stats[b].calls - stats[a].calls; })
        .slice(0, 5);

      canvasEl.innerHTML = entries.map(function (method) {
        const s = stats[method];
        const color = s.avgMs > 1 ? '#ffb300' : '#555570';
        return [
          '<div style="display:flex;justify-content:space-between;font-size:9px">',
            '<span style="color:#888">' + method + '</span>',
            '<span style="color:' + color + '">' + s.avgMs + 'ms × ' + s.calls + '</span>',
          '</div>',
        ].join('');
      }).join('');
    }

    // Bars
    const barsEl = hud.querySelector('#__wp_bars__');
    if (barsEl && state.latencySamples.length) {
      const recent = state.latencySamples.slice(-8).map(function (s) { return s.ms; });
      const maxV = Math.max.apply(null, recent) || 1;
      barsEl.innerHTML = recent.map(function (v) {
        const h = clamp(Math.round((v / maxV) * 24), 2, 24);
        return '<div style="flex:1;height:' + h + 'px;background:' + colorFor(v) + ';border-radius:2px 2px 0 0;opacity:0.85"></div>';
      }).join('');
    }

    // Dot flash on new latency sample
    const dot = hud.querySelector('#__wp_dot__');
    const status = hud.querySelector('#__wp_status__');
    if (dot && state.latencySamples.length) {
      const last = state.latencySamples[state.latencySamples.length - 1];
      dot.style.background = colorFor(last.ms);
      dot.style.boxShadow = '0 0 6px ' + colorFor(last.ms);
      if (status) status.textContent = 'last: ' + last.ms + 'ms (' + last.pointerType + ')';
      setTimeout(function () {
        dot.style.background = '#555570';
        dot.style.boxShadow = 'none';
      }, 400);
    }
  }

  function makeDraggable(el) {
    var ox, oy, sx, sy;
    el.addEventListener('pointerdown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      ox = el.offsetLeft || (window.innerWidth - el.offsetWidth - 20);
      oy = el.offsetTop  || (window.innerHeight - el.offsetHeight - 20);
      sx = e.clientX; sy = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function (e) {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
      el.style.left   = clamp(ox + e.clientX - sx, 0, window.innerWidth  - el.offsetWidth)  + 'px';
      el.style.top    = clamp(oy + e.clientY - sy, 0, window.innerHeight - el.offsetHeight) + 'px';
    });
  }

  // ── Public API ───────────────────────────────────────────────
  var WebProfiler = {

    init: function (options) {
      if (state.active) return this;
      state.options = Object.assign({
        target: window,
        overlay: true,
        logToConsole: false,
        stylusOnly: false,
        wrapCanvas: true,
        trackMemory: true,
        onLatency: null,
      }, options || {});

      // input latency
      var target = state.options.target;
      target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });

      // fps
      state.fpsLastTime = performance.now();
      fpsTick();

      // canvas wrapping
      if (state.options.wrapCanvas) wrapCanvasAPI();

      // memory
      if (state.options.trackMemory) startMemorySampling();

      // hud
      if (state.options.overlay) hud = createHUD();

      state.active = true;
      if (state.options.logToConsole) console.log('[WebProfiler] initialized.');
      return this;
    },

    destroy: function () {
      var target = state.options.target || window;
      target.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (state.rafLoop) cancelAnimationFrame(state.rafLoop);
      if (state.memoryInterval) clearInterval(state.memoryInterval);
      if (hud) { hud.remove(); hud = null; }
      state.active = false;
      return this;
    },

    getLatencyStats: function () {
      var vals = state.latencySamples.map(function (s) { return s.ms; });
      return {
        avg:     avg(vals),
        min:     vals.length ? Math.min.apply(null, vals) : null,
        max:     vals.length ? Math.max.apply(null, vals) : null,
        count:   vals.length,
        samples: state.latencySamples.slice(),
      };
    },

    getCanvasStats: getCanvasStats,

    getMemoryStats: function () {
      if (!state.memorySamples.length) return null;
      var used = state.memorySamples.map(function (s) { return s.usedMB; });
      return {
        avgMB: parseFloat((used.reduce(function (a, b) { return a + b; }, 0) / used.length).toFixed(1)),
        maxMB: Math.max.apply(null, used),
        samples: state.memorySamples.slice(),
      };
    },

    getFPS: function () { return state.fps; },

    exportCSV: function () {
      var sections = [];

      // Latency
      if (state.latencySamples.length) {
        sections.push('=== INPUT LATENCY ===');
        sections.push('sample,latency_ms,pointer_type,timestamp');
        state.latencySamples.forEach(function (s, i) {
          sections.push((i + 1) + ',' + s.ms + ',' + s.pointerType + ',' + s.timestamp);
        });
        sections.push('');
      }

      // Canvas
      var canvasStats = getCanvasStats();
      var methods = Object.keys(canvasStats);
      if (methods.length) {
        sections.push('=== CANVAS API TIMING ===');
        sections.push('method,calls,avg_ms,max_ms,total_ms');
        methods.forEach(function (m) {
          var s = canvasStats[m];
          sections.push(m + ',' + s.calls + ',' + s.avgMs + ',' + s.maxMs + ',' + s.totalMs);
        });
        sections.push('');
      }

      // Memory
      if (state.memorySamples.length) {
        sections.push('=== MEMORY ===');
        sections.push('sample,used_mb,total_mb,timestamp');
        state.memorySamples.forEach(function (s, i) {
          sections.push((i + 1) + ',' + s.usedMB + ',' + s.totalMB + ',' + s.timestamp);
        });
      }

      if (!sections.length) {
        console.warn('[WebProfiler] No data to export yet.');
        return;
      }

      var csv = sections.join('\n');
      var blob = new Blob([csv], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'web_profiler_' + Date.now() + '.csv';
      a.click();
      if (state.options.logToConsole) console.log('[WebProfiler] Exported.');
    },

    clear: function () {
      state.latencySamples = [];
      state.memorySamples  = [];
      Object.keys(state.canvasTimings).forEach(function (k) { state.canvasTimings[k] = []; });
      if (hud) {
        ['#__wp_fps__', '#__wp_lat__', '#__wp_mem__'].forEach(function (id) {
          var el = hud.querySelector(id);
          if (el) { el.textContent = '—'; el.style.color = '#00e5ff'; }
        });
        var bars = hud.querySelector('#__wp_bars__');
        if (bars) bars.innerHTML = '';
        var canvas = hud.querySelector('#__wp_canvas__');
        if (canvas) canvas.innerHTML = '';
        var status = hud.querySelector('#__wp_status__');
        if (status) status.textContent = 'waiting…';
      }
      if (state.options.logToConsole) console.log('[WebProfiler] Cleared.');
      return this;
    },
  };

  global.WebProfiler = WebProfiler;

})(window);
