/* options.js */
const DEFAULTS = {
  endpoint: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-chat',
  bankText: '',
  quizSelectors: '',
  nextDelay: 3000,
  resumeInterval: 1200,
};

const $ = (id) => document.getElementById(id);

function showResult(el, text, kind) {
  el.style.display = 'block';
  el.textContent = text;
  el.className = 'result' + (kind ? ' ' + kind : '');
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (v) => {
    const cfg = Object.assign({}, DEFAULTS, v || {});
    $('endpoint').value = cfg.endpoint;
    $('model').value = cfg.model;
    $('bankText').value = cfg.bankText || '';
    $('quizSelectors').value = cfg.quizSelectors || '';
    $('nextDelay').value = cfg.nextDelay;
    $('resumeInterval').value = cfg.resumeInterval;
  });
  chrome.storage.local.get({ apiKey: '' }, (v) => {
    $('apiKey').value = v.apiKey || '';
  });
}

function save() {
  const nextDelay = Math.max(500, parseInt($('nextDelay').value, 10) || 3000);
  const resumeInterval = Math.max(400, parseInt($('resumeInterval').value, 10) || 1200);
  chrome.storage.sync.set(
    {
      endpoint: $('endpoint').value.trim() || DEFAULTS.endpoint,
      model: $('model').value.trim() || DEFAULTS.model,
      bankText: $('bankText').value,
      quizSelectors: $('quizSelectors').value,
      nextDelay,
      resumeInterval,
    },
    () => {
      $('nextDelay').value = nextDelay;
      $('resumeInterval').value = resumeInterval;
      const tip = $('savedTip');
      tip.classList.add('show');
      setTimeout(() => tip.classList.remove('show'), 1600);
    }
  );
  chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
}

$('btnSave').addEventListener('click', save);

$('btnReset').addEventListener('click', () => {
  if (!confirm('恢复默认设置？题库和 API Key 也会清空。')) return;
  chrome.storage.sync.set(DEFAULTS);
  chrome.storage.local.set({ apiKey: '' });
  load();
  const tip = $('savedTip');
  tip.textContent = '已恢复默认';
  tip.classList.add('show');
  setTimeout(() => {
    tip.classList.remove('show');
    tip.textContent = '已保存';
  }, 1600);
});

$('btnTest').addEventListener('click', () => {
  const el = $('testResult');
  showResult(el, '测试中，最多等 30 秒…');
  // 先存一下，避免测的是旧配置
  chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
  chrome.storage.sync.set({ endpoint: $('endpoint').value.trim(), model: $('model').value.trim() });

  try {
    chrome.runtime.sendMessage(
      {
        type: 'testLLM',
        apiKey: $('apiKey').value.trim(),
        endpoint: $('endpoint').value.trim(),
        model: $('model').value.trim(),
      },
      (r) => {
        if (chrome.runtime.lastError) {
          showResult(el, '后台无响应：' + chrome.runtime.lastError.message, 'err');
          return;
        }
        if (!r) {
          showResult(el, '后台无响应（service worker 可能已休眠，重试一次）', 'err');
          return;
        }
        if (r.ok) {
          const label = (r.answers || []).map((i) => String.fromCharCode(65 + i)).join(',');
          showResult(el, '连接成功，测试题答：' + label + '（应为 A）', 'ok');
        } else {
          showResult(el, '失败：' + (r.reason || '未知原因'), 'err');
        }
      }
    );
  } catch (e) {
    showResult(el, '发送失败：' + ((e && e.message) || e), 'err');
  }
});

$('btnBank').addEventListener('click', () => {
  const el = $('bankResult');
  try {
    chrome.runtime.sendMessage({ type: 'testBank', bankText: $('bankText').value }, (r) => {
      if (chrome.runtime.lastError || !r) {
        showResult(el, '后台无响应，重试一次', 'err');
        return;
      }
      if (!r.ok) {
        showResult(el, '解析失败：' + r.reason, 'err');
        return;
      }
      const sample = (r.sample || []).map((s) => s.q.slice(0, 24) + ' => ' + JSON.stringify(s.a)).join('；');
      showResult(el, '解析到 ' + r.count + ' 条' + (sample ? '，示例：' + sample : ''), r.count ? 'ok' : 'err');
    });
  } catch (e) {
    showResult(el, '发送失败：' + ((e && e.message) || e), 'err');
  }
});

load();
