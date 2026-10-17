'use strict';
/**
 * tools/reminders.js — 提醒/闹钟（语音助手的核心场景：到点用语音播报）
 *
 * 落盘 data/reminders.json；由 server 启动时注册 onFire 回调做播报。
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.VOICEAI_DATA_DIR || path.join(__dirname, '..', 'data'), 'reminders.json');
let reminders = [];
let onFire = null;
let timer = null;
let seq = 0;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw.reminders)) {
      reminders = raw.reminders.filter((r) => r && r.id && r.at);
      seq = raw.seq || reminders.length;
    }
  } catch (e) { /* 首次运行 */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ seq, reminders }, null, 1));
  } catch (e) { console.error('[Reminder] 保存失败:', e.message); }
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 → 数值：支持 三 / 十 / 十一 / 二十三 / 半（0.5） 等形式 */
function cnToNum(s) {
  const t = String(s || '').trim();
  if (!t) return NaN;
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '半') return 30;                    // 用于"三点半"的分钟位
  if (t === '十') return 10;
  const m = t.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (t.length === 1 && t in CN_DIGITS) return CN_DIGITS[t];
  if (t.length === 2 && t[0] in CN_DIGITS && t[1] in CN_DIGITS) return CN_DIGITS[t[0]] * 10 + CN_DIGITS[t[1]];
  return NaN;
}

/** 把 "3分钟后""明天早上八点""下午三点半""六点" 这类时间说法解析成 Date */
function parseWhen(when, now = new Date()) {
  const s = String(when || '').trim();
  if (!s) return null;

  // 相对时间：N 秒/分钟/小时/天 后（数字或中文数字）
  let m = s.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(秒|分钟|分|小时|钟头|天|周)\s*(?:后|之后|以后|later)?/);
  if (m && /后|之后|以后|later/.test(s)) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : cnToNum(m[1]);
    const unit = { 秒: 1000, 分钟: 60000, 分: 60000, 小时: 3600000, 钟头: 3600000, 天: 86400000, 周: 604800000 }[m[2]];
    if (Number.isFinite(n)) return new Date(now.getTime() + n * unit);
  }

  // 绝对时间：HH:MM / HH点[MM分|半]（含中文数字与"点半"）
  const abs = s.match(/(?:今天|明天|后天)?\s*(?:早上|上午|中午|下午|晚上|傍晚|夜里|凌晨)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点:：时]\s*(\d{1,2}|[一二两三四五六七八九十]{1,3}|半)?\s*分?/);
  if (abs) {
    let h = /^\d/.test(abs[1]) ? Number(abs[1]) : cnToNum(abs[1]);
    let mi = abs[2] ? (/^\d/.test(abs[2]) ? Number(abs[2]) : cnToNum(abs[2])) : 0;
    if (Number.isFinite(h) && Number.isFinite(mi)) {
      const isPM = /下午|晚上|傍晚|夜里/.test(s);
      const isAM = /早上|上午|凌晨/.test(s);
      const isNoon = /中午/.test(s);
      if (isPM && h < 12) h += 12;
      if (isAM && h === 12) h = 0;
      if (isNoon && h < 12 && h !== 12) h += 12;
      if (h >= 0 && h < 24 && mi >= 0 && mi < 60) {
        const d = new Date(now);
        d.setHours(h, mi, 0, 0);
        if (/明天/.test(s)) d.setDate(d.getDate() + 1);
        else if (/后天/.test(s)) d.setDate(d.getDate() + 2);
        else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);   // 已过则默认明天
        return d;
      }
    }
  }

  if (/明天/.test(s)) { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d; }
  if (/今天/.test(s)) { const d = new Date(now); d.setHours(d.getHours() + 1, 0, 0, 0); return d; }
  return null;
}

function fmt(d) {
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${w} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function addReminder({ text, when }) {
  const label = String(text || '').trim();
  if (!label) return { error: '缺少提醒内容' };
  const at = parseWhen(when);
  if (!at) return { error: `无法理解这个时间: ${when}（试试"3分钟后""明天早上八点""下午三点半"）` };
  if (at.getTime() - Date.now() < -5000) return { error: '这个时间已经过去了' };
  const r = { id: `r${++seq}`, text: label, when: String(when), at: at.getTime(), fired: false };
  reminders.push(r);
  save();
  schedule();
  return { ok: true, id: r.id, text: label, at: fmt(at), inSeconds: Math.round((at.getTime() - Date.now()) / 1000) };
}

function listReminders() {
  const pending = reminders.filter((r) => !r.fired);
  return { count: pending.length, items: pending.map((r) => ({ id: r.id, text: r.text, at: fmt(new Date(r.at)), inSeconds: Math.round((r.at - Date.now()) / 1000) })) };
}

function cancelReminder({ id, text }) {
  const before = reminders.length;
  reminders = reminders.filter((r) => {
    if (r.fired) return true;
    if (id) return r.id !== id;
    if (text) return !r.text.includes(String(text));
    return false;
  });
  save();
  return { ok: true, removed: before - reminders.length, remaining: listReminders().count };
}

/** 到点触发 */
function checkDue() {
  const now = Date.now();
  const due = reminders.filter((r) => !r.fired && r.at <= now);
  if (!due.length) return;
  for (const r of due) r.fired = true;
  save();
  for (const r of due) {
    const line = r.when && /分钟后|秒后|小时后/.test(r.when) && r.text.startsWith('提醒') === false
      ? `提醒你：${r.text}`
      : `时间到了，${r.text}`;
    if (typeof onFire === 'function') {
      try { onFire(line, r); } catch (e) { console.error('[Reminder] 播报失败:', e.message); }
    }
  }
  // 清理已触发 1 天以上的记录
  reminders = reminders.filter((r) => !r.fired || now - r.at < 86400000);
  save();
}

function schedule() {
  if (timer) return;
  // 1 秒一扫：5 秒间隔会让"10 秒后提醒"晚响好几秒
  timer = setInterval(checkDue, 1000);
  timer.unref?.();
}

function start(fireCallback) {
  onFire = fireCallback;
  load();
  schedule();
  const n = listReminders().count;
  console.log(`[Reminder] 已加载，待触发 ${n} 条`);
}

module.exports = { start, addReminder, listReminders, cancelReminder, parseWhen, fmt, checkDue, cnToNum, _internal: () => reminders };
