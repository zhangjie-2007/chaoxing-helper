/*
 * background.js —— MV3 service worker。
 * 只干一件事：接到内容脚本的题目，返回答案下标数组。
 * 两种来源：本地题库（模糊匹配）/ 大模型（OpenAI 兼容接口，默认 DeepSeek）。
 */

const LLM_DEFAULTS = {
  solver: 'llm',
  endpoint: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-chat',
  bankText: '',
};

const SYSTEM_PROMPT =
  '你是一个严谨的答题助手。用户会给你一道单选题或多选题和它的选项。' +
  '请选出正确答案，只输出 JSON，形如 {"answers":[0]} 或 {"answers":[0,2]}，' +
  '其中数字是正确选项的下标（从 0 开始）。单选只能给 1 个下标，多选给出全部正确下标。' +
  '不要输出任何解释、标点或代码块标记。';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const norm = (s) =>
  String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function jaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  let union = A.size + B.size;
  for (const [g, n] of A) {
    const m = B.get(g);
    if (m) {
      inter += Math.min(n, m);
      union -= Math.min(n, m);
    }
  }
  return union > 0 ? inter / union : 0;
}

const letterToIndex = (c) => {
  const u = String(c).toUpperCase();
  if (!/^[A-H]$/.test(u)) return -1;
  return u.charCodeAt(0) - 65;
};

/* ------------------------------------------------------------------ *
 * 答案解析：把 "A"/"AC"/"0,2"/"选项原文" 统一成下标数组
 * ------------------------------------------------------------------ */
function toAnswerIndexes(raw, optionCount, options) {
  const out = [];

  const push = (i) => {
    if (Number.isInteger(i) && i >= 0 && i < optionCount && !out.includes(i)) out.push(i);
  };

  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'number') push(v);
      else {
        const n = parseInt(String(v), 10);
        if (!Number.isNaN(n) && /^\d+$/.test(String(v).trim())) push(n);
        else {
          const li = letterToIndex(String(v).trim().slice(0, 1));
          if (li >= 0) push(li);
        }
      }
    }
    return out;
  }

  if (typeof raw === 'number') {
    push(raw);
    return out;
  }

  const s = String(raw == null ? '' : raw).trim();
  if (!s) return out;

  // 题库里写成数组的答案，如 "[1,3]" / '["A","C"]'
  if (/^\[[\s\S]*\]$/.test(s)) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return toAnswerIndexes(arr, optionCount, options);
    } catch (_) {}
  }

  // 纯数字串，如 "0,2"
  if (/^[\d\s,，、;；]+$/.test(s)) {
    for (const n of s.match(/\d+/g) || []) push(parseInt(n, 10));
    if (out.length) return out;
  }

  // 字母串，如 "AC" / "A,C"
  const letters = s.toUpperCase().match(/[A-H]/g);
  const compact = s.replace(/[\s,，、;；\/|]/g, '');
  if (letters && letters.length && compact.length <= 8) {
    for (const c of letters) push(letterToIndex(c));
    if (out.length) return out;
  }

  // 选项原文
  if (Array.isArray(options) && options.length) {
    const target = norm(s);
    const byText = options.findIndex((o) => {
      const no = norm(o);
      return no === target || (no.length > 3 && (target.includes(no) || no.includes(target)));
    });
    if (byText >= 0) push(byText);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 本地题库
 * ------------------------------------------------------------------ */
function parseBank(text) {
  const list = [];
  const raw = String(text || '').trim();
  if (!raw) return list;

  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const it of arr) {
          if (!it) continue;
          const q = it.q || it.question || it.题目;
          const a = it.a ?? it.answer ?? it.answers ?? it.答案;
          if (q && a != null) list.push({ q: String(q), a });
        }
        return list;
      }
    } catch (_) {}
  }

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    let parts = s.split(/\s*(?:==>|=>|\t)\s*/);
    if (parts.length < 2) parts = s.split(/\s*\|\s*/);
    if (parts.length < 2) {
      const i = s.lastIndexOf('：');
      const j = s.lastIndexOf(':');
      const k = Math.max(i, j);
      if (k > 0) parts = [s.slice(0, k), s.slice(k + 1)];
    }
    if (parts.length < 2) continue;
    const q = parts[0].trim();
    const a = parts.slice(1).join(' ').trim();
    if (q && a) list.push({ q, a });
  }
  return list;
}

function matchBank(bankText, question, options) {
  const list = parseBank(bankText);
  if (!list.length) return null;
  const qn = norm(question);
  if (!qn) return null;

  let best = null;
  let bestScore = 0;
  for (const item of list) {
    const bn = norm(item.q);
    if (!bn) continue;
    let score = 0;
    if (bn === qn) score = 1;
    else if (bn.length >= 10 && qn.length >= 10 && (qn.includes(bn) || bn.includes(qn))) score = 0.95;
    else score = jaccard(qn, bn);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best || bestScore < 0.8) return null;
  const answers = toAnswerIndexes(best.a, options.length, options);
  if (!answers.length) return null;
  return { answers, score: bestScore, source: 'bank' };
}

/* ------------------------------------------------------------------ *
 * 大模型
 * ------------------------------------------------------------------ */
