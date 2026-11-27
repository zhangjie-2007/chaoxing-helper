/* popup.js */
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
  solver: 'llm',
};

const $ = (id) => document.getElementById(id);

const TOGGLES = ['enabled', 'keepPlaying', 'autoQuiz', 'autoNext', 'mute', 'autoChapterQuiz'];

let tabId = null;
let pollTimer = null;

/* ---------------- 配置读写 ---------------- */
function loadCfg() {
  chrome.storage.sync.get(DEFAULTS, (v) => {
    const cfg = Object.assign({}, DEFAULTS, v || {});
    for (const k of TOGGLES) {
      const el = $(k);
      if (el) el.checked = !!cfg[k];
    }
    $('rate').value = String(cfg.rate == null ? 0 : cfg.rate);
    $('solver').value = cfg.solver || 'llm';
    document.body.classList.toggle('off', !cfg.enabled);
  });
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

for (const k of TOGGLES) {
  const el = $(k);
  if (!el) continue;
  el.addEventListener('change', () => {
    save({ [k]: el.checked });
    if (k === 'enabled') document.body.classList.toggle('off', !el.checked);
    refresh();
  });
}

$('rate').addEventListener('change', () => {
  save({ rate: Number($('rate').value) || 0 });
  refresh();
});

$('solver').addEventListener('change', () => {
  save({ solver: $('solver').value });
  refresh();
});

/* ---------------- 与页面通信 ---------------- */
function sendToTab(msg) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => {
        if (chrome.runtime.lastError) {
          resolve({ __err: chrome.runtime.lastError.message });
        } else resolve(r || null);
      });
    } catch (e) {
      resolve({ __err: String((e && e.message) || e) });
    }
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function renderStatus(st) {
  const info = $('pageInfo');
  const hint = $('pageHint');

  if (!st || st.__err) {
    info.textContent = '当前页面未加载助手';
    hint.textContent = '请在超星/学习通的课程学习页打开本插件（刷视频、弹题、跳章节都在课程页生效）。';
    $('statVideo').textContent = '—';
    $('statPaused').textContent = '—';
    $('statResumed').textContent = '—';
    $('statQuiz').textContent = '—';
    $('logBody').innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }

  let host = '';
  try {
    host = new URL(st.url).host;
  } catch (_) {
    host = st.url || '';
  }
  info.textContent = host + (st.chapterId ? ' · 章节 ' + st.chapterId : '');

  const v = st.video;
  const sv = $('statVideo');
  if (v) {
    const cur = v.currentTime || 0;
    const dur = v.duration || 0;
    const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    sv.textContent = v.paused ? '已暂停' : mmss(cur) + '/' + mmss(dur);
    sv.className = 'stat-value ' + (v.paused ? 'warn' : 'good');
  } else {
    sv.textContent = '未找到';
    sv.className = 'stat-value';
  }

  const m = st.main || {};
  $('statPaused').textContent = m.paused != null ? m.paused : '0';
  $('statResumed').textContent = m.resumed != null ? m.resumed : '0';
  $('statQuiz').textContent = st.quizCount != null ? st.quizCount : '0';

  if (st.fromFrame && v) {
    hint.textContent =
      '视频在子框架里播放，状态已同步；正在播放 ' +
      (m.playing || (v.paused ? 0 : 1)) +
      ' 个，可见性伪装 ' +
      (m.visible ? '已生效' : '未生效（视频可能还没开始）') +
      '。';
  } else if (m.videos) {
    hint.textContent =
      '本框架 ' +
      m.videos +
      ' 个视频，正在播放 ' +
      (m.playing || 0) +
      ' 个；可见性伪装 ' +
      (m.visible ? '已生效' : '未生效') +
      '。';
  } else if (st.quizCount > 0) {
    hint.textContent = '页面上检测到 ' + st.quizCount + ' 处选择题容器。';
  } else {
    hint.textContent = '正在守护当前页面。';
  }

  const body = $('logBody');
  const logs = Array.isArray(st.logs) ? st.logs : [];
  if (!logs.length) {
    body.innerHTML = '<div class="log-empty">暂无日志</div>';
  } else {
    body.innerHTML = logs
      .map(
        (l) =>
          '<div class="log-line"><span class="log-time">' +
          fmtTime(l.t) +
          '</span>' +
          escapeHtml(l.text) +
          '</div>'
      )
      .join('');
    body.scrollTop = body.scrollHeight;
  }
  if (diagText) {
    // 结构诊断（点「识别当前题目」后抓的 DOM 快照）固定贴在日志后面
    body.innerHTML +=
      '<div class="log-line"><span class="log-time">结构</span><pre style="white-space:pre-wrap;margin:0;font:inherit">' +
      escapeHtml(diagText) +
      '</pre></div>';
    body.scrollTop = body.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function refresh() {
  const st = await sendToTab({ type: 'getStatus' });
  renderStatus(st);
}

/* ---------------- 结构诊断：抓所有框架里"像题目"的 DOM 摘要 ---------------- */
let diagText = '';

function dumpExamDom() {
  // 注意：这个函数会被注入到页面里执行，不能引用外部的任何变量
  const vis = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none' && +st.opacity > 0.05;
    } catch (_) {
      return false;
    }
  };
  const cls = (el) => {
    let c = '';
    try {
      const cn = el.className;
      c = typeof cn === 'string' ? cn.trim().split(/\s+/).slice(0, 3).join('.') : '';
    } catch (_) {}
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : '');
  };
  const out = [];
  const radios = document.querySelectorAll('input[type="radio"]');
  const boxes = document.querySelectorAll('input[type="checkbox"]');
  out.push('inputs: radio=' + radios.length + ' checkbox=' + boxes.length + ' allInputs=' + document.querySelectorAll('input').length);

  let cands = [];
  const all = Array.from(document.querySelectorAll('div, li, ul, dl, section'));
  for (const el of all) {
    if (!vis(el)) continue;
    const t = (el.innerText || '').trim();
    if (t.length < 20 || t.length > 1500) continue;
    if (!/多选题|单选题|判断题|填空题|【.*题】/.test(t)) continue;
    if (el.querySelectorAll('div, li, ul, dl').length > 60) continue;
    cands.push(el);
  }
  cands = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o))).slice(0, 2);
  out.push('题目候选块=' + cands.length);
  for (const c of cands) {
    out.push('Q ' + cls(c));
    const kids = Array.from(c.querySelectorAll('*')).slice(0, 26).map(cls);
    out.push('  kids: ' + kids.join(' | '));
    out.push('  text: ' + (c.innerText || '').replace(/\s+/g, ' ').slice(0, 200));
  }
  return out.join('\n');
}

