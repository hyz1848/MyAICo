'use strict';
/**
 * tools/datetime.js — 日期计算（模型算日期极不可靠，必须用工具）
 */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function parseDate(s, base = new Date()) {
  const t = String(s || '').trim();
  if (!t || t === '今天' || t === 'now' || t === 'today') return new Date(base);
  if (t === '明天') return new Date(base.getTime() + 86400000);
  if (t === '后天') return new Date(base.getTime() + 2 * 86400000);
  if (t === '昨天') return new Date(base.getTime() - 86400000);
  if (t === '前天') return new Date(base.getTime() - 2 * 86400000);
  const m = t.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const m2 = t.match(/^(\d{1,2})[-/月](\d{1,2})日?$/);
  if (m2) return new Date(base.getFullYear(), Number(m2[1]) - 1, Number(m2[2]));
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

function fmt(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}

/** 日期运算 */
function dateMath({ base, op, value, unit, target }) {
  const b = parseDate(base);
  if (!b) return { error: `无法解析日期: ${base}` };
  if (op === 'diff') {
    const t = parseDate(target, b);
    if (!t) return { error: `无法解析日期: ${target}` };
    const days = Math.round((t.setHours(0, 0, 0, 0) - new Date(b).setHours(0, 0, 0, 0)) / 86400000);
    return { from: fmt(b), to: fmt(t), days, weeks: Number((days / 7).toFixed(2)), weekdayOfTarget: WEEK[t.getDay()] };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `无效数值: ${value}` };
  const d = new Date(b);
  switch (unit) {
    case 'day': d.setDate(d.getDate() + n); break;
    case 'week': d.setDate(d.getDate() + n * 7); break;
    case 'month': d.setMonth(d.getMonth() + n); break;
    case 'year': d.setFullYear(d.getFullYear() + n); break;
    case 'hour': d.setHours(d.getHours() + n); break;
    case 'minute': d.setMinutes(d.getMinutes() + n); break;
    default: return { error: `无效单位: ${unit}（可用 day/week/month/year/hour/minute）` };
  }
  return { base: fmt(b), result: fmt(d), iso: d.toISOString(), weekday: WEEK[d.getDay()] };
}

module.exports = { dateMath, parseDate, fmt, WEEK };
