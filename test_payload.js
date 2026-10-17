// test_payload.js — 在真实请求体层面核对 LLM 调用（KV 前缀稳定性 + 关键开关）
//
// 为什么需要：KV 前缀缓存要求"消息序列前部逐轮不变"。此前把时间戳注入 system，
// 导致每轮 2000+ token 全部重算（实测 2.4s vs 0.53s）。这里直接抓取发给模型的
// 真实 payload，逐字节验证前缀是否稳定。
//
// 运行：node test_payload.js

'use strict';
const { createPiClient } = require('./agent/pi-client');

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? '  ' + info : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${info ? '  ' + info : ''}`); }
  return ok;
};

async function main() {
  const SYSTEM = '你是一个语音助手。回答要简洁。';   // 逐轮不变的 system
  const payloads = [];
  const client = await createPiClient({
    onPayload: (p) => { payloads.push(JSON.parse(JSON.stringify(p))); return undefined; },   // 不改，只抓
  });

  // 第 1 轮
  const t1 = [{ role: 'user', content: '你好' }];
  const r1 = await client.chat({ systemPrompt: SYSTEM, messages: t1.map((m) => ({ ...m })) });
  // 第 2 轮：历史 = 第 1 轮 + 回答 + 新问题（模拟 server.js 的 history 追加）
  const t2 = [...t1, { role: 'assistant', content: r1.text }, { role: 'user', content: '再讲一句' }];
  const r2 = await client.chat({ systemPrompt: SYSTEM, messages: t2.map((m) => ({ ...m })) });

  console.log('\n[1] 请求体基本形状');
  const p1 = payloads[0], p2 = payloads[1];
  check('抓到两次请求体', !!p1 && !!p2, `n=${payloads.length}`);
  const sysOf = (p) => JSON.stringify(p.messages.find((m) => m.role === 'system'));
  check('system 逐轮一致（KV 前缀前提）', sysOf(p1) === sysOf(p2));
  check('关闭思维链的开关已注入',
    !!(p1.chat_template_kwargs && p1.chat_template_kwargs.enable_thinking === false),
    JSON.stringify(p1.chat_template_kwargs));

  console.log('\n[2] 消息里不得包含逐轮变化的时间戳/元数据');
  const bad = (p1.messages || []).filter((m) => m.role !== 'system' && 'timestamp' in m);
  check('消息体不含 timestamp 字段', bad.length === 0, bad.length ? JSON.stringify(bad[0]).slice(0, 120) : '');

  console.log('\n[3] 前缀逐字节一致（缓存命中的充分条件）');
  const msgs = (p) => (p.messages || []).filter((m) => m.role !== 'system').map((m) => JSON.stringify(m));
  const m1 = msgs(p1), m2 = msgs(p2);
  check('第 2 轮以第 1 轮的消息逐条一致为前缀', m1.every((x, i) => m2[i] === x),
    `第1轮 ${m1.length} 条 → 第2轮 ${m2.length} 条`);
  check('末条是最新用户问题', JSON.stringify((p2.messages || []).slice(-1)[0]).includes('再讲一句'));

  console.log('\n[4] 功能未受影响');
  check('第 1 轮有文本', r1.text.trim().length > 0, `${r1.text.length} 字`);
  check('第 2 轮有文本', r2.text.trim().length > 0, `${r2.text.length} 字`);
  check('两轮都 stopReason=stop', r1.stopReason === 'stop' && r2.stopReason === 'stop',
    `${r1.stopReason}/${r2.stopReason}`);

  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
