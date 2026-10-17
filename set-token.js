// set-token.js — 把 GitHub token 存进 git 凭据管理器（Windows 的 cmd / PowerShell / Git Bash 通用）
//
// 为什么不用 `printf ... | git credential approve`：
//   · printf 只在 Git Bash / WSL 里有，cmd 与 PowerShell 没有
//   · PowerShell 管道会写成 CRLF → 密码末尾多一个 \r → 之后所有推送 401 Bad credentials
//   Node 写 stdin 精确可控（LF），三种 shell 行为一致。
//
// 用法：
//   node set-token.js                 # 交互输入（不回显）
//   node set-token.js ghp_xxxxxxxx    # 直接传入（注意别留在命令历史里）
//
// 特性：存之前先用 API 校验 token，存之后再用 git credential fill 复核，只写 Windows 凭据管理器，不落盘。

'use strict';
const { execFileSync } = require('child_process');

const USER = process.env.GH_USER || 'hyz1848';
const HOST = 'github.com';

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) {
      // 非交互（被管道喂入）：直接按行读
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf.split('\n')[0].trim()));
      return;
    }
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value.trim());
      } else if (ch === '\u0003') {            // Ctrl+C
        process.stdout.write('\n已取消\n');
        process.exit(130);
      } else if (ch === '\u007f') {            // 退格
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function validate(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `token ${token}`, 'User-Agent': 'voiceai-set-token' },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const u = await res.json();
  const scopes = res.headers.get('x-oauth-scopes');
  return { ok: true, login: u.login, scopes };
}

function store(token) {
  // 精确 LF；Node 的 input 不会被 shell 换成 CRLF
  execFileSync('git', ['credential', 'approve'], {
    input: `protocol=https\nhost=${HOST}\nusername=${USER}\npassword=${token}\n\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function readBack() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${HOST}\n\n`,
    encoding: 'utf8',
  });
  const p = out.match(/^password=(.*)$/m);
  return p ? p[1].trim() : null;
}

(async () => {
  let token = (process.argv[2] || '').trim();
  if (!token) token = await readHidden('粘贴 GitHub token（不回显，回车确认）：');
  if (!token) {
    console.error('没有输入 token');
    process.exit(2);
  }
  if (!/^(ghp_|github_pat_)/.test(token)) {
    console.log(`⚠️  看起来不像 GitHub token（通常以 ghp_ 或 github_pat_ 开头，当前 ${token.length} 字符）`);
  }

  process.stdout.write('校验中… ');
  const v = await validate(token);
  if (!v.ok) {
    console.log(`✗ HTTP ${v.status}（token 无效/已过期/已吊销）`);
    process.exit(1);
  }
  console.log(`✓ 有效，账号 ${v.login}${v.scopes ? `，权限 ${v.scopes}` : ''}`);

  store(token);
  const back = readBack();
  if (back === token) console.log('✓ 已存入 Windows 凭据管理器（git credential 复核一致）');
  else console.log('⚠️  存入后复核不一致，请重跑一次');

  console.log('\n以后推送：');
  console.log('  git push                 # github.com 可达时');
  console.log('  node push.js             # 自动选路：通了走 git push，被墙走 REST API');
  console.log('\n提醒：用完（或觉得不安全）随时到 GitHub → Settings → Developer settings 吊销该 token。');
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