async function runDiag() {
  if (tabId == null) return;
  diagText = '';
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: dumpExamDom,
    });
    const parts = [];
    for (const r of res || []) {
      if (r && r.result) parts.push('[frame ' + (r.frameId || 0) + ']\n' + r.result);
    }
    diagText = parts.join('\n---\n').slice(0, 3000) || '（所有框架都没抓到题目结构）';
  } catch (e) {
    diagText = '抓取失败：' + ((e && e.message) || e);
  }
  refresh();
}

/* ---------------- 按钮 ---------------- */
$('btnNext').addEventListener('click', async () => {
  const r = await sendToTab({ type: 'cmd', cmd: 'next' });
  if (!r || r.__err) $('pageHint').textContent = '无法执行：请确认在课程学习页';
  else if (r.ok) $('pageHint').textContent = '已跳转：' + (r.how || '下一节');
  else $('pageHint').textContent = '未跳转：' + (r.reason || '未知原因');
  setTimeout(refresh, 1200);
});

$('btnReload').addEventListener('click', () => {
  chrome.runtime.reload();
});

$('btnDiagNext').addEventListener('click', async () => {
  const r = await sendToTab({ type: 'cmd', cmd: 'diagNext' });
  if (!r || r.__err) $('pageHint').textContent = '无法执行：请确认在课程学习页';
  else $('pageHint').textContent = '已把"下一节会怎么走"写进日志（不点任何东西）。';
  setTimeout(refresh, 1200);
});

$('btnScan').addEventListener('click', async () => {
  const r = await sendToTab({ type: 'cmd', cmd: 'scanQuiz' });
  if (!r || r.__err) $('pageHint').textContent = '无法执行：请确认在课程学习页';
  else $('pageHint').textContent = '已扫描当前页面，详情看日志或页面控制台。';
  runDiag();
  setTimeout(refresh, 1500);
});

$('btnClear').addEventListener('click', async () => {
  await sendToTab({ type: 'cmd', cmd: 'clearLogs' });
  refresh();
});

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/* ---------------- 启动 ---------------- */
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs && tabs[0]) tabId = tabs[0].id;
  refresh();
  pollTimer = setInterval(refresh, 1500);
});

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

loadCfg();