function buildPrompt(question, options, multi) {
  const opts = options.map((o, i) => i + '. ' + String(o || '').replace(/\s+/g, ' ').slice(0, 160)).join('\n');
  return (
    '题型：' + (multi ? '多选题（可能有多个正确答案）' : '单选题（只有一个正确答案）') + '\n' +
    '题目：' + String(question || '').slice(0, 800) + '\n' +
    '选项：\n' + opts + '\n\n' +
    (multi ? '请给出全部正确选项的下标。' : '请给出唯一正确选项的下标。') +
    '只输出 JSON：{"answers":[0]}'
  );
}

function parseLLMAnswer(content, optionCount) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  const tryJson = (s) => {
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  };

  let obj = tryJson(text);
  if (!obj) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) obj = tryJson(m[0]);
  }
  if (!obj) {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) obj = tryJson(m[0]);
  }

  if (obj != null) {
    if (Array.isArray(obj)) return toAnswerIndexes(obj, optionCount, null);
    const cand = obj.answers ?? obj.answer ?? obj.indices ?? obj.index ?? obj.正确选项 ?? obj.答案;
    if (cand != null) return toAnswerIndexes(cand, optionCount, null);
  }

  // 直接是 "A" / "AC" / "answer: B"
  const letters = text.replace(/[^A-Ha-h]/g, '');
  if (letters && letters.length <= 4) return toAnswerIndexes(letters, optionCount, null);
  return [];
}

async function postChat(cfg, payload, signal) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  return { res, text };
}

async function askLLM(cfg, question, options, multi) {
  if (!cfg.apiKey) return { ok: false, reason: '还没填 API Key（在插件设置里填）' };
  if (!cfg.endpoint) return { ok: false, reason: '还没填接口地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const base = {
      model: cfg.model || 'deepseek-chat',
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(question, options, multi) },
      ],
    };

    // DeepSeek / OpenAI 都支持 json_object；个别自建网关不认，去掉参数再试一次
    let { res, text } = await postChat(
      cfg,
      { ...base, response_format: { type: 'json_object' } },
      controller.signal
    );
    if (!res.ok && /response_format|json_object|unsupported|not\s*support/i.test(text)) {
      const retry = await postChat(cfg, base, controller.signal);
      res = retry.res;
      text = retry.text;
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: '接口返回 ' + res.status + '：' + String(text).slice(0, 160),
      };
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, reason: '接口返回的不是 JSON：' + String(text).slice(0, 120) };
    }
    const content =
      (data && data.choices && data.choices[0] && (data.choices[0].message?.content ?? data.choices[0].text)) || '';
    const answers = parseLLMAnswer(content, options.length);
    if (!answers.length) {
      return { ok: false, reason: '模型没给出可用答案：' + String(content).slice(0, 120) };
    }
    return { ok: true, answers, source: 'llm', raw: String(content).slice(0, 200) };
  } catch (e) {
    const isAbort = e && e.name === 'AbortError';
    return { ok: false, reason: isAbort ? '请求超时（30s）' : '请求失败：' + String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function readCfg() {
  const sync = await chrome.storage.sync.get(LLM_DEFAULTS);
  const local = await chrome.storage.local.get({ apiKey: '' });
  return {
    solver: sync.solver || 'llm',
    endpoint: (sync.endpoint || LLM_DEFAULTS.endpoint).trim(),
    model: (sync.model || LLM_DEFAULTS.model).trim(),
    bankText: sync.bankText || '',
    apiKey: (local.apiKey || '').trim(),
  };
}

async function solve({ question, options, multi }) {
  const opts = Array.isArray(options) ? options.map((o) => String(o || '')) : [];
  if (!question || opts.length < 2) return { ok: false, reason: '题目/选项解析失败' };

  const cfg = await readCfg();

  // 1) 题库优先：命中就不花钱、还准
  if (cfg.bankText) {
    const hit = matchBank(cfg.bankText, question, opts);
    if (hit) return { ok: true, answers: hit.answers, source: 'bank' };
  }

  // 2) 大模型
  if (cfg.solver === 'llm') return await askLLM(cfg, question, opts, !!multi);

  return { ok: false, reason: cfg.solver === 'bank' ? '题库里没找到这道题' : '答题来源被关闭了' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'solve') {
    solve(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'testLLM') {
    readCfg()
      .then((cfg) =>
        askLLM(
          { ...cfg, apiKey: (msg.apiKey || cfg.apiKey || '').trim(), endpoint: (msg.endpoint || cfg.endpoint).trim(), model: msg.model || cfg.model },
          '中国的首都是哪座城市？',
          ['A. 北京', 'B. 上海', 'C. 广州', 'D. 深圳'],
          false
        )
      )
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'testBank') {
    readCfg()
      .then((cfg) => {
        const list = parseBank(msg.bankText != null ? msg.bankText : cfg.bankText);
        sendResponse({ ok: true, count: list.length, sample: list.slice(0, 3) });
      })
      .catch((e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(LLM_DEFAULTS, (v) => {
    chrome.storage.sync.set({ ...LLM_DEFAULTS, ...v }, () => {});
  });
});
