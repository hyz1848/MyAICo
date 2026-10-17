// push_via_github_api.js — 用 GitHub REST API 推送本地提交（绕过被墙的 github.com）
//
// 为什么需要：国内网络常见 "api.github.com 通、github.com:443 不通" —— 此时 git push
// 会卡在 "Failed to connect to github.com port 443"。而 REST API 走 api.github.com，
// 可以把本地 HEAD 的内容原样建成远端提交（同一棵树 → 内容逐字节一致）。
//
// 用法：
//   GH_TOKEN=<你的 PAT> node push_via_github_api.js [owner/repo] [branch]
// 默认 owner/repo=hyz1848/MyAICo，branch=main
//
// 安全：token 只从环境变量读，不写入任何文件。
// 说明：只推送本地 HEAD 的内容（首次提交/整体覆盖远端分支），不做增量与历史合并。

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2] || 'hyz1848/MyAICo';
const BRANCH = process.argv[3] || 'main';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量（GitHub PAT）');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'buffer' }).toString('utf8').trim();

async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'voiceai-push',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 300);
    throw new Error(`${method} ${url} → HTTP ${res.status}: ${msg}`);
  }
  return json;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

(async () => {
  const headMessage = git('log', '-1', '--format=%B');
  const authorName = git('log', '-1', '--format=%an');
  const authorEmail = git('log', '-1', '--format=%ae');
  const authorDate = git('log', '-1', '--format=%aI');
  const localTree = git('rev-parse', 'HEAD^{tree}');
  console.log(`仓库 ${REPO} 分支 ${BRANCH}`);
  console.log(`本地 HEAD: ${git('rev-parse', '--short', 'HEAD')} tree=${localTree}`);
  console.log(`作者: ${authorName} <${authorEmail}>`);

  // 1) 取本地 HEAD 下的全部文件（path/mode/blob sha），内容用 git cat-file 从提交里读（保证与提交一致）
  const ls = git('ls-files', '-s').split('\n').filter(Boolean).map((line) => {
    const [meta, p] = line.split('\t');
    const [mode, sha] = meta.split(/\s+/);
    return { mode, sha, path: p };
  });
  console.log(`文件数: ${ls.length}`);

  // 2) 逐文件准备 tree 条目：文本内联 content，二进制先传 blob。
  //    注意：**空仓库里不允许创建 blob**（409 "Git Repository is empty"）→
  //    先把文本建成树与提交，等仓库有提交后再补二进制，因此这里只分类、不立即上传。
  const inlineEntries = [];   // 文本：直接内联
  const binaryFiles = [];     // 二进制：待上传 blob
  for (const f of ls) {
    const buf = execFileSync('git', ['cat-file', 'blob', f.sha], { cwd: __dirname, maxBuffer: 64 * 1024 * 1024 });
    if (isBinary(buf)) binaryFiles.push({ ...f, buf });
    else inlineEntries.push({ path: f.path, mode: f.mode, type: 'blob', content: buf.toString('utf8') });
  }
  console.log(`准备完成：文本 ${inlineEntries.length} 个（内联），二进制 ${binaryFiles.length} 个`);

  const createTree = (entries, baseTree) => api('POST', `/repos/${REPO}/git/trees`,
    baseTree ? { tree: entries, base_tree: baseTree } : { tree: entries });
  const makeCommit = (treeSha, parents) => api('POST', `/repos/${REPO}/git/commits`, {
    message: headMessage, tree: treeSha, parents,
    author: { name: authorName, email: authorEmail, date: authorDate },
    committer: { name: authorName, email: authorEmail, date: authorDate },
  });

  // 3) 远端是否已有分支
  let branchSha = null;
  try {
    const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    branchSha = ref.object.sha;
    console.log(`远端分支已存在: ${branchSha.slice(0, 8)}`);
  } catch (e) {
    console.log('远端分支不存在（首次推送）');
  }

  // 4) 空仓库特例：GitHub 在**空仓库**上禁用 Git Data API（blob/tree 都返回 409
  //    "Git Repository is empty"）→ 必须先用 Contents API 造出首个提交。
  if (!branchSha) {
    const seedPath = '.gitignore';
    const seedSha = git('rev-parse', `HEAD:${seedPath}`);
    const seedBuf = execFileSync('git', ['cat-file', 'blob', seedSha], { cwd: __dirname });
    const seed = await api('PUT', `/repos/${REPO}/contents/${seedPath}`, {
      message: 'chore: 初始化仓库',
      content: seedBuf.toString('base64'),
      branch: BRANCH,
    });
    branchSha = seed.commit.sha;
    console.log(`空仓库已初始化（首个提交 ${branchSha.slice(0, 8)}，仅 .gitignore）`);
  }

  // 5) 通用流程：全量树 + 提交（parent = 当前分支）+ 强推引用
  const entries = [...inlineEntries];
  for (const f of binaryFiles) {
    const b = await api('POST', `/repos/${REPO}/git/blobs`, { content: f.buf.toString('base64'), encoding: 'base64' });
    entries.push({ path: f.path, mode: f.mode, type: 'blob', sha: b.sha });
  }
  const tree = await createTree(entries);
  const commit = await makeCommit(tree.sha, [branchSha]);
  await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  console.log(`远端提交完成: ${commit.sha.slice(0, 8)}`);
  const treeSha = tree.sha;
  const commitSha = commit.sha;

  const treeMatches = treeSha === localTree;
  console.log(`远端 tree: ${treeSha}`);
  console.log(treeMatches
    ? '✅ tree 哈希与本地完全一致 → 内容逐字节相同'
    : `⚠️  tree 哈希不同（本地 ${localTree}）：内容可能有差异（换行符/模式），请核对`);
  console.log(`远端 commit: ${commitSha}`);

  // 6) 记录远端跟踪引用，便于本地与远端对齐（不需要网络）
  const refFile = path.join(__dirname, '.git', 'refs', 'remotes', 'origin', BRANCH);
  fs.mkdirSync(path.dirname(refFile), { recursive: true });
  fs.writeFileSync(refFile, commitSha + '\n');
  console.log(`已写入本地跟踪引用 .git/refs/remotes/origin/${BRANCH} → ${commitSha.slice(0, 8)}`);
  console.log(`\n下一步（本地对齐，无需网络）：\n  git reset --mixed ${commitSha}\n  git branch --set-upstream-to=origin/${BRANCH} ${BRANCH}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
