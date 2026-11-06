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
    autoChapterQuiz: false,
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
  function videoTick() {
    let vids = [];
    try {
      vids = Array.from(document.querySelectorAll('video'));
    } catch (_) {}
    for (const v of vids) attachVideo(v);
    applyVideoPrefs();
  }

  /* ================================================================== *
   * 自动下一节
   * ================================================================== */
  let nextScheduled = false;

  function scheduleNext() {
    if (nextScheduled) return;
    if (!cfg.enabled || !cfg.autoNext) return;
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
      if (t && t.length <= 6 && NEXT_TEXT_RE.test(t)) return el;
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
    } catch (_) {}
    return false;
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
    for (let waited = 0; waited < timeout; waited += step) {
      await sleep(step);
      if (currentKey() !== beforeKey) return true;
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
    if (curIdx < 0) curIdx = info.findIndex((x) => x.active);
    // 目录项没有 chapterId 时，靠页面标题里的编号（如 4.5）对号入座
    if (curIdx < 0) {
      const no = currentSectionNo();
      if (no) curIdx = info.findIndex((x) => x.num && x.num === no);
    }
    if (curIdx < 0) curIdx = info.findIndex((x) => !x.done) - 1;

    const usable = (x) => x && !x.done && !x.isGroup;
    let pool = info.filter((x) => x.i > curIdx && usable(x));
    if (!pool.length) pool = info.filter((x) => x.i < Math.max(curIdx, 0) && usable(x));
    if (!pool.length) return { ok: false, reason: '后面的小节看起来都已完成' };
    const target = pickNextTarget(pool);

    log('下一节：' + target.name + '（编号 ' + (target.num || '?') + ' / 章节 ' + (target.id || '?') + '）');
    const ok = await navigateTo(target.el);
    return ok ? { ok: true, how: '目录「' + target.name + '」' } : { ok: false, reason: '点了目录没反应（' + target.name + '）' };
  }

  async function goNext(manual) {
    if (!manual) {
      if (!cfg.enabled) return { ok: false, reason: '插件已关闭' };
      if (!cfg.autoNext) return { ok: false, reason: '自动下一节开关是关的' };
    }

    // 1) 目录优先：点完能验证到底跳没跳，比乱猜按钮可靠
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

  async function solveAndAnswer(quiz, force) {
    const sig = hashStr(quiz.question + '||' + quiz.options.map((o) => o.text).join('|'));
    const seen = handled.get(sig);
    if (!force && seen && Date.now() - seen < 10 * 60 * 1000) return { skipped: true };
    handled.set(sig, Date.now());

    lastQuizSig = sig;
    log('识别到弹题（' + (quiz.multi ? '多选' : '单选') + '）：' + quiz.question.slice(0, 80));
    quiz.options.forEach((o, i) => log('  选项' + i + '：' + o.text.slice(0, 60)));

    let res = null;
    try {
      res = await new Promise((resolve) => {
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
      res = { ok: false, reason: String((e && e.message) || e) };
    }

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
   * 章节测验（可选，默认关闭）
   * ================================================================== */
  async function scanChapterQuiz() {
    if (!cfg.enabled || !cfg.autoChapterQuiz) return;
    let blocks = [];
    try {
      blocks = Array.from(document.querySelectorAll('.TiMu, .questionLi, .question-item'));
    } catch (_) {}
    if (!blocks.length) return;
    for (const b of blocks) {
      const quiz = extractQuiz(b);
      if (!quiz) continue;
      const t = cleanText(b.textContent || '');
      if (/正确答案|已批阅|正确/.test(t)) continue;
      await solveAndAnswer(quiz, false);
      await sleep(900);
    }
    // 整页共用一个提交按钮
    try {
      const all = Array.from(document.querySelectorAll('button, a, div, span'));
      for (const el of all) {
        const t = cleanText(el.textContent || '');
        if (t === '提交' || t === '提交答案') {
          if (visible(el) && el.getClientRects().length) {
            await sleep(600);
            clickEl(el);
            log('已提交章节测验');
            break;
          }
        }
      }
    } catch (_) {}
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
  function ensureVideoTab() {
    if (!IS_TOP) return;
    if (!cfg.enabled || !cfg.autoNext) return;
    if (pageHasVideo()) return;
    const cid = currentChapterId() || location.href;
    if (videoTabTick.id !== cid) videoTabTick = { id: cid, tried: '' };
    if (videoTabTick.tried === cid) return;
    const tabs = videoTabCandidates();
    if (!tabs.length) return;
    const target = tabs.find((el) => !itemActive(el));
    if (!target) return; // 已经在视频标签上了
    videoTabTick.tried = cid;
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
    let pageText = '';
    try {
      pageText = cleanText((document.body && document.body.innerText) || '').slice(0, 3000);
    } catch (_) {}
    const isExamPage = /题量\s*[:：]|满分\s*[:：]|\d+\s*题\s*\/|单选题|多选题|判断题/.test(pageText);
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
          scanChapterQuiz();
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
      if (d.__cx === 'videoEnded') scheduleNext();
      else if (d.__cx === 'toast') toast(d.text, d.kind);
      else if (d.__cx === 'frameState') {
        Object.assign(lastFrameState, d.payload || {}, { at: Date.now() });
      }
    });
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

  log('已注入：' + (IS_TOP ? '顶层' : '子框架') + ' ' + location.host + location.pathname.slice(0, 60));

  // 供控制台调试
  window.__cx = { cfg, logs, goNext, scanQuiz, collectStatus, pickNextTarget, get lastSig() { return lastQuizSig; } };
})();
