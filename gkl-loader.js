(function () {
  'use strict';

  if (window._gklLoaderStarted) return;
  window._gklLoaderStarted = true;

  var THREE_MODULE_URL = 'https://cdn.jsdelivr.net/npm/three@0.183.2/build/three.module.js';
  var WORKER_URL = 'https://plastformula.store/gkl-worker.js';
  var SCENE_URL = 'https://plastformula.store/gkl-scene.js';

  window._W3D = false;
  window._GKL_W = null;

  var orig = document.getElementById('bgC');
  if (!orig) {
    console.warn('[gkl-loader] bgC canvas not found');
    return;
  }

  var m = matchMedia('(pointer:coarse)').matches;
  var mob = ('ontouchstart' in window) && m && Math.min(screen.width, screen.height) < 768;
  var td = ('ontouchstart' in window) && !(matchMedia('(pointer:fine)').matches);
  var cn = navigator.connection || navigator.mozConnection;
  var slow = cn && (cn.effectiveType === '2g' || cn.effectiveType === 'slow-2g' || cn.saveData);
  var reduceMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;

  if (reduceMotion) {
    console.log('[gkl-loader] prefers-reduced-motion=reduce — 3D disabled');
    return;
  }

  var workerAlive = false;
  var w = null;
  var wc = null;

  /* v4: CorsWorker паттерн — скачиваем воркер через fetch (CORS *),
   * оборачиваем в Blob, Worker создаётся как same-origin blob:
   * Внутри воркера НЕТ cross-origin запросов — весь код локальный. */
  function createCorsWorker() {
    if (typeof orig.transferControlToOffscreen !== 'function') {
      console.warn('[gkl-loader] ❌ OffscreenCanvas not supported');
      return Promise.reject(new Error('no-offscreen'));
    }
    if (location.protocol === 'file:') {
      console.warn('[gkl-loader] ❌ file:// protocol');
      return Promise.reject(new Error('file-protocol'));
    }

    console.log('[gkl-loader] fetching worker code from', WORKER_URL);
    return fetch(WORKER_URL, { mode: 'cors', credentials: 'omit', cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
        return r.text();
      })
      .then(function (code) {
        console.log('[gkl-loader] worker code loaded, size:', code.length, 'bytes');
        var blob = new Blob([code], { type: 'application/javascript' });
        var blobUrl = URL.createObjectURL(blob);
        var worker = new Worker(blobUrl);
        URL.revokeObjectURL(blobUrl);
        return worker;
      });
  }

  function startWorker() {
    createCorsWorker().then(function (worker) {
      w = worker;

      wc = document.createElement('canvas');
      wc.id = 'bgC2';
      wc.setAttribute('aria-hidden', 'true');
      wc.style.cssText = orig.style.cssText || 'position:fixed;inset:0;z-index:0;pointer-events:none;touch-action:none';
      orig.parentNode.insertBefore(wc, orig.nextSibling);

      var oc = wc.transferControlToOffscreen();

      w.postMessage({
        type: 'init',
        canvas: oc,
        deviceInfo: {
          w: innerWidth, h: innerHeight,
          isMobile: mob, isTouchDevice: td,
          dpr: devicePixelRatio, slowNet: !!slow,
          isLaptop: !!window._GKL_LT
        }
      }, [oc]);

      orig.style.display = 'none';
      window._W3D = true;
      window._GKL_W = w;

      w.onmessage = function (e) {
        if (e.data && e.data.type === 'alive') {
          workerAlive = true;
          console.log('[gkl-loader] ✓ Worker alive, main thread FREE, Three.js NOT loaded');
          setupVisibilityPause();
        }
      };
      w.onerror = function (err) {
        console.error('[gkl-loader] ❌ Worker runtime:', err.message || err.type || err);
        revertToMainThread();
      };

      setTimeout(function () {
        if (!workerAlive) {
          console.warn('[gkl-loader] ❌ Worker did not respond in 3s');
          revertToMainThread();
        }
      }, 3000);
    }).catch(function (err) {
      console.error('[gkl-loader] ❌ Worker create failed:', err.message);
      revertToMainThread();
    });
  }

  function setupVisibilityPause() {
    if (typeof IntersectionObserver !== 'function') return;
    var target = wc || orig;
    var paused = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (ent) {
        if (ent.isIntersecting && paused) {
          paused = false;
          if (w) w.postMessage({ type: 'resume' });
        } else if (!ent.isIntersecting && !paused) {
          paused = true;
          if (w) w.postMessage({ type: 'pause' });
        }
      });
    }, { threshold: 0, rootMargin: '200px 0px' });
    io.observe(target);

    document.addEventListener('visibilitychange', function () {
      if (!w) return;
      if (document.hidden) w.postMessage({ type: 'pause' });
      else if (!paused) w.postMessage({ type: 'resume' });
    });
  }

  var fallbackStarted = false;
  function revertToMainThread() {
    if (fallbackStarted) return;
    fallbackStarted = true;
    window._W3D = false;
    window._GKL_W = null;
    if (w) { try { w.terminate(); } catch (e) {} w = null; }
    if (orig) orig.style.display = '';
    var c2 = document.getElementById('bgC2');
    if (c2) c2.remove();
    startMainThreadScene();
  }

  function startMainThreadScene() {
    console.log('[gkl-loader] Starting main-thread WebGL (heavier)');
    var p1 = import(THREE_MODULE_URL);
    var p2 = loadSceneScript();
    Promise.all([p1, p2]).then(function (results) {
      var THREE = results[0];
      if (typeof window._gklScene !== 'function') {
        console.error('[gkl-loader] _gklScene missing');
        return;
      }
      try { window._gklScene(THREE); }
      catch (e) { console.error('[gkl-loader] Scene threw:', e); }
    }).catch(function (e) {
      console.error('[gkl-loader] Failed THREE/scene:', e.message);
    });
  }

  function loadSceneScript() {
    return new Promise(function (resolve, reject) {
      if (typeof window._gklScene === 'function') { resolve(); return; }
      var s = document.createElement('script');
      s.src = SCENE_URL;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load scene')); };
      document.head.appendChild(s);
    });
  }

  var mt = 0;
  addEventListener('mousemove', function (e) {
    if (!window._W3D || !w) return;
    var nx = (e.clientX / innerWidth) * 2 - 1;
    var ny = -(e.clientY / innerHeight) * 2 + 1;
    var n = performance.now();
    if (n - mt > 16) { mt = n; w.postMessage({ type: 'mouse', x: nx, y: ny }); }
  }, { passive: true });

  addEventListener('touchstart', function (e) {
    if (!window._W3D || !w) return;
    var t = e.touches[0];
    w.postMessage({ type: 'touch', touching: true, x: (t.clientX / innerWidth) * 2 - 1, y: -(t.clientY / innerHeight) * 2 + 1 });
  }, { passive: true });

  addEventListener('touchmove', function (e) {
    if (!window._W3D || !w) return;
    var t = e.touches[0];
    w.postMessage({ type: 'touch', touching: true, x: (t.clientX / innerWidth) * 2 - 1, y: -(t.clientY / innerHeight) * 2 + 1 });
  }, { passive: true });

  addEventListener('touchend', function () {
    if (!window._W3D || !w) return;
    w.postMessage({ type: 'touch', touching: false });
  }, { passive: true });

  var rt;
  addEventListener('resize', function () {
    if (!window._W3D || !w) return;
    clearTimeout(rt);
    rt = setTimeout(function () { w.postMessage({ type: 'resize', w: innerWidth, h: innerHeight }); }, 200);
  });

  (function gl() {
    requestAnimationFrame(gl);
    if (document.hidden || !window._W3D) return;
    var t = performance.now() * 0.001;
    ['gs1', 'gs2', 'gs3', 'gs4'].forEach(function (id, i) {
      var el = document.getElementById(id);
      if (el) {
        var sp = [0.3, 0.35, 0.22, 0.27][i];
        var sp2 = [0.25, 0.28, 0.3, 0.33][i];
        el.style.transform = 'translate(' + Math.sin(t * sp) * 30 + 'px,' + Math.cos(t * sp2) * 20 + 'px)';
      }
    });
  })();

  startWorker();
})();
