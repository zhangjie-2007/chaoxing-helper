/*
 * 后台逻辑的离线自测（不需要浏览器）：
 *   node tools/test-background.js
 * 覆盖：题库解析、模糊匹配、答案解析、来源开关。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

const store = {
  sync: { solver: 'bank', endpoint: 'http://127.0.0.1:1/x', model: 'm', bankText: '' },
  local: { apiKey: 'test-key' },
};
const listeners = [];

const chrome = {
  runtime: {
    onMessage: { addListener: (f) => listeners.push(f) },
    onInstalled: { addListener: () => {} },
  },
  storage: {
    sync: {
      get: async (d) => ({ ...d, ...store.sync }),
      set: (o, cb) => {
        Object.assign(store.sync, o);
        if (cb) cb();
      },
    },
    local: {
      get: async (d) => ({ ...d, ...store.local }),
      set: (o, cb) => {
        Object.assign(store.local, o);
        if (cb) cb();
      },
    },
  },
};

// 假网络：queue 里预置响应，每次 fetch 取一条
const net = { calls: [], queue: [] };
const fetchStub = async (url, init) => {
  net.calls.push({ url, body: (init && init.body) || '', headers: (init && init.headers) || {} });
  const item = net.queue.shift() || { status: 500, text: 'no stub left' };
  return {
    ok: item.status >= 200 && item.status < 300,
    status: item.status,
    text: async () => item.text,
  };
};

const ctx = vm.createContext({
  chrome,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: fetchStub,
});
vm.runInContext(src, ctx, { filename: 'background.js' });

const ask = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else {
    failed++;
    console.log('  FAIL ' + name + (extra ? ' -> ' + JSON.stringify(extra) : ''));
  }
}

(async () => {
  console.log('[1] 题库解析');
  const bank = [
    '# 注释行会被忽略',
    '存储器是计算机中用来存放程序和数据的部件？ => A',
    'CPU 由哪些部分组成？ => ABC',
    '操作系统的主要功能 | 进程管理、内存管理',
    '',
  ].join('\n');

  let r = await ask({ type: 'testBank', bankText: bank });
  check('解析出 3 条', r.ok && r.count === 3, r);
  check('首条题干正确', r.sample && r.sample[0].q.indexOf('存储器') >= 0, r.sample);

  r = await ask({ type: 'testBank', bankText: '[{"q":"题目一","a":"B"},{"q":"题目二","a":[0,2]}]' });
  check('JSON 题库解析', r.ok && r.count === 2, r);

  console.log('[2] 题型答案解析');
  const opts4 = ['北京', '上海', '广州', '深圳'];

  store.sync.bankText = '中国的首都是哪座城市 => A';
  r = await ask({ type: 'solve', question: '中国的首都是哪座城市？', options: opts4, multi: false });
  check('题库命中返回下标 0', r.ok && r.answers[0] === 0 && r.source === 'bank', r);

  store.sync.bankText = '中国的首都是哪座城市 => A';
  r = await ask({ type: 'solve', question: '中国的首都是哪座城市（单选）', options: opts4, multi: false });
  check('题干略有差异仍命中', r.ok && r.answers[0] === 0, r);

  store.sync.bankText = '以下哪些属于操作系统？ => A,C';
  r = await ask({ type: 'solve', question: '以下哪些属于操作系统？', options: ['Windows', 'Word', 'Linux', 'Excel'], multi: true });
  check('多选 A,C -> [0,2]', r.ok && r.answers.join(',') === '0,2', r);

  store.sync.bankText = '以下哪些属于操作系统？ => [1,3]';
  r = await ask({ type: 'solve', question: '以下哪些属于操作系统？', options: ['Windows', 'Word', 'Linux', 'Excel'], multi: true });
  check('多选数组答案 -> [1,3]', r.ok && r.answers.join(',') === '1,3', r);

  store.sync.bankText = '计算机的核心部件是什么？ => 中央处理器';
  r = await ask({ type: 'solve', question: '计算机的核心部件是什么？', options: ['内存', '中央处理器', '硬盘'], multi: false });
  check('按选项原文作答 -> 1', r.ok && r.answers[0] === 1, r);

  console.log('[3] 兜底行为');
  store.sync.bankText = '完全无关的题目 => A';
  r = await ask({ type: 'solve', question: '中国的首都是哪座城市？', options: opts4, multi: false });
  check('题库未命中且来源=bank 时明确报错', !r.ok && /没找到/.test(r.reason), r);

  store.sync.solver = 'off';
  store.sync.bankText = '中国的首都是哪座城市 => A';
  r = await ask({ type: 'solve', question: '中国的首都是哪座城市？', options: opts4, multi: false });
  check('题库命中优先于来源关闭', r.ok && r.answers[0] === 0, r);

  store.sync.solver = 'off';
  store.sync.bankText = '';
  r = await ask({ type: 'solve', question: '中国的首都是哪座城市？', options: opts4, multi: false });
  check('来源关闭且无题库 -> 报错', !r.ok && /关闭/.test(r.reason), r);

  store.sync.solver = 'llm';
  r = await ask({ type: 'solve', question: '', options: opts4, multi: false });
  check('空题干被拒绝', !r.ok && /解析失败/.test(r.reason), r);

  console.log('[4] 大模型链路（假网络）');
  const llmReply = (content) => ({
    status: 200,
    text: JSON.stringify({ choices: [{ message: { content } }] }),
  });

  store.sync.solver = 'llm';
  store.sync.bankText = '';
  net.queue = [llmReply('{"answers":[2]}')];
  r = await ask({ type: 'solve', question: '中国的首都是哪座城市？', options: opts4, multi: false });
  check('JSON 答案 -> 下标 2', r.ok && r.answers.join(',') === '2' && r.source === 'llm', r);
  check(
    '请求带上了 json_object 与 Bearer',
    /response_format/.test(net.calls.at(-1).body) && net.calls.at(-1).headers.Authorization === 'Bearer test-key',
    net.calls.at(-1).headers
  );

  net.queue = [llmReply('```json\n{"answers":[0,1]}\n```')];
  r = await ask({ type: 'solve', question: '多选测试', options: opts4, multi: true });
  check('代码块包裹的答案也能解析 -> 0,1', r.ok && r.answers.join(',') === '0,1', r);

  net.queue = [llmReply('B')];
  r = await ask({ type: 'solve', question: '只回字母', options: opts4, multi: false });
  check('只回字母 B -> 1', r.ok && r.answers.join(',') === '1', r);

  net.queue = [{ status: 400, text: '{"error":{"message":"response_format is not supported"}}' }, llmReply('{"answers":[3]}')];
  r = await ask({ type: 'solve', question: '网关不认 response_format', options: opts4, multi: false });
  check('不认 json_object 时自动重试', r.ok && r.answers.join(',') === '3' && net.queue.length === 0, r);

  net.queue = [{ status: 401, text: '{"error":{"message":"invalid api key"}}' }];
  r = await ask({ type: 'solve', question: '鉴权失败', options: opts4, multi: false });
  check('401 明确报错', !r.ok && /401/.test(r.reason), r);

  net.queue = [llmReply('我不知道')];
  r = await ask({ type: 'solve', question: '模型胡言乱语', options: opts4, multi: false });
  check('答非所问时明确失败', !r.ok && /没给出/.test(r.reason), r);

  console.log(failed ? '\n有 ' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
