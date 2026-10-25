/*
 * main-hook.js —— 运行在页面主世界（MAIN world）、document_start、所有 iframe。
 * 这里干的是"页面 JS 看不见我"的活：改 visibility、掐事件、拦 pause、兜底续播。
 * 配置由隔离世界的 content.js 通过 postMessage 下发（见 handleCfg）。
 */
(() => {
  'use strict';
  if (window.__cxLoaded) return;
  // 注意：不往 window 上挂任何可被页面探测的标记。
  // 这里用 try/catch 包住的局部判断，页面拿不到（Symbol 也不暴露）。
  try {
    const KEY = Symbol.for('cx.loaded');
    if (window[KEY]) return;
    Object.defineProperty(window, KEY, { value: true, configurable: false, enumerable: false, writable: false });
  } catch (_) {
    if (window.__cxLoaded) return;
    try {
      Object.defineProperty(window, '__cxLoaded', { value: true, configurable: false, enumerable: false, writable: false });
    } catch (_) {}
  }

  /** 可热更新的配置 */
  const cfg = {
    enabled: true,
    keepPlaying: true,
    blockVisibility: true,
    mute: false,
    rate: 0,
    resumeInterval: 1200,
  };

  const state = {
    lastTrustedClick: 0,
    lastResumeAt: 0,
    lastPostAt: 0,
    paused: 0, // 被我们吞掉的 pause 次数
    resumed: 0, // 兜底续播次数
    mutedStart: 0, // 靠"先静音"骗过自动播放限制的次数
  };

  const origAdd = EventTarget.prototype.addEventListener;
  const origPause = HTMLMediaElement.prototype.pause;

  /* ------------------------------------------------------------------ *
   * 0. 让被替换掉的原生方法在 toString() 下仍显示 [native code]
   *    —— "pause.toString() 里出现 JS 代码" 是最常被用来判断页面被改过的手法。
   * ------------------------------------------------------------------ */
  const NATIVE_LIKE = new WeakSet();
  const origFnToString = Function.prototype.toString;
  function markNative(fn) {
    try {
      NATIVE_LIKE.add(fn);
    } catch (_) {}
    return fn;
  }
  try {
    const fakeToString = function toString() {
      try {
        if (NATIVE_LIKE.has(this)) return 'function ' + ((this && this.name) || '') + '() { [native code] }';
      } catch (_) {}
      return origFnToString.call(this);
    };
    NATIVE_LIKE.add(fakeToString);
    Function.prototype.toString = fakeToString;
  } catch (_) {}

  /* ------------------------------------------------------------------ *
   * 1. 伪造成"页面一直可见、一直有焦点"
   * ------------------------------------------------------------------ */
  const VIS_GETTERS = [
    ['hidden', false],
    ['visibilityState', 'visible'],
    ['webkitHidden', false],
    ['webkitVisibilityState', 'visible'],
    ['mozHidden', false],
    ['mozVisibilityState', 'visible'],
    ['msHidden', false],
    ['msVisibilityState', 'visible'],
  ];
  /** 撤销函数集合，用于运行期关闭该功能 */
  let undoVisibility = [];
  let visibilityOn = false;

  function enableVisibilitySpoof() {
    if (visibilityOn) return;
    visibilityOn = true;

    for (const [prop, value] of VIS_GETTERS) {
      try {
        const prev = Object.getOwnPropertyDescriptor(document, prop);
        Object.defineProperty(document, prop, {
          configurable: true,
          enumerable: true,
          get() {
            return value;
          },
        });
        undoVisibility.push(() => {
          try {
            if (prev) Object.defineProperty(document, prop, prev);
            else delete document[prop];
          } catch (_) {}
        });
      } catch (_) {}
    }

    // document.hasFocus() 恒为 true
    try {
      const hadOwn = Object.prototype.hasOwnProperty.call(document, 'hasFocus');
      const prevHasFocus = document.hasFocus;
      document.hasFocus = function hasFocus() {
        return true;
      };
      undoVisibility.push(() => {
        try {
          if (hadOwn) document.hasFocus = prevHasFocus;
          else delete document.hasFocus;
        } catch (_) {}
      });
    } catch (_) {}

    // document.visibilityState 相关的一些旧接口
    try {
      if ('onvisibilitychange' in document) {
        const prev = Object.getOwnPropertyDescriptor(document, 'onvisibilitychange');
        Object.defineProperty(document, 'onvisibilitychange', {
          configurable: true,
          enumerable: true,
          get() {
            return null;
          },
          set() {},
        });
        undoVisibility.push(() => {
          try {
            if (prev) Object.defineProperty(document, 'onvisibilitychange', prev);
            else delete document.onvisibilitychange;
          } catch (_) {}
        });
      }
    } catch (_) {}
  }

  function disableVisibilitySpoof() {
    if (!visibilityOn) return;
    visibilityOn = false;
    for (const fn of undoVisibility.reverse()) {
      try {
        fn();
      } catch (_) {}
    }
    undoVisibility = [];
  }

  /* ------------------------------------------------------------------ *
   * 2. 掐掉"页面失去焦点 / 鼠标离开"的信号
   * ------------------------------------------------------------------ */
  const swallow = (e) => {
    try {
      e.stopImmediatePropagation();
      e.stopPropagation();
    } catch (_) {}
  };

  const NO_RELATED_TARGET = (e) => !e.relatedTarget && !e.toElement && !e.fromElement;

  function installGuards() {
    // 2.1 页面自己 dispatch 的 visibilitychange / pagehide：在 window 捕获阶段拦截
    const guardVisibility = (e) => {
      if (!cfg.enabled || !cfg.blockVisibility) return;
      swallow(e);
    };
    origAdd.call(window, 'visibilitychange', guardVisibility, true);
    origAdd.call(window, 'webkitvisibilitychange', guardVisibility, true);
    origAdd.call(window, 'pagehide', guardVisibility, true);

    // 2.2 blur：只拦"窗口整体失焦"（e.target === window）
    origAdd.call(
      window,
      'blur',
      (e) => {
        if (!cfg.enabled || !cfg.blockVisibility) return;
        if (e.target !== window) return;
        swallow(e);
      },
      true
    );

    // 2.3 鼠标真正离开文档（relatedTarget 为空）才算"离开页面"，内部移动一律放行，
    //     这样不会破坏目录 hover 之类的正常交互。
    const guardMouse = (e) => {
      if (!cfg.enabled || !cfg.blockVisibility) return;
      if (!NO_RELATED_TARGET(e)) return;
      swallow(e);
    };
    origAdd.call(window, 'mouseout', guardMouse, true);
    origAdd.call(window, 'mouseleave', guardMouse, true);
    origAdd.call(document, 'mouseout', guardMouse, true);
    origAdd.call(document, 'mouseleave', guardMouse, true);

    // 2.4 第二层：直接拒绝注册这些监听（挡在源头，兼容 jQuery / 框架委托）
    const dropOn = new Set(['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange', 'pagehide']);
    // 'unload' 浏览器已经废弃，注册时会在扩展面板里冒一条 Permissions policy violation，
    // 页面拿它只做清理，跳过不影响功能，顺手挡掉免得脏了错误列表。
    const dropAlways = new Set(['unload']);
    EventTarget.prototype.addEventListener = markNative(function addEventListener(type, listener, options) {
      try {
        const t = typeof type === 'string' ? type.toLowerCase() : '';
        if (dropAlways.has(t) && (this === window || this === document)) return;
        if (cfg.enabled && cfg.blockVisibility) {
          const isPageLevel = this === window || this === document || this === document.documentElement || this === document.body;
          if (isPageLevel && dropOn.has(t)) return;
          if (this === window && t === 'blur') return;
        }
      } catch (_) {}
      return origAdd.call(this, type, listener, options);
    });

    // 2.5 属性式 onxxx = fn 直接压成空
    const killProp = (obj, name) => {
      try {
        const prev = Object.getOwnPropertyDescriptor(obj, name);
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: true,
          get() {
            return null;
          },
          set() {},
        });
        return () => {
          try {
            if (prev) Object.defineProperty(obj, name, prev);
            else delete obj[name];
          } catch (_) {}
        };
      } catch (_) {
        return () => {};
      }
    };
    killProp(window, 'onblur');
    killProp(window, 'onpagehide');
    killProp(document, 'onvisibilitychange');
    killProp(document, 'onmouseleave');

    // 2.6 记录"用户主动点击"，用来区分手动暂停和反作弊暂停
    origAdd.call(
      window,
      'pointerdown',
      () => {
        state.lastTrustedClick = performance.now();
      },
      true
    );
    origAdd.call(
      window,
      'click',
      () => {
        state.lastTrustedClick = performance.now();
      },
      true
    );
  }

  /* ------------------------------------------------------------------ *
   * 3. 拦截 pause()，反作弊的暂停调用直接吞掉
   * ------------------------------------------------------------------ */
  function installPauseGuard() {
    HTMLMediaElement.prototype.pause = markNative(function pause() {
      try {
        if (cfg.enabled && cfg.keepPlaying && !this.ended) {
          const userInitiated = performance.now() - state.lastTrustedClick < 800;
          if (!userInitiated) {
            state.paused += 1;
            const el = this;
            // 有的播放器先 pause 再改 UI，下一帧再拉回来
            setTimeout(() => {
              try {
                if (el.paused && !el.ended) el.play().catch(() => {});
              } catch (_) {}
            }, 0);
            return undefined;
          }
        }
      } catch (_) {}
      return origPause.apply(this, arguments);
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. 兜底：定时巡检，暂停了就拉起来，倍速跑偏了就纠正
   * ------------------------------------------------------------------ */
  const visible = (el) => {
    try {
      if (!el.getClientRects().length) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      return true;
    } catch (_) {
      return false;
    }
  };

  function applyRate(v) {
    try {
      const want = Number(cfg.rate) || 0;
      if (want <= 0.01) return; // 0 = 跟随页面，不干预（给 Global Speed 之类的扩展让路）
      if (Math.abs((v.playbackRate || 1) - want) > 0.01) v.playbackRate = want;
    } catch (_) {}
  }

  /** 起播：正常失败（浏览器自动播放策略）时先静音起播，再尝试把声音放回来 */
  function tryResume(v) {
    let p;
    try {
      p = v.play();
    } catch (_) {
      return;
    }
    if (p && p.then) {
      p.then(
        () => {
          state.resumed += 1;
        },
        () => {
          try {
            const wasMuted = v.muted;
            v.muted = true;
            const p2 = v.play();
            if (p2 && p2.then) {
              p2.then(
                () => {
                  state.resumed += 1;
                  state.mutedStart = (state.mutedStart || 0) + 1;
                  // 静音只是为了骗过自动播放限制，起播后 1.2s 把声音还回去
                  if (!wasMuted && !cfg.mute) {
                    setTimeout(() => {
                      try {
                        v.muted = false;
                        if (v.paused) v.play().catch(() => { v.muted = true; });
                      } catch (_) {}
                    }, 1200);
                  }
                },
                () => {}
              );
            }
          } catch (_) {}
        }
      );
    }
  }

  function tick() {
    if (!cfg.enabled) return;
    let videos = [];
    try {
      videos = Array.from(document.querySelectorAll('video'));
    } catch (_) {}

    for (const v of videos) {
      try {
        if (cfg.mute && !v.muted) v.muted = true;
        applyRate(v);
        if (!cfg.keepPlaying) continue;
        if (v.ended || !v.paused) continue;
        if (!visible(v)) continue;
        if (performance.now() - state.lastTrustedClick < 900) continue; // 用户自己按的暂停
        tryResume(v);
      } catch (_) {}
    }

    // 每 2s 把拦截统计报给隔离世界（弹窗里能看到）
    const now = Date.now();
    if (now - state.lastPostAt > 2000) {
      state.lastPostAt = now;
      try {
        let playing = 0;
        for (const v of videos) if (!v.paused) playing += 1;
        window.postMessage(
          {
            __cx: 'state',
            payload: {
              paused: state.paused,
              resumed: state.resumed,
              videos: videos.length,
              playing,
              visible: visibilityOn,
            },
          },
          '*'
        );
      } catch (_) {}
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. 配置热更新
   * ------------------------------------------------------------------ */
  function applyCfg(patch) {
    Object.assign(cfg, patch || {});
    if (cfg.blockVisibility && cfg.enabled) enableVisibilitySpoof();
    else disableVisibilitySpoof();
    restartTick();
  }

  let tickTimer = null;
  function restartTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    const ms = Math.max(400, Number(cfg.resumeInterval) || 1200);
    tickTimer = setInterval(tick, ms);
  }

  origAdd.call(
    window,
    'message',
    (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__cx !== 'cfg') return;
      applyCfg(d.payload);
    },
    false
  );

  /* ------------------------------------------------------------------ *
   * 4.5 网络上报探测（只读观察，改动不了任何请求内容）
   *     目的：把"播放进度上报"这类请求抓出来，看看服务端到底收到什么
   *     （有没有 rate / playTime / duration），用于判断云端怎么算时长。
   * ------------------------------------------------------------------ */
  const NET_RE = /log|report|progress|multimedia|study|record|heartbeat|api/i;
  const netSeen = new Map(); // 签名 -> 次数，避免刷屏
  function noteNet(kind, url, body) {
    try {
      const u = String(url || '');
      if (!u || u.indexOf('chrome-extension') === 0) return;
      if (!NET_RE.test(u)) return;
      const b = body ? String(body).slice(0, 240) : '';
      const sig = kind + '|' + u.slice(0, 160) + '|' + b.slice(0, 120);
      const n = (netSeen.get(sig) || 0) + 1;
      netSeen.set(sig, n);
      if (n > 3) return; // 同一请求只报前 3 次
      window.postMessage(
        { __cx: 'net', payload: { kind, url: u.slice(0, 200), body: b, n } },
        '*'
      );
    } catch (_) {}
  }

  /* 上报探测：只记录接近"进度上报"的请求，不改内容。
     注意不要在包装函数或 XHR 实例上挂任何自定义属性（__cxProbed/__cxUrl 这类
     字段页面自己 new 个 XHR 就能看到），一律用 WeakSet/WeakMap 存在闭包里。 */
  const PROBED_FN = new WeakSet();
  const XHR_META = new WeakMap();

  function installNetProbe() {
    try {
      const of = window.fetch;
      if (typeof of === 'function' && !PROBED_FN.has(of)) {
        const wrapped = markNative(function fetch(input, init) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            noteNet('fetch', url, init && init.body);
          } catch (_) {}
          return of.apply(this, arguments);
        });
        PROBED_FN.add(wrapped);
        try {
          window.fetch = wrapped;
        } catch (_) {}
      }
    } catch (_) {}
    try {
      const XO = XMLHttpRequest.prototype.open;
      const XS = XMLHttpRequest.prototype.send;
      if (!PROBED_FN.has(XO)) {
        const openW = markNative(function open(m, u) {
          try {
            XHR_META.set(this, { m: String(m || ''), u: String(u || '') });
          } catch (_) {}
          return XO.apply(this, arguments);
        });
        const sendW = markNative(function send(b) {
          try {
            const meta = XHR_META.get(this);
            if (meta) noteNet('xhr:' + meta.m, meta.u, b);
          } catch (_) {}
          return XS.apply(this, arguments);
        });
        PROBED_FN.add(openW);
        PROBED_FN.add(sendW);
        XMLHttpRequest.prototype.open = openW;
        XMLHttpRequest.prototype.send = sendW;
      }
    } catch (_) {}
    try {
      const ob = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
      if (ob && !PROBED_FN.has(ob)) {
        const wb = markNative(function sendBeacon(u, d) {
          try {
            noteNet('beacon', u, d && typeof d === 'string' ? d : '[非文本]');
          } catch (_) {}
          return ob(u, d);
        });
        PROBED_FN.add(wb);
        navigator.sendBeacon = wb;
      }
    } catch (_) {}
  }


  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  try {
    installPauseGuard();
    installGuards();
    installNetProbe();
    enableVisibilitySpoof(); // 先乐观开启，content.js 下发配置后再校正
    restartTick();
    // 页面动态插入 video / 切集时顺手补一刀（防抖，避免拖慢页面）
    let moTimer = null;
    try {
      new MutationObserver(() => {
        if (moTimer) return;
        moTimer = setTimeout(() => {
          moTimer = null;
          tick();
        }, 400);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  } catch (e) {
    console.warn('[CX助手:main] 初始化失败', e);
  }
})();
