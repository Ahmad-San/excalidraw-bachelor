/**
 * web-profiler.js
 * ─────────────────────────────────────────────────────────────
 * Lightweight web profiler for constrained browsers (Tizen 5.2+)
 * No dependencies. Single file drop-in.
 *
 * Measures:
 *  1. Input latency  — pointerdown → first requestAnimationFrame
 *  2. FPS            — frames per second
 *  3. Canvas timing  — how long each canvas API call takes
 *  4. Memory         — JS heap size
 *  5. Call tree      — pointerdown → rAF → canvas calls
 *
 * EXPORTS:
 *  - exportCSV()        — CSV with all data sections
 *  - exportFirefox()    — Firefox Profiler JSON (drag into profiler.firefox.com)
 *
 * USAGE:
 *   <script src="web-profiler.js"></script>
 *   <script> WebProfiler.init({ logToConsole: true }); </script>
 * ─────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  var state = {
    active: false,
    options: {},
    startTime: performance.now(),  // profile start — needed for Firefox format

    // 1. latency
    latencySamples: [],
    pointerDownTime: 0,
    rafPending: false,

    // 2. fps
    fps: 0,
    fpsFrames: 0,
    fpsLastTime: performance.now(),
    rafLoop: null,

    // 3. canvas timing
    canvasTimings: {},

    // 4. memory
    memorySamples: [],
    memoryInterval: null,

    // 5. call tree
    callTrees: [],
    currentTree: null,
    isDrawing: false,
    strokeCanvasCalls: [],
  };

  // ── Utilities ───────────────────────────────────────────────
  function avg(arr) {
    return arr.length ? Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length) : null;
  }
  function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }
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

  // ── 3. Canvas API Wrapping ──────────────────────────────────
  var CANVAS_METHODS = [
    'stroke', 'fill', 'beginPath', 'moveTo', 'lineTo',
    'bezierCurveTo', 'quadraticCurveTo', 'arc',
    'drawImage', 'putImageData', 'clearRect', 'fillRect',
  ];

  function wrapCanvasAPI() {
    var proto = CanvasRenderingContext2D.prototype;
    CANVAS_METHODS.forEach(function (method) {
      if (!proto[method]) return;
      var original = proto[method];
      state.canvasTimings[method] = [];
      proto[method] = function () {
        var t = performance.now();
        var result = original.apply(this, arguments);
        var elapsed = parseFloat((performance.now() - t).toFixed(3));
        state.canvasTimings[method].push(elapsed);
        if (state.canvasTimings[method].length > 200) state.canvasTimings[method].shift();
        if (state.isDrawing && state.currentTree) {
          state.strokeCanvasCalls.push({ name: method, durationMs: elapsed });
        }
        return result;
      };
    });
  }

  function getCanvasStats() {
    var result = {};
    CANVAS_METHODS.forEach(function (method) {
      var s = state.canvasTimings[method];
      if (!s || !s.length) return;
      result[method] = {
        calls: s.length,
        avgMs: parseFloat((s.reduce(function (a, b) { return a + b; }, 0) / s.length).toFixed(3)),
        maxMs: parseFloat(Math.max.apply(null, s).toFixed(3)),
        totalMs: parseFloat(s.reduce(function (a, b) { return a + b; }, 0).toFixed(3)),
      };
    });
    return result;
  }

  // ── 1. Input Latency ────────────────────────────────────────
  function onPointerDown(e) {
    if (state.options.stylusOnly && e.pointerType === 'mouse') return;
    state.pointerDownTime = performance.now();
    state.isDrawing = true;
    state.strokeCanvasCalls = [];
    state.currentTree = {
      name: 'stroke_' + (state.callTrees.length + 1),
      pointerType: e.pointerType,
      startMs: state.pointerDownTime,
      endMs: null,
      durationMs: null,
      latencyMs: null,
      children: [{
        name: 'pointerdown',
        durationMs: parseFloat((performance.now() - state.pointerDownTime).toFixed(3)),
        children: [],
      }],
    };
    if (!state.rafPending) {
      state.rafPending = true;
      requestAnimationFrame(function () {
        var latency = Math.round(performance.now() - state.pointerDownTime);
        state.rafPending = false;
        if (state.currentTree) {
          state.currentTree.children.push({
            name: 'first-rAF (latency)',
            durationMs: latency,
            children: [],
          });
          state.currentTree.latencyMs = latency;
        }
        state.latencySamples.push({
          ms: latency,
          pointerType: e.pointerType,
          timestamp: new Date().toISOString(),
          timeFromStart: parseFloat((state.pointerDownTime - state.startTime).toFixed(3)),
        });
        if (state.options.logToConsole) console.log('[WebProfiler] latency: ' + latency + 'ms');
        if (typeof state.options.onLatency === 'function') state.options.onLatency(latency);
        updateHUD();
      });
    }
  }

  function onPointerUp() {
    if (!state.isDrawing || !state.currentTree) return;
    state.isDrawing = false;
    var now = performance.now();
    state.currentTree.endMs = now;
    state.currentTree.durationMs = parseFloat((now - state.currentTree.startMs).toFixed(3));
    if (state.strokeCanvasCalls.length) {
      var grouped = {};
      state.strokeCanvasCalls.forEach(function (c) {
        if (!grouped[c.name]) grouped[c.name] = { name: c.name, calls: 0, totalMs: 0 };
        grouped[c.name].calls++;
        grouped[c.name].totalMs += c.durationMs;
      });
      state.currentTree.children.push({
        name: 'pointermove → canvas (' + state.strokeCanvasCalls.length + ' calls)',
        durationMs: parseFloat(state.strokeCanvasCalls.reduce(function (a, b) { return a + b.durationMs; }, 0).toFixed(3)),
        children: Object.keys(grouped).map(function (k) {
          var g = grouped[k];
          return { name: k + ' ×' + g.calls, durationMs: parseFloat(g.totalMs.toFixed(3)), children: [] };
        }),
      });
    }
    state.callTrees.push(state.currentTree);
    if (state.callTrees.length > 50) state.callTrees.shift();
    state.currentTree = null;
    state.strokeCanvasCalls = [];
    updateHUD();
  }

  // ── 2. FPS ──────────────────────────────────────────────────
  function fpsTick() {
    state.fpsFrames++;
    var now = performance.now();
    var elapsed = now - state.fpsLastTime;
    if (elapsed >= 1000) {
      state.fps = Math.round((state.fpsFrames * 1000) / elapsed);
      state.fpsFrames = 0;
      state.fpsLastTime = now;
      updateHUD();
    }
    state.rafLoop = requestAnimationFrame(fpsTick);
  }

  // ── 4. Memory ───────────────────────────────────────────────
  function startMemorySampling() {
    if (!performance.memory) return;
    state.memoryInterval = setInterval(function () {
      state.memorySamples.push({
        usedMB: parseFloat(mb(performance.memory.usedJSHeapSize)),
        totalMB: parseFloat(mb(performance.memory.totalJSHeapSize)),
        timestamp: new Date().toISOString(),
      });
    }, 2000);
  }

  // ── Firefox Profiler Export ──────────────────────────────────
  // Converts call trees into the Gecko profile format accepted by
  // profiler.firefox.com. Drag-and-drop the downloaded .json file there.
  //
  // Format references:
  //   https://github.com/firefox-devtools/profiler/blob/main/docs-developer/gecko-profile-format.md
  //   https://mostlynerdless.de/blog/2023/02/02/using-firefox-profiler-beyond-the-web/
  function buildFirefoxProfile() {
    // String table — all function names are stored here, referenced by index
    var stringTable = [];
    var stringMap = {};

    function internString(s) {
      if (stringMap[s] === undefined) {
        stringMap[s] = stringTable.length;
        stringTable.push(s);
      }
      return stringMap[s];
    }

    // We build parallel arrays for the Firefox Profiler format:
    // funcTable, frameTable, stackTable, samples

    var funcTable = {
      name: [],          // index into stringTable
      isJS: [],
      relevantForJS: [],
      resource: [],      // -1 = unknown
      address: [],       // -1 for JS functions (required by upgraders)
      fileName: [],
      lineNumber: [],
      columnNumber: [],
      length: 0,
    };

    var frameTable = {
      address: [],
      inlineDepth: [],
      category: [],
      subcategory: [],
      func: [],           // index into funcTable
      nativeSymbol: [],   // -1 = no native symbol (required by upgraders)
      innerWindowID: [],  // 0 for all JS frames (required by upgraders)
      implementation: [], // null = interpreter (required by upgraders)
      line: [],
      column: [],
      length: 0,
    };

    var stackTable = {
      frame: [],  // index into frameTable
      category: [],
      subcategory: [],
      prefix: [],  // index into stackTable or null
      length: 0,
    };

    var samples = {
      stack: [],           // index into stackTable
      time: [],            // ms since profile start
      responsiveness: [],  // null per sample (required by upgraders)
      weight: [],
      weightType: 'tracing-ms',
      length: 0,
    };

    var markers = {
      name: [],
      time: [],
      endTime: [],
      phase: [],  // 0=instant, 1=interval start, 2=interval end
      category: [],
      data: [],
      length: 0,
    };

    // Cache: funcName → funcIndex
    var funcCache = {};

    function getOrCreateFunc(name) {
      if (funcCache[name] !== undefined) return funcCache[name];
      var idx = funcTable.length;
      funcTable.name.push(internString(name));
      funcTable.isJS.push(false);
      funcTable.relevantForJS.push(false);
      funcTable.resource.push(-1);
      funcTable.address.push(-1);
      funcTable.fileName.push(null);
      funcTable.lineNumber.push(null);
      funcTable.columnNumber.push(null);
      funcTable.length++;
      funcCache[name] = idx;
      return idx;
    }

    function getOrCreateFrame(funcIdx) {
      var idx = frameTable.length;
      frameTable.address.push(-1);
      frameTable.inlineDepth.push(0);
      frameTable.category.push(0);
      frameTable.subcategory.push(0);
      frameTable.func.push(funcIdx);
      frameTable.nativeSymbol.push(-1);
      frameTable.innerWindowID.push(0);
      frameTable.implementation.push(null);
      frameTable.line.push(null);
      frameTable.column.push(null);
      frameTable.length++;
      return idx;
    }

    function addStack(frameIdx, prefixStackIdx) {
      var idx = stackTable.length;
      stackTable.frame.push(frameIdx);
      stackTable.category.push(0);
      stackTable.subcategory.push(0);
      stackTable.prefix.push(prefixStackIdx !== undefined ? prefixStackIdx : null);
      stackTable.length++;
      return idx;
    }

    // Convert a call tree node recursively into stack samples
    // Each node becomes a "sample" at its timestamp with its full call path
    function processNode(node, parentStackIdx, timeOffset) {
      var funcIdx = getOrCreateFunc(node.name);
      var frameIdx = getOrCreateFrame(funcIdx);
      var stackIdx = addStack(frameIdx, parentStackIdx);

      var nodeStart = timeOffset;
      var nodeEnd = timeOffset + (node.durationMs || 0);

      // Add a sample at the start of this node
      samples.stack.push(stackIdx);
      samples.time.push(parseFloat(nodeStart.toFixed(3)));
      samples.responsiveness.push(null);
      samples.weight.push(node.durationMs || 0);
      samples.length++;

      // Add a marker for this node (shows as interval in timeline)
      markers.name.push(internString(node.name));
      markers.time.push(parseFloat(nodeStart.toFixed(3)));
      markers.endTime.push(parseFloat(nodeEnd.toFixed(3)));
      markers.phase.push(1); // interval
      markers.category.push(0);
      markers.data.push({ type: 'Text', name: node.name });
      markers.length++;

      // Process children
      var childOffset = nodeStart;
      (node.children || []).forEach(function (child) {
        processNode(child, stackIdx, childOffset);
        childOffset += (child.durationMs || 0);
      });
    }

    // Process all call trees
    state.callTrees.forEach(function (tree) {
      var treeOffset = tree.startMs - state.startTime;
      processNode(tree, null, treeOffset);
    });

    // Add latency markers (input events on timeline)
    state.latencySamples.forEach(function (s) {
      markers.name.push(internString('Input Latency: ' + s.ms + 'ms'));
      markers.time.push(parseFloat(s.timeFromStart.toFixed(3)));
      markers.endTime.push(parseFloat((s.timeFromStart + s.ms).toFixed(3)));
      markers.phase.push(1);
      markers.category.push(0);
      markers.data.push({ type: 'Text', name: s.pointerType + ' → ' + s.ms + 'ms' });
      markers.length++;
    });

    var profileDuration = performance.now() - state.startTime;

    return {
      meta: {
        interval: 1,
        startTime: state.startTime,
        processType: 0,
        product: 'WebProfiler (Excalidraw / Tizen)',
        stackwalk: 0,
        version: 24,
        symbolicated: false,
        markerSchema: [],
        categories: [
          { name: 'Drawing', color: 'blue', subcategories: ['Other'] },
          { name: 'Input', color: 'green', subcategories: ['Other'] },
          { name: 'Canvas', color: 'orange', subcategories: ['Other'] },
        ],
      },
      libs: [],
      threads: [
        {
          processType: 'default',
          processStartupTime: 0,
          processShutdownTime: parseFloat(profileDuration.toFixed(3)),
          registerTime: 0,
          unregisterTime: null,
          pausedRanges: [],
          name: 'Main Thread (Excalidraw)',
          isMainThread: true,
          pid: '1',
          tid: '1',
          samples: samples,
          markers: markers,
          stackTable: stackTable,
          frameTable: frameTable,
          libs: [],
          funcTable: funcTable,
          resourceTable: {
            lib: [],
            name: [],
            host: [],
            type: [],
            length: 0,
          },
          nativeSymbols: {
            libIndex: [],
            address: [],
            name: [],
            functionSize: [],
            length: 0,
          },
          stringArray: stringTable,
        },
      ],
    };
  }

  // ── HUD ─────────────────────────────────────────────────────
  var hud = null;

  function createHUD() {
    var el = document.createElement('div');
    el.id = '__web_profiler_hud__';
    el.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px',
      'z-index:2147483647',
      'background:rgba(8,8,14,0.93)',
      'border:1px solid #2a2a3a', 'border-radius:10px',
      'padding:14px 18px', 'font-family:monospace', 'font-size:11px',
      'color:#e8e8f0', 'min-width:240px',
      'box-shadow:0 4px 32px rgba(0,0,0,0.6)',
      'user-select:none', 'cursor:move',
    ].join(';');

    el.innerHTML = [
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">',
      '<span style="color:#00e5ff;font-weight:700;font-size:10px;letter-spacing:0.08em">⬡ WEB PROFILER</span>',
      '<div style="display:flex;gap:5px">',
      '<button id="__wp_tree__"    style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">TREE</button>',
      '<button id="__wp_export__"  style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CSV</button>',
      '<button id="__wp_firefox__" style="background:transparent;border:1px solid #ff9500;color:#ff9500;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">FFX</button>',
      '<button id="__wp_clear__"   style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CLR</button>',
      '</div>',
      '</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">',
      '<div><div style="color:#555570;font-size:9px;margin-bottom:2px">FPS</div>',
      '<div id="__wp_fps__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div></div>',
      '<div><div style="color:#555570;font-size:9px;margin-bottom:2px">AVG LAT</div>',
      '<div id="__wp_lat__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
      '<div style="color:#555570;font-size:9px">ms</div></div>',
      '<div><div style="color:#555570;font-size:9px;margin-bottom:2px">MEM</div>',
      '<div id="__wp_mem__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
      '<div style="color:#555570;font-size:9px">MB</div></div>',
      '</div>',
      '<div style="color:#555570;font-size:9px;margin-bottom:4px">CANVAS CALLS (avg ms)</div>',
      '<div id="__wp_canvas__" style="display:flex;flex-direction:column;gap:3px;margin-bottom:10px"></div>',
      '<div style="color:#555570;font-size:9px;margin-bottom:4px">LAST 8 STROKES</div>',
      '<div id="__wp_bars__" style="display:flex;align-items:flex-end;gap:3px;height:24px;margin-bottom:8px"></div>',
      '<div id="__wp_tree_panel__" style="display:none;margin-top:8px;border-top:1px solid #2a2a3a;padding-top:8px">',
      '<div style="color:#555570;font-size:9px;margin-bottom:4px">LAST STROKE PIPELINE</div>',
      '<div id="__wp_tree_content__" style="font-size:9px;line-height:1.9;color:#888;max-height:180px;overflow-y:auto;white-space:nowrap"></div>',
      '</div>',
      '<div style="display:flex;align-items:center;gap:6px;margin-top:6px">',
      '<div id="__wp_dot__" style="width:6px;height:6px;border-radius:50%;background:#555570"></div>',
      '<div id="__wp_status__" style="color:#555570;font-size:10px">waiting…</div>',
      '</div>',
    ].join('');

    document.body.appendChild(el);

    el.querySelector('#__wp_export__').addEventListener('click', function (e) { e.stopPropagation(); WebProfiler.exportCSV(); });
    el.querySelector('#__wp_firefox__').addEventListener('click', function (e) { e.stopPropagation(); WebProfiler.exportFirefox(); });
    el.querySelector('#__wp_clear__').addEventListener('click', function (e) { e.stopPropagation(); WebProfiler.clear(); });
    el.querySelector('#__wp_tree__').addEventListener('click', function (e) {
      e.stopPropagation();
      var panel = hud.querySelector('#__wp_tree_panel__');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      renderLastTree();
    });

    makeDraggable(el);
    return el;
  }

  function renderLastTree() {
    if (!hud) return;
    var content = hud.querySelector('#__wp_tree_content__');
    if (!content) return;
    if (!state.callTrees.length) {
      content.innerHTML = '<span style="color:#555570">draw a stroke first</span>';
      return;
    }
    var tree = state.callTrees[state.callTrees.length - 1];
    function renderNode(node, depth) {
      var indent = '';
      for (var i = 0; i < depth; i++) indent += '&nbsp;&nbsp;&nbsp;';
      var prefix = depth > 0 ? '└─ ' : '';
      var ms = node.durationMs !== null && node.durationMs !== undefined ? node.durationMs : '?';
      var color = (typeof ms === 'number' && ms > 16) ? '#ffb300' : '#00e5ff';
      return '<div>' + indent + prefix +
        '<span style="color:' + color + '">' + node.name + '</span>' +
        '&nbsp;<span style="color:#555570">' + ms + 'ms</span>' +
        '</div>' +
        (node.children || []).map(function (c) { return renderNode(c, depth + 1); }).join('');
    }
    content.innerHTML = renderNode(tree, 0);
  }

  function updateHUD() {
    if (!hud) return;
    var fpsEl = hud.querySelector('#__wp_fps__');
    if (fpsEl) { fpsEl.textContent = state.fps; fpsEl.style.color = fpsColor(state.fps); }
    var latEl = hud.querySelector('#__wp_lat__');
    if (latEl && state.latencySamples.length) {
      var a = avg(state.latencySamples.map(function (s) { return s.ms; }));
      latEl.textContent = a; latEl.style.color = colorFor(a);
    }
    var memEl = hud.querySelector('#__wp_mem__');
    if (memEl && performance.memory) memEl.textContent = mb(performance.memory.usedJSHeapSize);
    var canvasEl = hud.querySelector('#__wp_canvas__');
    if (canvasEl) {
      var stats = getCanvasStats();
      canvasEl.innerHTML = Object.keys(stats)
        .sort(function (a, b) { return stats[b].calls - stats[a].calls; })
        .slice(0, 5)
        .map(function (m) {
          var s = stats[m], c = s.avgMs > 1 ? '#ffb300' : '#555570';
          return '<div style="display:flex;justify-content:space-between;font-size:9px">' +
            '<span style="color:#888">' + m + '</span>' +
            '<span style="color:' + c + '">' + s.avgMs + 'ms × ' + s.calls + '</span></div>';
        }).join('');
    }
    var barsEl = hud.querySelector('#__wp_bars__');
    if (barsEl && state.latencySamples.length) {
      var recent = state.latencySamples.slice(-8).map(function (s) { return s.ms; });
      var maxV = Math.max.apply(null, recent) || 1;
      barsEl.innerHTML = recent.map(function (v) {
        var h = clamp(Math.round((v / maxV) * 24), 2, 24);
        return '<div style="flex:1;height:' + h + 'px;background:' + colorFor(v) + ';border-radius:2px 2px 0 0"></div>';
      }).join('');
    }
    var dot = hud.querySelector('#__wp_dot__'), status = hud.querySelector('#__wp_status__');
    if (dot && state.latencySamples.length) {
      var last = state.latencySamples[state.latencySamples.length - 1];
      dot.style.background = colorFor(last.ms);
      dot.style.boxShadow = '0 0 6px ' + colorFor(last.ms);
      if (status) status.textContent = 'last: ' + last.ms + 'ms (' + last.pointerType + ')';
      setTimeout(function () { dot.style.background = '#555570'; dot.style.boxShadow = 'none'; }, 400);
    }
    var panel = hud.querySelector('#__wp_tree_panel__');
    if (panel && panel.style.display !== 'none') renderLastTree();
  }

  function makeDraggable(el) {
    var ox, oy, sx, sy;
    el.addEventListener('pointerdown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      ox = el.offsetLeft || (window.innerWidth - el.offsetWidth - 20);
      oy = el.offsetTop || (window.innerHeight - el.offsetHeight - 20);
      sx = e.clientX; sy = e.clientY; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function (e) {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = clamp(ox + e.clientX - sx, 0, window.innerWidth - el.offsetWidth) + 'px';
      el.style.top = clamp(oy + e.clientY - sy, 0, window.innerHeight - el.offsetHeight) + 'px';
    });
  }

  // ── Public API ───────────────────────────────────────────────
  var WebProfiler = {

    init: function (options) {
      if (state.active) return this;
      state.options = Object.assign({
        target: window, overlay: true, logToConsole: false,
        stylusOnly: false, wrapCanvas: true, trackMemory: true, onLatency: null,
      }, options || {});
      state.startTime = performance.now();
      var target = state.options.target;
      target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
      target.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
      target.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });
      if (state.options.wrapCanvas) wrapCanvasAPI();
      if (state.options.trackMemory) startMemorySampling();
      state.fpsLastTime = performance.now();
      fpsTick();
      if (state.options.overlay) hud = createHUD();
      state.active = true;
      if (state.options.logToConsole) console.log('[WebProfiler] initialized.');
      return this;
    },

    destroy: function () {
      var target = state.options.target || window;
      target.removeEventListener('pointerdown', onPointerDown, { capture: true });
      target.removeEventListener('pointerup', onPointerUp, { capture: true });
      target.removeEventListener('pointercancel', onPointerUp, { capture: true });
      if (state.rafLoop) cancelAnimationFrame(state.rafLoop);
      if (state.memoryInterval) clearInterval(state.memoryInterval);
      if (hud) { hud.remove(); hud = null; }
      state.active = false;
      return this;
    },

    getLatencyStats: function () {
      var vals = state.latencySamples.map(function (s) { return s.ms; });
      return {
        avg: avg(vals), min: vals.length ? Math.min.apply(null, vals) : null,
        max: vals.length ? Math.max.apply(null, vals) : null, count: vals.length,
        samples: state.latencySamples.slice()
      };
    },
    getCanvasStats: getCanvasStats,
    getCallTrees: function () { return state.callTrees.slice(); },
    getFPS: function () { return state.fps; },
    getMemoryStats: function () {
      if (!state.memorySamples.length) return null;
      var used = state.memorySamples.map(function (s) { return s.usedMB; });
      return {
        avgMB: parseFloat((used.reduce(function (a, b) { return a + b; }, 0) / used.length).toFixed(1)),
        maxMB: Math.max.apply(null, used), samples: state.memorySamples.slice()
      };
    },

    // ── Export: CSV ────────────────────────────────────────────
    exportCSV: function () {
      var sections = [];
      if (state.latencySamples.length) {
        sections.push('=== INPUT LATENCY ===');
        sections.push('sample,latency_ms,pointer_type,timestamp');
        state.latencySamples.forEach(function (s, i) {
          sections.push((i + 1) + ',' + s.ms + ',' + s.pointerType + ',' + s.timestamp);
        });
        sections.push('');
      }
      var cs = getCanvasStats(); var methods = Object.keys(cs);
      if (methods.length) {
        sections.push('=== CANVAS API TIMING ===');
        sections.push('method,calls,avg_ms,max_ms,total_ms');
        methods.forEach(function (m) { var s = cs[m]; sections.push(m + ',' + s.calls + ',' + s.avgMs + ',' + s.maxMs + ',' + s.totalMs); });
        sections.push('');
      }
      if (state.callTrees.length) {
        sections.push('=== CALL TREES ===');
        sections.push('stroke,depth,node,duration_ms,pointer_type');
        state.callTrees.forEach(function (tree, ti) {
          function exportNode(node, depth) {
            sections.push((ti + 1) + ',' + depth + ',' + node.name + ',' + (node.durationMs || 0) + ',' + (tree.pointerType || 'unknown'));
            (node.children || []).forEach(function (c) { exportNode(c, depth + 1); });
          }
          exportNode(tree, 0);
        });
        sections.push('');
      }
      if (state.memorySamples.length) {
        sections.push('=== MEMORY ===');
        sections.push('sample,used_mb,total_mb,timestamp');
        state.memorySamples.forEach(function (s, i) { sections.push((i + 1) + ',' + s.usedMB + ',' + s.totalMB + ',' + s.timestamp); });
      }
      if (!sections.length) { console.warn('[WebProfiler] No data.'); return; }
      var blob = new Blob([sections.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'web_profiler_' + Date.now() + '.csv';
      a.click();
    },

    // ── Export: Firefox Profiler JSON ──────────────────────────
    // Downloads a .json file you can drag into profiler.firefox.com
    exportFirefox: function () {
      if (!state.callTrees.length && !state.latencySamples.length) {
        console.warn('[WebProfiler] No data to export.');
        return;
      }
      var profile = buildFirefoxProfile();
      var json = JSON.stringify(profile);
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'web_profiler_firefox_' + Date.now() + '.json';
      a.click();
      if (state.options.logToConsole) console.log('[WebProfiler] Firefox profile exported. Drag into profiler.firefox.com');
    },

    clear: function () {
      state.latencySamples = []; state.memorySamples = []; state.callTrees = [];
      state.currentTree = null; state.strokeCanvasCalls = []; state.isDrawing = false;
      Object.keys(state.canvasTimings).forEach(function (k) { state.canvasTimings[k] = []; });
      state.startTime = performance.now();
      if (hud) {
        ['#__wp_fps__', '#__wp_lat__', '#__wp_mem__'].forEach(function (id) {
          var el = hud.querySelector(id); if (el) { el.textContent = '—'; el.style.color = '#00e5ff'; }
        });
        ['#__wp_bars__', '#__wp_canvas__', '#__wp_tree_content__'].forEach(function (id) {
          var el = hud.querySelector(id); if (el) el.innerHTML = '';
        });
        var s = hud.querySelector('#__wp_status__'); if (s) s.textContent = 'waiting…';
      }
      return this;
    },
  };

  global.WebProfiler = WebProfiler;

})(window);