// test_kv_prefix.js — 验证「线上消息布局逐轮只追加」（KV 前缀缓存的前提）
//
// 背景：KV 缓存按 token 前缀命中。只要相邻两次请求的消息序列不是"前一次 + 追加"，
// 缓存就从分叉点开始全部作废。
// 曾经的坑：① system 里带时间戳（已修）② 动态上下文只注入当次、历史里存原文
//          → 从第一条 user 消息就分叉 ③ 工具轮把 finalMessage/toolResult 只放进当次请求。
//
// 做法：给服务加 VOICEAI_LLM_DUMP=<file> 后，每次真正发出的请求体会被追加写进该文件；
// 本脚本连问 4 轮（含一轮需要调工具的），然后校验：
//   ① 每一次请求都以"上一次请求的全部消息"为逐字节前缀
//   ② system 提示词逐轮一致
//   ③ 消息里没有逐轮变化的时间戳字段
//
// 跑法：VOICEAI_LLM_DUMP=temp/llm_dump.jsonl node server.js ...   （需重启服务）
//       node test_kv_prefix.js

'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DUMP = process.env.VOICEAI_LLM_DUMP || path.join(__dirname, 'temp', 'llm_dump.jsonl');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? '  ' + info : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${info ? '  ' + info : ''}`); }
  return ok;
};

const QUESTIONS = [
  '你好，请用一句话打个招呼。',
  '现在几点了？（用工具查，不要猜）',
  '那再过三小时是几点？',
  '谢谢，最后说一句再见。',
];

function askAll() {
  return new Promise((resolve) => {
    const ws = new WebSocket(process.env.WS_URL || 'ws://localhost:8214');
    let sent = 0;
    const next = () => {
      if (sent >= QUESTIONS.length) { setTimeout(() => { ws.close(); resolve(); }, 1500); return; }
      const q = QUESTIONS[sent++];
      console.log(`  → 第 ${sent} 问: ${q}`);
      ws.send(JSON.stringify({ type: 'text', text: q }));
    };
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'clear_history' })); setTimeout(next, 300); });
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'llm_done') setTimeout(next, 300);       // 上一轮完全结束后再问下一轮
      if (m.type === 'error') console.log('    (错误事件)', m.error);
    });
    ws.on('error', (e) => { console.log('WS 错误:', e.message); resolve(); });
    setTimeout(() => { try { ws.close(); } catch (e) {} resolve(); }, 120000);
  });
}

(async () => {
  const before = fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).length : 0;
  console.log(`\n[1] 连问 ${QUESTIONS.length} 轮（含工具轮）`);
  await askAll();

  const lines = fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean).slice(before) : [];
  if (!lines.length) {
    console.log('审计文件里没有新记录 —— 服务没带 VOICEAI_LLM_DUMP 启动？');
    process.exit(2);
  }
  const reqs = lines.map((l) => JSON.parse(l)).filter((r) => r.payload && r.payload.messages);
  const warms = reqs.filter((r) => r.warm);
  console.log(`\n[2] 抓到 ${reqs.length} 次真实请求（其中保温 ${warms.length} 次）`);
  check('至少 4 次请求（工具轮会多一次）', reqs.length >= 4, `n=${reqs.length}`);
  if (reqs.length < 2) { console.log(`\n通过: ${pass}  失败: ${fail}`); process.exit(1); }

  const msgs = (r) => (r.payload.messages || []).map((m) => JSON.stringify(m));

  console.log('\n[3] system 与消息体稳定性');
  const systems = new Set(reqs.map((r) => JSON.stringify(r.payload.messages.find((m) => m.role === 'system'))));
  check('system 逐轮逐字节一致', systems.size === 1, `不同取值 ${systems.size} 种`);
  const badTs = reqs.flatMap(msgs).filter((s) => s.includes('"timestamp"'));
  check('消息体不含 timestamp 字段', badTs.length === 0, badTs.length ? badTs[0].slice(0, 100) : '');

  console.log('\n[3b] 保温请求（KV 预热）');
  if (warms.length) {
    check('保温请求 max_tokens=1', warms.every((r) => r.payload.max_tokens === 1),
      `取值 ${[...new Set(warms.map((r) => r.payload.max_tokens))].join(',')}`);
    check('保温请求与真实请求同 system', warms.every((r) =>
      JSON.stringify(r.payload.messages.find((m) => m.role === 'system'))
      === JSON.stringify(reqs.find((x) => !x.warm).payload.messages.find((m) => m.role === 'system'))));
    const cacheHits = reqs.filter((r) => r.usage).map((r) => (r.usage.input || 0) + (r.usage.cacheRead || 0) > 0
      ? Math.round((r.usage.cacheRead / ((r.usage.input || 0) + (r.usage.cacheRead || 0))) * 100) : 0);
    console.log(`    各请求缓存命中率: ${cacheHits.join('% → ')}%`);
    check('存在高命中请求（≥80%）', cacheHits.some((p) => p >= 80), `最高 ${Math.max(...cacheHits)}%`);
  } else {
    console.log('    （本次没有触发保温；把 VOICEAI_KV_WARM_IDLE_MS 调小可观察到）');
  }

  console.log('\n[4] 逐轮只追加（KV 前缀命中的充分条件）');
  let broken = 0, detail = '';
  for (let i = 1; i < reqs.length; i++) {
    const prev = msgs(reqs[i - 1]), cur = msgs(reqs[i]);
    const ok = prev.every((x, k) => cur[k] === x);
    if (!ok) {
      broken++;
      if (!detail) {
        const k = prev.findIndex((x, j) => cur[j] !== x);
        detail = `第 ${i} 次请求与上一次在第 ${k} 条消息分叉\n      上次: ${String(prev[k]).slice(0, 90)}\n      本次: ${String(cur[k]).slice(0, 90)}`;
      }
    }
  }
  check(`相邻请求两两满足「前缀 + 追加」（${reqs.length - 1} 组）`, broken === 0, broken ? `${broken} 组分叉，首例：\n      ${detail}` : '');

  console.log('\n[5] 序列长度单调增长');
  const lens = reqs.map((r) => (r.payload.messages || []).length);
  check('消息条数不减', lens.every((n, i) => i === 0 || n >= lens[i - 1]), lens.join(' → '));
  console.log(`    末次请求消息数 ${lens[lens.length - 1]}，服务端报告 ${JSON.stringify(reqs[reqs.length - 1].usage)}`);

  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
