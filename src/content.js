/*
 * content.js —— 隔离世界，所有 iframe，document_idle。
 * 职责：
 *   1) 把配置下发给 main-hook（反挂机那一层）
 *   2) 盯视频：播完了通知顶层跳下一节
 *   3) 盯弹题：识别题目 -> 后台求解 -> 自动点选 + 提交
 *   4) 给弹窗提供状态/手动命令
 */
(() => {
  'use strict';
  if (window.__cxContent) return;
  window.__cxContent = true;

  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch (_) {
      return false;
    }
  })();

  /* 只在超星学习通上跑（智慧树有反作弊检测，已放弃支持） */

  /* ================================================================== *
   * 配置
   * ================================================================== */
  const DEFAULTS = {
    enabled: true,
    keepPlaying: true,
    blockVisibility: true,
    autoQuiz: true,
    autoChapterQuiz: true,
    autoNext: true,
    mute: false,
    rate: 0,
    nextDelay: 3000,
    resumeInterval: 1200,
    quizSelectors: '',
    solver: 'llm',
  };

  const cfg = Object.assign({}, DEFAULTS);
  const logs = [];
  const mainState = { paused: 0, resumed: 0, at: 0 };

  const log = (...args) => {
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(' ');
    try {
      console.log('%c[CX助手]', 'color:#ff8a00;font-weight:bold', text);
    } catch (_) {}
    logs.push({ t: Date.now(), text: text.slice(0, 300) });
    if (logs.length > 80) logs.shift();
  };

  // 网络探测行单独占位，格式已经在调用处裁好长度
  const pushLog = (text) => {
    try {
      console.log('%c[CX助手]', 'color:#ff8a00;font-weight:bold', text);
    } catch (_) {}
    logs.push({ t: Date.now(), text: String(text).slice(0, 400) });
    if (logs.length > 80) logs.shift();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadCfg() {
    try {
      chrome.storage.sync.get(DEFAULTS, (v) => {
        Object.assign(cfg, DEFAULTS, v || {});
        onCfgChanged();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let hit = false;
        for (const k of Object.keys(changes)) {
          if (k in DEFAULTS) {
            cfg[k] = changes[k].newValue;
            hit = true;
          }
        }
        if (hit) onCfgChanged();
      });
    } catch (e) {
      log('读取配置失败', e && e.message);
      onCfgChanged();
    }
  }

  let lastCfgJson = '';
  function onCfgChanged() {
    const json = JSON.stringify(cfg);
    if (json === lastCfgJson) return;
    lastCfgJson = json;
    postCfg();
    applyVideoPrefs();
  }

  function postCfg() {
    try {
      window.postMessage(
        {
          __cx: 'cfg',
          payload: {
            enabled: cfg.enabled,
            keepPlaying: cfg.keepPlaying,
            blockVisibility: cfg.blockVisibility,
            mute: cfg.mute,
            rate: Number(cfg.rate) || 0,
            resumeInterval: Number(cfg.resumeInterval) || 1200,
          },
        },
        '*'
      );
    } catch (_) {}
  }

  /* ================================================================== *
   * 小工具
   * ================================================================== */
  const cleanText = (s) =>
    String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

  function visible(el) {
    try {
      if (!el || !el.getClientRects || !el.getClientRects().length) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch (_) {
      return false;
    }
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {}
    try {
      el.click();
      return true;
    } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (_) {}
    return false;
  }

  /** 用来点"遮罩层按钮"：有些按钮只认完整的按下->抬起序列，单发 click 无效 */
  function clickHard(el) {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {}
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try {
        const Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_) {}
    }
    try {
      el.click();
      return true;
    } catch (_) {}
    return false;
  }

  function currentChapterId() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get('chapterId') || u.searchParams.get('chapterid');
      if (q && /^\d{4,}$/.test(q)) return q;
      const m = location.href.match(/chapterId[=/](\d+)/i);
      if (m) return m[1];
      const hash = location.hash.match(/chapterId[=/](\d+)/i);
      if (hash) return hash[1];
    } catch (_) {}
    return '';
  }

  /** 页面标题里的章节编号，如 "第六章 6.2.5、请示" 里的 6.2.5 */
  function currentSectionNo() {
    const src = [];
    try {
      src.push(document.title || '');
    } catch (_) {}
    for (const sel of ['.chapter-title', '.video-title', '.currentChapter', '.playTitle', '.clearfix .title']) {
      try {
        const el = document.querySelector(sel);
        if (el) src.push(el.textContent || '');
      } catch (_) {}
    }
    for (const s of src) {
      const t = cleanText(s);
      const m = t.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (m) return m[1];
    }
    return '';
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* ================================================================== *
   * 顶层提示条
   * ================================================================== */
  let toastBox = null;
  let toastTimer = null;
  function toast(text, kind) {
    if (!IS_TOP || !document.body) return;
    try {
      if (!toastBox) {
        toastBox = document.createElement('div');
        toastBox.className = 'cx-toast';
        document.body.appendChild(toastBox);
      }
      toastBox.textContent = text;
      toastBox.dataset.kind = kind || 'info';
      toastBox.classList.add('cx-toast-show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastBox && toastBox.classList.remove('cx-toast-show'), 3200);
    } catch (_) {}
  }
  const notify = (text, kind) => {
    log(text);
    toast(text, kind);
  };

  /* ================================================================== *
   * 视频：倍速 / 静音 / 播放结束
   * ================================================================== */
  function applyVideoPrefs() {
    let vids = [];
    try {
      vids = Array.from(document.querySelectorAll('video'));
    } catch (_) {}
    for (const v of vids) {
      try {
        if (cfg.mute) v.muted = true;
        const want = Number(cfg.rate) || 0;
        if (want > 1.001 && Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want;
      } catch (_) {}
    }
  }

  const watched = new WeakSet();
  let lastEndedAt = 0;

  function markEnded(why) {
    const now = Date.now();
    if (now - lastEndedAt < 15000) return;
    lastEndedAt = now;
    notify('本节视频已播放完毕（' + why + '）');
    if (IS_TOP) scheduleNext();
    else {
      try {
        window.top.postMessage({ __cx: 'videoEnded' }, '*');
      } catch (_) {}
    }
  }

  function attachVideo(v) {
    if (watched.has(v)) return;
    watched.add(v);
    log('发现视频元素', v.duration ? '时长 ' + Math.round(v.duration) + 's' : '时长未知');
    v.addEventListener('ended', () => markEnded('ended 事件'));
    // 有些播放器不触发 ended，靠进度兜底
    v.addEventListener('timeupdate', () => {
      try {
        const d = v.duration;
        if (d && isFinite(d) && d > 5 && v.currentTime >= d - 0.35) markEnded('进度到末尾');
      } catch (_) {}
    });
  }

  let videoTimer = null;
  const alreadyEnded = new WeakSet();

  function videoTick() {
    let vids = [];
    try {
      vids = Array.from(document.querySelectorAll('video'));
    } catch (_) {}
    for (const v of vids) attachVideo(v);
    applyVideoPrefs();
    // 打开页面时视频就已经在结尾（这节之前看完了）——也要往下走，否则一直停着
    for (const v of vids) {
      try {
        const d = v.duration;
        if (!d || !isFinite(d) || d < 5) continue;
        if (v.currentTime < d - 1.5) continue;
        if (alreadyEnded.has(v)) continue;
        alreadyEnded.add(v);
        markEnded('打开时已在结尾');
      } catch (_) {}
    }
  }

  /* ================================================================== *
   * 自动下一节
   * ================================================================== */
  let nextScheduled = false;
  // 本章的章节测验已经是批阅状态（我的答案/本次成绩）时记下来，避免反复切过去
  let examGradedChapter = '';

  // 本节任务点已完成（早就看过了）→ 别重看，直接跳
  let completedTick = { chapter: '', n: 0 };

  function skipIfAlreadyDone() {
    if (!IS_TOP) return;
    if (!cfg.enabled || !cfg.autoNext) return;
    const key = currentChapterId() || location.href;
    let done = false;
    try { done = pageSaysCompleted(); } catch (_) {}
    if (!done) { completedTick = { chapter: '', n: 0 }; return; }
    if (completedTick.chapter !== key) completedTick = { chapter: key, n: 0 };
    completedTick.n++;
    if (completedTick.n === 3) {
      log('本节任务点已完成（左上角那个绿标），直接跳下一节');
      scheduleNext();
    }
  }

  function scheduleNext() {
    if (nextScheduled) { log('跳转已排队，本次忽略'); return; }
    if (!cfg.enabled) { log('不跳转：总开关是关的'); return; }
    if (!cfg.autoNext) { log('不跳转：自动下一节开关是关的'); return; }
    nextScheduled = true;
    const delay = Math.max(800, Number(cfg.nextDelay) || 3000);
    log('将在 ' + Math.round(delay / 1000) + 's 后跳转下一节');
    setTimeout(() => {
      nextScheduled = false;
      goNext(false).then((r) => {
        if (r && r.ok) notify('已跳转下一节：' + (r.how || ''), 'ok');
        else if (r && r.reason) notify('自动下一节未执行：' + r.reason, 'warn');
      });
    }, delay);
  }

  const NEXT_BUTTONS = [
    '#prevNextFocusNext',
    '.prevNextFocusNext',
    '.nextChapter',
    'a[title="下一节"]',
    'a[title="下一集"]',
    'a[title="下一章"]',
    'a[title="下一个"]',
  ];

  const NEXT_TEXT_RE = /^(下一节|下一集|下一章|下一个|下一课|下一小节|下一个视频|下一节视频|播放下一节|继续下一个)$/;

  function findNextByText() {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll('a, button, div, span'));
    } catch (_) {}
    for (const el of els) {
      if (!visible(el)) continue;
      if (el.querySelector('a, button')) continue; // 只要叶子节点，别点到整块容器
      const t = cleanText(el.textContent || '');
      if (t && t.length <= 6 && NEXT_TEXT_RE.test(t)) {
        // 文字所在的 div 本身往往不响应点击，往上找一层真正可点的
        let cur = el;
        for (let up = 0; up < 3 && cur.parentElement; up++) {
          const p = cur.parentElement;
          const tag = (p.tagName || '').toLowerCase();
          if (tag === 'a' || tag === 'button' || tag === 'li' || p.onclick || /btn|next/i.test(String(p.className || ''))) {
            return p;
          }
          cur = p;
        }
        return el;
      }
      const title = cleanText(el.getAttribute('title') || el.getAttribute('aria-label') || '');
      if (title && NEXT_TEXT_RE.test(title)) return el;
    }
    return null;
  }

  function pickFirst(selectors, needVisible) {
    for (const sel of selectors) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(sel));
      } catch (_) {}
      for (const el of list) {
        if (needVisible && !visible(el)) continue;
        return el;
      }
    }
    return null;
  }

  function itemChapterId(el) {
    try {
      const idm = (el.id || '').match(/(\d{5,})/);
      if (idm) return idm[1];
      for (const a of el.attributes) {
        const m = String(a.value || '').match(/chapterId[=/"']?(\d{4,})/i);
        if (m) return m[1];
      }
      const link = el.querySelector('a[href*="chapterId"], a[href*="chapterid"]');
      if (link) {
        const m = link.getAttribute('href').match(/chapterId[=/"']?(\d{4,})/i);
        if (m) return m[1];
      }
      const m2 = (el.getAttribute('onclick') || '').match(/(\d{6,})/);
      if (m2) return m2[1];
    } catch (_) {}
    return '';
  }

  function itemDone(el) {
    try {
      if (el.querySelector('.icon_Completed, .icon_completed, [class*="icon_Completed"], [class*="IconComplete"], .taskpoint-complete, .icon_taskpoint_complete')) return true;
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/(^|[\s_-])(complete|completed|done|finish|finished)([\s_-]|$)/i.test(cls)) return true;
      if (/已完成|已学完|已看完|已学过|已学习/.test(cleanText(el.textContent || ''))) return true;
    } catch (_) {}
    return false;
  }

  function itemActive(el) {
    try {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/(^|[\s_-])(active|cur|current|selected|on)([\s_-]|$)/i.test(cls)) return true;
      if (/^cur/i.test(el.id || '')) return true;
      if (el.querySelector('.icon_Current, .icon_current, #cur')) return true;
      // 学习通的"当前小节"经常只靠背景色高亮：取自身与上一层的底色判断
      const tinted = (node) => {
        try {
          const bg = getComputedStyle(node).backgroundColor || '';
          const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!m) return false;
          const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
          return b > 180 && b - r > 30 && b - g > 15; // 明确的偏蓝浅底（绿底/白底不算）
        } catch (_) { return false; }
      };
      if (tinted(el)) return true;
      if (el.parentElement && tinted(el.parentElement)) return true;
    } catch (_) {}
    return false;
  }

  /** 本节任务点是不是已经完成了（左上角那个绿色「任务点已完成」） */
  function pageSaysCompleted() {
    const RE = /任务点已完成|已完成学习|学习已完成/;
    const docs = [];
    const push = (d) => {
      if (!d || docs.includes(d)) return;
      docs.push(d);
    };
    push(document);
    for (let i = 0; i < docs.length && docs.length < 8; i++) {
      const d = docs[i];
      try {
        for (const f of Array.from(d.querySelectorAll('iframe'))) {
          try { if (f.contentDocument && f.contentDocument.body) push(f.contentDocument); } catch (_) {}
        }
      } catch (_) {}
    }
    for (const d of docs) {
      try {
        const t = (d.body && d.body.innerText) || '';
        if (RE.test(t)) return true;
      } catch (_) {}
    }
    return false;
  }

  /** 页面上那个大标题（小节名），用于在目录里对号入座 */
  function pageSectionName() {
    const sels = [
      '.chapter-title', '.video-title', '.playTitle', '.currentChapter',
      '#chapterTitle', '.chapter_title', '.title-text', 'h1', '.under-title',
    ];
    for (const sel of sels) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      for (const el of list) {
        if (!visible(el)) continue;
        const t = cleanText(el.textContent || '');
        if (t.length >= 4 && t.length <= 40 && !/章节详情|返回课程|讨论|笔记|标注|目录/.test(t)) return t;
      }
    }
    return '';
  }

  function catalogItems() {
    const sels = [
      '.posCatalog_select',
      '.posCatalog_level .posCatalog_select',
      '.chapter_item',
      '.catalog_item',
    ];
    for (const sel of sels) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(sel));
      } catch (_) {}
      if (list.length >= 2) return list;
    }
    // 兜底：任何带 chapterId 的节点（目录换了类名，或折叠时只剩隐藏的链接）
    let links = [];
    try {
      links = Array.from(
        document.querySelectorAll('a[href*="chapterId="], a[href*="chapterid="], [onclick*="chapterId"], [onclick*="chapterid"]')
      );
    } catch (_) {}
    const seen = new Set();
    const out = [];
    for (const el of links) {
      const id = itemChapterId(el);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(el);
    }
    return out.length >= 2 ? out : [];
  }

  /** 目录被折叠/懒加载时，试着点开它再重试一次 */
  async function openCatalog() {
    let hits = [];
    try {
      hits = Array.from(
        document.querySelectorAll(
          '[class*="catalog" i], [id*="catalog" i], [class*="chapterList" i], [id*="chapterList" i], [class*="directory" i]'
        )
      );
    } catch (_) {}
    for (const el of hits) {
      if (!visible(el)) continue;
      const text = cleanText(el.textContent || '');
      if (text.length > 24) continue; // 大容器不是开关
      if (!/目录|章节|展开|收起|catalog|chapter/i.test(text + ' ' + String(el.className || ''))) continue;
      clickEl(el);
      await sleep(1000);
      return true;
    }
    return false;
  }

  function contentIframe() {
    return pickFirst(['#iframe', 'iframe.ans-attach-online', 'iframe[name="iframe"]', 'iframe'], true);
  }

  /** 判断"页面到底跳没跳"用的指纹：只认 chapterId 变化或 URL 变化。
   *  早先直接比 iframe 的 src，页面上任何无关 iframe 刷新都会误判成功。 */
  function currentKey() {
    const id = currentChapterId();
    if (id) return 'c:' + id;
    try {
      const ifr = contentIframe();
      const m = ifr && String(ifr.src || '').match(/chapterId[=/"']?(\d{4,})/i);
      if (m) return 'c:' + m[1];
    } catch (_) {}
    return 'u:' + location.href;
  }

  /** 点完之后等一会儿，看 chapterId / URL 有没有变（学习通很多跳转是 ajax 换 iframe） */
  async function waitNavigated(beforeKey, timeout) {
    const step = 300;
    const beforeTitle = pageSectionName();
    for (let waited = 0; waited < timeout; waited += step) {
      await sleep(step);
      if (currentKey() !== beforeKey) return true;
      // 纯 JS 换小节时 URL 不变，但页面大标题会变
      const t = pageSectionName();
      if (beforeTitle && t && t !== beforeTitle) {
        log('页面标题已变：「' + beforeTitle.slice(0, 12) + '」→「' + t.slice(0, 12) + '」');
        return true;
      }
    }
    return false;
  }

  function chapterUrlFor(id, el) {
    // 优先用目录项自己的 href（那就是"用户点它"会去的地方）
    try {
      const a = el && (el.tagName === 'A' ? el : el.querySelector('a[href*="chapterId"], a[href*="chapterid"]'));
      const href = a && a.getAttribute('href');
      if (href && /chapterId/i.test(href)) {
        return new URL(href, location.href).href;
      }
    } catch (_) {}
    // 退而求其次：拿当前地址，把 chapterId 换掉
    try {
      const u = new URL(location.href);
      if (!u.searchParams.get('chapterId') && !u.searchParams.get('chapterid')) return '';
      if (u.searchParams.get('chapterId')) u.searchParams.set('chapterId', id);
      else u.searchParams.set('chapterid', id);
      return u.href;
    } catch (_) {}
    return '';
  }

  async function navigateTo(el) {
    const beforeKey = currentKey();
    const targets = [el.querySelector('.posCatalog_name'), el, el.querySelector('a')].filter(Boolean);
    for (const t of targets) {
      clickEl(t);
      if (await waitNavigated(beforeKey, 2600)) return true;
    }
    // 兜底：点不动就直接按 chapterId 换地址（学习通认这种 URL）
    const id = itemChapterId(el);
    const url = id ? chapterUrlFor(id, el) : '';
    if (url && url !== location.href) {
      log('目录点了没反应，直接按 chapterId 跳：' + id);
      try {
        location.href = url;
      } catch (_) {}
      if (await waitNavigated(beforeKey, 5000)) return true;
    }
    return false;
  }

  /** 从候选池里挑真正该去的小节（纯函数，方便离线自测） */
  function pickNextTarget(pool) {
    if (!pool || !pool.length) return null;
    // 编号能区分层级："5 Python语言基本语法" 是章（depth 1），"5.1 xxx" 是小节（depth 2）。
    // 有更深层级可用时优先用它，否则退回池子里的第一个。
    const deeper = pool.filter((x) => Number(x.depth) >= 2);
    return deeper.length ? deeper[0] : pool[0];
  }

  /** 目录认不出时，把"像目录项的元素"打出来（带时长 mm:ss 的最像），方便按真实 class 补规则 */
  function logDirDiagnostics() {
    let cands = [];
    try {
      cands = Array.from(document.querySelectorAll('div, li, a')).filter((el) => {
        if (!visible(el)) return false;
        const t = cleanText(el.textContent || '');
        return t.length >= 4 && t.length <= 120 && /\d{1,2}:\d{2}/.test(t);
      });
    } catch (_) {}
    if (!cands.length) {
      log('目录诊断：页面里没有带时长（mm:ss）的条目');
      return;
    }
    cands.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const top = cands.slice(0, 5).map((el) => '「' + cleanText(el.textContent || '').slice(0, 20) + '」' + classChain(el));
    log(('目录诊断：' + top.join(' | ')).slice(0, 380));
  }

  /** 走课程目录：找当前项之后第一个未完成的小节 */
  async function catalogNext() {
    let items = catalogItems();
    if (!items.length) {
      if (await openCatalog()) items = catalogItems();
    }
    if (!items.length) {
      let linkCount = 0;
      try {
        linkCount = document.querySelectorAll('a[href*="chapterId="]').length;
      } catch (_) {}
      logDirDiagnostics();
      return { ok: false, reason: '没找到课程目录（chapterId 链接 ' + linkCount + ' 个）' };
    }

    const curId = currentChapterId();
    const fullText = (el) => cleanText(el.textContent || '');
    const numOf = (el) => {
      const m = fullText(el).match(/^(\d+(?:\.\d+)*)/);
      return m ? m[1] : '';
    };
    const info = items.map((el, i) => {
      const name = cleanText((el.querySelector('.posCatalog_name') || el).textContent || '').slice(0, 40);
      // "章标题"行会把小节节点包在里面；用"是否包含列表里的另一项"来判断，
      // 不能用 class 名判断（同名 class 会是兄弟节点，会把所有项误判成组）
      let isGroup = false;
      try {
        isGroup = items.some((other) => other !== el && el.contains(other));
      } catch (_) {}
      const num = numOf(el);
      return {
        el,
        i,
        id: itemChapterId(el),
        name,
        num,
        depth: num ? num.split('.').length : 0,
        done: itemDone(el),
        active: itemActive(el),
        isGroup,
      };
    });
    log(
      '目录共 ' + info.length + ' 项（章标题 ' + info.filter((x) => x.isGroup).length +
        '，已完成 ' + info.filter((x) => x.done).length + '），当前 chapterId=' + (curId || '未知')
    );

    let curIdx = curId ? info.findIndex((x) => x.id && x.id === curId) : -1;
    // 页面大标题就是当前小节名——拿它在目录里对号入座最准
    const secName = pageSectionName();
    if (curIdx < 0 && secName) {
      const hits = info.map((x, i) => ({ x, i })).filter(({ x }) => x.name && (x.name.includes(secName) || secName.includes(x.name)));
      if (hits.length === 1) curIdx = hits[0].i;
      else if (hits.length > 1) {
        const notDone = hits.filter(({ x }) => !x.done);
        if (notDone.length === 1) curIdx = notDone[0].i;
      }
    }
    if (curIdx < 0) {
      const actives = info.map((x, i) => ({ x, i })).filter(({ x }) => x.active);
      if (actives.length === 1) curIdx = actives[0].i;
    }
    // 目录项没有 chapterId 时，靠页面标题里的编号（如 4.5）对号入座
    if (curIdx < 0) {
      const no = currentSectionNo();
      if (no) curIdx = info.findIndex((x) => x.num && x.num === no);
    }
    if (curIdx < 0) {
      // 再用"目录项文字里包含页面标题"来对号入座（有些皮肤没有 active 类、编号也不在行首）
      let title = '';
      try { title = cleanText(document.title || '').replace(/[_\-|].*$/, ''); } catch (_) {}
      if (title && title.length >= 4) {
        curIdx = info.findIndex((x) => x.name && (x.name.includes(title) || title.includes(x.name)));
      }
    }
    if (curIdx < 0) {
      // 认不出当前在哪一节，就别按"第一个未完成"瞎猜（会把课程从头再放一遍）
      log('认不出当前小节在目录里的位置，不敢乱点目录');
      return { ok: false, reason: '认不出当前小节（目录 ' + info.length + ' 项，active 一个都没有）' };
    }

    const usable = (x) => x && !x.done && !x.isGroup;
    let pool = info.filter((x) => x.i > curIdx && usable(x));
    if (!pool.length) pool = info.filter((x) => x.i < Math.max(curIdx, 0) && usable(x));
    if (!pool.length) return { ok: false, reason: '后面的小节看起来都已完成' };
    const target = pickNextTarget(pool);

    log('下一节：' + target.name + '（编号 ' + (target.num || '?') + ' / 章节 ' + (target.id || '?') + '）');
    const ok = await navigateTo(target.el);
    return ok ? { ok: true, how: '目录「' + target.name + '」' } : { ok: false, reason: '点了目录没反应（' + target.name + '）' };
  }

  const examNavTick = { chapter: '', opened: false };

  /** 本章还有没做的章节测验吗（同一章只主动切一次，避免来回切） */
  function examTabPending() {
    const ch = currentChapterId() || location.href;
    if (examGradedChapter === ch) return null;
    if (examNavTick.chapter === ch && examNavTick.opened) return null;
    let t = '';
    try {
      t = cleanText((document.body && document.body.innerText) || '');
    } catch (_) {}
    if (/我的答案\s*[:：]|本次成绩/.test(t)) return null;
    for (const el of tabItems()) {
      const s2 = cleanText(el.textContent || '');
      if (!/章节测验|章节测试/.test(s2)) continue;
      if (!visible(el)) continue;
      return el;
    }
    return null;
  }

  async function goNext(manual) {
    log('开始跳下一节（' + (manual ? '手动' : '自动') + '）chapterId=' + (currentChapterId() || '(无)'));
    if (!manual) {
      if (!cfg.enabled) return { ok: false, reason: '插件已关闭' };
      if (!cfg.autoNext) return { ok: false, reason: '自动下一节开关是关的' };
    }

    // 0) 本节视频看完了，但本章还有没做的章节测验 → 先去做题，别急着跳下一节
    if (!manual && cfg.autoChapterQuiz) {
      const tab = examTabPending();
      if (tab) {
        examNavTick.chapter = currentChapterId() || location.href;
        examNavTick.opened = true;
        clickHard(tab);
        await sleep(1200);
        let switched = false;
        try {
          switched = tabItems().some(
            (el) => /章节测验|章节测试/.test(cleanText(el.textContent || '')) && isActiveish(el)
          );
        } catch (_) {}
        log('本节看完了，先切到「章节测验」把题做掉（切换成功=' + (switched ? '是' : '否') + '）');
        if (!switched) {
          log('「章节测验」标签没切过去，改为直接跳下一节');
        } else setTimeout(() => {
          let t = '';
          try {
            t = cleanText((document.body && document.body.innerText) || '');
          } catch (_) {}
          if (/我的答案|本次成绩|已完成/.test(t)) {
            log('章节测验已经是做完的状态，继续下一节');
            scheduleNext();
          }
        }, 9000);
        if (switched) return { ok: true, how: '先做章节测验' };
      }
    }

    // 1) 页面上的「下一节」按钮优先（和学习通自己的交互一致，点了也能验证）
    const direct = pickFirst(NEXT_BUTTONS, true) || findNextByText();
    if (direct) {
      const label0 = cleanText(direct.textContent || direct.title || '').slice(0, 12);
      const before0 = currentKey();
      clickEl(direct);
      log('点击下一节按钮', label0 || '(无文字)');
      if (await waitNavigated(before0, 6000)) {
        return { ok: true, how: '下一节按钮' + (label0 ? '「' + label0 + '」' : '') };
      }
      log('下一节按钮点了没动，改走目录');
    }

    // 2) 目录兜底：点完能验证到底跳没跳
    const cat = await catalogNext();
    if (cat.ok) return cat;

    // 2) "下一节"按钮兜底，但点了必须验证，否则就是假成功
    const btn = pickFirst(NEXT_BUTTONS, true) || findNextByText() || pickFirst(NEXT_BUTTONS, false);
    if (btn) {
      const label = cleanText(btn.textContent || btn.title || '').slice(0, 12);
      const beforeKey = currentKey();
      clickEl(btn);
      log('点击下一节按钮', label || '(无文字)');
      if (await waitNavigated(beforeKey, 6000)) {
        return { ok: true, how: '下一节按钮' + (label ? '「' + label + '」' : '') };
      }
      log('点了下一节按钮但页面没动');
      return { ok: false, reason: cat.reason || '按钮点了没反应' };
    }

    return cat;
  }

  /* ================================================================== *
   * 弹题：识别 -> 求解 -> 作答
   * ================================================================== */
  const QUIZ_SELECTORS = [
    '.ans-videoquiz',
    '.ans-videoquiz-wrap',
    '.questionLayer',
    '.videoquiz',
    '.video-question',
    '.popup-question',
    '.question-wrap',
    '.topic-question',
  ];

  const STRICT_TITLE_SELECTORS = [
    '.ans-videoquiz-title',
    '.question-title',
    '.questionTitle',
    '.q-title',
    '.topic-title',
    '.Zy_TItle',
    '.stem',
  ];

  const QUIZ_HINT_RE = /(单选题|多选题|判断题|不定项|选择题|【.*题】)/;

  function quizSelectors() {
    const extra = String(cfg.quizSelectors || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return QUIZ_SELECTORS.concat(extra);
  }

  /** 避免把"匿名评论/评分"这类普通表单当成题目 */
  function looksLikeQuiz(root) {
    let t = '';
    try {
      t = cleanText(root.textContent || '');
    } catch (_) {
      return false;
    }
    if (t.length < 8 || t.length > 4000) return false;
    if (findSubmit(root)) return true;
    try {
      if (root.querySelector(STRICT_TITLE_SELECTORS.join(','))) return true;
    } catch (_) {}
    if (QUIZ_HINT_RE.test(t)) return true;
    return false;
  }

  const TITLE_SELECTORS = [
    '.ans-videoquiz-title',
    '.question-title',
    '.questionTitle',
    '.q-title',
    '.topic-title',
    '.stem',
    '.Zy_TItle',
    '.topic_title',
    '.subject_describe',
    '.question_name',
    '.ti-title',
    '.title',
    'h1',
    'h2',
    'h3',
    'h4',
  ];

  const SUBMIT_RE = /^(提交|提交答案|确定|确认|确定答案|确认答案|保存并提交|保存|下一题|继续)$/;

  /** 学习通常用自定义单选框：input 本身可能是 display:none，真正可见的是 label */
  function inputVisible(inp) {
    if (visible(inp)) return true;
    const label = inp.closest('label');
    if (label && visible(label)) return true;
    return !!(inp.parentElement && visible(inp.parentElement));
  }

  function choiceInputs(root) {
    try {
      return Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(
        (i) => !i.disabled && inputVisible(i)
      );
    } catch (_) {
      return [];
    }
  }

  function findSubmit(root) {
    let cands = [];
    try {
      cands = Array.from(root.querySelectorAll('button, a, div, span, input[type="submit"], input[type="button"]'));
    } catch (_) {}
    for (const el of cands) {
      const t = cleanText(el.textContent || el.value || '');
      if (!t || t.length > 8) continue;
      if (!SUBMIT_RE.test(t)) continue;
      if (!visible(el)) continue;
      if (el.querySelector('button, a, div')) continue; // 只要叶子节点
      return el;
    }
    return null;
  }

  function optionText(inp) {
    const label = inp.closest('label');
    if (label) {
      const t = cleanText(label.textContent);
      if (t) return t;
    }
    let p = inp.parentElement;
    for (let d = 0; p && d < 3; d++, p = p.parentElement) {
      if (p.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 1) break;
      const t = cleanText(p.textContent);
      if (t && t.length <= 200) return t;
    }
    const sib = inp.nextElementSibling;
    if (sib) {
      const t = cleanText(sib.textContent);
      if (t) return t;
    }
    return cleanText(inp.value || '') || '(选项 ' + (inp.value || '?') + ')';
  }

  function questionText(root, options) {
    for (const sel of TITLE_SELECTORS) {
      let el = null;
      try {
        el = root.querySelector(sel);
      } catch (_) {}
      if (el && visible(el)) {
        const t = cleanText(el.textContent);
        if (t.length >= 4 && t.length <= 800) return t;
      }
    }
    let t = cleanText(root.textContent);
    const first = options[0] && options[0].text;
    if (first) {
      const key = first.slice(0, Math.min(10, first.length));
      const i = t.indexOf(key);
      if (i > 2) t = t.slice(0, i);
    }
    t = t.replace(/(提交|确定|确认)$/g, '').trim();
    return t.slice(0, 800);
  }

  function extractQuiz(root) {
    const inputs = choiceInputs(root);
    if (inputs.length < 2) return null;
    const options = inputs.map((inp, index) => ({ index, input: inp, text: optionText(inp) }));
    // 过滤掉识别成空/重复的选项
    const texts = options.map((o) => o.text);
    if (new Set(texts).size < 2) return null;
    const multi = inputs.some((i) => i.type === 'checkbox');
    const q = questionText(root, options);
    if (!q || q.length < 2) return null;
    return { root, question: q, options, multi, submit: findSubmit(root) };
  }

  function collectQuizRoots() {
    const found = [];
    const push = (el) => {
      if (el && !found.includes(el)) found.push(el);
    };

    for (const sel of quizSelectors()) {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(sel));
      } catch (_) {}
      for (const el of list) {
        if (!visible(el)) continue;
        if (choiceInputs(el).length >= 2 && looksLikeQuiz(el)) push(el);
      }
    }

    if (!found.length) {
      // 通用兜底：从每个单/多选框往上找"最小的、含多个选项的容器"
      let inputs = [];
      try {
        inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      } catch (_) {}
      for (const inp of inputs) {
        if (!inputVisible(inp)) continue;
        let p = inp.parentElement;
        for (let d = 0; p && d < 12; d++, p = p.parentElement) {
          if (p === document.body || p === document.documentElement) break;
          const n = p.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
          if (n >= 2 && n <= 12) {
            const t = cleanText(p.textContent);
            if (t.length >= 6 && t.length <= 2000 && looksLikeQuiz(p)) push(p);
            break;
          }
        }
      }
    }

    // 只保留最内层容器
    const minimal = found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
    return minimal;
  }

  const handled = new Map(); // sig -> ts
  let scanning = false;
  let lastQuizSig = '';

  function submitOf(root) {
    return findSubmit(root);
  }

  /** 弹题答完（或答错）后学习通会挂一层"继续学习"遮罩把视频停住，得点掉才能继续 */
  // 这一类文字只出现在"答题完毕、等你确认"的遮罩上，看到就能点，不需要别的条件
  const CONTINUE_STRONG = /^(继续学习|继续播放|继续观看|继续看|继续观看视频|继续听课)$/;
  // 这一类太泛（很多弹窗都有"确定"），必须确认视频真的被停住才点
  const CONTINUE_WEAK = /^(继续|知道了|我知道了|确定|确认|好的|好|关闭|我知道了。)$/;

  function ownText(el) {
    return cleanText(el.textContent || el.value || '');
  }

  function findContinueBtn() {
    let els = [];
    try {
      els = Array.from(
        document.querySelectorAll('a, button, div, span, li, p, input[type="button"], input[type="submit"]')
      );
    } catch (_) {}
    const strong = [];
    const weak = [];
    for (const el of els) {
      try {
        if (el.closest('.cx-toast')) continue;
      } catch (_) {}
      if (!visible(el)) continue;
      const t = ownText(el);
      if (!t || t.length > 10) continue;
      if (CONTINUE_STRONG.test(t)) strong.push(el);
      else if (CONTINUE_WEAK.test(t)) weak.push(el);
    }
    // 取最内层的那个：点内层文本，事件照样冒泡到外层按钮
    const inner = (list) => {
      if (!list.length) return null;
      list.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return list[0];
    };
    return { strong: inner(strong), weak: inner(weak) };
  }

  function videoPausedSomewhere() {
    try {
      for (const v of document.querySelectorAll('video')) if (v.paused && !v.ended) return true;
    } catch (_) {}
    const fv = lastFrameState.video;
    // 窗口放宽到 30s：子框架每 3 轮才上报一次，太短会漏判
    if (fv && fv.paused && !fv.ended && (!lastFrameState.at || Date.now() - lastFrameState.at < 30000)) return true;
    return false;
  }

  function dismissBlockingOverlay() {
    if (!cfg.enabled || !cfg.keepPlaying) return;
    const btn = findContinueBtn();
    // 1) "继续学习/继续播放"这类只可能是遮挡层 → 无条件点
    if (btn.strong) {
      clickHard(btn.strong);
      log('点掉遮挡层「' + ownText(btn.strong).slice(0, 10) + '」');
      return;
    }
    // 2) 泛化按钮：确认视频确实被停住才点，避免误触章节测验的"确定"
    if (btn.weak && videoPausedSomewhere()) {
      clickHard(btn.weak);
      log('点掉遮挡按钮「' + ownText(btn.weak).slice(0, 10) + '」');
    }
  }

  /** 只问"这道题选什么"，不动页面。弹题与章节测验共用。 */
  async function askBrain(quiz) {
    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: '答题服务超时' }), 45000);
        try {
          chrome.runtime.sendMessage(
            {
              type: 'solve',
              question: quiz.question,
              options: quiz.options.map((o) => o.text),
              multi: quiz.multi,
              url: location.href,
            },
            (r) => {
              clearTimeout(timer);
              if (chrome.runtime.lastError) {
                resolve({ ok: false, reason: '后台无响应：' + chrome.runtime.lastError.message });
              } else resolve(r || { ok: false, reason: '后台无响应' });
            }
          );
        } catch (e) {
          clearTimeout(timer);
          resolve({ ok: false, reason: '发送失败：' + (e && e.message) });
        }
      });
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  async function solveAndAnswer(quiz, force) {
    const sig = hashStr(quiz.question + '||' + quiz.options.map((o) => o.text).join('|'));
    const seen = handled.get(sig);
    if (!force && seen && Date.now() - seen < 10 * 60 * 1000) return { skipped: true };
    handled.set(sig, Date.now());

    lastQuizSig = sig;
    log('识别到弹题（' + (quiz.multi ? '多选' : '单选') + '）：' + quiz.question.slice(0, 80));
    quiz.options.forEach((o, i) => log('  选项' + i + '：' + o.text.slice(0, 60)));

    const res = await askBrain(quiz);

    if (!res || !res.ok || !Array.isArray(res.answers) || !res.answers.length) {
      const why = (res && res.reason) || '没拿到答案';
      log('答题失败：' + why);
      toast('弹题未能自动作答：' + why, 'warn');
      markQuizFailed(quiz, why);
      return { ok: false, reason: why };
    }

    let answers = res.answers
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < quiz.options.length);
    // 单选框点第二个会把第一个顶掉，所以单选只取第一个
    if (!quiz.multi && answers.length > 1) answers = answers.slice(0, 1);
    if (!answers.length) {
      log('答案下标越界：', res.answers);
      return { ok: false, reason: '答案格式不对' };
    }

    const chosen = answers.map((i) => quiz.options[i].text).join(' / ');
    log('作答（来源 ' + (res.source || '?') + '）：' + chosen);
    await applyAnswers(quiz, answers);

    const txt = chosen.length > 40 ? chosen.slice(0, 40) + '…' : chosen;
    toast('已作答：' + txt, 'ok');
    return { ok: true, answers, source: res.source };
  }

  async function applyAnswers(quiz, answers) {
    for (const idx of answers) {
      const opt = quiz.options[idx];
      if (!opt || !opt.input) continue;
      const inp = opt.input;
      if (inp.checked) continue;
      clickEl(inp);
      await sleep(120 + Math.random() * 160);
      if (!inp.checked) {
        const label = inp.closest('label');
        if (label) clickEl(label);
        else if (inp.parentElement) clickEl(inp.parentElement);
        await sleep(150);
      }
    }

    // 多选一般需要手动提交；单选很多播放器点完即判
    if (!document.contains(quiz.root)) {
      log('容器已关闭（点选即判定），跳过提交');
      return;
    }
    const btn = submitOf(quiz.root) || (quiz.submit && visible(quiz.submit) ? quiz.submit : null);
    if (btn) {
      await sleep(quiz.multi ? 500 : 260);
      clickEl(btn);
      log('已点击提交');
    } else {
      log('没有提交按钮，按"点选即判定"处理');
    }

    // 有些弹题提交后还有个"知道了/继续"的确认
    setTimeout(() => {
      try {
        const btns = Array.from(document.querySelectorAll('button, a, div, span'));
        for (const b of btns) {
          const t = cleanText(b.textContent || '');
          if (t && t.length <= 6 && /^(知道了|好的|继续|继续播放)$/.test(t) && visible(b)) {
            clickEl(b);
            break;
          }
        }
      } catch (_) {}
    }, 1200);
  }

  function markQuizFailed(quiz, why) {
    try {
      window.top.postMessage({ __cx: 'toast', text: '弹题需要手动作答：' + why, kind: 'warn' }, '*');
    } catch (_) {}
  }

  function logQuizDiagnostics() {
    let inputs = [];
    try {
      inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    } catch (_) {}
    const vis = inputs.filter(inputVisible);
    log('诊断：单/多选框共 ' + inputs.length + ' 个，可见 ' + vis.length + ' 个');
    if (!inputs.length) {
      log('诊断：本框架没有 radio/checkbox —— 题目可能还没弹出，或在别的 iframe 里（点插件里的"识别当前题目"会逐个框架扫描）');
      return;
    }
    for (const inp of vis.slice(0, 6)) {
      log('诊断容器：', classChain(inp));
    }
  }

  function classChain(el) {
    const parts = [];
    let p = el.parentElement;
    for (let d = 0; p && d < 5; d++, p = p.parentElement) {
      let s = p.tagName.toLowerCase();
      if (p.id) s += '#' + p.id;
      const cn = typeof p.className === 'string' ? p.className.trim() : '';
      if (cn) s += '.' + cn.split(/\s+/).slice(0, 3).join('.');
      parts.push(s);
    }
    return parts.join(' < ');
  }

  async function scanQuiz(force) {
    if (scanning) return;
    if (!cfg.enabled) return;
    if (!cfg.autoQuiz) return;
    scanning = true;
    try {
      const roots = collectQuizRoots();
      if (!roots.length) {
        if (force) logQuizDiagnostics();
        return;
      }
      for (const root of roots) {
        const quiz = extractQuiz(root);
        if (!quiz) continue;
        if (!force) {
          // 已经答过的题（页面上有"正确答案"或输入框 disabled）就别再动
          const t = cleanText(root.textContent || '');
          if (/正确答案|回答正确|已提交|答案已记录/.test(t)) continue;
          if (quiz.options.every((o) => o.input.disabled)) continue;
        }
        await solveAndAnswer(quiz, force);
        await sleep(600);
      }
    } catch (e) {
      log('扫描题目出错', e && e.message);
    } finally {
      scanning = false;
    }
  }

  /* ================================================================== *
   * 章节测验（整卷）：逐题问大模型 → 全部填好 → 点提交
   * 默认关闭；只有面板里打开「章节测验自动作答」才会动，而且填不全不提交。
   * ================================================================== */
  const EXAM_BLOCK_SEL = ['.TiMu', '.questionLi', '.question-item', '.mark_item', '.exam-question'];
  const EXAM_SUBMIT_TEXT = ['提交', '提交答案', '交卷', '提交试卷', '保存并提交'];
  let examTick = { lastTry: 0, filling: false, submitted: '' };

  /** 这一页像不像章节测验（有题量/满分/题型字样，或当前选中的标签是"章节测验"） */
  function looksLikeExamPage() {
    let t = '';
    try {
      t = cleanText((document.body && document.body.innerText) || '').slice(0, 3000);
    } catch (_) {}
    if (/题量\s*[:：]|满分\s*[:：]|\d+\s*题\s*\/|单选题|多选题|判断题/.test(t)) return true;
    return /测验|考试|作业/.test(activeTabText());
  }

  /* ---- 顶部那排标签（1 学习目标 / 2 视频 / 2 章节测验）---- */
  const TAB_TEXT_RE = /^(?:\d+\s*)?(视频|章节测验|章节测试|学习目标|作业|考试|讨论|资料|拓展|测验)$/;

  function tabItems() {
    const out = [];
    let list = [];
    try {
      list = Array.from(document.querySelectorAll('a, li, div, span'));
    } catch (_) {}
    for (const el of list) {
      const t = cleanText(el.textContent || '');
      if (!t || !TAB_TEXT_RE.test(t)) continue;
      if (!visible(el)) continue;
      if (el.querySelectorAll('*').length > 3) continue; // 只要标签本身
      out.push(el);
    }
    return out;
  }

  /** 选中态：class 里有 active/cur/selected，或底色是明显的蓝 */
  function isActiveish(el) {
    let p = el;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      let cls = '';
      try {
        cls = String(p.className || '') + ' ' + String((p.getAttribute && p.getAttribute('class')) || '');
      } catch (_) {}
      if (/\b(active|cur|current|selected|on|checked)\b/i.test(cls) || /(active|cur$|current|selected|checked|itemOn|on$)/i.test(cls)) return true;
      try {
        const bg = getComputedStyle(p).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = +m[1];
          const g = +m[2];
          const b = +m[3];
          if (b > 150 && b - r > 40 && b - g > 20) return true; // 蓝底白字那种选中态
        }
      } catch (_) {}
    }
    return false;
  }

  function activeTabText() {
    const items = tabItems();
    for (const el of items) if (isActiveish(el)) return cleanText(el.textContent || '');
    return '';
  }

  function examBlocks() {
    let best = [];
    for (const sel of EXAM_BLOCK_SEL) {
      let found = [];
      try {
        found = Array.from(document.querySelectorAll(sel));
      } catch (_) {}
      found = found.filter((el) => visible(el) && choiceInputs(el).length >= 2);
      if (found.length > best.length) best = found;
    }
    if (!best.length) best = examBlocksByInputs();
    // 去掉嵌套：只留最外层，避免同一道题被算两遍
    return best.filter((el) => !best.some((o) => o !== el && el.contains(o)));
  }

  /** 兜底：不认容器 class 时，从"第一个包含 ≥2 个选项的父节点"反推题块 */
  function examBlocksByInputs() {
    const out = [];
    let inputs = [];
    try {
      inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(inputVisible);
    } catch (_) {}
    for (const inp of inputs) {
      let p = inp.parentElement;
      let best = null;
      for (let d = 0; p && d < 8; d++, p = p.parentElement) {
        let n = 0;
        try {
          n = p.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
        } catch (_) {}
        if (n >= 2) {
          best = p;
          break;
        }
      }
      if (!best) continue;
      if (out.some((o) => o === best || o.contains(best))) continue;
      out.push(best);
    }
    return out;
  }

  function examBlockFilled(block) {
    try {
      return choiceInputs(block).some((i) => i.checked);
    } catch (_) {
      return false;
    }
  }

  function examDone(block) {
    return /正确答案\s*[:：]|已批阅|本题得分/.test(cleanText(block.textContent || ''));
  }

  function examSubmitBtn() {
    let cands = [];
    try {
      cands = Array.from(document.querySelectorAll('a, button, div, span, input[type="button"], input[type="submit"]'));
    } catch (_) {}
    for (const el of cands) {
      if (!visible(el)) continue;
      const t = cleanText(el.textContent || el.value || '');
      if (!t || t.length > 10) continue;
      if (!EXAM_SUBMIT_TEXT.includes(t)) continue;
      if (el.querySelector('a, button, div, span')) continue; // 只要叶子
      if (el.closest('.TiMu, .questionLi, .question-item')) continue; // 题内的小按钮不算
      return el;
    }
    return null;
  }

  /** 只勾选项，不点提交（整卷一起提交） */
  async function applyChoiceOnly(quiz, answers) {
    for (const idx of answers) {
      const opt = quiz.options[idx];
      if (!opt || !opt.input) continue;
      if (opt.input.checked) continue;
      clickEl(opt.input);
      await sleep(120 + Math.random() * 160);
      if (!opt.input.checked) {
        const label = opt.input.closest('label');
        if (label) clickEl(label);
        else if (opt.input.parentElement) clickEl(opt.input.parentElement);
        await sleep(150);
      }
    }
  }

  /** 交卷弹窗：先看它是不是在警告"还有没做完的"，是就取消，绝不硬交 */
  /** 能搜到的所有文档：自己 + 各级父框架 + 子框架（弹窗可能不在发起点击的那个框架里） */
  function dialogDocs() {
    const docs = [document];
    let w = window;
    for (let i = 0; i < 6; i++) {
      try {
        if (!w.parent || w.parent === w) break;
        w = w.parent;
        if (w.document && docs.indexOf(w.document) < 0) docs.push(w.document);
      } catch (_) {
        break;
      }
    }
    const addKids = (doc) => {
      try {
        for (const f of doc.querySelectorAll('iframe')) {
          let d = null;
          try {
            d = f.contentDocument;
          } catch (_) {}
          if (d && docs.indexOf(d) < 0) {
            docs.push(d);
            addKids(d);
          }
        }
      } catch (_) {}
    };
    for (const d of docs.slice()) addKids(d);
    return docs;
  }

  function examDialogRoot() {
    const RE = /未做完|还有.{0,8}未|确认提交|确定要?提交|确认要?提交|提交试卷吗|提交吗|确认交卷/;
    let best = null;
    for (const doc of dialogDocs()) {
      let list = [];
      try {
        list = Array.from(doc.querySelectorAll('div, section, article, form'));
      } catch (_) {
        continue;
      }
      for (const el of list) {
        if (!visible(el)) continue;
        const t = cleanText(el.textContent || '');
        if (!t || t.length > 300) continue;
        if (!RE.test(t)) continue;
        if (!/取消/.test(t) || !/提交/.test(t)) continue;
        if (best && best.contains(el)) continue;
        best = el;
        if (best && best.parentElement && best.parentElement.textContent.length < 320) {
          // 继续往上找更完整的弹窗，但别超过一层
        }
      }
      if (best) return { root: best, text: cleanText(best.textContent || '') };
    }
    return null;
  }

  async function confirmExamSubmit() {
    // 弹窗可能是动画进来的，多等几轮
    let dlg = null;
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 700 : 700);
      dlg = examDialogRoot();
      if (dlg) break;
    }
    if (!dlg) {
      log('没看到确认弹窗（可能已经交了）');
      return 'none';
    }
    const scope = dlg.root;
    // 页面自己说"还有未做完的题"→ 取消，绝不硬交
    if (/未做完|还有.*未|请完成|不能提交/.test(dlg.text)) {
      for (const el of Array.from(scope.querySelectorAll('a, button, div, span'))) {
        if (!visible(el)) continue;
        const t = cleanText(el.textContent || '');
        if (!/^(取消|关闭|再想想)$/.test(t)) continue;
        if (el.querySelector('a, button, div, span')) continue;
        clickHard(el);
        log('弹窗说还有没做完的题，已点「' + t + '」取消提交');
        return 'cancel';
      }
      log('弹窗说还有没做完的题，但没找到「取消」，请你手动点取消');
      return 'cancel';
    }
    // 候选：文字是"提交/确定"的最内层元素，再往上两层的容器也留着（有的按钮点位在父节点上）
    const cands = [];
    for (const el of Array.from(scope.querySelectorAll('a, button, div, span'))) {
      if (!visible(el)) continue;
      const t = cleanText(el.textContent || '');
      if (!/^(提交|确定|确认|确定提交|确认提交|是的|是)$/.test(t)) continue;
      if (el.querySelector('a, button, div, span')) continue;
      if (el.closest('.TiMu, .questionLi, .question-item')) continue;
      cands.push({ el, t });
    }
    if (!cands.length) return 'none';

    // 点一版、看弹窗还在不在；还在就换"更外层/键盘回车"再试
    for (const { el, t } of cands) {
      for (const target of [el, el.parentElement, el.parentElement && el.parentElement.parentElement]) {
        if (!target) continue;
        clickHard(target);
        await sleep(1100);
        if (!examDialogRoot()) {
          log('已确认提交弹窗「' + t + '」（点了 ' + target.tagName.toLowerCase() + '）');
          return 'ok';
        }
      }
      // 最后一招：聚焦后回车
      try {
        if (el.focus) el.focus();
        const ev = (type, code) => new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        el.dispatchEvent(ev('keydown'));
        el.dispatchEvent(ev('keypress'));
        el.dispatchEvent(ev('keyup'));
        await sleep(1100);
        if (!examDialogRoot()) {
          log('已确认提交弹窗「' + t + '」（用回车）');
          return 'ok';
        }
      } catch (_) {}
    }
    log('确认弹窗点了没反应，它还在（先别自动跳，免得白等）');
    return 'stuck';
  }

  async function solveChapterQuiz() {
    if (!cfg.enabled || !cfg.autoChapterQuiz) return; // 题目可能整块在 iframe 里，所以不限定顶层
    if (examTick.filling) return;
    const blocks = examBlocks();
    if (!blocks.length) return;
    const key = location.href + '#' + blocks.length;
    if (examTick.submitted === key) return;
    if (Date.now() - examTick.lastTry < 15000) return; // 失败的题别每轮都问一遍

    examTick.lastTry = Date.now();
    examTick.filling = true;
    try {
      const todo = blocks.filter((b) => !examBlockFilled(b) && !examDone(b));
      if (todo.length) {
        log('章节测验：共 ' + blocks.length + ' 道题，' + todo.length + ' 道待填，开始作答');
        let ok = 0;
        for (const b of todo) {
          const quiz = extractQuiz(b);
          if (!quiz) {
            log('测验：这一块认不出选项，先跳过');
            continue;
          }
          log('测验作答（' + (quiz.multi ? '多选' : '单选') + '）：' + quiz.question.slice(0, 60));
          const res = await askBrain(quiz);
          if (!res || !res.ok || !Array.isArray(res.answers) || !res.answers.length) {
            log('测验答题失败：' + ((res && res.reason) || '没拿到答案'));
            continue;
          }
          let answers = res.answers
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < quiz.options.length);
          if (!quiz.multi && answers.length > 1) answers = answers.slice(0, 1);
          if (!answers.length) continue;
          await applyChoiceOnly(quiz, answers);
          ok += 1;
          log(
            '已填第 ' + ok + ' 题（' + (res.source || '?') + '）：' +
              answers.map((i) => quiz.options[i].text.slice(0, 16)).join(' / ')
          );
          await sleep(400);
        }
      }

      const left = examBlocks().filter((b) => !examBlockFilled(b) && !examDone(b));
      if (left.length) {
        log('还有 ' + left.length + ' 道题没填上，先不提交（填齐了会自动提交）');
        return;
      }
      const btn = examSubmitBtn();
      if (!btn) {
        log('题目都填好了，但没找到「提交」按钮，请手动提交');
        return;
      }
      const label = cleanText(btn.textContent || '') || '提交';
      clickEl(btn);
      log('已点击「' + label + '」');
      await confirmExamSubmit();
      examTick.submitted = key;
      toast('章节测验已作答并提交', 'ok');
    } catch (e) {
      log('章节测验出错：' + ((e && e.message) || e));
    } finally {
      examTick.filling = false;
    }
  }

  /* ---------------------------------------------------------------- *
   * 文字版章节测验（2025 新版）
   * 新版把整份卷子塞在 mooc-ans/work/selectWorkQuestion 这个框架里，
   * 页面里一个 input 都没有，选项是 div/span 画的。
   * 所以：按文字解析题目 -> 按文字找到选项节点 -> 点掉 -> 靠样式变化确认。
   * ---------------------------------------------------------------- */
  const EXAM_TAG_RE = /【\s*(多选题|单选题|判断题|填空题|简答题|论述题|名词解释)\s*】/;
  let textExamTick = { last: 0, busy: false, done: '' };

  function examPlainText() {
    try {
      return String((document.body && document.body.innerText) || '');
    } catch (_) {
      return '';
    }
  }

  function looksLikeTextExam() {
    const t = examPlainText();
    if (!t) return false;
    if (!/题量\s*[:：]|满分\s*[:：]/.test(t.slice(0, 1500))) return false;
    return EXAM_TAG_RE.test(t);
  }

  function typeOfTag(tag) {
    if (/多选/.test(tag)) return 'multi';
    if (/判断/.test(tag)) return 'judge';
    if (/单选/.test(tag)) return 'single';
    return 'text'; // 填空/简答/论述：不处理
  }

  /** 把整页文字解析成 [{type, stem, options:[{letter,text}]}] */
  function parseTextExam() {
    const lines = examPlainText()
      .split(/\r?\n/)
      .map((s) => cleanText(s))
      .filter((s) => s !== '');
    const out = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const tag = ln.match(EXAM_TAG_RE);
      if (tag) {
        cur = { type: typeOfTag(tag[1]), stem: [], options: [] };
        const rest = cleanText(ln.slice(ln.indexOf(tag[0]) + tag[0].length));
        if (rest) cur.stem.push(rest);
        out.push(cur);
        continue;
      }
      if (!cur) continue;
      const mo = ln.match(/^([A-H])(?:\s*[、.．:：)）]\s*|\s+)(.*)$/) || ln.match(/^([A-H])$/);
      if (mo) {
        let text = cleanText(mo[2]);
        if (!text) {
          const nx = lines[i + 1];
          if (nx && !/^[A-H]\s*[、.．:：)）]/.test(nx) && !EXAM_TAG_RE.test(nx)) {
            text = cleanText(nx);
            i += 1;
          }
        }
        cur.options.push({ letter: mo[1], text: text || '选项 ' + mo[1] });
        continue;
      }
      if (!cur.options.length) cur.stem.push(ln);
    }
    for (const q of out) {
      // 判断题有时只写"对 / 错"，没有 A/B
      if (q.type === 'judge' && q.options.length < 2) {
        q.options = [
          { letter: 'A', text: '对' },
          { letter: 'B', text: '错' },
        ];
      }
    }
    return out.filter((q) => q.options.length >= 2 && q.type !== 'text');
  }

  /** 按"字母 + 选项文字"找出最内层的可点节点 */
  function findOptionNode(opt) {
    let list = [];
    try {
      list = Array.from(document.querySelectorAll('div, li, span, a, p, label, td'));
    } catch (_) {}
    const hits = [];
    const letterRe = new RegExp('^' + opt.letter + '\\s*[、.．:：)）]?');
    for (const el of list) {
      if (!visible(el)) continue;
      const t = cleanText(el.textContent || '');
      if (!t || t.length > 300) continue;
      const body = cleanText(t.replace(letterRe, ''));
      const okBody = body === opt.text || t === opt.text || t.indexOf(opt.text) >= 0;
      const okJudge = (opt.text === '对' || opt.text === '错') && t === opt.text;
      if (!okBody && !okJudge) continue;
      hits.push(el);
    }
    if (!hits.length) return null;
    const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    return inner[inner.length - 1] || hits[hits.length - 1];
  }

  /** 整块 HTML 的指纹：任何 class / 样式 / 子元素变化都会变 */
  function htmlSig(el) {
    let s = '';
    try {
      s = String((el && el.innerHTML) || '');
    } catch (_) {}
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return s.length + ':' + h;
  }

  /** 往上找到"含至少两个字母选项"的那一块，作为比对范围 */
  function optionRowScope(node) {
    const letterCount = (p) => {
      let n = 0;
      try {
        for (const x of p.querySelectorAll('*')) {
          if (x.children.length) continue;
          const t = cleanText(x.textContent || '');
          if (/^[A-H]$/.test(t)) n += 1;
          if (n >= 2) break;
        }
      } catch (_) {}
      return n;
    };
    let p = node;
    for (let i = 0; i < 6 && p && p.parentElement; i++) {
      p = p.parentElement;
      if (p === document.body || p === document.documentElement) break;
      if (letterCount(p) >= 2) return p;
    }
    return node.parentElement || node;
  }

  /** 点一个选项，返回"这一块 HTML 有没有变化"（变了基本就是选上了） */
  async function clickOptionNode(node) {
    const scope = optionRowScope(node);
    const before = htmlSig(scope);
    const targets = [node];
    let up = node;
    for (let i = 0; i < 3 && up && up.parentElement; i++) {
      up = up.parentElement;
      if (up === document.body) break;
      targets.push(up);
    }
    for (const t of targets) {
      try {
        clickHard(t);
      } catch (_) {}
      await sleep(170 + Math.random() * 110);
      if (htmlSig(scope) !== before) return true;
    }
    return false;
  }

  /** 只负责点「提交」，确认弹窗交给调用方处理 */
  async function submitTextExam() {
    let cands = [];
    try {
      cands = Array.from(document.querySelectorAll('a, button, div, span, input[type="button"], input[type="submit"]'));
    } catch (_) {}
    for (const el of cands) {
      if (!visible(el)) continue;
      const t = cleanText(el.textContent || el.value || '');
      if (!/^(提交|提交答案|交卷|提交试卷|保存并提交|提交作业)$/.test(t)) continue;
      if (el.querySelector('a, button, div, span')) continue;
      clickHard(el);
      log('已点提交「' + t + '」');
      await sleep(700);
      return true;
    }
    return false;
  }

  function examDeclaredCount() {
    const m = examPlainText().match(/题量\s*[:：]\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  /** 新版卷子懒加载：不滚到底，innerText 里只有已经渲染出来的题 */
  async function scrollLoadAll() {
    const el = document.scrollingElement || document.documentElement;
    try {
      const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y < el.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await sleep(220);
      }
      window.scrollTo(0, el.scrollHeight);
      await sleep(600);
      window.scrollTo(0, 0);
      await sleep(300);
    } catch (_) {}
  }

  async function solveTextExam() {
    if (!cfg.enabled || !cfg.autoChapterQuiz) return;
    if (textExamTick.busy) return;
    const t = examPlainText();
    // 已经答过 / 已批阅的卷子，绝不要再动；但要把"这章测验做完了"告诉顶层，好切回视频
    if (/我的答案\s*[:：]|本次成绩|已批阅|AI讲解/.test(t)) {
      if (!textExamTick.gradedAt) {
        textExamTick.gradedAt = Date.now();
        log('本章测验已是批阅状态，切回视频别在这儿停着');
        try { window.top.postMessage({ __cx: 'examGraded' }, '*'); } catch (_) {}
      }
      return;
    }
    if (!looksLikeTextExam()) return;
    let qs = parseTextExam();
    const declared = examDeclaredCount();
    if (declared && qs.length < declared) {
      log('页面写了 ' + declared + ' 题，只解析到 ' + qs.length + ' 题，先把整卷滚一遍再解析');
      await scrollLoadAll();
      qs = parseTextExam();
    }
    if (!qs.length) return;
    const key = location.href + '#' + qs.length;
    if (textExamTick.done === key) return;
    if (Date.now() - textExamTick.last < 15000) return;

    textExamTick.last = Date.now();
    textExamTick.busy = true;
    try {
      log('章节测验（文字版）：共 ' + qs.length + ' 题，开始作答');
      let filled = 0;
      const unverified = [];
      for (let qi = 0; qi < qs.length; qi++) {
        const q = qs[qi];
        const quiz = {
          question: cleanText(q.stem.join(' ')).slice(0, 600),
          options: q.options.map((o, i) => ({ index: i, input: null, text: o.letter + '、' + o.text })),
          multi: q.type === 'multi',
        };
        if (!quiz.question) continue;
        log(
          '测验第 ' + (qi + 1) + ' 题（' +
            (q.type === 'multi' ? '多选' : q.type === 'judge' ? '判断' : '单选') +
            '）：' + quiz.question.slice(0, 50)
        );
        const res = await askBrain(quiz);
        if (!res || !res.ok || !Array.isArray(res.answers) || !res.answers.length) {
          log('第 ' + (qi + 1) + ' 题没拿到答案：' + ((res && res.reason) || '未知'));
          continue;
        }
        let idxs = res.answers
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
        if (q.type !== 'multi' && idxs.length > 1) idxs = idxs.slice(0, 1);
        let hit = 0;
        let changedAny = false;
        for (const idx of idxs) {
          const opt = q.options[idx];
          const node = findOptionNode(opt);
          if (!node) {
            log('找不到选项 ' + opt.letter + ' 的可点击位置');
            continue;
          }
          const changed = await clickOptionNode(node);
          log('点选 ' + opt.letter + (changed ? '（样式已变化）' : '（样式没变，需要盯一眼）'));
          hit += 1;
          if (changed) changedAny = true;
        }
        if (hit) filled += 1;
        if (hit && !changedAny) unverified.push(qi + 1);
        await sleep(300);
      }
      if (unverified.length) log('这几题点了但看不出选中效果：第 ' + unverified.join('、') + ' 题（提交后会以页面的提示为准）');
      if (filled < qs.length) {
        log('只填了 ' + filled + '/' + qs.length + ' 题，先不提交');
        return;
      }
      const ok = await submitTextExam();
      if (!ok) {
        log('都填好了，但没找到「提交」按钮，请手动交');
        return;
      }
      const verdict = await confirmExamSubmit();
      if (verdict === 'stuck') {
        textExamTick.last = Date.now() + 30000;
        toast('交卷确认弹窗没点动，请手动点一下「提交」', 'warn');
        return;
      }
      if (verdict === 'cancel') {
        // 页面自己说还有没做完的题：取消掉，等一会儿再试，别硬交
        textExamTick.last = Date.now() + 45000;
        log('已取消提交（页面说还有没做完的题），稍后重试');
        return;
      }
      if (verdict === 'ok') {
        textExamTick.done = key;
        toast('章节测验已作答并提交', 'ok');
        log('本章测验做完了，通知顶层去点「下一节」');
        try {
          // 顶层活得比这个 iframe 久：交卷后本框架会被重建，定时器必须放在顶层
          if (IS_TOP) examSubmittedTop();
          else window.top.postMessage({ __cx: 'examSubmitted' }, '*');
        } catch (e) { log('通知顶层失败：' + e); }
      } else {
        textExamTick.done = key;
        log('提交后没看到确认弹窗，可能已经交了（请看一眼页面）');
      }
    } catch (e) {
      log('文字版章节测验出错：' + ((e && e.message) || e));
    } finally {
      textExamTick.busy = false;
    }
  }

  /* ================================================================== *
   * 循环
   * ================================================================== */
  let loopTimer = null;

  /** 顶层用来汇总子框架里的视频情况（学习通的视频通常在 iframe 里） */
  const lastFrameState = {};

  function reportFrameState() {
    if (IS_TOP) return;
    let video = null;
    try {
      const el = document.querySelector('video');
      if (el) {
        video = {
          paused: el.paused,
          currentTime: Math.round(el.currentTime || 0),
          duration: Math.round(el.duration || 0),
          rate: el.playbackRate,
          muted: el.muted,
        };
      }
    } catch (_) {}
    let quizCount = 0;
    try {
      quizCount = collectQuizRoots().length;
    } catch (_) {}
    const emptyHint = hasEmptyHint();
    if (!video && !quizCount && !emptyHint) return;
    // 反挂机的拦截统计发生在子框架的主世界里，顶层看不到，一起带上去
    const stats = {
      paused: mainState.paused || 0,
      resumed: mainState.resumed || 0,
      visible: mainState.visible,
      playing: mainState.playing,
      videos: mainState.videos,
    };
    // 子框架的日志也带上去，否则顶层弹窗里只看得到"已注入"一行
    const frameLogs = logs.slice(-6);
    try {
      window.top.postMessage({ __cx: 'frameState', payload: { video, quizCount, stats, frameLogs, emptyHint } }, '*');
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 空章节：没有视频、也没有题目（页面只显示"暂无内容"）
   * 这种情况下既不会有 video ended，也不会有弹题，必须自己发现并跳过，
   * 否则整条自动连播就断在这里。
   * ------------------------------------------------------------------ */
  const EMPTY_RE = /暂无内容|无内容|没有内容|本章节暂无|暂无学习内容|尚未添加|暂无任务点/;
  let emptyTick = { id: '', n: 0, done: '', told: '' };

  /** "暂无内容"这几个字通常长在内容 iframe 里，所以每个框架各自判断一次 */
  function hasEmptyHint() {
    let txt = '';
    try {
      txt = cleanText((document.body && document.body.innerText) || '');
    } catch (_) {}
    if (!txt) return false;
    return EMPTY_RE.test(txt.slice(0, 4000));
  }

  function anyVisibleVideo() {
    try {
      for (const v of document.querySelectorAll('video')) {
        if (visible(v)) return true;
      }
    } catch (_) {}
    return false;
  }

  function anyVisibleQuiz() {
    try {
      const sels = QUIZ_SELECTORS.concat(['input[type="radio"]', 'input[type="checkbox"]']);
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (visible(el)) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 有的小节是"多标签页"结构（学习目标 / 视频 / 章节测验），默认停在
   * 「学习目标」这种纯文字页上就没有视频可播，也不会触发任何事件。
   * 这时先替用户点一下「视频」标签；点完还是没有视频、没有题，才当成没内容跳过。
   * ------------------------------------------------------------------ */
  const VIDEO_TAB_RE = /^(?:\d+\s*)?视频$/;
  let videoTabTick = { id: '', tried: '' };

  function videoTabCandidates() {
    const out = [];
    try {
      for (const el of document.querySelectorAll('a, li, div, span')) {
        if (!visible(el)) continue;
        const t = cleanText(el.textContent || '');
        if (!t || t.length > 10) continue;
        if (!VIDEO_TAB_RE.test(t)) continue;
        if (el.querySelector('a, button, li')) continue; // 只要最内层
        out.push(el);
      }
    } catch (_) {}
    return out;
  }

  function pageHasVideo() {
    try {
      for (const v of document.querySelectorAll('video')) {
        if (visible(v)) return true;
      }
    } catch (_) {}
    const fv = lastFrameState.video;
    return !!(fv && lastFrameState.at && Date.now() - lastFrameState.at < 15000);
  }

  /** 学习目标/章测这类"有内容但没有视频"的标签页，帮用户切到「视频」 */
  function ensureVideoTab(force) {
    if (!IS_TOP) return;
    if (!cfg.enabled || !cfg.autoNext) return;
    // force 是"我们自己判定该切了"（比如这章测验已批阅），此时别拿"别处有视频"当理由不动
    if (!force && pageHasVideo()) return;
    // 章节测验页不要去"切视频标签"——那会把用户正在做的卷子切走
    if (!force && looksLikeExamPage() && examGradedChapter !== (currentChapterId() || location.href)) return;
    // 用户刚自己点过页面（比如手动切了标签），60 秒内不抢；force 时例外（那是我们自己判定该切了）
    if (!force && Date.now() - lastTrustedPointer < 60000) {
      log('暂不切视频标签：你刚点过页面，60s 内不抢');
      return;
    }
    const cid = currentChapterId() || location.href;
    if (!force) {
      if (videoTabTick.id !== cid) videoTabTick = { id: cid, tried: '' };
      if (videoTabTick.tried === cid) return;
    }
    const tabs = videoTabCandidates();
    if (!tabs.length) {
      log('没找到「视频」标签（候选 ' + tabs.length + ' 个）');
      return;
    }
    const target = tabs.find((el) => !itemActive(el));
    if (!target) {
      log('已经在「视频」标签上了');
      return;
    }
    videoTabTick = { id: cid, tried: cid };
    log('本节默认停在非视频标签，自动切到「视频」标签');
    clickEl(target);
  }

  /** 返回 {empty, hasVideo, hasQuiz, isExamPage, why} */
  function emptyChapterProbe() {
    const hasVideo = anyVisibleVideo();
    const hasQuiz = anyVisibleQuiz();
    const fv = lastFrameState.video;
    const framePlaying = !!(fv && !fv.paused && !fv.ended && lastFrameState.at && Date.now() - lastFrameState.at < 12000);
    // 空提示可能在顶层，也可能在内容 iframe 里（学习通的章节内容基本都在 iframe 中）
    const emptyText = hasEmptyHint() || !!lastFrameState.emptyHint;
    // 章节测验页：有"题量/满分"这类字样，绝不能当没内容跳过去
    const isExamPage = looksLikeExamPage();
    const empty = IS_TOP && !hasVideo && !hasQuiz && !framePlaying && emptyText;
    return {
      empty,
      hasVideo,
      hasQuiz,
      isExamPage,
      why: '视频' + (hasVideo ? '有' : '无') + '/题目' + (hasQuiz ? '有' : '无') +
        '/框架在播' + (framePlaying ? '是' : '否') + '/空提示' + (emptyText ? '有' : '无') +
        '/测验页' + (isExamPage ? '是' : '否'),
    };
  }

  function maybeSkipEmptyChapter() {
    const cid = currentChapterId() || location.href;
    if (emptyTick.id !== cid) emptyTick = { id: cid, n: 0, done: '', told: '' };
    if (emptyTick.done === cid) return;
    const probe = emptyChapterProbe();
    // 没有「暂无内容」提示、但确实既无视频又无题目、也不是章节测验页 —— 多半是
    // "学习目标"这类纯文字页；给它更长的观察时间（4 次 ≈24s），确认没视频再跳。
    const soft = !probe.empty && IS_TOP && !probe.hasVideo && !probe.hasQuiz && !probe.isExamPage && !pageHasVideo();
    const need = probe.empty ? 2 : 4;
    if (!probe.empty && !soft) {
      emptyTick.n = 0;
      // 每个章节只解释一次，便于远程定位"为什么没跳过"
      if (emptyTick.told !== cid) {
        emptyTick.told = cid;
        log('本章内容检测：' + probe.why);
      }
      return;
    }
    emptyTick.n += 1;
    if (emptyTick.told !== cid) {
      emptyTick.told = cid;
      log('本章内容检测：' + probe.why + (soft ? '（无空提示，按纯文字页处理）' : ''));
    }
    if (emptyTick.n < need) return;
    emptyTick.done = cid;
    log('本章没有视频也没有题目，自动跳过（' + probe.why + '）');
    goNext(false);
  }

  /* ------------------------------------------------------------------ *
   * 自动起播：换章节是整页刷新，浏览器"无手势不许自动播放"会把视频卡在 0 秒，
   * 学习通的播放器又是自定义 UI（play() 有时被它自己按回去），所以再补一次点击。
   * ------------------------------------------------------------------ */
  let autostartTries = 0;
  let lastTrustedPointer = 0;
  try {
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.isTrusted) lastTrustedPointer = Date.now();
      },
      true
    );
  } catch (_) {}

  const PLAY_BTN_SELECTORS = [
    '.vjs-big-play-button',
    '.xgplayer-play',
    '.prism-big-play-btn',
    '.pv-play-icon',
    '.vjs-play-control',
    '[class*="bigplay" i]',
    '[class*="play-btn" i]',
    '[class*="playBtn"]',
  ];

  function tryAutostart() {
    if (!cfg.keepPlaying) return;
    if (autostartTries >= 4) return;
    if (Date.now() - lastTrustedPointer < 2000) return; // 用户刚动过，别抢
    let v = null;
    try {
      for (const el of document.querySelectorAll('video')) {
        if (visible(el) && el.paused && !el.ended) {
          v = el;
          break;
        }
      }
    } catch (_) {}
    if (!v) return;
    autostartTries += 1;
    const btn = pickFirst(PLAY_BTN_SELECTORS, true);
    if (btn) {
      clickEl(btn);
      log('自动起播：点了播放按钮');
    } else {
      clickEl(v);
      log('自动起播：点了视频画面');
    }
  }

  function startLoop() {
    if (loopTimer) clearInterval(loopTimer);
    let n = 0;
    loopTimer = setInterval(() => {
      n += 1;
      try {
        videoTick();
      } catch (_) {}
      if (n % 2 === 0) {
        try {
          scanQuiz(false);
        } catch (_) {}
        try {
          solveChapterQuiz();
        } catch (_) {}
        try {
          solveTextExam();
        } catch (_) {}
      }
      if (n % 3 === 0) {
        try {
          reportFrameState();
        } catch (_) {}
      }
      if (n % 3 === 0) {
        try {
          dismissBlockingOverlay();
        } catch (_) {}
      }
      if (n % 3 === 0) {
        try {
          tryAutostart();
        } catch (_) {}
      }
      if (n % 2 === 0 && cfg.enabled && cfg.autoNext) {
        try {
          ensureVideoTab();
        } catch (_) {}
      }
      // 本节任务点早就完成了 → 别重看，直接跳过
      if (n % 2 === 0 && cfg.enabled && cfg.autoNext) {
        try {
          skipIfAlreadyDone();
        } catch (_) {}
      }
      if (n % 5 === 0 && cfg.enabled && cfg.autoNext) {
        try {
          maybeSkipEmptyChapter();
        } catch (_) {}
      }
    }, 1200);
  }

  /* ================================================================== *
   * 与 main-hook / 顶层 / popup 的通信
   * ================================================================== */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.__cx === 'state') {
      Object.assign(mainState, d.payload || {}, { at: Date.now() });
      return;
    }
    if (d.__cx === 'net') {
      // 上报探测：把接近"进度上报"的请求记到日志里（同签名 main-hook 只发 3 次）
      const p = d.payload || {};
      const line = `[网络] ${p.kind} ${p.url}${p.body ? '  ← ' + p.body : ''}`;
      pushLog(line.slice(0, 400));
      return;
    }
  });

  // 子框架：响应顶层下发的"立刻扫题"（跨域框架收不到，靠各自定时扫描兜底）
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__cx !== 'scanQuiz' || IS_TOP) return;
    scanQuiz(true);
  });

  function broadcastScan() {
    try {
      for (let i = 0; i < window.frames.length; i++) {
        window.frames[i].postMessage({ __cx: 'scanQuiz' }, '*');
      }
    } catch (_) {}
  }

  if (IS_TOP) {
    // 子 iframe 的消息：视频播完了 / 请求提示 / 视频状态（视频在 iframe 里，面板要能看到）
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d) return;
      if (d.__cx === 'examSubmitted') {
        log('收到子框架的「本章测验已交卷」通知');
        examSubmittedTop();
      } else if (d.__cx === 'examGraded') {
        examGradedChapter = currentChapterId() || location.href;
        log('本章测验已批阅，切回「视频」标签继续看');
        ensureVideoTab(true);
      } else if (d.__cx === 'videoEnded') {
        log('收到子框架的「该跳下一节」通知');
        scheduleNext();
      }
      else if (d.__cx === 'toast') toast(d.text, d.kind);
      else if (d.__cx === 'frameState') {
        Object.assign(lastFrameState, d.payload || {}, { at: Date.now() });
      }
    });
  }

  let examSubmittedAt = 0;
  /** 测验交卷后：在顶层等 3s（页面会重渲染）再跳下一节 */
  function examSubmittedTop() {
    if (Date.now() - examSubmittedAt < 20000) return;
    examSubmittedAt = Date.now();
    log('等 3s（页面重渲染完）再跳下一节');
    setTimeout(() => scheduleNext(), 3000);
  }

  /** 只读诊断：把"下一节会怎么走"逐条写进日志，不做任何点击 */
  function diagNext() {
    const say = (t) => log('诊断·' + t);
    say('当前 chapterId=' + (currentChapterId() || '(无)') + ' 页面有视频=' + (pageHasVideo() ? '是' : '否'));
    say('题目标签待做=' + (examTabPending() ? '是' : '否') + ' 本章测验已批阅=' + (examGradedChapter === (currentChapterId() || location.href) ? '是' : '否'));
    let idx = 0;
    for (const sel of NEXT_BUTTONS) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      for (const el of list) {
        if (idx++ >= 8) break;
        const t = cleanText(el.textContent || '').slice(0, 18);
        const cls = (el.className && String(el.className).slice(0, 30)) || '';
        say('按钮候选 ' + sel + ' → <' + el.tagName.toLowerCase() + '> "' + t + '" .' + cls + ' 可见=' + (visible(el) ? '是' : '否'));
      }
    }
    if (!idx) say('按钮候选：一个都没匹配到（NEXT_BUTTONS 全部落空）');
    const byText = findNextByText();
    say('按文字找「下一节」→ ' + (byText ? '<' + byText.tagName.toLowerCase() + '> "' + cleanText(byText.textContent || '').slice(0, 18) + '" 可见=' + (visible(byText) ? '是' : '否') : '没找到'));
    const items = catalogItems();
    say('目录项 ' + items.length + ' 个');
    if (items.length) {
      const inf = items.map((el) => {
        let name = '';
        try { name = cleanText((el.querySelector('.posCatalog_name') || el).textContent || '').slice(0, 24); } catch (_) {}
        const num = ((cleanText(el.textContent || '').match(/^(\d+(?:\.\d+)*)/) || [])[1]) || '';
        return { el, name, num, active: itemActive(el), done: itemDone(el) };
      });
      const cur = currentChapterId();
      const no = currentSectionNo();
      let title = '';
      try { title = cleanText(document.title || '').replace(/[_\-|].*$/, ''); } catch (_) {}
      const byActive = inf.findIndex((x) => x.active);
      const byNum = no ? inf.findIndex((x) => x.num && x.num === no) : -1;
      const byTitle = title && title.length >= 4 ? inf.findIndex((x) => x.name && (x.name.includes(title) || title.includes(x.name))) : -1;
      // 标题候选：看看页面上到底哪些元素像是"小节名"
    let hCount = 0;
    for (const sel of ['h1', 'h2', '.chapter-title', '.video-title', '.playTitle', '.currentChapter', '#chapterTitle', '.chapter_title', '.under-title', '.title', '.mark_title']) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      for (const el of list) {
        if (!visible(el)) continue;
        if (hCount++ >= 3) break;
        const t = cleanText(el.textContent || '').slice(0, 16);
        if (!t) continue;
        say('标题候选 ' + sel + ' → <' + el.tagName.toLowerCase() + '> "' + t + '" .' + String(el.className || '').slice(0, 24));
      }
      if (hCount >= 3) break;
    }
    if (!hCount) say('标题候选：全都没匹配到');
    say('页面大标题="' + (pageSectionName() || '(没取到)').slice(0, 20) + '"');
    // 目录里"非白底"的行（学习通靠底色标当前行）
    let bgCount = 0;
    try {
      const rows = catalogItems().slice(0, 20);
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i];
        const bg = getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
        const alpha = m && m[4] !== undefined ? Number(m[4]) : 1;
        const white = !m || (Number(m[1]) > 250 && Number(m[2]) > 250 && Number(m[3]) > 250) || alpha === 0;
        if (white) continue;
        if (bgCount++ >= 3) break;
        say('彩色行 #' + i + ' "' + cleanText(el.textContent || '').slice(0, 12) + '" ' + bg + ' cls=' + String(el.className || '').slice(0, 18));
      }
    } catch (_) {}
    if (!bgCount) say('目录里没有非白底的行（当前行不是靠底色标记）');
      say('认当前项：active→' + byActive + ' 编号(' + (no || '?') + ')→' + byNum + ' 标题(' + (title || '?').slice(0, 10) + ')→' + byTitle + ' chapterId=' + (cur || '无'));
      const hit = byActive >= 0 ? byActive : byNum >= 0 ? byNum : byTitle;
      say('生效的定位=' + hit + (hit >= 0 ? ' 命中「' + inf[hit].name + '」编号 ' + (inf[hit].num || '?') + ' 已完成=' + (inf[hit].done ? '是' : '否') : '（认不出）'));
      if (hit >= 0) {
        const nx = inf.slice(hit + 1).find((x) => !x.done);
        say('下一个未完成=' + (nx ? '「' + nx.name + '」编号 ' + (nx.num || '?') : '（后面都完成了）'));
      }
    }
    say('完');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'getStatus') {
      sendResponse(collectStatus());
      return;
    }
    if (msg.type === 'cmd') {
      if (msg.cmd === 'next') {
        goNext(true).then((r) => sendResponse(r));
        return true;
      }
      if (msg.cmd === 'scanQuiz') {
        broadcastScan();
        scanQuiz(true).then(() => sendResponse({ ok: true, sig: lastQuizSig }));
        return true;
      }
      if (msg.cmd === 'diagNext') {
        diagNext();
        sendResponse({ ok: true });
        return;
      }
      if (msg.cmd === 'clearLogs') {
        logs.length = 0;
        sendResponse({ ok: true });
        return;
      }
    }
  });

  function collectStatus() {
    let v = null;
    try {
      const el = document.querySelector('video');
      if (el) {
        v = {
          paused: el.paused,
          currentTime: Math.round(el.currentTime || 0),
          duration: Math.round(el.duration || 0),
          rate: el.playbackRate,
          muted: el.muted,
        };
      }
    } catch (_) {}
    let quizCount = 0;
    try {
      quizCount = collectQuizRoots().length;
    } catch (_) {}

    // 视频通常在学习通的 iframe 里，顶层自己找不到就用子框架上报的
    let fromFrame = false;
    const fresh = lastFrameState.at && Date.now() - lastFrameState.at < 8000;
    if (!v && fresh && lastFrameState.video) {
      v = lastFrameState.video;
      fromFrame = true;
    }
    if (!quizCount && fresh && lastFrameState.quizCount) quizCount = lastFrameState.quizCount;

    // 视频在 iframe 里时，拦截统计也从子框架来
    const mainInfo = { ...mainState };
    if (fromFrame && lastFrameState.stats) Object.assign(mainInfo, lastFrameState.stats);

    // 日志：顶层自己的 + 子框架最近几条（标上 [子框架]）
    const merged = logs.map((l) => ({ t: l.t, text: l.text }));
    if (fresh && Array.isArray(lastFrameState.frameLogs)) {
      for (const l of lastFrameState.frameLogs) {
        if (l && l.text && l.t && Date.now() - l.t < 45000) merged.push({ t: l.t, text: '[子框架] ' + l.text });
      }
    }
    merged.sort((a, b) => (a.t || 0) - (b.t || 0));

    return {
      url: location.href,
      isTop: IS_TOP,
      chapterId: currentChapterId(),
      video: v,
      fromFrame,
      quizCount,
      lastQuizSig: lastQuizSig,
      main: mainInfo,
      logs: merged.slice(-20),
      cfg: { ...cfg },
    };
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */
  loadCfg();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startLoop();
      videoTick();
    });
  } else {
    startLoop();
    videoTick();
  }

  log('[b145] 已注入：' + (IS_TOP ? '顶层' : '子框架') + ' ' + location.host + location.pathname.slice(0, 60));

  // 供控制台调试
  window.__cx = { cfg, logs, goNext, scanQuiz, collectStatus, pickNextTarget, get lastSig() { return lastQuizSig; } };
})();
