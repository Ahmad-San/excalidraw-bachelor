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
 *  5. Call tree      — full drawing pipeline:
 *                      pointerdown → rAF → canvas calls
 *
 * USAGE:
 *   <script src="web-profiler.js"></script>
 *   <script> WebProfiler.init({ logToConsole: true }); </script>
 * ─────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  // ── State ───────────────────────────────────────────────────
  var state = {
    active: false,
    options: {},

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
    callTrees: [],       // completed trees (one per stroke)
    currentTree: null,   // tree being built right now
    callStack: [],       // live stack during a stroke
  };

  // ── Utilities ───────────────────────────────────────────────
  function avg(arr) {
    return arr.length ? Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) : null;
  }
  function clamp(v,min,max){return Math.min(max,Math.max(min,v));}
  function colorFor(ms){
    if(ms<30)return'#00e5ff';
    if(ms<80)return'#ffb300';
    return'#ff3d71';
  }
  function fpsColor(fps){
    if(fps>=50)return'#00e5ff';
    if(fps>=30)return'#ffb300';
    return'#ff3d71';
  }
  function mb(bytes){return(bytes/1048576).toFixed(1);}

  // ── 5. Call Tree ────────────────────────────────────────────
  // A node looks like:
  // { name, startMs, endMs, durationMs, children: [] }

  function treeStart(name) {
    var node = {
      name: name,
      startMs: performance.now(),
      endMs: null,
      durationMs: null,
      children: [],
    };
    // attach to parent if stack is not empty
    if (state.callStack.length > 0) {
      state.callStack[state.callStack.length - 1].children.push(node);
    } else if (state.currentTree) {
      state.currentTree.children.push(node);
    }
    state.callStack.push(node);
    return node;
  }

  function treeEnd() {
    if (!state.callStack.length) return;
    var node = state.callStack.pop();
    node.endMs = performance.now();
    node.durationMs = parseFloat((node.endMs - node.startMs).toFixed(3));
  }

  // Wrap requestAnimationFrame to capture it in the tree
  function wrapRAF() {
    var originalRAF = global.requestAnimationFrame;
    global.requestAnimationFrame = function(callback) {
      return originalRAF.call(global, function(timestamp) {
        if (state.currentTree) {
          treeStart('requestAnimationFrame');
          callback(timestamp);
          treeEnd();
        } else {
          callback(timestamp);
        }
      });
    };
    global.requestAnimationFrame.__wrapped = true;
  }

  // ── 3. Canvas API Wrapping ──────────────────────────────────
  var CANVAS_METHODS = [
    'stroke','fill','beginPath','moveTo','lineTo',
    'bezierCurveTo','quadraticCurveTo','arc',
    'drawImage','putImageData','clearRect','fillRect',
  ];

  function wrapCanvasAPI() {
    var proto = CanvasRenderingContext2D.prototype;
    CANVAS_METHODS.forEach(function(method) {
      if (!proto[method]) return;
      var original = proto[method];
      state.canvasTimings[method] = [];
      proto[method] = function() {
        var t = performance.now();

        // call tree node
        if (state.currentTree) treeStart(method);

        var result = original.apply(this, arguments);

        if (state.currentTree) treeEnd();

        var elapsed = performance.now() - t;
        state.canvasTimings[method].push(elapsed);
        if (state.canvasTimings[method].length > 200) {
          state.canvasTimings[method].shift();
        }
        return result;
      };
    });
    if (state.options.logToConsole) console.log('[WebProfiler] Canvas API wrapped.');
  }

  function getCanvasStats() {
    var result = {};
    CANVAS_METHODS.forEach(function(method) {
      var samples = state.canvasTimings[method];
      if (!samples || !samples.length) return;
      result[method] = {
        calls:   samples.length,
        avgMs:   parseFloat((samples.reduce(function(a,b){return a+b;},0)/samples.length).toFixed(3)),
        maxMs:   parseFloat(Math.max.apply(null,samples).toFixed(3)),
        totalMs: parseFloat(samples.reduce(function(a,b){return a+b;},0).toFixed(3)),
      };
    });
    return result;
  }

  // ── 1. Input Latency ────────────────────────────────────────
  function onPointerDown(e) {
    if (state.options.stylusOnly && e.pointerType === 'mouse') return;

    state.pointerDownTime = performance.now();

    // start a new call tree for this stroke
    state.currentTree = {
      name: 'stroke_' + (state.callTrees.length + 1),
      pointerType: e.pointerType,
      startMs: state.pointerDownTime,
      endMs: null,
      durationMs: null,
      children: [],
    };
    state.callStack = [];

    // add pointerdown as first node
    treeStart('pointerdown');
    // pointerdown ends immediately (the event handler itself)
    setTimeout(function(){ treeEnd(); }, 0);

    if (state.rafPending) return;
    state.rafPending = true;

    requestAnimationFrame(function() {
      var latency = Math.round(performance.now() - state.pointerDownTime);
      state.rafPending = false;

      // close the tree
      if (state.currentTree) {
        state.currentTree.endMs = performance.now();
        state.currentTree.durationMs = parseFloat(
          (state.currentTree.endMs - state.currentTree.startMs).toFixed(3)
        );
        state.currentTree.latencyMs = latency;
        state.callTrees.push(state.currentTree);
        // keep last 50 trees
        if (state.callTrees.length > 50) state.callTrees.shift();
        state.currentTree = null;
        state.callStack = [];
      }

      state.latencySamples.push({
        ms: latency,
        pointerType: e.pointerType,
        timestamp: new Date().toISOString(),
      });

      if (state.options.logToConsole) {
        console.log('[WebProfiler] latency: ' + latency + 'ms (' + e.pointerType + ')');
      }
      if (typeof state.options.onLatency === 'function') state.options.onLatency(latency);

      updateHUD();
    });
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
    state.memoryInterval = setInterval(function() {
      state.memorySamples.push({
        usedMB:  parseFloat(mb(performance.memory.usedJSHeapSize)),
        totalMB: parseFloat(mb(performance.memory.totalJSHeapSize)),
        timestamp: new Date().toISOString(),
      });
    }, 2000);
  }

  // ── HUD ─────────────────────────────────────────────────────
  var hud = null;

  function createHUD() {
    var el = document.createElement('div');
    el.id = '__web_profiler_hud__';
    el.style.cssText = [
      'position:fixed','bottom:20px','right:20px',
      'z-index:2147483647',
      'background:rgba(8,8,14,0.93)',
      'border:1px solid #2a2a3a','border-radius:10px',
      'padding:14px 18px','font-family:monospace','font-size:11px',
      'color:#e8e8f0','min-width:240px',
      'box-shadow:0 4px 32px rgba(0,0,0,0.6)',
      'user-select:none','cursor:move',
    ].join(';');

    el.innerHTML = [
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">',
        '<span style="color:#00e5ff;font-weight:700;font-size:10px;letter-spacing:0.08em">⬡ WEB PROFILER</span>',
        '<div style="display:flex;gap:5px">',
          '<button id="__wp_tree__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">TREE</button>',
          '<button id="__wp_export__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CSV</button>',
          '<button id="__wp_clear__" style="background:transparent;border:1px solid #2a2a3a;color:#888;font-family:monospace;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">CLR</button>',
        '</div>',
      '</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">',
        '<div><div style="color:#555570;font-size:9px;margin-bottom:2px">FPS</div><div id="__wp_fps__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div></div>',
        '<div><div style="color:#555570;font-size:9px;margin-bottom:2px">AVG LAT</div><div id="__wp_lat__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div><div style="color:#555570;font-size:9px">ms</div></div>',
        '<div><div style="color:#555570;font-size:9px;margin-bottom:2px">MEM</div><div id="__wp_mem__" style="font-size:20px;font-weight:700;color:#00e5ff;line-height:1">—</div><div style="color:#555570;font-size:9px">MB</div></div>',
      '</div>',
      '<div style="color:#555570;font-size:9px;margin-bottom:4px">CANVAS CALLS (avg ms)</div>',
      '<div id="__wp_canvas__" style="display:flex;flex-direction:column;gap:3px;margin-bottom:10px"></div>',
      '<div style="color:#555570;font-size:9px;margin-bottom:4px">LAST 8 STROKES</div>',
      '<div id="__wp_bars__" style="display:flex;align-items:flex-end;gap:3px;height:24px;margin-bottom:8px"></div>',
      // call tree panel (hidden by default)
      '<div id="__wp_tree_panel__" style="display:none;margin-top:8px;border-top:1px solid #2a2a3a;padding-top:8px">',
        '<div style="color:#555570;font-size:9px;margin-bottom:4px">LAST STROKE PIPELINE</div>',
        '<div id="__wp_tree_content__" style="font-size:9px;line-height:1.8;color:#888;max-height:160px;overflow-y:auto"></div>',
      '</div>',
      '<div style="display:flex;align-items:center;gap:6px;margin-top:6px">',
        '<div id="__wp_dot__" style="width:6px;height:6px;border-radius:50%;background:#555570"></div>',
        '<div id="__wp_status__" style="color:#555570;font-size:10px">waiting…</div>',
      '</div>',
    ].join('');

    document.body.appendChild(el);

    el.querySelector('#__wp_export__').addEventListener('click', function(e){
      e.stopPropagation(); WebProfiler.exportCSV();
    });
    el.querySelector('#__wp_clear__').addEventListener('click', function(e){
      e.stopPropagation(); WebProfiler.clear();
    });
    el.querySelector('#__wp_tree__').addEventListener('click', function(e){
      e.stopPropagation();
      var panel = hud.querySelector('#__wp_tree_panel__');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      renderLastTree();
    });

    makeDraggable(el);
    return el;
  }

  // Render the last call tree as indented text
  function renderLastTree() {
    if (!hud) return;
    var content = hud.querySelector('#__wp_tree_content__');
    if (!content) return;
    if (!state.callTrees.length) {
      content.innerHTML = '<span style="color:#555570">no strokes yet</span>';
      return;
    }
    var tree = state.callTrees[state.callTrees.length - 1];

    function renderNode(node, depth) {
      var indent = '';
      for (var i = 0; i < depth; i++) indent += '&nbsp;&nbsp;';
      var arrow = depth > 0 ? '└─ ' : '';
      var color = node.durationMs > 16 ? '#ffb300' : '#00e5ff';
      var line = '<div>' + indent + arrow +
        '<span style="color:' + color + '">' + node.name + '</span>' +
        '<span style="color:#555570"> ' + (node.durationMs || '?') + 'ms</span>' +
        '</div>';
      var childLines = (node.children || []).map(function(c){
        return renderNode(c, depth + 1);
      }).join('');
      return line + childLines;
    }

    content.innerHTML = renderNode(tree, 0);
  }

  function updateHUD() {
    if (!hud) return;

    var fpsEl = hud.querySelector('#__wp_fps__');
    if (fpsEl) { fpsEl.textContent = state.fps; fpsEl.style.color = fpsColor(state.fps); }

    var latEl = hud.querySelector('#__wp_lat__');
    if (latEl && state.latencySamples.length) {
      var a = avg(state.latencySamples.map(function(s){return s.ms;}));
      latEl.textContent = a; latEl.style.color = colorFor(a);
    }

    var memEl = hud.querySelector('#__wp_mem__');
    if (memEl && performance.memory) memEl.textContent = mb(performance.memory.usedJSHeapSize);

    // canvas table
    var canvasEl = hud.querySelector('#__wp_canvas__');
    if (canvasEl) {
      var stats = getCanvasStats();
      var entries = Object.keys(stats)
        .sort(function(a,b){return stats[b].calls - stats[a].calls;})
        .slice(0,5);
      canvasEl.innerHTML = entries.map(function(method){
        var s = stats[method];
        var c = s.avgMs > 1 ? '#ffb300' : '#555570';
        return '<div style="display:flex;justify-content:space-between;font-size:9px">' +
          '<span style="color:#888">' + method + '</span>' +
          '<span style="color:' + c + '">' + s.avgMs + 'ms × ' + s.calls + '</span>' +
          '</div>';
      }).join('');
    }

    // bars
    var barsEl = hud.querySelector('#__wp_bars__');
    if (barsEl && state.latencySamples.length) {
      var recent = state.latencySamples.slice(-8).map(function(s){return s.ms;});
      var maxV = Math.max.apply(null, recent) || 1;
      barsEl.innerHTML = recent.map(function(v){
        var h = clamp(Math.round((v/maxV)*24),2,24);
        return '<div style="flex:1;height:'+h+'px;background:'+colorFor(v)+';border-radius:2px 2px 0 0;opacity:0.85"></div>';
      }).join('');
    }

    // dot flash
    var dot = hud.querySelector('#__wp_dot__');
    var status = hud.querySelector('#__wp_status__');
    if (dot && state.latencySamples.length) {
      var last = state.latencySamples[state.latencySamples.length-1];
      dot.style.background = colorFor(last.ms);
      dot.style.boxShadow = '0 0 6px ' + colorFor(last.ms);
      if (status) status.textContent = 'last: ' + last.ms + 'ms (' + last.pointerType + ')';
      setTimeout(function(){
        dot.style.background = '#555570';
        dot.style.boxShadow = 'none';
      }, 400);
    }

    // update tree panel if visible
    var panel = hud.querySelector('#__wp_tree_panel__');
    if (panel && panel.style.display !== 'none') renderLastTree();
  }

  function makeDraggable(el) {
    var ox,oy,sx,sy;
    el.addEventListener('pointerdown', function(e){
      if(e.target.tagName==='BUTTON')return;
      ox=el.offsetLeft||(window.innerWidth-el.offsetWidth-20);
      oy=el.offsetTop||(window.innerHeight-el.offsetHeight-20);
      sx=e.clientX;sy=e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function(e){
      if(!el.hasPointerCapture(e.pointerId))return;
      el.style.right='auto';el.style.bottom='auto';
      el.style.left=clamp(ox+e.clientX-sx,0,window.innerWidth-el.offsetWidth)+'px';
      el.style.top=clamp(oy+e.clientY-sy,0,window.innerHeight-el.offsetHeight)+'px';
    });
  }

  // ── Public API ───────────────────────────────────────────────
  var WebProfiler = {

    init: function(options) {
      if (state.active) return this;
      state.options = Object.assign({
        target:       window,
        overlay:      true,
        logToConsole: false,
        stylusOnly:   false,
        wrapCanvas:   true,
        wrapRAF:      true,
        trackMemory:  true,
        onLatency:    null,
      }, options || {});

      var target = state.options.target;
      target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });

      if (state.options.wrapRAF)    wrapRAF();
      if (state.options.wrapCanvas) wrapCanvasAPI();
      if (state.options.trackMemory) startMemorySampling();

      state.fpsLastTime = performance.now();
      fpsTick();

      if (state.options.overlay) hud = createHUD();

      state.active = true;
      if (state.options.logToConsole) console.log('[WebProfiler] initialized.');
      return this;
    },

    destroy: function() {
      var target = state.options.target || window;
      target.removeEventListener('pointerdown', onPointerDown, { capture: true });
      if (state.rafLoop) cancelAnimationFrame(state.rafLoop);
      if (state.memoryInterval) clearInterval(state.memoryInterval);
      if (hud) { hud.remove(); hud = null; }
      state.active = false;
      return this;
    },

    // ── Getters ────────────────────────────────────────────────
    getLatencyStats: function() {
      var vals = state.latencySamples.map(function(s){return s.ms;});
      return {
        avg:     avg(vals),
        min:     vals.length ? Math.min.apply(null,vals) : null,
        max:     vals.length ? Math.max.apply(null,vals) : null,
        count:   vals.length,
        samples: state.latencySamples.slice(),
      };
    },

    getCanvasStats: getCanvasStats,

    getCallTrees: function() { return state.callTrees.slice(); },

    getMemoryStats: function() {
      if (!state.memorySamples.length) return null;
      var used = state.memorySamples.map(function(s){return s.usedMB;});
      return {
        avgMB: parseFloat((used.reduce(function(a,b){return a+b;},0)/used.length).toFixed(1)),
        maxMB: Math.max.apply(null,used),
        samples: state.memorySamples.slice(),
      };
    },

    getFPS: function() { return state.fps; },

    // ── Export ─────────────────────────────────────────────────
    exportCSV: function() {
      var sections = [];

      // latency
      if (state.latencySamples.length) {
        sections.push('=== INPUT LATENCY ===');
        sections.push('sample,latency_ms,pointer_type,timestamp');
        state.latencySamples.forEach(function(s,i){
          sections.push((i+1)+','+s.ms+','+s.pointerType+','+s.timestamp);
        });
        sections.push('');
      }

      // canvas
      var cs = getCanvasStats();
      var methods = Object.keys(cs);
      if (methods.length) {
        sections.push('=== CANVAS API TIMING ===');
        sections.push('method,calls,avg_ms,max_ms,total_ms');
        methods.forEach(function(m){
          var s=cs[m];
          sections.push(m+','+s.calls+','+s.avgMs+','+s.maxMs+','+s.totalMs);
        });
        sections.push('');
      }

      // call trees
      if (state.callTrees.length) {
        sections.push('=== CALL TREES ===');
        sections.push('stroke,node,depth,duration_ms,pointer_type');
        state.callTrees.forEach(function(tree, ti) {
          function exportNode(node, depth) {
            sections.push(
              (ti+1) + ',' +
              node.name + ',' +
              depth + ',' +
              (node.durationMs||0) + ',' +
              (tree.pointerType||'unknown')
            );
            (node.children||[]).forEach(function(c){ exportNode(c, depth+1); });
          }
          exportNode(tree, 0);
        });
        sections.push('');
      }

      // memory
      if (state.memorySamples.length) {
        sections.push('=== MEMORY ===');
        sections.push('sample,used_mb,total_mb,timestamp');
        state.memorySamples.forEach(function(s,i){
          sections.push((i+1)+','+s.usedMB+','+s.totalMB+','+s.timestamp);
        });
      }

      if (!sections.length) {
        console.warn('[WebProfiler] No data to export.');
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

    clear: function() {
      state.latencySamples = [];
      state.memorySamples  = [];
      state.callTrees      = [];
      state.currentTree    = null;
      state.callStack      = [];
      Object.keys(state.canvasTimings).forEach(function(k){ state.canvasTimings[k]=[]; });
      if (hud) {
        ['#__wp_fps__','#__wp_lat__','#__wp_mem__'].forEach(function(id){
          var el=hud.querySelector(id);
          if(el){el.textContent='—';el.style.color='#00e5ff';}
        });
        var bars=hud.querySelector('#__wp_bars__');
        if(bars)bars.innerHTML='';
        var canvas=hud.querySelector('#__wp_canvas__');
        if(canvas)canvas.innerHTML='';
        var content=hud.querySelector('#__wp_tree_content__');
        if(content)content.innerHTML='';
        var status=hud.querySelector('#__wp_status__');
        if(status)status.textContent='waiting…';
      }
      if (state.options.logToConsole) console.log('[WebProfiler] Cleared.');
      return this;
    },
  };

  global.WebProfiler = WebProfiler;

})(window);
