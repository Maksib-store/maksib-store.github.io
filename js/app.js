/**
 * سوق المكسب — Core Application Script
 * Arabic RTL · Auth · Cart · Toasts · Shared Site Shell (header/footer) · Socket.IO · AI Assistant
 *
 * Pages only need to include:
 *   <div data-site-header></div>  ...page...  <div data-site-footer></div>
 * and load this file. The shell is rendered here so every page shares one header/footer.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 0. Server pool — فحص متوازي + اختيار الأسرع + تبديل تلقائي (Failover)
  //
  //   • ضيف أي عدد من السيرفرات في SERVERS (بدون / في النهاية).
  //   • كل سيرفر لازم يرد على GET /healthy (200 = سليم، 503 = واقع/مزدحم)
  //     ولازم يسمح بـ CORS للـ endpoint ده (وإلا الفحص هيعتبره واقع).
  //   • كل السيرفرات بتتفحص في نفس الوقت (مش واحد ورا التاني):
  //       - أول زيارة: أول سيرفر سليم يرد = الأسرع، وبيتم اختياره فوراً.
  //       - فحص دوري في الخلفية: بيحدّث زمن الاستجابة لكل سيرفر، ولو سيرفر تاني
  //         أسرع بفارق واضح بيتم التحويل له (hysteresis عشان ما يحصلش تذبذب).
  //       - طلبات GET: لو السيرفر الحالي اتأخر (hedgeAfterMs) بيتبعت نفس الطلب
  //         للسيرفر اللي بعده بالتوازي وأول رد سليم يكسب (مفيش انتظار في الطابور).
  //       - طلبات POST/PUT/DELETE: ما بتتكررش إلا على 502/503 عشان ما نكرّرش عملية.
  // ---------------------------------------------------------------------------
  var SERVER_CONFIG = {
    servers: [
      'https://maksib.up.railway.app',
      'https://70qgl61o0ymm-production-qr391fha.europe-west1.suga.run',
      'https://x9sdfeu0k9ld-production-4pbmlhys.us-central1.suga.run',
      'https://0qglaye1nauq-production-pckvh4ha.europe-west1.suga.run'// ← ضيف أي سيرفر إضافي هنا
    ],
    healthPath: '/healthy',
    healthTimeoutMs: 3000,          // أقصى انتظار لفحص /healthy
    requestTimeoutMs: 20000,        // أقصى انتظار لكل محاولة GET
    writeTimeoutMs: 60000,          // أقصى انتظار لطلبات POST/PUT/DELETE
    hedgeAfterMs: 2500,             // لو GET ما رجعش في المدة دي → جرّب سيرفر تاني بالتوازي
    cooldownMs: 30000,              // السيرفر الواقع بيتتجاهل المدة دي قبل ما نجربه تاني
    recheckIntervalMs: 30000,       // فحص دوري متوازي لكل السيرفرات في الخلفية
    stickyTtlMs: 15 * 60 * 1000,    // مدة تذكّر السيرفر المختار قبل إعادة السباق من الأول
    strategy: 'fastest',            // 'fastest' الأسرع · 'priority' بترتيب القائمة · 'random' عشوائي بين السليمين
    switchRatio: 0.6,               // (fastest) ما نبدّلش إلا لو الجديد أسرع بنسبة كبيرة (< 60% من زمن الحالي)
    switchMinGainMs: 150,           // …وبفارق ملحوظ بالمللي ثانية
    storageKey: 'maksib_active_server',
    logRequests: false,             // true = اطبع في الكونسول السيرفر المستخدم لكل طلب API
  };

  // ---------------------------------------------------------------------------
  // 0.1 Session token (Bearer) — يحل مشكلة "تسجيل الدخول مرتين"
  //
  //   الفرونت والسيرفرات دومينات مختلفة، فالمتصفح ممكن يحجب كوكي الجلسة. الحل: نحفظ
  //   الـ token اللي السيرفر بيرجّعه ونبعته في Authorization: Bearer مع كل طلب.
  //   نظافة الـ token:
  //     - بيتمسح لو شكله مش JWT صالح أو لو منتهي (حسب exp) قبل ما يتبعت.
  //     - بيتمسح عند 401 من أي طلب كان شايله (وبالأخص /api/auth/me).
  //     - بيتمسح محلياً أولاً عند تسجيل الخروج (حتى لو الشبكة وقعت).
  //     - تغييره في تاب تاني بيتزامن مع باقي التابات.
  // ---------------------------------------------------------------------------
  var TOKEN_KEY = 'maksib_token';
  var MAX_TOKEN_LENGTH = 4096;          // نفس حد السيرفر (request_token.js)
  var TOKEN_CLOCK_SKEW_MS = 30 * 1000;  // نعتبره منتهي قبل الميعاد بـ 30 ثانية

  function isWellFormedToken(token) {
    return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
  }

  /** يقرأ exp من الـ JWT (بالمللي ثانية) من غير التحقق من التوقيع. null لو مش موجود. */
  function tokenExpiryMs(token) {
    try {
      var part = String(token).split('.')[1];
      if (!part) return null;
      var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(atob(b64));
      return (payload && typeof payload.exp === 'number') ? payload.exp * 1000 : null;
    } catch (e) { return null; }
  }

  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage unavailable */ }
  }

  function setToken(token) {
    try {
      if (!token) { localStorage.removeItem(TOKEN_KEY); return; }
      if (!isWellFormedToken(token)) { console.warn('[auth] ignored malformed token'); return; }
      localStorage.setItem(TOKEN_KEY, String(token));
    } catch (e) { /* storage unavailable */ }
  }

  /** بيرجّع token صالح أو ''. التوكن التالف/المنتهي بيتمسح تلقائياً. */
  function getToken() {
    var token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    if (!token) return '';
    var exp = tokenExpiryMs(token);
    if (!isWellFormedToken(token) || (exp !== null && exp - TOKEN_CLOCK_SKEW_MS <= Date.now())) {
      clearToken();
      return '';
    }
    return token;
  }

  var ServerPool = (function () {
    var cfg = SERVER_CONFIG;
    var list = cfg.servers
      .filter(function (u) { return u && !/YOUR-/i.test(u); })
      .map(function (u) { return String(u).replace(/\/+$/, ''); })
      .filter(function (u, i, a) { return a.indexOf(u) === i; });
    if (!list.length) list = [String(cfg.servers[0]).replace(/\/+$/, '')];

    var stats = {};       // url -> { ms (متوسط متحرك), ok, at }
    var down = {};        // url -> timestamp لحد إمتى متجاهَل
    var active = null;
    var evaluating = null;
    var readyPromise = Promise.resolve();

    function now() { return Date.now(); }
    function isDown(u) { return (down[u] || 0) > now(); }
    function clock() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : now(); }

    function load() {
      try {
        var raw = JSON.parse(localStorage.getItem(cfg.storageKey) || 'null');
        if (raw && list.indexOf(raw.url) !== -1 && now() - raw.t < cfg.stickyTtlMs) return raw.url;
      } catch (e) { /* storage unavailable */ }
      return null;
    }
    function save(u) {
      try { localStorage.setItem(cfg.storageKey, JSON.stringify({ url: u, t: now() })); } catch (e) { /* ignore */ }
    }

    function setActive(u, reason) {
      if (u === active) return;
      var from = active;
      active = u;
      save(u);
      console.warn('[servers] switched ' + from + ' → ' + u + (reason ? ' (' + reason + ')' : ''));
      try { window.dispatchEvent(new CustomEvent('market:server_changed', { detail: { from: from, to: u, reason: reason } })); } catch (e) { /* ignore */ }
    }

    /** فحص /healthy واحد. بيرجّع { url, ok, ms } ولا بيرمي أبداً. */
    function probe(u) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.healthTimeoutMs) : null;
      var t0 = clock();
      return fetch(u + cfg.healthPath, { cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.ok ? r.json().catch(function () { return { status: 'ok' }; }) : null; })
        .then(function (d) { return !!d && (d.status === undefined || d.status === 'ok'); })
        .catch(function () { return false; })
        .then(function (ok) {
          if (timer) clearTimeout(timer);
          return { url: u, ok: ok, ms: Math.max(1, Math.round(clock() - t0)) };
        });
    }

    /** يسجّل نتيجة فحص: متوسط متحرك لزمن الاستجابة + حالة الـ cooldown. */
    function record(r) {
      var s = stats[r.url] || (stats[r.url] = { ms: null, ok: null, at: 0 });
      s.ok = r.ok;
      s.at = now();
      if (r.ok) {
        s.ms = s.ms === null ? r.ms : Math.round(s.ms * 0.5 + r.ms * 0.5);
        delete down[r.url];
      } else {
        down[r.url] = now() + cfg.cooldownMs;
      }
      return r;
    }

    /**
     * يفحص كل السيرفرات في نفس الوقت.
     *  first → أول نتيجة سليمة (= الأسرع) أو null لو كلهم واقعين.
     *  all   → كل النتائج بعد ما يخلصوا (أقصى انتظار = healthTimeoutMs).
     */
    function raceProbes(urls) {
      var all = urls.map(function (u) { return probe(u).then(record); });
      var first = new Promise(function (resolve) {
        var left = all.length;
        if (!left) return resolve(null);
        all.forEach(function (p) {
          p.then(function (r) {
            if (r.ok) resolve(r);
            else if (--left === 0) resolve(null);
          });
        });
      });
      return { first: first, all: Promise.all(all) };
    }

    function byKnownLatency(a, b) {
      if (cfg.strategy === 'priority') return list.indexOf(a) - list.indexOf(b);
      var ma = stats[a] && stats[a].ms, mb = stats[b] && stats[b].ms;
      if (ma == null && mb == null) return list.indexOf(a) - list.indexOf(b);
      if (ma == null) return 1;
      if (mb == null) return -1;
      return ma - mb;
    }

    /** يختار من النتائج السليمة حسب الاستراتيجية. */
    function pick(healthy) {
      if (!healthy.length) return null;
      if (cfg.strategy === 'random') return healthy[Math.floor(Math.random() * healthy.length)];
      return healthy.slice().sort(function (a, b) { return byKnownLatency(a.url, b.url); })[0];
    }

    /** أفضل بديل معروف (مش واقع) غير `from`. null لو مفيش. */
    function bestKnownAlternative(from) {
      var c = list.filter(function (u) { return u !== from && !isDown(u); });
      if (!c.length) return null;
      c.sort(byKnownLatency);
      return c[0];
    }

    /** ترتيب المحاولات: الحالي أولاً، ثم السليمين الأسرع، ثم الواقعين كآخر حل. */
    function order() {
      var others = list.filter(function (u) { return u !== active; });
      return [active].concat(
        others.filter(function (u) { return !isDown(u); }).sort(byKnownLatency),
        others.filter(isDown)
      );
    }

    /** سجّل إن السيرفر ده وقع، وحوّل فوراً لأفضل بديل معروف ثم تأكد منه بفحص متوازي. */
    function reportFailure(u, reason) {
      down[u] = now() + cfg.cooldownMs;
      if (u !== active) return;
      var nxt = bestKnownAlternative(u);
      if (nxt) { setActive(nxt, reason || 'failure'); evaluate(); }
    }

    function noteSuccess(u) { delete down[u]; }

    /** فحص متوازي لكل السيرفرات، ثم تحويل لو لازم (الحالي واقع / فيه أسرع بفارق واضح). */
    function evaluate() {
      if (list.length < 2) return Promise.resolve(active);
      if (evaluating) return evaluating;
      var urls = list.filter(function (u) { return u === active || !isDown(u); });
      evaluating = raceProbes(urls).all.then(function (results) {
        evaluating = null;
        var healthy = results.filter(function (r) { return r.ok; });
        var best = pick(healthy);
        if (!best) return active; // الكل واقع: ابقى مكانك وجرّب لاحقاً
        var cur = results.filter(function (r) { return r.url === active; })[0];
        if (!cur || !cur.ok) { setActive(best.url, 'health-check'); return active; }
        if (best.url === active) return active;

        var better = false;
        if (cfg.strategy === 'priority') {
          better = list.indexOf(best.url) < list.indexOf(active);
        } else if (cfg.strategy === 'fastest') {
          var sa = stats[active].ms, sb = stats[best.url].ms;
          better = sb < sa * cfg.switchRatio && (sa - sb) >= cfg.switchMinGainMs;
        }
        if (better) setActive(best.url, cfg.strategy === 'priority' ? 'higher-priority' : 'faster');
        return active;
      }, function () { evaluating = null; return active; });
      return evaluating;
    }

    // ---- الاختيار الأولي ----
    var sticky = load();
    if (sticky) {
      active = sticky;                                // نبدأ فوراً بدون انتظار، ونتأكد في الخلفية
      if (list.length > 1) setTimeout(evaluate, 0);
    } else {
      active = list[0];
      if (list.length > 1) {
        var race = raceProbes(list);
        var decided = cfg.strategy === 'fastest'
          ? race.first                                // أول سيرفر سليم يرد = الأسرع
          : race.all.then(function (rs) { return pick(rs.filter(function (r) { return r.ok; })); });
        readyPromise = decided.then(function (r) {
          if (r) { setActive(r.url, 'startup'); save(r.url); }
        }).catch(function () { /* ابقى على الافتراضي */ });
      }
    }

    // فحص دوري + عند رجوع التاب/الإنترنت
    if (list.length > 1) {
      setInterval(function () { if (!document.hidden) evaluate(); }, cfg.recheckIntervalMs);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) evaluate(); });
      window.addEventListener('online', function () { down = {}; evaluate(); });
    }

    return {
      list: list,
      current: function () { return active; },
      ready: function () { return readyPromise; },
      order: order,
      hasAlternative: function () { return bestKnownAlternative(active) !== null; },
      reportFailure: reportFailure,
      noteSuccess: noteSuccess,
      evaluate: evaluate,
      verify: evaluate,
      /** للاختبار من الـ Console: await App.servers.status() — بيفحص الكل بالتوازي. */
      status: function () {
        return raceProbes(list).all.then(function (rs) {
          return rs.map(function (r) {
            return { url: r.url, healthy: r.ok, ms: r.ms, avg_ms: stats[r.url].ms, active: r.url === active, cooling_down: isDown(r.url) };
          });
        });
      },
    };
  })();

  /** يحوّل مسار مثل /api/xxx إلى رابط كامل على السيرفر الحالي. الروابط الكاملة (http/https) تبقى كما هي. */
  function apiUrl(path) {
    path = String(path || '');
    if (/^https?:\/\//i.test(path)) return path;
    return ServerPool.current() + (path.charAt(0) === '/' ? path : '/' + path);
  }

  /** يطبع في الكونسول السيرفر الشغال حالياً. */
  function logActiveServer(reason) {
    var cur = ServerPool.current();
    var idx = ServerPool.list.indexOf(cur) + 1;
    console.log(
      '%c[servers]%c السيرفر الحالي: %c' + cur + '%c  (#' + idx + ' من ' + ServerPool.list.length + ')' +
      (reason ? '  — ' + reason : ''),
      'background:#111;color:#fff;padding:2px 6px;border-radius:3px;',
      'color:inherit;',
      'color:#16a34a;font-weight:bold;',
      'color:#6b7280;'
    );
  }

  window.addEventListener('market:server_changed', function (e) {
    var d = (e && e.detail) || {};
    logActiveServer('تم التبديل من ' + d.from + ' بسبب: ' + (d.reason || 'غير معروف'));
  });

  var RETRY_STATUSES = { 502: true, 503: true, 504: true };

  /**
   * محاولة واحدة على سيرفر واحد مع timeout وإمكانية الإلغاء.
   * callerAborted = الإلغاء جه من صاحب الطلب (مش timeout ولا إلغاء داخلي).
   */
  function startAttempt(base, fullPath, config, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = { base: base, callerAborted: false, promise: null, abort: function () { if (ctrl) ctrl.abort(); } };
    var timer = null;
    var outer = config.signal;

    if (ctrl && outer) {
      if (outer.aborted) { t.callerAborted = true; ctrl.abort(); }
      else outer.addEventListener('abort', function () { t.callerAborted = true; ctrl.abort(); }, { once: true });
    }
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    if (SERVER_CONFIG.logRequests) console.debug('[api]', String(config.method || 'GET').toUpperCase(), base + fullPath);

    var init = ctrl ? Object.assign({}, config, { signal: ctrl.signal }) : config;
    t.promise = fetch(base + fullPath, init).then(
      function (res) { if (timer) clearTimeout(timer); return res; },
      function (err) { if (timer) clearTimeout(timer); throw err; }
    );
    return t;
  }

  function discardBody(res) {
    try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel(); } catch (e) { /* ignore */ }
  }

  /**
   * GET/HEAD: "hedged request" — لو السيرفر الحالي وقع/رد 502-504 نكمل على اللي بعده فوراً،
   * ولو اتأخر (hedgeAfterMs) نبعت للتاني بالتوازي. أول رد سليم يكسب والباقي يتلغي.
   */
  function hedgedRequest(fullPath, config) {
    return new Promise(function (resolve, reject) {
      var candidates = ServerPool.order();
      var tries = [], idx = 0, pending = 0, settled = false;
      var hedgeTimer = null, lastRes = null, lastResTry = null, lastErr = null;

      function settle(winner, fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(hedgeTimer);
        tries.forEach(function (t) { if (t !== winner) t.abort(); });
        fn(value);
      }

      function advance() {
        if (settled || pending > 0) return;
        if (launch()) return;
        if (lastRes) settle(lastResTry, resolve, lastRes);
        else settle(null, reject, lastErr || new Error('network'));
      }

      function launch() {
        if (idx >= candidates.length) return false;
        var t = startAttempt(candidates[idx++], fullPath, config, SERVER_CONFIG.requestTimeoutMs);
        tries.push(t);
        pending++;

        t.promise.then(function (res) {
          pending--;
          if (settled) { discardBody(res); return; }
          if (RETRY_STATUSES[res.status]) {
            ServerPool.reportFailure(t.base, 'http-' + res.status);
            discardBody(lastRes);
            lastRes = res; lastResTry = t;
            advance();
          } else {
            ServerPool.noteSuccess(t.base);
            if (t.base !== ServerPool.current()) ServerPool.evaluate();
            settle(t, resolve, res);
          }
        }, function (err) {
          pending--;
          if (settled) return;
          if (t.callerAborted) { settle(null, reject, err); return; }
          lastErr = err;
          ServerPool.reportFailure(t.base, err && err.name === 'AbortError' ? 'timeout' : 'network');
          advance();
        });

        clearTimeout(hedgeTimer);
        if (idx < candidates.length) {
          hedgeTimer = setTimeout(function () { if (!settled) launch(); }, SERVER_CONFIG.hedgeAfterMs);
        }
        return true;
      }

      launch();
    });
  }

  /**
   * POST/PUT/DELETE: بنجرّب السيرفر التاني فقط لو الرد 502/503 (الطلب ماوصلش للتطبيق)،
   * عشان ما نكرّرش عملية اتنفذت فعلاً (زي إنشاء طلب شراء مرتين).
   * لو اتقطع الاتصال/timeout بنحوّل للسيرفر التاني للطلب الجاي بس.
   */
  async function sendWrite(fullPath, config) {
    var candidates = ServerPool.order();
    var lastRes = null;
    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var t = startAttempt(base, fullPath, config, SERVER_CONFIG.writeTimeoutMs);
      var res;
      try {
        res = await t.promise;
      } catch (err) {
        var timedOut = !!err && err.name === 'AbortError' && !t.callerAborted;
        if (!t.callerAborted && !timedOut) ServerPool.reportFailure(base, 'network');
        throw err;
      }
      if (res.status !== 502 && res.status !== 503) { ServerPool.noteSuccess(base); return res; }
      ServerPool.reportFailure(base, 'http-' + res.status);
      discardBody(lastRes);
      lastRes = res;
    }
    return lastRes;
  }

  async function fetchWithFailover(path, config) {
    path = String(path || '');
    config = config || {};
    if (/^https?:\/\//i.test(path)) return fetch(path, config);

    var method = String(config.method || 'GET').toUpperCase();
    var fullPath = path.charAt(0) === '/' ? path : '/' + path;
    await ServerPool.ready(); // أول زيارة فقط: انتظار أسرع سيرفر سليم (محدود بـ healthTimeoutMs)
    return (method === 'GET' || method === 'HEAD') ? hedgedRequest(fullPath, config) : sendWrite(fullPath, config);
  }

  var FALLBACK_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">' +
    '<rect width="500" height="500" fill="#F3F4F6"/>' +
    '<g fill="none" stroke="#9CA3AF" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="150" y="170" width="200" height="160" rx="14"/><circle cx="215" cy="228" r="16"/>' +
    '<path d="M160 320l60-60 45 45 30-30 45 45"/></g></svg>'
  );

  // ---------------------------------------------------------------------------
  // 1. Utilities
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /** 16650 -> "16,650 ج.م" · 99.5 -> "99.50 ج.م" (Western digits, like Amazon Egypt). */
  function formatPrice(amount) {
    var num = Number(amount) || 0;
    var hasFraction = Math.round(num * 100) % 100 !== 0;
    return num.toLocaleString('en-US', {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    }) + ' ج.م';
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  function imgFallback(img) {
    if (img && img.src !== FALLBACK_IMG) { img.onerror = null; img.src = FALLBACK_IMG; }
  }

  // ---------------------------------------------------------------------------
  // 2. Toasts (uses #toast-region + .toast.<type>.show from style.css)
  // ---------------------------------------------------------------------------
  var TOAST_ICONS = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
  };
  var TOAST_TITLES = { success: 'تم بنجاح', error: 'تنبيه', warning: 'انتبه', info: 'إشعار' };
  var MAX_TOASTS = 4;

  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    if (type === 'danger') type = 'error';
    if (type === 'primary') type = 'info';
    if (!TOAST_ICONS[type]) type = 'info';

    var region = document.getElementById('toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    while (region.children.length >= MAX_TOASTS) region.removeChild(region.firstChild);

    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML =
      '<span class="toast-icon-wrap"><i class="fa-solid ' + TOAST_ICONS[type] + '"></i></span>' +
      '<div class="toast-content">' +
        '<div class="toast-title">' + TOAST_TITLES[type] + '</div>' +
        '<div class="toast-message">' + escapeHtml(message) + '</div>' +
      '</div>' +
      '<button type="button" class="toast-close-btn" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>';
    region.appendChild(toast);

    function dismiss() {
      toast.classList.remove('show');
      toast.classList.add('removing');
      setTimeout(function () { toast.remove(); }, 260);
    }
    toast.querySelector('.toast-close-btn').addEventListener('click', dismiss);
    requestAnimationFrame(function () { requestAnimationFrame(function () { toast.classList.add('show'); }); });
    setTimeout(dismiss, duration);
  }

  // ---------------------------------------------------------------------------
  // 3. API wrapper
  // ---------------------------------------------------------------------------
  var AUTH_ISSUING_PATH = /\/api\/auth\//;
  var AUTH_NON_ISSUING_PATH = /\/api\/auth\/(me|log_out)(\?|$|\/)/;

  async function fetchAPI(url, options) {
    options = options || {};
    url = String(url || '');
    var internal = !/^https?:\/\//i.test(url);
    var headers = {};
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

    // Bearer fallback: يتبعت مع كل طلب لسيرفراتنا فقط (مش للروابط الخارجية)
    var token = internal ? getToken() : '';
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var config = Object.assign({ credentials: 'include' }, options, {
      headers: Object.assign(headers, options.headers || {}),
    });

    try {
      var response = await fetchWithFailover(url, config);
      var data = await response.json().catch(function () { return {}; });
      if (!data || typeof data !== 'object') data = {};

      // سجّل/حدّث الـ token لو السيرفر رجّعه (login / register)
      var issued = (typeof data.token === 'string' && data.token) ||
                   (data.data && typeof data.data.token === 'string' && data.data.token) || '';
      if (response.ok && issued && AUTH_ISSUING_PATH.test(url) && !AUTH_NON_ISSUING_PATH.test(url)) {
        setToken(issued);
      }

      // 401 على طلب كان شايل token (وأي endpoint، مش /me بس) → التوكن مرفوض: امسحه عشان ما يتبعتش تاني.
      // الشرط getToken() === token بيمنع مسح token جديد اتسجّل أثناء الطلب.
      if (response.status === 401 && token && getToken() === token) {
        clearToken();
        auth.invalidate();
        try { window.dispatchEvent(new CustomEvent('market:session_expired')); } catch (e) { /* ignore */ }
      }

      if (!response.ok) {
        var msg = data.message || 'حدث خطأ في معالجة الطلب';
        if (response.status === 429) msg = 'لقد تجاوزت الحد المسموح من الطلبات. يرجى الانتظار والمحاولة لاحقاً.';
        else if (response.status === 401 && url.indexOf('/api/auth/me') === -1) msg = data.message || 'يرجى تسجيل الدخول أولاً للمتابعة';
        else if (response.status === 403) msg = 'ليس لديك الصلاحية الكافية للقيام بهذا الإجراء';
        return { ok: false, status: response.status, message: msg, data: data.data || null };
      }
      return { ok: true, status: response.status, data: data.data !== undefined ? data.data : (issued ? data : undefined), message: data.message, pagination: data.pagination, raw: data };
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, status: 0, aborted: true, message: 'تم إلغاء الطلب' };
      return { ok: false, status: 0, message: 'تعذر الاتصال بالخادم. يرجى التحقق من اتصالك بالإنترنت.' };
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Auth
  // ---------------------------------------------------------------------------

  /**
   * تسجيل الخروج على كل السيرفرات بالتوازي (best-effort، أقصى انتظار ~4 ثواني).
   * ضروري لأن الكوكي مربوطة بدومين كل سيرفر: لو المستخدم اتحوّل بين سيرفرين، log_out على
   * السيرفر الحالي بس كان هيسيب كوكي صالحة على التاني.
   */
  function logoutEverywhere(token) {
    var headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    return Promise.all(ServerPool.list.map(function (base) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
      return fetch(base + '/api/auth/log_out', {
        method: 'POST', credentials: 'include', headers: headers, signal: ctrl ? ctrl.signal : undefined,
      }).then(function (r) { return r.ok; }, function () { return false; })
        .then(function (ok) { if (timer) clearTimeout(timer); return ok; });
    }));
  }

  var auth = {
    currentUser: null,
    networkError: false,
    _pending: null,
    _loggingOut: false,

    /** Resolves the signed-in user or null. One network call per page load (يعيد المحاولة بعد فشل الشبكة). */
    me: function (force) {
      var self = this;
      if (force) self._pending = null;
      if (!self._pending) {
        self._pending = fetchAPI('/api/auth/me').then(function (res) {
          // فشل شبكة/سيرفر ≠ "غير مسجّل": ما نكاشش النتيجة ونسيب المحاولة الجاية تعيد الفحص
          self.networkError = !res.ok && (res.status === 0 || res.status >= 500);
          if (self.networkError) { self._pending = null; self.currentUser = null; return null; }
          self.currentUser = (res.ok && res.raw && res.raw.authenticated && res.raw.user) ? res.raw.user : null;
          return self.currentUser;
        });
      }
      return self._pending;
    },

    /** يمسح الحالة المخزنة محلياً (بعد 401 / تسجيل خروج / تغيير التوكن من تاب تاني). */
    invalidate: function () {
      this.currentUser = null;
      this._pending = null;
      this.networkError = false;
    },

    async logout() {
      if (this._loggingOut) return;
      this._loggingOut = true;
      // 1) امسح التوكن محلياً الأول: حتى لو الشبكة وقعت المستخدم يطلع فعلاً من جهته
      var token = getToken();
      clearToken();
      this.invalidate();
      // 2) اطلب من كل السيرفرات تمسح الكوكي (والتوكن بيتبعت صراحةً عشان السيرفر يعرف مين اللي بيخرج)
      await logoutEverywhere(token);
      showToast('تم تسجيل الخروج بنجاح', 'success');
      setTimeout(function () { window.location.href = '/login.html'; }, 600);
    },

    async requireAuth(allowedRoles) {
      allowedRoles = allowedRoles || [];
      var user = await this.me();
      if (!user) {
        if (this.networkError) {
          showToast('تعذر التحقق من حسابك الآن. تأكد من اتصالك بالإنترنت وأعد تحميل الصفحة.', 'error');
          return null;
        }
        showToast('يرجى تسجيل الدخول أولاً للوصول لهذه الصفحة', 'warning');
        setTimeout(function () {
          window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
        }, 800);
        return null;
      }
      if (allowedRoles.length > 0 && allowedRoles.indexOf(user.role) === -1) {
        showToast('غير مصرح لك بالدخول لهذه الصفحة', 'error');
        setTimeout(function () { window.location.href = '/'; }, 1000);
        return null;
      }
      return user;
    },
  };

  // مزامنة الجلسة بين التابات: تسجيل خروج/دخول في تاب بيتعكس في الباقي
  window.addEventListener('storage', function (e) {
    if (e.key !== TOKEN_KEY && e.key !== null) return;
    var hadUser = !!auth.currentUser;
    auth.invalidate();
    try { window.dispatchEvent(new CustomEvent('market:auth_changed')); } catch (err) { /* ignore */ }
    if (hadUser && !auth._loggingOut) window.location.reload();
  });

  // ---------------------------------------------------------------------------
  // 5. Cart (localStorage, with safe fallbacks)
  // ---------------------------------------------------------------------------
  var cart = {
    KEY: 'more_stores_cart',

    get: function () {
      try {
        var parsed = JSON.parse(localStorage.getItem(this.KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) { return []; }
    },

    save: function (items) {
      try { localStorage.setItem(this.KEY, JSON.stringify(items)); } catch (e) { /* storage unavailable */ }
      this.updateBadges();
      window.dispatchEvent(new CustomEvent('market:cart_updated', { detail: items }));
    },

    add: function (product, quantity) {
      quantity = Math.max(1, parseInt(quantity, 10) || 1);
      var items = this.get();
      var id = product._id || product.id;
      var existing = items.find(function (item) { return item.id === id; });

      if (existing) {
        existing.quantity = (existing.quantity || 0) + quantity;
      } else {
        items.push({
          id: id,
          name: product.name,
          price: product.price,
          final_price: product.final_price !== undefined ? product.final_price : product.price,
          discount: product.discount || 0,
          image: (Array.isArray(product.images) && product.images[0]) ? product.images[0] : (product.image || FALLBACK_IMG),
          section_name: (product.section && product.section.name) || 'عام',
          quantity: quantity,
        });
      }
      this.save(items);
      showToast('تمت إضافة "' + product.name + '" إلى السلة', 'success');
    },

    update: function (id, quantity) {
      quantity = parseInt(quantity, 10) || 0;
      var items = this.get();
      if (quantity <= 0) {
        items = items.filter(function (item) { return item.id !== id; });
      } else {
        var item = items.find(function (i) { return i.id === id; });
        if (item) item.quantity = quantity;
      }
      this.save(items);
    },

    remove: function (id) {
      this.save(this.get().filter(function (item) { return item.id !== id; }));
      showToast('تم حذف المنتج من السلة', 'info');
    },

    clear: function () {
      try { localStorage.removeItem(this.KEY); } catch (e) { /* ignore */ }
      this.updateBadges();
      window.dispatchEvent(new CustomEvent('market:cart_updated', { detail: [] }));
    },

    count: function () {
      return this.get().reduce(function (sum, item) { return sum + (item.quantity || 1); }, 0);
    },

    total: function () {
      return this.get().reduce(function (sum, item) {
        var p = item.final_price !== undefined ? item.final_price : item.price;
        return sum + (Number(p) || 0) * (item.quantity || 1);
      }, 0);
    },

    updateBadges: function () {
      var count = this.count();
      document.querySelectorAll('.cart-badge-count').forEach(function (el) {
        el.textContent = count > 99 ? '99+' : count;
        el.style.display = count > 0 ? 'inline-flex' : 'none';
      });
    },
  };

  // ---------------------------------------------------------------------------
  // 6. Shared site shell: header, drawer, footer
  // ---------------------------------------------------------------------------
  var BRAND = 'سوق المكسب';

  function headerTemplate() {
    return '' +
    '<div class="drawer-backdrop" id="drawer-backdrop">' +
      '<aside class="sidebar-drawer" role="dialog" aria-label="القائمة الرئيسية">' +
        '<div class="drawer-header">' +
          '<div class="drawer-user-info" id="drawer-user-greeting">' +
            '<i class="fa-solid fa-circle-user"></i><span>أهلاً بك، تسجيل الدخول</span>' +
          '</div>' +
          '<button type="button" class="drawer-close-btn" data-drawer-close aria-label="إغلاق القائمة"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="drawer-body">' +
          '<div class="drawer-section">' +
            '<div class="drawer-section-title">تسوق حسب القسم</div>' +
            '<div id="drawer-categories-list"></div>' +
          '</div>' +
          '<div class="drawer-section">' +
            '<div class="drawer-section-title">حسابي</div>' +
            '<a href="/profile.html" class="drawer-link-item"><span>حسابي الشخصي</span><i class="fa-solid fa-angle-left"></i></a>' +
            '<a href="/orders.html" class="drawer-link-item"><span>مشترياتي وطلباتي</span><i class="fa-solid fa-angle-left"></i></a>' +
            '<a href="/cart.html" class="drawer-link-item"><span>سلة المشتريات</span><i class="fa-solid fa-angle-left"></i></a>' +
            '<div id="drawer-auth-actions" style="margin-top:10px;"></div>' +
          '</div>' +
        '</div>' +
      '</aside>' +
    '</div>' +

    '<header class="site-header">' +
      '<div class="header-top"><div class="container">' +
        '<a href="/" class="header-brand" aria-label="' + BRAND + ' - الصفحة الرئيسية">' +
          '<i class="fa-solid fa-boxes-packing brand-badge"></i><span>' + BRAND + '</span>' +
        '</a>' +
        '<a href="/profile.html" class="header-deliver-to">' +
          '<i class="fa-solid fa-location-dot"></i>' +
          '<div><span class="sub-text">التوصيل إلى</span><span class="main-text" id="header-location-text">كل المدن</span></div>' +
        '</a>' +
        '<div class="header-search">' +
          '<form class="header-search-form" id="global-search-form" role="search">' +
            '<div class="search-category-select"><select id="header-search-category" aria-label="اختر القسم"><option value="">جميع الأقسام</option></select></div>' +
            '<div class="search-input-wrap"><input type="search" id="header-search-input" placeholder="ابحث في آلاف السلع المكسبة..." autocomplete="off" aria-label="بحث"></div>' +
            '<button type="submit" class="search-submit-btn" aria-label="بحث"><i class="fa-solid fa-magnifying-glass"></i></button>' +
          '</form>' +
        '</div>' +
        '<div class="header-actions">' +
          '<div class="header-account-wrap" id="header-account-container">' +
            '<a href="/login.html" class="header-nav-item" id="header-account-link">' +
              '<span class="sub-label">مرحباً، سجّل الدخول</span>' +
              '<span class="main-label">الحساب والقوائم <i class="fa-solid fa-caret-down"></i></span>' +
            '</a>' +
            '<div class="account-flyout">' +
              '<div class="flyout-auth-header" id="flyout-top-action">' +
                '<a href="/login.html" class="button btn-accent btn-sm">تسجيل الدخول</a>' +
                '<p class="flyout-signup-prompt">مستخدم جديد؟ <a href="/register.html">ابدأ من هنا</a></p>' +
              '</div>' +
              '<div class="flyout-col" id="flyout-menu-links">' +
                '<h4>حسابك</h4>' +
                '<a href="/profile.html"><i class="fa-regular fa-user"></i> إدارة الحساب</a>' +
                '<a href="/orders.html"><i class="fa-solid fa-clock-rotate-left"></i> سجل طلباتي</a>' +
                '<a href="/cart.html"><i class="fa-solid fa-cart-shopping"></i> سلة المشتريات</a>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<a href="/orders.html" class="header-nav-item"><span class="sub-label">الإرجاع</span><span class="main-label">والطلبات</span></a>' +
          '<a href="/cart.html" class="header-nav-item header-cart-link" aria-label="سلة المشتريات">' +
            '<div class="cart-icon-wrap"><i class="fa-solid fa-cart-shopping"></i><span class="cart-count-badge cart-badge-count" style="display:none;">0</span></div>' +
            '<span class="main-label cart-label">السلة</span>' +
          '</a>' +
        '</div>' +
      '</div></div>' +

      '<div class="mobile-header-top">' +
        '<button type="button" class="subnav-all-btn" data-drawer-open aria-label="فتح القائمة" style="padding:4px;"><i class="fa-solid fa-bars" style="font-size:20px;"></i></button>' +
        '<a href="/" class="header-brand"><i class="fa-solid fa-boxes-packing brand-badge"></i><span>' + BRAND + '</span></a>' +
        '<div style="display:flex;align-items:center;gap:14px;">' +
          '<a href="/orders.html" style="color:#fff;" aria-label="طلباتي"><i class="fa-solid fa-clock-rotate-left" style="font-size:18px;"></i></a>' +
          '<a href="/cart.html" style="color:#fff;" class="cart-icon-wrap" aria-label="سلة المشتريات"><i class="fa-solid fa-cart-shopping" style="font-size:20px;"></i><span class="cart-count-badge cart-badge-count" style="display:none;">0</span></a>' +
        '</div>' +
      '</div>' +
      '<div class="mobile-header-search">' +
        '<form class="header-search-form" id="mobile-search-form" role="search">' +
          '<div class="search-input-wrap"><input type="search" id="mobile-search-input" placeholder="ابحث في ' + BRAND + '..." aria-label="بحث"></div>' +
          '<button type="submit" class="search-submit-btn" aria-label="بحث"><i class="fa-solid fa-magnifying-glass"></i></button>' +
        '</form>' +
      '</div>' +

      '<nav class="header-subnav" aria-label="الأقسام"><div class="container">' +
        '<button type="button" class="subnav-all-btn" data-drawer-open><i class="fa-solid fa-bars"></i><span>الكل</span></button>' +
        '<div class="subnav-links">' +
          '<a href="/products.html" class="subnav-link" data-subnav-all>كل المعروضات</a>' +
          '<div id="subnav-dynamic-categories" style="display:contents;"></div>' +
        '</div>' +
        '<div class="subnav-promo"><i class="fa-solid fa-bolt"></i><span>كل السلع تُفحص قبل النشر</span></div>' +
      '</div></nav>' +
    '</header>';
  }

  function footerTemplate() {
    return '' +
    '<footer class="site-footer">' +
      '<button type="button" class="footer-back-to-top" data-back-to-top>الرجوع إلى أعلى الصفحة</button>' +
      '<div class="footer-main"><div class="container footer-grid">' +
        '<div class="footer-col"><h4>تسوق</h4><ul class="footer-links-list">' +
          '<li><a href="/products.html">كل المعروضات</a></li>' +
          '<li><a href="/cart.html">سلة المشتريات</a></li>' +
          '<li><a href="/orders.html">تتبع طلباتك</a></li>' +
        '</ul></div>' +
        '<div class="footer-col"><h4>البيع على المنصة</h4><ul class="footer-links-list">' +
          '<li><a href="/register.html">أنشئ حساباً</a></li>' +
          '<li><a href="/profile.html">اطلب أن تصبح بائعاً</a></li>' +
          '<li><a href="/seller-dashboard.html">لوحة البائع</a></li>' +
        '</ul></div>' +
        '<div class="footer-col"><h4>الشراء والضمان</h4><ul class="footer-links-list">' +
          '<li><a href="/products.html">سلع مفحوصة ومعتمدة</a></li>' +
          '<li><a href="/cart.html">كوبونات الخصم</a></li>' +
          '<li><a href="/orders.html">المعاينة قبل الاستلام</a></li>' +
        '</ul></div>' +
        '<div class="footer-col"><h4>خدمة العملاء</h4><ul class="footer-links-list">' +
          '<li><a href="/profile.html">حسابك الشخصي</a></li>' +
          '<li><a href="/orders.html">طلباتك الحالية</a></li>' +
          '<li><a href="/login.html">تسجيل الدخول</a></li>' +
        '</ul></div>' +
      '</div></div>' +
      '<div class="footer-brand-strip"><div class="container">' +
        '<a href="/" class="footer-logo"><i class="fa-solid fa-boxes-packing"></i> ' + BRAND + '</a>' +
        '<p class="footer-copyright">&copy; ' + new Date().getFullYear() + ' ' + BRAND + '. جميع الحقوق محفوظة.</p>' +
      '</div></div>' +
    '</footer>';
  }

  var shell = {
    sections: null,

    toggleDrawer: function (open) {
      var backdrop = document.getElementById('drawer-backdrop');
      if (!backdrop) return;
      backdrop.classList.toggle('is-open', !!open);
      document.body.style.overflow = open ? 'hidden' : '';
    },

    render: function () {
      var headerHost = document.querySelector('[data-site-header]');
      var footerHost = document.querySelector('[data-site-footer]');
      if (headerHost) headerHost.outerHTML = headerTemplate();
      if (footerHost) footerHost.outerHTML = footerTemplate();
      if (!headerHost && !footerHost) return;

      var self = this;
      // مستمع واحد (event delegation) لكل أزرار الهيدر/الدروار/الفوتر، بما فيها تسجيل الخروج
      document.addEventListener('click', function (e) {
        if (e.target.closest('[data-logout]')) auth.logout();
        else if (e.target.closest('[data-drawer-open]')) self.toggleDrawer(true);
        else if (e.target.closest('[data-drawer-close]')) self.toggleDrawer(false);
        else if (e.target.id === 'drawer-backdrop') self.toggleDrawer(false);
        else if (e.target.closest('[data-back-to-top]')) window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (e.target.closest('#drawer-categories-list a')) self.toggleDrawer(false);
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') self.toggleDrawer(false); });

      ['global-search-form', 'mobile-search-form'].forEach(function (id) {
        var form = document.getElementById(id);
        if (form) form.addEventListener('submit', function (e) { e.preventDefault(); self.search(); });
      });

      var params = new URLSearchParams(window.location.search);
      var q = params.get('search') || '';
      ['header-search-input', 'mobile-search-input'].forEach(function (id) {
        var input = document.getElementById(id);
        if (input && q) input.value = q;
      });

      this.markActiveNav();
      this.loadSections();
      this.applyUser();
    },

    search: function () {
      var catEl = document.getElementById('header-search-category');
      var desktop = document.getElementById('header-search-input');
      var mobile = document.getElementById('mobile-search-input');
      var q = ((desktop && desktop.value) || (mobile && mobile.value) || '').trim();
      var cat = catEl ? catEl.value : '';
      var qs = new URLSearchParams();
      if (q) qs.set('search', q);
      if (cat) qs.set('section', cat);
      var str = qs.toString();
      window.location.href = '/products.html' + (str ? '?' + str : '');
    },

    markActiveNav: function () {
      var onProducts = window.location.pathname.indexOf('products.html') !== -1;
      var section = new URLSearchParams(window.location.search).get('section');
      var all = document.querySelector('[data-subnav-all]');
      if (all && onProducts && !section) all.classList.add('is-active');
    },

    loadSections: async function () {
      var res = await fetchAPI('/api/get_all_sections');
      var list = (res.ok && Array.isArray(res.data)) ? res.data : [];
      this.sections = list;
      window.dispatchEvent(new CustomEvent('market:sections_loaded', { detail: list }));

      var select = document.getElementById('header-search-category');
      var subnav = document.getElementById('subnav-dynamic-categories');
      var drawer = document.getElementById('drawer-categories-list');
      var current = new URLSearchParams(window.location.search).get('section') || '';

      if (select) {
        select.innerHTML = '<option value="">جميع الأقسام</option>' + list.map(function (sec) {
          return '<option value="' + escapeHtml(sec.name) + '"' + (sec.name === current ? ' selected' : '') + '>' + escapeHtml(sec.name) + '</option>';
        }).join('');
      }
      if (subnav) {
        subnav.innerHTML = list.map(function (sec) {
          return '<a href="/products.html?section=' + encodeURIComponent(sec.name) + '" class="subnav-link' + (sec.name === current ? ' is-active' : '') + '">' + escapeHtml(sec.name) + '</a>';
        }).join('');
      }
      if (drawer) {
        var emptyMsg = res.ok ? 'لا توجد أقسام بعد' : 'تعذر تحميل الأقسام';
        drawer.innerHTML = list.map(function (sec) {
          return '<a href="/products.html?section=' + encodeURIComponent(sec.name) + '" class="drawer-link-item"><span>' + escapeHtml(sec.name) + '</span><i class="fa-solid fa-angle-left"></i></a>';
        }).join('') || '<div class="drawer-link-item" style="color:var(--text-secondary);">' + emptyMsg + '</div>';
      }
    },

    applyUser: async function () {
      var user = await auth.me();
      if (!user) return;

      var firstName = user.name ? String(user.name).split(' ')[0] : 'عزيزنا';
      var roleLabel = user.role === 'seller' ? 'بائع معتمد' : (user.role === 'super_admin' ? 'المدير العام' : 'مشتري');
      var roleClass = user.role === 'seller' ? 'badge-certified' : (user.role === 'super_admin' ? 'badge-best-seller' : 'badge-neutral');

      var link = document.getElementById('header-account-link');
      if (link) {
        link.setAttribute('href', '/profile.html');
        link.innerHTML = '<span class="sub-label">مرحباً، ' + escapeHtml(firstName) + '</span>' +
          '<span class="main-label">الحساب والقوائم <i class="fa-solid fa-caret-down"></i></span>';
      }
      var greet = document.getElementById('drawer-user-greeting');
      if (greet) greet.innerHTML = '<i class="fa-solid fa-circle-user"></i><span>أهلاً، ' + escapeHtml(user.name) + '</span>';

      var top = document.getElementById('flyout-top-action');
      if (top) {
        top.innerHTML = '<div style="font-weight:700;font-size:14px;margin-bottom:4px;">' + escapeHtml(user.name) + '</div>' +
          '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">' + escapeHtml(user.email) + '</div>' +
          '<span class="badge ' + roleClass + '">' + roleLabel + '</span>';
      }

      var extraLinks = [];
      if (user.role === 'seller') extraLinks.push({ href: '/seller-dashboard.html', icon: 'fa-store', label: 'لوحة البائع' });
      if (user.role === 'super_admin') extraLinks.push({ href: '/admin-dashboard.html', icon: 'fa-gear', label: 'لوحة المدير العام' });

      var menu = document.getElementById('flyout-menu-links');
      if (menu) {
        menu.innerHTML = '<h4>حسابك</h4>' +
          '<a href="/profile.html"><i class="fa-regular fa-user"></i> إدارة الحساب</a>' +
          '<a href="/orders.html"><i class="fa-solid fa-clock-rotate-left"></i> سجل طلباتي</a>' +
          '<a href="/cart.html"><i class="fa-solid fa-cart-shopping"></i> سلة المشتريات</a>' +
          extraLinks.map(function (l) { return '<a href="' + l.href + '"><i class="fa-solid ' + l.icon + '"></i> ' + l.label + '</a>'; }).join('') +
          '<button type="button" class="flyout-logout-btn" data-logout><i class="fa-solid fa-arrow-right-from-bracket"></i> تسجيل الخروج</button>';
      }
      var drawerAuth = document.getElementById('drawer-auth-actions');
      if (drawerAuth) {
        drawerAuth.innerHTML =
          extraLinks.map(function (l) {
            return '<a href="' + l.href + '" class="drawer-link-item"><span>' + l.label + '</span><i class="fa-solid fa-angle-left"></i></a>';
          }).join('') +
          '<button type="button" class="button btn-danger btn-block btn-sm" data-logout style="margin-top:10px;">تسجيل الخروج</button>';
      }
      var loc = document.getElementById('header-location-text');
      if (loc && user.GPS_URL) loc.textContent = 'عنوانك المسجل';
    },
  };

  // ---------------------------------------------------------------------------
  // 7. Socket.IO real-time events
  // ---------------------------------------------------------------------------
  function initSocket(user) {
    if (typeof io === 'undefined') return;
    var socket = null, socketBase = null, fails = 0;

    function relay(evt) {
      return function (data) { window.dispatchEvent(new CustomEvent('market:' + evt, { detail: data })); };
    }

    function open() {
      try {
        if (socket) { socket.removeAllListeners(); socket.close(); }
        socketBase = ServerPool.current();
        fails = 0;
        socket = io(socketBase, {
          transports: ['websocket'],
          withCredentials: true,
          reconnectionDelayMax: 5000,
          // التوكن بيتقرا عند كل (إعادة) اتصال، فلو اتمسح/اتجدد بيتبعت الحالي
          auth: function (cb) { cb({ token: getToken() }); },
        });

        socket.on('connect', function () {
          fails = 0;
          console.log('%c[socket]%c متصل بالسيرفر: ' + socketBase,
            'background:#111;color:#fff;padding:2px 6px;border-radius:3px;', 'color:#16a34a;font-weight:bold;');
          socket.emit('join_users');
          if (user && (user.role === 'super_admin' || user.role === 'admin')) socket.emit('join_admin');
        });
        // بعد محاولتين فاشلتين نعتبر السيرفر واقع ونتحول للي بعده (الحدث market:server_changed بيعيد فتح الـ socket)
        socket.on('connect_error', function () {
          if (++fails >= 2) { fails = 0; ServerPool.reportFailure(socketBase, 'socket'); }
        });

        socket.on('new_product', function (d) {
          showToast('منتج جديد: ' + ((d && d.name) || 'تمت إضافة منتج مكسب جديد'), 'info');
          relay('new_product')(d);
        });
        socket.on('new_section', function (d) {
          showToast('قسم جديد: ' + ((d && d.name) || 'تمت إضافة قسم جديد'), 'info');
          relay('new_section')(d);
        });
        socket.on('update_status', function (d) {
          showToast('تم تحديث حالة أحد الطلبات', 'info');
          relay('update_status')(d);
        });
        socket.on('new_order', function (d) {
          showToast('طلب شراء جديد تم تسجيله في المنصة', 'warning');
          relay('new_order')(d);
        });
        ['deleted_product', 'deleted_section', 'upgrade_user', 'update_user', 'deleted_order'].forEach(function (evt) {
          socket.on(evt, relay(evt));
        });
      } catch (err) {
        console.warn('Socket.IO connection skipped:', err);
      }
    }

    open();
    window.addEventListener('market:server_changed', function () {
      if (socketBase !== ServerPool.current()) open();
    });
  }

  // ---------------------------------------------------------------------------
  // 8. AI shopping assistant (styled by the .ai-* rules in style.css)
  // ---------------------------------------------------------------------------
  var aiChatbot = {
    history: [],
    busy: false,

    init: function () {
      var self = this;
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'ai-floating-trigger';
      trigger.id = 'ai-chat-btn';
      trigger.setAttribute('aria-label', 'فتح المساعد الذكي');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.innerHTML =
        '<span class="ai-trigger-icon"><span class="ai-trigger-pulse"></span><i class="fa-solid fa-robot"></i></span>' +
        '<span class="ai-trigger-text"><span class="ai-trigger-title">مساعد التسوق</span><span class="ai-trigger-sub">اسألني عن أي منتج</span></span>';

      var box = document.createElement('section');
      box.className = 'ai-chat-window';
      box.id = 'ai-chat-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'مساعد التسوق');
      box.innerHTML =
        '<div class="ai-chat-header">' +
          '<div class="ai-header-info">' +
            '<div class="ai-avatar"><i class="fa-solid fa-robot"></i></div>' +
            '<div class="ai-title-wrap"><h4>مساعد التسوق</h4><span class="ai-status-indicator"><span class="ai-status-dot"></span>متصل الآن</span></div>' +
          '</div>' +
          '<button type="button" class="ai-chat-close-btn" id="ai-chat-close" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="ai-chat-body" id="ai-chat-msgs" aria-live="polite"></div>' +
        '<div class="ai-quick-prompts" id="ai-quick-prompts">' +
          '<button type="button" class="ai-prompt-chip">أرخص لابتوب متاح</button>' +
          '<button type="button" class="ai-prompt-chip">ما العروض الحالية؟</button>' +
          '<button type="button" class="ai-prompt-chip">كيف أتتبع طلبي؟</button>' +
        '</div>' +
        '<form class="ai-chat-input-bar" id="ai-chat-form">' +
          '<input type="text" class="ai-chat-input" id="ai-chat-input" placeholder="اكتب سؤالك هنا..." autocomplete="off" required aria-label="رسالتك">' +
          '<button type="submit" class="ai-chat-send-btn" id="ai-chat-send" aria-label="إرسال"><i class="fa-solid fa-paper-plane" style="transform:scaleX(-1);"></i></button>' +
        '</form>';

      document.body.appendChild(trigger);
      document.body.appendChild(box);

      this.addMessage('assistant', 'مرحباً بك في ' + BRAND + '! أنا مساعدك الذكي — اسألني عن المنتجات والأسعار والعروض أو تتبع طلبك.');

      function setOpen(open) {
        box.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', String(open));
        if (open) document.getElementById('ai-chat-input').focus();
      }
      trigger.addEventListener('click', function () { setOpen(!box.classList.contains('is-open')); });
      document.getElementById('ai-chat-close').addEventListener('click', function () { setOpen(false); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

      document.getElementById('ai-quick-prompts').addEventListener('click', function (e) {
        var chip = e.target.closest('.ai-prompt-chip');
        if (chip) self.send(chip.textContent);
      });
      document.getElementById('ai-chat-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('ai-chat-input');
        var text = input.value.trim();
        if (text) { input.value = ''; self.send(text); }
      });
    },

    send: async function (text) {
      if (this.busy) return;
      this.busy = true;
      this.addMessage('user', text);
      var quick = document.getElementById('ai-quick-prompts');
      if (quick) quick.style.display = 'none';

      var typing = this.addTyping();
      try {
        var res = await fetchAPI('/api/ai_assistant', {
          method: 'POST',
          body: JSON.stringify({ message: text, history: this.history.slice(-8) }),
        });
        typing.remove();

        if (res.ok && res.data) {
          var reply = res.data.reply || 'شكراً لسؤالك! تصفح المنتجات في المتجر لتجد ما يناسبك.';
          this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
          this.addMessage('assistant', reply, res.data.products || []);
        } else {
          this.addMessage('assistant', 'عذراً، تعذر الرد الآن. يمكنك تصفح المنتجات يدوياً أو المحاولة بعد قليل.');
        }
      } catch (err) {
        typing.remove();
        this.addMessage('assistant', 'عذراً، تعذر الرد الآن. يمكنك تصفح المنتجات يدوياً أو المحاولة بعد قليل.');
      } finally {
        this.busy = false;
      }
    },

    addTyping: function () {
      var body = document.getElementById('ai-chat-msgs');
      var el = document.createElement('div');
      el.className = 'ai-bubble incoming';
      el.innerHTML = '<span class="ai-typing-dots"><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></span>';
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
      return el;
    },

    addMessage: function (role, text, products) {
      var body = document.getElementById('ai-chat-msgs');
      var el = document.createElement('div');
      el.className = 'ai-bubble ' + (role === 'user' ? 'outgoing' : 'incoming');
      var html = '<div>' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';

      if (products && products.length) {
        html += '<div class="ai-product-slider">' + products.map(function (p) {
          var img = p.image || (Array.isArray(p.images) && p.images[0]) || FALLBACK_IMG;
          var price = p.final_price !== undefined ? p.final_price : p.price;
          return '<a href="/product.html?id=' + escapeHtml(p.id || p._id) + '" class="ai-product-mini">' +
            '<img src="' + escapeHtml(img) + '" alt="" loading="lazy" onerror="App.imgFallback(this)">' +
            '<span class="ai-product-mini-title">' + escapeHtml(p.name) + '</span>' +
            '<span class="ai-product-mini-price">' + formatPrice(price) + '</span></a>';
        }).join('') + '</div>';
      }
      el.innerHTML = html;
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
    },
  };


  // ---------------------------------------------------------------------------
  // Shared product card (used by home + catalog)
  // ---------------------------------------------------------------------------
  var _cardProducts = {};
  function productCard(p) {
    var id = p._id || p.id;
    _cardProducts[id] = p;
    var img = (Array.isArray(p.images) && p.images[0]) || p.image || FALLBACK_IMG;
    var hasDiscount = p.discount > 0;
    var finalPrice = p.final_price !== undefined ? p.final_price : p.price;
    var qty = p.quantity;
    var out = qty !== undefined && qty !== null && Number(qty) <= 0;
    var low = !out && Number(qty) > 0 && Number(qty) <= 3;
    var stock = out ? '<span class="card-condition card-stock-low"><i class="fa-solid fa-circle-xmark"></i> غير متوفر حالياً</span>'
      : low ? '<span class="card-condition card-stock-low"><i class="fa-solid fa-circle-exclamation"></i> متبقي ' + escapeHtml(qty) + ' فقط</span>'
      : '<span class="card-condition"><i class="fa-solid fa-circle-check"></i> مفحوص ومتوفر</span>';
    var storeLink = p.store_slug
      ? '<a href="/store.html?slug=' + encodeURIComponent(p.store_slug) + '" class="card-shipping" style="color:var(--link); font-weight:700;"><i class="fa-solid fa-store"></i><span>زيارة المتجر</span></a>'
      : '';
    return '<div class="product-card' + (out ? ' is-out-of-stock' : '') + '">' +
      '<div class="card-top-badges">' + (hasDiscount ? '<span class="badge badge-discount">توفير ' + escapeHtml(p.discount) + '%</span>' : '<span></span>') + '</div>' +
      '<a href="/product.html?id=' + escapeHtml(id) + '" class="product-image-wrap" data-card-link="' + escapeHtml(id) + '">' +
        '<img src="' + escapeHtml(img) + '" alt="' + escapeHtml(p.name) + '" class="product-image" loading="lazy" onerror="App.imgFallback(this)"></a>' +
      '<span class="product-card-category">' + escapeHtml((p.section && p.section.name) || 'عام') + '</span>' +
      '<a href="/product.html?id=' + escapeHtml(id) + '" data-card-link="' + escapeHtml(id) + '"><h3 class="product-title">' + escapeHtml(p.name) + '</h3></a>' +
      stock +
      '<div class="card-price-box"><span class="price-main">' + formatPrice(finalPrice) + '</span>' +
        (hasDiscount ? '<span class="price-old">' + formatPrice(p.price) + '</span>' : '') + '</div>' +
      '<div class="card-shipping"><i class="fa-solid fa-truck"></i><span>توصيل أو استلام مباشر</span></div>' +
      storeLink +
      '<button type="button" class="card-add-btn" data-card-add="' + escapeHtml(id) + '"' + (out ? ' disabled' : '') + '><i class="fa-solid fa-cart-plus"></i> أضف إلى السلة</button>' +
    '</div>';
  }
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-card-add]');
    if (add && _cardProducts[add.dataset.cardAdd]) cart.add(_cardProducts[add.dataset.cardAdd]);
  });
  document.addEventListener('mousedown', function (e) {
    var a = e.target.closest('[data-card-link]');
    if (a && _cardProducts[a.dataset.cardLink]) {
      try { sessionStorage.setItem('current_product', JSON.stringify(_cardProducts[a.dataset.cardLink])); } catch (err) { /* ignore */ }
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Init
  // ---------------------------------------------------------------------------
  var initialized = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    logActiveServer('عند تحميل الصفحة');
    shell.render();
    cart.updateBadges();
    aiChatbot.init();
    var user = await auth.me();
    initSocket(user);
  }

  window.toggleDrawer = function (open) { shell.toggleDrawer(open); };

  window.App = {
    escapeHtml: escapeHtml,
    formatPrice: formatPrice,
    productCard: productCard,
    showToast: showToast,
    fetchAPI: fetchAPI,
    apiUrl: apiUrl,
    servers: ServerPool,
    logServer: logActiveServer,
    safeDecode: safeDecode,
    imgFallback: imgFallback,
    FALLBACK_IMG: FALLBACK_IMG,
    auth: auth,
    cart: cart,
    shell: shell,
    init: init,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
  };

  Object.defineProperty(window.App, 'API_BASE_URL', { get: function () { return ServerPool.current(); } });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
