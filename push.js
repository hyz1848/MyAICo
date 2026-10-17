// push.js — 一键推送：网络通走 git push，被墙自动改走 GitHub REST API
//
// 为什么：本机 github.com:443 时常不可达（api.github.com 正常），git push 会卡 20s 后失败。
// 本脚本先快速探测 github.com 连通性：
//   · 通   → 走标准 git push（正常处理分支/合并语义）
//   · 不通 → 走 REST API（见 push_via_github_api.js），并在推送前比对内容：
//            若远端分支的 tree 与本地 HEAD 的 tree 相同（内容一致），直接跳过，不产生空提交
//
// 凭据来源：优先环境变量 GH_TOKEN / GITHUB_TOKEN；否则用 `git credential fill` 取
//           Windows 凭据管理器里已存的 GitHub 凭据（即之前 git 授权时存下的那份）。
//
// 用法：node push.js            （只推本地已提交的内容，不含 add/commit）

'use strict';
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const REPO = process.env.GH_REPO || 'hyz1848/MyAICo';
const BRANCH = process.env.GH_BRANCH || 'main';
const API = 'https://api.github.com';

const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim();

function getToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      cwd: __dirname, encoding: 'utf8',
      input: 'protocol=https\nhost=github.com\n\n',
    });
    const m = out.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch (e) { /* 取不到就报错 */ }
  return null;
}

async function apiFetch(token, url) {
  const res = await fetch(`${API}${url}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'voiceai-push' },
  });
  if (!res.ok) return null;
  return res.json();
}

// 探测 git 真正用的端点（Smart HTTP）。只测首页会误判：
// 实测 https://github.com 首页能开，但 git 端点 TLS 被重置（Recv failure: Connection was reset）。
async function gitEndpointReachable() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  try {
    const r = await fetch(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`, {
      method: 'GET', signal: c.signal, redirect: 'manual',
    });
    return r.status > 0;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const localTree = git('rev-parse', 'HEAD^{tree}');
  const localHead = git('rev-parse', '--short', 'HEAD');
  console.log(`本地 ${localHead} tree=${localTree.slice(0, 8)}  目标 ${REPO}@${BRANCH}`);

  // 1) git 端点通 → 先走标准推送；失败也不放弃，继续走 API
  if (await gitEndpointReachable()) {
    console.log('github.com git 端点可达 → 尝试标准 git push');
    const r = spawnSync('git', ['push', '-u', 'origin', BRANCH], { cwd: __dirname, stdio: 'inherit' });
    if (r.status === 0) process.exit(0);
    console.log('git push 失败 → 改走 REST API');
  } else {
    console.log('github.com git 端点不可达 → 直接走 REST API');
  }

  // 2) 取凭据
  const token = getToken();
  if (!token) {
    console.error('取不到 GitHub 凭据：请设置 GH_TOKEN，或先手动 git push 一次以存入凭据管理器');
    process.exit(2);
  }

  // 3) 内容一致就不推（避免产生只有 SHA 不同的空提交）
  const ref = await apiFetch(token, `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (ref) {
    const remoteCommit = await apiFetch(token, `/repos/${REPO}/git/commits/${ref.object.sha}`);
    if (remoteCommit && remoteCommit.tree && remoteCommit.tree.sha === localTree) {
      console.log(`远端内容已与本一致（tree ${localTree.slice(0, 8)}，远端提交 ${ref.object.sha.slice(0, 8)}）→ 无需推送`);
      process.exit(0);
    }
  }

  // 4) API 推送
  const { pushViaApi } = require('./push_via_github_api');
  try {
    const out = await pushViaApi(token, { repo: REPO, branch: BRANCH });
    console.log(out && out.treeMatches ? '\n✅ 推送完成，内容与本地逐字节一致' : '\n✅ 推送完成（tree 哈希与本地不同，请核对内容）');
  } catch (e) {
    if (/401|403/.test(e.message)) {
      console.error('\n凭据无效（可能 token 已吊销/过期）→ 重新存入：');
      console.error('  printf "protocol=https\\nhost=github.com\\nusername=hyz1848\\npassword=<新TOKEN>\\n\\n" | git credential approve');
    }
    throw e;
  }
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
