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
    startTime: performance.now(),

    latencySamples: [],
    pointerDownTime: 0,

    fps: 0,
    fpsFrames: 0,
    fpsLastTime: performance.now(),
    rafLoop: null,

    canvasTimings: {},

    memorySamples: [],
    memoryInterval: null,

    callTrees: [],
    interactionCount: 0,
    currentTree: null,
    isDrawing: false,
    interactionCanvasCalls: [],
    eventObserver: null,
  };

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
        if (state.isDrawing) {
          state.interactionCanvasCalls.push({ name: method, durationMs: elapsed });
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

  function onPointerDown(e) {
    if (state.options.stylusOnly && e.pointerType === 'mouse') return;
    // #9 — ignore touches/clicks within the HUD itself
    if (hud && hud.contains(e.target)) return;
    state.pointerDownTime = performance.now();
    state.interactionCount++;

    if (nativeProfiler && !nativeProfiler.stopped) {
      // ── NATIVE MODE ──────────────────────────────────────────
      state.isDrawing = false;
      var nativeCount = state.interactionCount;
      var nativeDownTime = state.pointerDownTime;

      // Bug 1 fix: measure rAF latency BEFORE stopping native profiler
      // stopNativeProfiler() is async and takes time — measuring after it
      // would give inflated values (e.g. 600ms instead of real 34ms)
      var rafLatency = null;
      requestAnimationFrame(function() {
        rafLatency = Math.round(performance.now() - nativeDownTime);
        if (state.options.logToConsole) console.log('[WebProfiler] latency (native): ' + rafLatency + 'ms');
        if (typeof state.options.onLatency === 'function') state.options.onLatency(rafLatency);
        // Push latency sample immediately so HUD updates
        state.latencySamples.push({
          ms: rafLatency,
          pointerType: e.pointerType,
          timestamp: new Date().toISOString(),
          timeFromStart: parseFloat((nativeDownTime - state.startTime).toFixed(3)),
        });
        updateHUD();
      });

      if (typeof PerformanceObserver !== 'undefined') {
        try {
          if (state.eventObserver) {
            state.eventObserver.disconnect();
            state.eventObserver = null;
          }
          var obs = new PerformanceObserver(function(list) {
            list.getEntries().forEach(function(entry) {
              if (entry.name !== 'pointerdown') return;
              // Bug 2 fix: disconnect only after processing, then restart
              // profiler immediately so next pointerdown is covered
              obs.disconnect();
              state.eventObserver = null;

              var delay    = parseFloat((entry.processingStart - entry.startTime).toFixed(3));
              var procTime = parseFloat((entry.processingEnd - entry.processingStart).toFixed(3));

              stopNativeProfiler().then(function(trace) {
                // Restart profiler immediately so next interaction is covered
                startNativeProfiler();

                if (trace && trace.samples.length) {
                  var filteredTrace = {
                    frames: trace.frames,
                    resources: trace.resources,
                    stacks: trace.stacks,
                    samples: trace.samples.filter(function(s) {
                      return s.timestamp >= entry.startTime &&
                             s.timestamp <= entry.processingEnd;
                    }),
                  };

                  var trees = nativeTraceToCallTrees(filteredTrace, {});
                  // Use already-measured rAF latency (not re-measured after async stop)
                  var latency = rafLatency !== null ? rafLatency :
                    Math.round(performance.now() - nativeDownTime);

                  trees.forEach(function(t) {
                    t.name = 'interaction_native_' + nativeCount;
                    t.latencyMs = latency;
                    t.children.unshift(
                      { name: 'event delay: ' + delay + 'ms', durationMs: delay, children: [] },
                      { name: 'event processing: ' + procTime + 'ms', durationMs: procTime, children: [] },
                      { name: 'first-rAF (latency)', durationMs: latency, children: [] }
                    );
                  });

                  state.callTrees = state.callTrees.concat(trees);
                  updateHUD();

                  if (state.options.logToConsole) {
                    console.log('[WebProfiler] Native interaction_' + nativeCount +
                      ': delay=' + delay + 'ms proc=' + procTime + 'ms samples=' +
                      filteredTrace.samples.length);
                  }
                }
              });
            });
          });
          obs.observe({ type: 'event', durationThreshold: 0, buffered: false });
          state.eventObserver = obs;
        } catch(err) {
          stopNativeProfiler().then(function(trace) {
            startNativeProfiler();
            if (trace && trace.samples.length) {
              var trees = nativeTraceToCallTrees(trace, {});
              trees.forEach(function(t) { t.name = 'interaction_native_' + nativeCount; });
              state.callTrees = state.callTrees.concat(trees);
              updateHUD();
            }
          });
        }
      } else {
        stopNativeProfiler().then(function(trace) {
          startNativeProfiler();
          if (trace && trace.samples.length) {
            var trees = nativeTraceToCallTrees(trace, {});
            trees.forEach(function(t) { t.name = 'interaction_native_' + nativeCount; });
            state.callTrees = state.callTrees.concat(trees);
            updateHUD();
          }
        });
      }

    } else {
      // ── MANUAL MODE ──────────────────────────────────────────
      // Build manual canvas tree + rAF latency + PerformanceObserver
      state.isDrawing = true;
      state.interactionCanvasCalls = [];
      state.currentTree = {
        name: 'interaction_' + state.interactionCount,
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

      // PerformanceObserver for event timing — durationThreshold:0 to
      // capture all events not just slow ones (default threshold is 104ms)
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          if (state.eventObserver) {
            state.eventObserver.disconnect();
            state.eventObserver = null;
          }
          var treeRefObs = state.currentTree;
          var obs = new PerformanceObserver(function(list) {
            list.getEntries().forEach(function(entry) {
              if ((entry.name === 'pointerdown' || entry.name === 'pointermove')
                  && treeRefObs) {
                var procTime = parseFloat(
                  (entry.processingEnd - entry.processingStart).toFixed(3)
                );
                treeRefObs.children.push({
                  name: 'event: ' + entry.name +
                    ' (processing: ' + procTime + 'ms' +
                    ', delay: ' + parseFloat(entry.startTime.toFixed(3)) + 'ms)',
                  durationMs: parseFloat(entry.duration.toFixed(3)),
                  children: [],
                });
              }
            });
          });
          obs.observe({ type: 'event', durationThreshold: 0, buffered: false });
          state.eventObserver = obs;
        } catch(err) {
          if (state.options.logToConsole) {
            console.log('[WebProfiler] PerformanceObserver not supported:', err.message);
          }
        }
      }

      // rAF latency measurement
      var treeRef = state.currentTree;
      var downTime = state.pointerDownTime;
      requestAnimationFrame(function () {
        var latency = Math.round(performance.now() - downTime);
        if (treeRef) {
          treeRef.children.push({
            name: 'first-rAF (latency)',
            durationMs: latency,
            children: [],
          });
          treeRef.latencyMs = latency;
        }
        state.latencySamples.push({
          ms: latency,
          pointerType: e.pointerType,
          timestamp: new Date().toISOString(),
          timeFromStart: parseFloat((downTime - state.startTime).toFixed(3)),
        });
        if (state.options.logToConsole) console.log('[WebProfiler] latency: ' + latency + 'ms');
        if (typeof state.options.onLatency === 'function') state.options.onLatency(latency);
        updateHUD();
      });
    }
  }

  function onPointerUp() {
    if (!state.isDrawing || !state.currentTree) return;

    // Capture refs before nulling — Excalidraw renders its final frame
    // AFTER pointerup fires, so we keep isDrawing=true and currentTree
    // alive until those canvas calls land, then close the tree.
    var treeRef = state.currentTree;
    var callsRef = state.interactionCanvasCalls;
    var downTime = treeRef.startMs;

    // Null currentTree immediately so the next interaction can start,
    // but keep isDrawing=true so post-pointerup canvas calls still
    // get captured into callsRef (which still references the old array).
    state.currentTree = null;
    state.interactionCanvasCalls = [];

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // Disconnect PerformanceObserver for this interaction
        if (state.eventObserver) {
          state.eventObserver.disconnect();
          state.eventObserver = null;
        }

        state.isDrawing = false;

        var now = performance.now();
        treeRef.endMs = now;
        treeRef.durationMs = parseFloat((now - downTime).toFixed(3));

        if (callsRef.length) {
          var grouped = {};
          callsRef.forEach(function (c) {
            if (!grouped[c.name]) grouped[c.name] = { name: c.name, calls: 0, totalMs: 0 };
            grouped[c.name].calls++;
            grouped[c.name].totalMs += c.durationMs;
          });
          treeRef.children.push({
            name: 'pointermove → canvas (' + callsRef.length + ' calls)',
            durationMs: parseFloat(callsRef.reduce(function (a, b) { return a + b.durationMs; }, 0).toFixed(3)),
            children: Object.keys(grouped).map(function (k) {
              var g = grouped[k];
              return { name: k + ' ×' + g.calls, durationMs: parseFloat(g.totalMs.toFixed(3)), children: [] };
            }),
          });
        }

        state.callTrees.push(treeRef);
        updateHUD();
      });
    });
  }

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

  function buildFirefoxProfile() {
    var stringTable = [];
    var stringMap = {};

    function internString(s) {
      if (stringMap[s] === undefined) {
        stringMap[s] = stringTable.length;
        stringTable.push(s);
      }
      return stringMap[s];
    }

    var funcTable = {
      name: [],
      isJS: [],
      relevantForJS: [],
      resource: [],
      address: [],
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
      func: [],
      nativeSymbol: [],
      innerWindowID: [],
      implementation: [],
      line: [],
      column: [],
      length: 0,
    };

    var stackTable = {
      frame: [],
      category: [],
      subcategory: [],
      prefix: [],
      length: 0,
    };

    var samples = {
      stack: [],
      time: [],
      responsiveness: [],
      weight: [],
      weightType: 'tracing-ms',
      length: 0,
    };

    var markers = {
      schema: { name: 0, time: 1, endTime: 2, phase: 3, category: 4, data: 5 },
      data: [],
    };

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

    function processNode(node, parentStackIdx, timeOffset) {
      var funcIdx = getOrCreateFunc(node.name);
      var frameIdx = getOrCreateFrame(funcIdx);
      var stackIdx = addStack(frameIdx, parentStackIdx);

      var nodeStart = timeOffset;
      var nodeEnd = timeOffset + (node.durationMs || 0);

      samples.stack.push(stackIdx);
      samples.time.push(parseFloat(nodeStart.toFixed(3)));
      samples.responsiveness.push(null);
      samples.weight.push(node.durationMs || 0);
      samples.length++;

      markers.data.push([
        internString(node.name),
        parseFloat(nodeStart.toFixed(3)),
        parseFloat(nodeEnd.toFixed(3)),
        1,
        0,
        null,
      ]);

      var children = node.children || [];
      var childOffset = nodeStart;
      children.forEach(function (child) {
        processNode(child, stackIdx, childOffset);
        childOffset += (child.durationMs || 0.1);
      });
    }

    // Use earliest tree startMs as base — this way the timeline in
    // Firefox Profiler always starts near 0ms regardless of how long
    // the user waited before drawing the first interaction.
    var baseTime = state.callTrees.length
      ? state.callTrees[0].startMs
      : state.startTime;

    state.callTrees.forEach(function (tree) {
      var treeOffset = tree.startMs - baseTime;
      processNode(tree, null, treeOffset);
    });

    state.latencySamples.forEach(function (s) {
      var timeFrom = (s.timeFromStart !== undefined) ? s.timeFromStart : (s.ms || 0);
      markers.data.push([
        internString('Input Latency: ' + s.ms + 'ms'),
        parseFloat(timeFrom.toFixed(3)),
        parseFloat((timeFrom + s.ms).toFixed(3)),
        1,
        0,
        null,
      ]);
    });

    var profileDuration = performance.now() - state.startTime;

    return {
      meta: {
        interval: 1,
        startTime: baseTime,
        processType: 0,
        product: 'WebProfiler (Excalidraw / Tizen)',
        stackwalk: 0,
        version: 24,
        preprocessedProfileVersion: 47,
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
            lib: [], name: [], host: [], type: [], length: 0,
          },
          nativeSymbols: {
            libIndex: [], address: [], name: [], functionSize: [], length: 0,
          },
          stringArray: stringTable,
        },
      ],
    };
  }

  var hud = null;

  // HUD theme state
  var hudTheme = 'dark';

  function getThemeVars() {
    return hudTheme === 'dark' ? {
      bg:      'rgba(8,8,14,0.93)',
      border:  '#2a2a3a',
      color:   '#e8e8f0',
      muted:   '#555570',
      label:   '#888',
    } : {
      bg:      'rgba(245,245,250,0.97)',
      border:  '#d0d0e0',
      color:   '#111120',
      muted:   '#888899',
      label:   '#444455',
    };
  }

  function applyTheme(el) {
    var t = getThemeVars();
    el.style.background = t.bg;
    el.style.border = '1px solid ' + t.border;
    el.style.color = t.color;
    // update muted labels
    el.querySelectorAll('[data-muted]').forEach(function (e) { e.style.color = t.muted; });
    el.querySelectorAll('[data-label]').forEach(function (e) { e.style.color = t.label; });
  }

  function createHUD() {
    var t = getThemeVars();
    var el = document.createElement('div');
    el.id = '__web_profiler_hud__';
    el.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px',
      'z-index:2147483647',
      'background:' + t.bg,
      'border:1px solid ' + t.border,
      'border-radius:10px',
      'padding:10px 14px',
      'font-family:monospace', 'font-size:11px',
      'color:' + t.color,
      'min-width:220px', 'max-width:300px',
      'box-shadow:0 4px 32px rgba(0,0,0,0.5)',
      'user-select:none', 'cursor:move',
      'transition:all 0.15s ease',
    ].join(';');

    el.innerHTML = [
      // ── Title bar ──────────────────────────────────────────
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">',
      '<span id="__wp_title__" style="color:#00e5ff;font-weight:700;font-size:10px;letter-spacing:0.08em">⬡ WEB PROFILER [MANUAL]</span>',
      '<div style="display:flex;gap:4px;align-items:center">',
      '<button id="__wp_theme__"  title="Toggle theme"   style="background:transparent;border:1px solid #555570;color:#888;font-family:monospace;font-size:9px;padding:1px 5px;border-radius:3px;cursor:pointer">☀</button>',
      '<button id="__wp_min__"    title="Minimize"       style="background:transparent;border:1px solid #555570;color:#888;font-family:monospace;font-size:9px;padding:1px 5px;border-radius:3px;cursor:pointer">▲</button>',
      '</div>',
      '</div>',

      // ── Collapsible body ───────────────────────────────────
      '<div id="__wp_body__">',

      // Action buttons
      '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">',
      '<button id="__wp_stop__"    style="background:transparent;border:1px solid #a8ff78;color:#a8ff78;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer;display:none">STOP</button>',
      '<button id="__wp_export__"  style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CSV</button>',
      '<button id="__wp_firefox__" style="background:transparent;border:1px solid #ff9500;color:#ff9500;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">FFX</button>',
      '<button id="__wp_open__"    style="background:transparent;border:1px solid #a855f7;color:#a855f7;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">OPEN</button>',
      '<button id="__wp_clear__"   style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CLR</button>',
      '</div>',

      // Metrics row
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">',
      '<div><div data-muted style="font-size:9px;margin-bottom:2px">FPS</div>',
      '<div id="__wp_fps__" style="font-size:18px;font-weight:700;color:#00e5ff;line-height:1">—</div></div>',
      '<div><div data-muted style="font-size:9px;margin-bottom:2px">AVG LAT</div>',
      '<div id="__wp_lat__" style="font-size:18px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
      '<div data-muted style="font-size:9px">ms</div></div>',
      '<div><div data-muted style="font-size:9px;margin-bottom:2px">MEM</div>',
      '<div id="__wp_mem__" style="font-size:18px;font-weight:700;color:#00e5ff;line-height:1">—</div>',
      '<div data-muted style="font-size:9px">MB</div></div>',
      '</div>',

      // Canvas calls
      '<div data-muted style="font-size:9px;margin-bottom:3px">CANVAS CALLS (avg ms)</div>',
      '<div id="__wp_canvas__" style="display:flex;flex-direction:column;gap:2px;margin-bottom:8px"></div>',

      // Latency bars
      '<div data-muted style="font-size:9px;margin-bottom:3px">LAST 8 INTERACTIONS</div>',
      '<div id="__wp_bars__" style="display:flex;align-items:flex-end;gap:3px;height:20px;margin-bottom:6px"></div>',

      // Tree panel — open by default
      '<div id="__wp_tree_panel__" style="margin-top:6px;border-top:1px solid #2a2a3a;padding-top:6px">',
      '<div data-muted style="font-size:9px;margin-bottom:3px">LAST INTERACTION PIPELINE</div>',
      '<div id="__wp_tree_content__" style="font-size:9px;line-height:1.8;color:#888;max-height:160px;overflow-y:auto;white-space:nowrap"></div>',
      '</div>',

      // Status row
      '<div style="display:flex;align-items:center;gap:6px;margin-top:5px">',
      '<div id="__wp_dot__" style="width:6px;height:6px;border-radius:50%;background:#555570;flex-shrink:0"></div>',
      '<div id="__wp_status__" data-muted style="font-size:10px">waiting…</div>',
      '</div>',

      '</div>', // end __wp_body__
    ].join('');

    document.body.appendChild(el);

    // ── Button handlers ──────────────────────────────────────
    el.querySelector('#__wp_export__').addEventListener('click',  function (e) { e.stopPropagation(); WebProfiler.exportCSV(); });
    el.querySelector('#__wp_firefox__').addEventListener('click', function (e) { e.stopPropagation(); WebProfiler.exportFirefox(); });
    el.querySelector('#__wp_open__').addEventListener('click',    function (e) { e.stopPropagation(); WebProfiler.openInFirefoxProfiler(); });
    el.querySelector('#__wp_clear__').addEventListener('click',   function (e) { e.stopPropagation(); WebProfiler.clear(); });

    el.querySelector('#__wp_stop__').addEventListener('click', function (e) {
      e.stopPropagation();
      WebProfiler.stopNative().then(function () {
        el.querySelector('#__wp_stop__').style.display = 'none';
      });
    });

    // Minimize toggle
    var minimized = false;
    el.querySelector('#__wp_min__').addEventListener('click', function (e) {
      e.stopPropagation();
      minimized = !minimized;
      el.querySelector('#__wp_body__').style.display = minimized ? 'none' : 'block';
      el.querySelector('#__wp_min__').textContent = minimized ? '▼' : '▲';
      el.style.minWidth = minimized ? '0' : '220px';
    });

    // Theme toggle
    el.querySelector('#__wp_theme__').addEventListener('click', function (e) {
      e.stopPropagation();
      hudTheme = hudTheme === 'dark' ? 'light' : 'dark';
      var t2 = getThemeVars();
      el.style.background = t2.bg;
      el.style.border = '1px solid ' + t2.border;
      el.style.color = t2.color;
      el.querySelectorAll('[data-muted]').forEach(function (m) { m.style.color = t2.muted; });
      el.querySelector('#__wp_theme__').textContent = hudTheme === 'dark' ? '☀' : '☾';
      el.querySelector('#__wp_tree_panel__').style.borderTopColor = t2.border;
    });

    makeDraggable(el);
    renderLastTree();
    return el;
  }

  function renderLastTree() {
    if (!hud) return;
    var content = hud.querySelector('#__wp_tree_content__');
    if (!content) return;
    if (!state.callTrees.length) {
      content.innerHTML = '<span style="color:#555570">no interactions yet</span>';
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

  // ── JS Self-Profiling API (Chrome 94+ / Edge 94+) ───────────
  // If the browser supports the native Profiler API, we use it
  // to capture REAL JS call stacks automatically — no manual wrapping.
  // On old browsers (Tizen 5.2), it's not available so we fall back
  // to our manual canvas wrapping approach.
  //
  // The native API requires:
  //   Document-Policy: js-profiling
  // header on the server response. Add this to vercel.json headers
  // or your server config for it to work on modern browsers.

  var nativeProfiler = null;   // holds the Profiler instance if available
  var nativeTraceData = null;  // holds the trace after stop()

  function isNativeProfilerAvailable() {
    return typeof global.Profiler === 'function';
  }

  function startNativeProfiler() {
    try {
      nativeProfiler = new global.Profiler({
        sampleInterval: 10,   // sample every 10ms
        maxBufferSize: 10000, // max 10000 samples
      });
      if (state.options.logToConsole) {
        console.log('[WebProfiler] JS Self-Profiling API available — using native profiler.');
      }
      // HUD mode will be updated after createHUD() in init()
    } catch (e) {
      // NotAllowedError = missing Document-Policy header
      // Fall through to manual mode
      nativeProfiler = null;
      if (state.options.logToConsole) {
        console.log('[WebProfiler] JS Self-Profiling API not allowed (missing Document-Policy header). Using manual instrumentation.');
      }
    }
  }

  async function stopNativeProfiler() {
    if (!nativeProfiler || nativeProfiler.stopped) return null;
    try {
      nativeTraceData = await nativeProfiler.stop();
      if (state.options.logToConsole) {
        console.log('[WebProfiler] Native profiler stopped.', nativeTraceData.samples.length, 'samples captured.');
      }
      return nativeTraceData;
    } catch (e) {
      console.warn('[WebProfiler] Failed to stop native profiler:', e);
      return null;
    }
  }

  function updateHUDMode(mode) {
    if (!hud) return;
    var titleEl = hud.querySelector('#__wp_title__');
    var stopBtn = hud.querySelector('#__wp_stop__');
    if (!titleEl) return;
    if (mode === 'native') {
      titleEl.textContent = '⬡ WEB PROFILER [NATIVE]';
      titleEl.style.color = '#a8ff78';
      if (stopBtn) stopBtn.style.display = 'inline-block';
    } else {
      titleEl.textContent = '⬡ WEB PROFILER [MANUAL]';
      titleEl.style.color = '#00e5ff';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  }

  // ── Source Map Resolution (built-in, no dependencies) ────────
  // Implements a minimal VLQ source map decoder directly — no CDN,
  // no WASM, no external dependencies. Works everywhere including
  // Tizen 5.2 and Edge with tracking prevention enabled.

  var sourceMapCache = {}; // cache of parsed consumers per script URL

  // Base64 VLQ decoder — implements the source map spec
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_MAP = {};
  for (var _i = 0; _i < B64.length; _i++) B64_MAP[B64[_i]] = _i;

  function decodeVLQ(str, pos) {
    var result = 0, shift = 0, digit, cont;
    do {
      digit = B64_MAP[str[pos++]];
      cont  = digit & 32;
      digit &= 31;
      result += digit << shift;
      shift  += 5;
    } while (cont);
    return { value: (result & 1) ? -(result >> 1) : (result >> 1), pos: pos };
  }

  // Parse a source map JSON into a lookup structure
  // Returns a function: (line, column) → { name, source }
  function parseSourceMap(mapJson) {
    var names   = mapJson.names   || [];
    var sources = mapJson.sources || [];
    var mappings = mapJson.mappings || '';

    // Parse all mappings into a sorted array
    var segments = [];
    var genLine = 0;
    var srcFile = 0, srcLine = 0, srcCol = 0, nameIdx = 0;

    var lines = mappings.split(';');
    for (var li = 0; li < lines.length; li++) {
      genLine = li;
      var genCol = 0;
      var parts = lines[li].split(',');
      for (var pi = 0; pi < parts.length; pi++) {
        var seg = parts[pi];
        if (!seg) continue;
        var pos = 0;
        var r;

        r = decodeVLQ(seg, pos); genCol  += r.value; pos = r.pos;
        if (pos >= seg.length) continue;
        r = decodeVLQ(seg, pos); srcFile += r.value; pos = r.pos;
        if (pos >= seg.length) continue;
        r = decodeVLQ(seg, pos); srcLine += r.value; pos = r.pos;
        if (pos >= seg.length) continue;
        r = decodeVLQ(seg, pos); srcCol  += r.value; pos = r.pos;

        var nameIndex = -1;
        if (pos < seg.length) {
          r = decodeVLQ(seg, pos); nameIdx += r.value;
          nameIndex = nameIdx;
        }

        segments.push({
          gl: genLine, gc: genCol,
          name: nameIndex >= 0 ? names[nameIndex] : null,
          source: sources[srcFile] || null,
        });
      }
    }

    // Lookup: find closest segment for a given generated line/column
    return function lookup(line, column) {
      // line is 1-based in profiler, 0-based in source map
      var targetLine = line - 1;
      var best = null;
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        if (s.gl === targetLine && s.gc <= column) {
          if (!best || s.gc > best.gc) best = s;
        }
      }
      return best;
    };
  }

  // Fetch and parse a source map for a script URL
  async function getSourceMapLookup(scriptUrl) {
    if (sourceMapCache[scriptUrl]) return sourceMapCache[scriptUrl];
    try {
      var jsRes  = await fetch(scriptUrl);
      var jsText = await jsRes.text();
      var match  = jsText.match(/\/\/# sourceMappingURL=(.+)$/m);
      if (!match) return null;

      var mapUrl = match[1].startsWith('http')
        ? match[1]
        : new URL(match[1], scriptUrl).href;

      var mapRes  = await fetch(mapUrl);
      var mapJson = await mapRes.json();
      var lookup  = parseSourceMap(mapJson);
      sourceMapCache[scriptUrl] = lookup;
      if (state.options.logToConsole) console.log('[WebProfiler] Source map parsed:', mapUrl);
      return lookup;
    } catch(e) {
      if (state.options.logToConsole) console.warn('[WebProfiler] Source map fetch failed:', scriptUrl, e.message);
      return null;
    }
  }

  // Resolve all frame names in a native profiler trace
  // Returns { minifiedName → realName }
  async function resolveFrameNames(trace) {
    var resolved = {};
    if (!trace || !trace.frames) return resolved;

    try {
      // Build script URL map from resourceId
      var scripts = {};
      if (trace.resources) {
        trace.resources.forEach(function(url, i) { scripts[i] = url; });
      }

      // Group frames by script
      var byScript = {};
      trace.frames.forEach(function(frame) {
        if (!frame || frame.line === undefined || frame.column === undefined) return;
        var url = scripts[frame.resourceId];
        if (!url) return;
        if (!byScript[url]) byScript[url] = [];
        byScript[url].push(frame);
      });

      // Resolve each script's frames
      await Promise.all(Object.keys(byScript).map(async function(scriptUrl) {
        var lookup = await getSourceMapLookup(scriptUrl);
        if (!lookup) return;

        byScript[scriptUrl].forEach(function(frame) {
          var result = lookup(frame.line, frame.column);
          var realName = (result && result.name) ? result.name : frame.name;
          resolved[frame.name] = realName;
          if (state.options.logToConsole && realName !== frame.name) {
            console.log('[WebProfiler] ' + frame.name + ' → ' + realName);
          }
        });
      }));

    } catch(e) {
      if (state.options.logToConsole) console.warn('[WebProfiler] Resolution failed:', e.message);
    }

    return resolved;
  }

  // Convert native Profiler trace into our callTree format
  // so it works with the existing Firefox export and HUD
  function nativeTraceToCallTrees(trace, nameMap) {
    if (!trace || !trace.samples.length) return [];
    nameMap = nameMap || {};

    // Build a map of stackId → full call path
    function resolveStack(stackId) {
      if (stackId === undefined || stackId === null) return [];
      var stack = trace.stacks[stackId];
      if (!stack) return [];
      var parent = resolveStack(stack.parentId);
      var frame  = trace.frames[stack.frameId];
      var rawName = frame ? (frame.name || 'anonymous') : 'unknown';
      var name = nameMap[rawName] || rawName; // use resolved name if available
      return parent.concat([name]);
    }

    // Group samples by time proximity into "interactions"
    // (gap > 500ms = new interaction)
    var interactions = [];
    var currentInteraction = null;
    var GAP = 500;

    trace.samples.forEach(function (sample) {
      if (!currentInteraction || (sample.timestamp - currentInteraction.lastTime) > GAP) {
        currentInteraction = { samples: [], lastTime: sample.timestamp };
        interactions.push(currentInteraction);
      }
      currentInteraction.samples.push(sample);
      currentInteraction.lastTime = sample.timestamp;
    });

    // Convert each interaction into a call tree node
    return interactions.map(function (interaction, i) {
      var startMs = interaction.samples[0].timestamp;
      var endMs   = interaction.samples[interaction.samples.length - 1].timestamp;

      // Count how often each function appears
      var funcCounts = {};
      interaction.samples.forEach(function (sample) {
        var path = resolveStack(sample.stackId);
        path.forEach(function (name) {
          funcCounts[name] = (funcCounts[name] || 0) + 1;
        });
      });

      var children = Object.keys(funcCounts)
        .sort(function (a, b) { return funcCounts[b] - funcCounts[a]; })
        .slice(0, 10) // top 10 functions
        .map(function (name) {
          return {
            name: name + ' (' + funcCounts[name] + ' samples)',
            durationMs: funcCounts[name] * 10, // approx: samples × interval
            children: [],
          };
        });

      return {
        name: 'interaction_native_' + (i + 1),
        pointerType: 'pen',
        startMs: startMs,
        endMs: endMs,
        durationMs: parseFloat((endMs - startMs).toFixed(3)),
        latencyMs: null,
        children: children,
        source: 'native', // mark as native profiler data
      };
    });
  }

  var WebProfiler = {

    init: function (options) {
      if (state.active) return this;
      state.options = Object.assign({
        target: window, overlay: true, logToConsole: false,
        stylusOnly: false, wrapCanvas: true, trackMemory: true, onLatency: null,
        useNativeProfiler: true, // try JS Self-Profiling API first
      }, options || {});
      state.startTime = performance.now();
      var target = state.options.target;
      target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
      target.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
      target.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });

      // Try native profiler first, fall back to manual
      if (state.options.useNativeProfiler && isNativeProfilerAvailable()) {
        startNativeProfiler();
      } else {
        if (state.options.logToConsole) {
          console.log('[WebProfiler] JS Self-Profiling API not available. Using manual instrumentation (canvas wrapping).');
        }
      }

      // Always run manual instrumentation too
      // (latency, FPS, memory work regardless)
      if (state.options.wrapCanvas) wrapCanvasAPI();
      if (state.options.trackMemory) startMemorySampling();
      state.fpsLastTime = performance.now();
      fpsTick();
      if (state.options.overlay) hud = createHUD();
      // Update HUD mode AFTER hud is created
      if (nativeProfiler) updateHUDMode('native');
      state.active = true;
      if (state.options.logToConsole) console.log('[WebProfiler] initialized. Mode: ' + (nativeProfiler ? 'NATIVE' : 'MANUAL'));
      return this;
    },

    // Stop the native profiler and merge its data into callTrees
    stopNative: async function () {
      if (!nativeProfiler) {
        console.warn('[WebProfiler] Native profiler not running.');
        return null;
      }
      var trace = await stopNativeProfiler();
      if (trace) {
        // Show resolving status in HUD
        var status = hud ? hud.querySelector('#__wp_status__') : null;
        if (status) status.textContent = 'resolving names via source maps…';

        // Try to resolve minified names via source maps
        var nameMap = await resolveFrameNames(trace);
        var resolved = Object.keys(nameMap).filter(function(k){ return nameMap[k] !== k; }).length;
        if (state.options.logToConsole) console.log('[WebProfiler] Resolved ' + resolved + ' function names.');

        var trees = nativeTraceToCallTrees(trace, nameMap);
        state.callTrees = state.callTrees.concat(trees);
        updateHUD();
        if (state.options.logToConsole) {
          console.log('[WebProfiler] Native trace merged:', trees.length, 'interactions.');
        }
      }
      return trace;
    },

    // Check which mode is active
    getMode: function () {
      return nativeProfiler ? 'native' : 'manual';
    },

    isNativeAvailable: isNativeProfilerAvailable,

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
        sections.push('interaction,depth,node,duration_ms,pointer_type');
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

    // ── Open directly in Firefox Profiler (no download needed) ─
    // Opens profiler.firefox.com in a new tab and sends the profile
    // via postMessage — works even on browsers that can't download files.
    openInFirefoxProfiler: async function () {
      if (!state.callTrees.length && !state.latencySamples.length) {
        console.warn('[WebProfiler] No data to open.');
        return;
      }

      var status = hud ? hud.querySelector('#__wp_status__') : null;
      if (status) status.textContent = 'compressing profile…';

      var profile = buildFirefoxProfile();
      var json = JSON.stringify(profile);

      try {
        if (typeof CompressionStream === 'undefined') {
          throw new Error('CompressionStream not supported in this browser');
        }

        // gzip-compress the JSON — required by compressed-store endpoint
        var jsonBytes = new TextEncoder().encode(json);
        var cs = new CompressionStream('gzip');
        var writer = cs.writable.getWriter();
        writer.write(jsonBytes);
        writer.close();
        var compressedBuffer = await new Response(cs.readable).arrayBuffer();

        if (status) status.textContent = 'uploading to Firefox Profiler…';

        var res = await fetch('https://api.profiler.firefox.com/compressed-store', {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.firefox-profiler+json;version=1.0',
            'Content-Type': 'application/octet-stream',
          },
          body: compressedBuffer,
        });

        if (!res.ok) throw new Error('Upload failed: ' + res.status);

        // Response is a JWT — decode base64url payload to get profileToken
        var jwt = (await res.text()).trim();
        var b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        var payload = JSON.parse(atob(b64));
        var profileToken = payload.profileToken;
        if (!profileToken) throw new Error('No profile token in response');

        var profilerUrl = 'https://profiler.firefox.com/public/' + profileToken;

        if (status) status.textContent = 'opening profiler…';
        window.open(profilerUrl, '_blank');

        if (state.options.logToConsole) {
          console.log('[WebProfiler] Profile token:', profileToken);
          console.log('[WebProfiler] URL:', profilerUrl);
        }

      } catch(e) {
        if (status) status.textContent = 'failed — use FFX button';
        console.warn('[WebProfiler] Upload failed:', e.message);
      }
    },

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
      state.interactionCount = 0;
      state.currentTree = null; state.interactionCanvasCalls = []; state.isDrawing = false;
      if (state.eventObserver) { state.eventObserver.disconnect(); state.eventObserver = null; }
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