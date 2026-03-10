/**
 * latency-meter.js
 * ─────────────────────────────────────────────────────────────
 * Drop-in stylus/touch/mouse input latency measurement library.
 * Works on any web app. No dependencies.
 *
 * USAGE:
 *   <script src="latency-meter.js"></script>
 *   <script> LatencyMeter.init(); </script>
 *
 *   Or with options:
 *   <script>
 *     LatencyMeter.init({
 *       target: document.getElementById('my-canvas'), // default: window
 *       overlay: true,           // show floating HUD (default: true)
 *       logToConsole: true,      // print each measurement (default: false)
 *       onMeasure: (ms) => {}    // callback for each measurement
 *     });
 *   </script>
 * ─────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  // ── Internal state ──────────────────────────────────────────
  const state = {
    measurements: [],
    active: false,
    pointerDownTime: 0,
    rafPending: false,
    options: {},
  };

  // ── Helpers ─────────────────────────────────────────────────
  function avg(arr) {
    return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  }
  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }
  function colorFor(ms) {
    if (ms < 30) return '#00e5ff';
    if (ms < 80) return '#ffb300';
    return '#ff3d71';
  }

  // ── Core measurement logic ───────────────────────────────────
  function onPointerDown(e) {
    // ignore mouse if stylus/touch is available
    if (e.pointerType === 'mouse' && state.options.stylusOnly) return;

    state.pointerDownTime = performance.now();

    if (state.rafPending) return; // don't double-measure within same frame
    state.rafPending = true;

    requestAnimationFrame(() => {
      const latency = Math.round(performance.now() - state.pointerDownTime);
      state.rafPending = false;
      record(latency, e.pointerType);
    });
  }

  function record(ms, pointerType) {
    const entry = {
      ms,
      pointerType: pointerType || 'unknown',
      timestamp: new Date().toISOString(),
    };
    state.measurements.push(entry);

    if (state.options.logToConsole) {
      console.log(`[LatencyMeter] ${ms}ms (${pointerType})`);
    }
    if (typeof state.options.onMeasure === 'function') {
      state.options.onMeasure(ms, entry);
    }

    updateHUD();
  }

  // ── HUD (overlay UI) ─────────────────────────────────────────
  let hud = null;

  function createHUD() {
    const el = document.createElement('div');
    el.id = '__latency_meter_hud__';
    el.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      background: rgba(10,10,18,0.92);
      border: 1px solid #2a2a3a;
      border-radius: 10px;
      padding: 14px 18px;
      font-family: 'Space Mono', 'Courier New', monospace;
      font-size: 11px;
      color: #e8e8f0;
      min-width: 200px;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 32px rgba(0,0,0,0.5);
      user-select: none;
      cursor: move;
    `;

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="color:#00e5ff;font-weight:700;letter-spacing:0.08em;font-size:10px">⬡ LATENCY METER</span>
        <div style="display:flex;gap:6px">
          <button id="__lm_export__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;letter-spacing:0.05em">CSV</button>
          <button id="__lm_clear__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:inherit;font-size:9px;padding:2px 7px;border-radius:4px;cursor:pointer;letter-spacing:0.05em">CLR</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:2px">AVG</div>
          <div id="__lm_avg__" style="font-size:18px;font-weight:700;color:#00e5ff;line-height:1">—</div>
          <div style="color:#555570;font-size:9px">ms</div>
        </div>
        <div>
          <div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:2px">PEAK</div>
          <div id="__lm_peak__" style="font-size:18px;font-weight:700;color:#00e5ff;line-height:1">—</div>
          <div style="color:#555570;font-size:9px">ms</div>
        </div>
        <div>
          <div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:2px">COUNT</div>
          <div id="__lm_count__" style="font-size:18px;font-weight:700;color:#e8e8f0;line-height:1">0</div>
          <div style="color:#555570;font-size:9px">samples</div>
        </div>
      </div>

      <div style="margin-bottom:8px">
        <div style="color:#555570;font-size:9px;letter-spacing:0.1em;margin-bottom:4px">LAST 8 STROKES</div>
        <div id="__lm_bars__" style="display:flex;align-items:flex-end;gap:3px;height:28px"></div>
      </div>

      <div style="display:flex;align-items:center;gap:6px">
        <div id="__lm_dot__" style="width:6px;height:6px;border-radius:50%;background:#555570;transition:background 0.1s"></div>
        <div id="__lm_last__" style="color:#888;font-size:10px">waiting for input…</div>
      </div>
    `;

    document.body.appendChild(el);

    // button events
    el.querySelector('#__lm_export__').addEventListener('click', (e) => {
      e.stopPropagation();
      LatencyMeter.exportCSV();
    });
    el.querySelector('#__lm_clear__').addEventListener('click', (e) => {
      e.stopPropagation();
      LatencyMeter.clear();
    });

    // drag to reposition
    makeDraggable(el);

    return el;
  }

  function updateHUD() {
    if (!hud) return;
    const vals = state.measurements.map(m => m.ms);
    if (!vals.length) return;

    const last = vals[vals.length - 1];
    const avgVal = avg(vals);
    const peakVal = Math.max(...vals);

    const setEl = (id, text, color) => {
      const el = hud.querySelector(id);
      if (el) { el.textContent = text; if (color) el.style.color = color; }
    };

    setEl('#__lm_avg__',   avgVal,  colorFor(avgVal));
    setEl('#__lm_peak__',  peakVal, colorFor(peakVal));
    setEl('#__lm_count__', vals.length);
    setEl('#__lm_last__',  `last: ${last}ms`, colorFor(last));

    // dot flash
    const dot = hud.querySelector('#__lm_dot__');
    if (dot) {
      dot.style.background = colorFor(last);
      dot.style.boxShadow = `0 0 6px ${colorFor(last)}`;
      setTimeout(() => {
        dot.style.background = '#555570';
        dot.style.boxShadow = 'none';
      }, 300);
    }

    // mini bar chart — last 8
    const bars = hud.querySelector('#__lm_bars__');
    if (bars) {
      const recent = vals.slice(-8);
      const maxVal = Math.max(...recent, 1);
      bars.innerHTML = recent.map(v => {
        const h = clamp(Math.round((v / maxVal) * 28), 3, 28);
        return `<div style="flex:1;height:${h}px;background:${colorFor(v)};border-radius:2px 2px 0 0;opacity:0.85"></div>`;
      }).join('');
    }
  }

  function makeDraggable(el) {
    let ox, oy, startX, startY;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      ox = el.offsetLeft || (window.innerWidth - el.offsetWidth - 20);
      oy = el.offsetTop  || (window.innerHeight - el.offsetHeight - 20);
      startX = e.clientX; startY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
      el.style.left   = clamp(ox + dx, 0, window.innerWidth  - el.offsetWidth)  + 'px';
      el.style.top    = clamp(oy + dy, 0, window.innerHeight - el.offsetHeight) + 'px';
    });
  }

  // ── Public API ───────────────────────────────────────────────
  const LatencyMeter = {

    /**
     * init(options?)
     * Start measuring. Call once after page load.
     */
    init(options = {}) {
      if (state.active) return this;

      state.options = Object.assign({
        target: window,
        overlay: true,
        logToConsole: false,
        stylusOnly: false,
        onMeasure: null,
      }, options);

      const target = state.options.target;
      target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
      state.active = true;

      if (state.options.overlay) {
        hud = createHUD();
      }

      console.log('[LatencyMeter] initialized. Draw to measure input latency.');
      return this;
    },

    /**
     * destroy()
     * Remove listeners and HUD.
     */
    destroy() {
      const target = state.options.target || window;
      target.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (hud) { hud.remove(); hud = null; }
      state.active = false;
      return this;
    },

    /**
     * getMeasurements()
     * Returns array of { ms, pointerType, timestamp }
     */
    getMeasurements() {
      return [...state.measurements];
    },

    /**
     * getStats()
     * Returns { avg, min, max, count, samples[] }
     */
    getStats() {
      const vals = state.measurements.map(m => m.ms);
      return {
        avg:     avg(vals),
        min:     vals.length ? Math.min(...vals) : null,
        max:     vals.length ? Math.max(...vals) : null,
        count:   vals.length,
        samples: [...vals],
      };
    },

    /**
     * exportCSV()
     * Downloads measurements as a .csv file.
     */
    exportCSV() {
      if (!state.measurements.length) {
        console.warn('[LatencyMeter] No data to export yet.');
        return;
      }
      const header = 'sample,latency_ms,pointer_type,timestamp';
      const rows = state.measurements.map((m, i) =>
        `${i + 1},${m.ms},${m.pointerType},${m.timestamp}`
      );
      const csv = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `latency_meter_${Date.now()}.csv`;
      a.click();
      console.log(`[LatencyMeter] Exported ${state.measurements.length} samples.`);
    },

    /**
     * clear()
     * Reset all measurements.
     */
    clear() {
      state.measurements = [];
      if (hud) {
        ['#__lm_avg__','#__lm_peak__'].forEach(id => {
          const el = hud.querySelector(id);
          if (el) { el.textContent = '—'; el.style.color = '#00e5ff'; }
        });
        const count = hud.querySelector('#__lm_count__');
        if (count) count.textContent = '0';
        const bars = hud.querySelector('#__lm_bars__');
        if (bars) bars.innerHTML = '';
        const last = hud.querySelector('#__lm_last__');
        if (last) { last.textContent = 'waiting for input…'; last.style.color = '#888'; }
      }
      console.log('[LatencyMeter] Cleared.');
      return this;
    },
  };

  // expose globally
  global.LatencyMeter = LatencyMeter;

})(window);
