#!/usr/bin/env node
/**
 * 目录选点逻辑的离线自测。
 *
 * 真实页面上"下一个该看哪一节"踩过两个坑：
 *   1) 目录里既有章标题（"5 Python语言基本语法"），也有小节（"5.1 指令与程序语言"），
 *      章标题点不动（只是展开/收起）；
 *   2) 学习通把编号和标题拆成两个 span，小程序名字段里没有 "5.1"。
 * 所以 pickNextTarget 用"编号层级"来区分：depth>=2 才算真正的小节。
 *
 * 直接从 content.js 里把函数抠出来跑，避免逻辑漂移。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'content.js');
const code = fs.readFileSync(SRC, 'utf8');

// 抠出 pickNextTarget 的函数体
const m = code.match(/function pickNextTarget\(pool\) \{[\s\S]*?\n  \}/);
if (!m) {
  console.error('没找到 pickNextTarget，测试无法进行');
  process.exit(1);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[0] + '\nthis.pickNextTarget = pickNextTarget;', sandbox);
const pickNextTarget = sandbox.pickNextTarget;

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + '\n        期望 ' + JSON.stringify(want) + '\n        实际 ' + JSON.stringify(got));
  }
}

const item = (name, num, extra) =>
  Object.assign({ name, num, depth: num ? num.split('.').length : 0, done: false, isGroup: false }, extra || {});

// 1) 章标题在前、小节在后：必须跳过章标题
eq(
  '跳过 depth=1 的章标题，选 5.1',
  pickNextTarget([
    item('Python语言基本语法', '5'),
    item('指令与程序语言', '5.1'),
    item('python语言及运行环境', '5.2'),
  ]).name,
  '指令与程序语言'
);

// 2) 只有章标题（深层小节还没展开）：退而求其次，不返回 null
eq(
  '只有章标题时退回第一个',
  pickNextTarget([item('Python语言基本语法', '5'), item('元组、字典与列表', '7')]).name,
  'Python语言基本语法'
);

// 3) 没有编号（中文目录）：取第一个
eq('无编号时取第一个', pickNextTarget([item('绪论', ''), item('第一章 计算机概述', '')]).name, '绪论');

// 4) 更深的层级（5.2.1）也算小节
eq(
  '子小节 depth=3 也算小节',
  pickNextTarget([item('章', '5'), item('节', '5.2'), item('子节 安装python', '5.2.1')]).name,
  '节'
);

// 5) 空池子返回 null（catalogNext 会转成"后面的小节都已完成"）
eq('空池子返回 null', pickNextTarget([]), null);
eq('undefined 也返回 null', pickNextTarget(undefined), null);

console.log('');
if (fail) {
  console.log(pass + ' 通过，' + fail + ' 失败');
  process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
