/* check.js —— 交付前自检：清单、资源引用、语法。 node tools/check.js */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const node = process.execPath;
let bad = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => {
  bad++;
  console.log('  FAIL ' + m);
};

// 1. manifest
let m;
try {
  m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok('manifest.json 合法 v' + m.version);
} catch (e) {
  fail('manifest.json 解析失败: ' + e.message);
  process.exit(1);
}

// 2. 引用完整性
const need = [
  m.background && m.background.service_worker,
  m.action && m.action.default_popup,
  m.options_ui && m.options_ui.page,
  ...Object.values(m.icons || {}),
  ...(m.action && m.action.default_icon ? Object.values(m.action.default_icon) : []),
  ...m.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean);

for (const f of need) {
  if (!fs.existsSync(path.join(root, f))) fail('清单引用的文件不存在: ' + f);
}
ok('清单引用的 ' + need.length + ' 个文件都在');

// 3. HTML 里的 src/href
for (const page of [m.action.default_popup, m.options_ui.page].filter(Boolean)) {
  const dir = path.dirname(path.join(root, page));
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  for (const mt of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = mt[1];
    if (/^(https?:|data:|#)/.test(ref)) continue;
    if (!fs.existsSync(path.join(dir, ref))) fail(page + ' 引用了不存在的 ' + ref);
  }
}
ok('HTML 内的脚本/样式引用都在');

// 4. 语法
const jsFiles = [];
for (const d of ['src', 'tools']) {
  for (const f of fs.readdirSync(path.join(root, d))) {
    if (f.endsWith('.js')) jsFiles.push(path.join(root, d, f));
  }
}
for (const f of jsFiles) {
  try {
    execFileSync(node, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail('语法错误: ' + path.relative(root, f) + '\n' + String(e.stderr || ''));
  }
}
ok(jsFiles.length + ' 个 JS 文件语法通过');

// 5. 图标尺寸
try {
  for (const [size, file] of Object.entries(m.icons || {})) {
    const buf = fs.readFileSync(path.join(root, file));
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== Number(size) || h !== Number(size)) fail(file + ' 尺寸是 ' + w + 'x' + h + '，应为 ' + size);
  }
  ok('图标尺寸与清单一致');
} catch (e) {
  fail('图标检查失败: ' + e.message);
}

console.log(bad ? '\n' + bad + ' 项有问题' : '\n自检通过');
process.exit(bad ? 1 : 0);
