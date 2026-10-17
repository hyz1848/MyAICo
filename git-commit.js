// git-commit.js — 带安全检查的提交（防止误提交 venv / 模型 / 大文件）
//
// 为什么：我曾用 `git add -A && git commit` 把新建的 venv-gpu（6GB、2.5 万个文件）
// 提交进了版本库 —— .gitignore 只写了 `venv/`，没写 `venv-gpu/`。
// 这个脚本在提交前检查暂存区的**文件数/体积/单个大文件**，异常就拦下来。
//
// 用法：
//   node git-commit.js "feat: 说明"          # 检查通过才提交
//   node git-commit.js --check                # 只看检查结果
//   node git-commit.js --force "说明"         # 明知较大也提交
'use strict';
const { execFileSync } = require('child_process');

const MAX_FILES = 200;
const MAX_TOTAL_MB = 5;
const MAX_SINGLE_MB = 1;

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkOnly = args.includes('--check');
const message = args.filter((a) => !a.startsWith('--')).join(' ').trim();

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const staged = git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
if (!staged.length) {
  console.log('暂存区为空（先 git add）');
  process.exit(2);
}

let total = 0;
const big = [];
const { statSync } = require('fs');
for (const f of staged) {
  try {
    const s = statSync(f).size;
    total += s;
    if (s > MAX_SINGLE_MB * 1024 * 1024) big.push(`${(s / 1048576).toFixed(1)}MB  ${f}`);
  } catch (e) { /* 已删除的文件 */ }
}
const totalMB = total / 1048576;
console.log(`暂存: ${staged.length} 个文件, 共 ${totalMB.toFixed(2)} MB`);
if (big.length) {
  console.log(`⚠️  单个文件超过 ${MAX_SINGLE_MB}MB：`);
  big.slice(0, 10).forEach((x) => console.log('   ' + x));
}

const problems = [];
if (staged.length > MAX_FILES) problems.push(`文件数 ${staged.length} > ${MAX_FILES}（像是把 venv/模型 加进来了）`);
if (totalMB > MAX_TOTAL_MB) problems.push(`总体积 ${totalMB.toFixed(1)}MB > ${MAX_TOTAL_MB}MB`);
if (big.length) problems.push(`存在 ${big.length} 个大文件`);

if (problems.length) {
  console.log('\n✗ 需要确认:');
  problems.forEach((p) => console.log('   - ' + p));
  console.log('\n建议: 检查 .gitignore 是否覆盖新目录；要提交就加 --force');
  if (!force) process.exit(1);
  console.log('（--force 已指定，继续）');
}
if (checkOnly) process.exit(0);
if (!message) {
  console.log('\n缺少提交信息，例如: node git-commit.js "fix: ..."');
  process.exit(2);
}
execFileSync('git', ['commit', '-m', message], { stdio: 'inherit' });
console.log('✓ 已提交');
