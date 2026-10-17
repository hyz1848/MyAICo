'use strict';
/**
 * tools/units.js — 单位换算（长度/质量/面积/体积/速度/温度/数据）
 * 口语里高频（"180 磅是多少斤""30 度是多少华氏"），且模型心算极易错。
 */

// 以基准单位为准的换算系数
const TABLES = {
  length: { 米: 1, m: 1, 千米: 1000, km: 1000, 公里: 1000, 厘米: 0.01, cm: 0.01, 毫米: 0.001, mm: 0.001,
    英里: 1609.344, mile: 1609.344, 英尺: 0.3048, foot: 0.3048, feet: 0.3048, 英寸: 0.0254, inch: 0.0254 },
  mass: { 千克: 1, kg: 1, 公斤: 1, 克: 0.001, g: 0.001, 吨: 1000, t: 1000, 斤: 0.5, 两: 0.05,
    磅: 0.45359237, lb: 0.45359237, lbs: 0.45359237, 盎司: 0.028349523125, oz: 0.028349523125 },
  area: { 平方米: 1, m2: 1, 平方千米: 1e6, 公顷: 10000, 亩: 666.6666667, 平方英尺: 0.09290304 },
  volume: { 升: 1, l: 1, 毫升: 0.001, ml: 0.001, 立方米: 1000, m3: 1000, 加仑: 3.785411784, gallon: 3.785411784 },
  speed: { 米每秒: 1, 'm/s': 1, 千米每小时: 0.2777777778, kmh: 0.2777777778, 'km/h': 0.2777777778,
    英里每小时: 0.44704, mph: 0.44704, 节: 0.5144444444, knot: 0.5144444444 },
  data: { 字节: 1, b: 1, kb: 1024, 千字节: 1024, mb: 1024 ** 2, 兆字节: 1024 ** 2,
    gb: 1024 ** 3, 吉字节: 1024 ** 3, tb: 1024 ** 4, 太字节: 1024 ** 4 },
  time: { 秒: 1, s: 1, 分钟: 60, min: 60, 小时: 3600, h: 3600, 天: 86400, day: 86400, 周: 604800 },
};

const TEMP_UNITS = ['摄氏度', '°c', 'c', '摄氏', '华氏度', '°f', 'f', '华氏', '开尔文', 'k'];

function norm(u) {
  return String(u || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 单位换算 */
function convert({ value, from, to }) {
  const v = Number(value);
  const f = norm(from), t = norm(to);
  if (!Number.isFinite(v)) return { error: `无效数值: ${value}` };
  if (!f || !t) return { error: '需要给出 from 与 to' };

  // 温度单独处理（仿射而非线性比例）
  if (TEMP_UNITS.includes(f) || TEMP_UNITS.includes(t)) {
    const isC = (x) => ['摄氏度', '°c', 'c', '摄氏'].includes(x);
    const isF = (x) => ['华氏度', '°f', 'f', '华氏'].includes(x);
    const isK = (x) => ['开尔文', 'k'].includes(x);
    let c;
    if (isC(f)) c = v; else if (isF(f)) c = (v - 32) * 5 / 9; else if (isK(f)) c = v - 273.15; else return { error: `不支持的温度单位: ${from}` };
    let out;
    if (isC(t)) out = c; else if (isF(t)) out = c * 9 / 5 + 32; else if (isK(t)) out = c + 273.15; else return { error: `不支持的温度单位: ${to}` };
    const r = Number(out.toFixed(4));
    return { value: v, from, to, result: r, display: `${v}${from} = ${r}${to}` };
  }

  for (const [kind, table] of Object.entries(TABLES)) {
    if (table[f] !== undefined && table[t] !== undefined) {
      const out = v * table[f] / table[t];
      const r = Number(out.toPrecision(10));
      return { kind, value: v, from, to, result: r, display: `${v}${from} = ${r}${to}` };
    }
  }
  return { error: `无法换算 ${from} → ${to}（两单位不属于同一类，或单位名不认识）` };
}

module.exports = { convert, TABLES };
