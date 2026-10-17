'use strict';
/**
 * echo-guard.js — 内容级回声识别（解决 TTS 被自家麦克风听回去形成自问自答环）
 *
 * 思路：能量门限挡不住喇叭声（音量远超噪声底），但**我们知道刚刚说了什么**。
 * 若 ASR 结果与最近播报过的文本高度重合，就判定为回声丢弃。
 *
 * 与时间窗配合：
 *  - 播报中：直接忽略非停止词的 ASR（server 现有逻辑）
 *  - 播报结束后的尾巴/混响：由本模块兜底（时间窗内 + 内容相似）
 *
 * 判定规则（任一命中即为回声）：
 *  1) 最长公共子串 >= minMatch（默认 6 字，中文回声几乎逐字一致）
 *  2) ASR 文本几乎整体包含在最近播报内容里：len >= 2 且 lcs >= len * 0.8
 *  3) ASR 文本是最近播报内容的子串（长度 >= 3）
 *
 * 单字结果（"嗯"/"在"）一律不判回声：误杀的代价小于误判，且单字不会成环。
 */

const DEFAULT_WINDOW_MS = 25000;
const DEFAULT_MIN_MATCH = 6;
const MIN_LEN_FOR_FULL_MATCH = 2;
const MIN_LEN_FOR_SUBSTRING = 3;
// "几乎整体重合"分支的绝对下限：避免把用户真说的短词（如「停止」）当成回声吞掉。
// 2 字重合的证据太弱；而 2 字回声漏进 LLM 无害（也成不了环）。
const MIN_LCS_ABS = 4;

/** 归一化：去掉标点/空白，小写化，便于比较 */
function normalize(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 最长公共子串长度（DP，输入均很短） */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const n = a.length, m = b.length;
  let best = 0;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev; prev = cur; cur = tmp;
    cur.fill(0);
  }
  return best;
}

/**
 * 纯函数判定：asrText 是否像 recentText 的回声
 * @returns {{echo:boolean, reason:string, lcs:number}}
 */
function classifyEcho(asrText, recentText, opts = {}) {
  const minMatch = opts.minMatch || DEFAULT_MIN_MATCH;
  const a = normalize(asrText);
  const b = normalize(recentText);
  if (!a || !b) return { echo: false, reason: 'empty', lcs: 0 };
  if (a.length < MIN_LEN_FOR_FULL_MATCH) return { echo: false, reason: 'too-short-input', lcs: 0 };

  if (a.length >= MIN_LEN_FOR_SUBSTRING && b.includes(a)) {
    return { echo: true, reason: 'asr-contained-in-speech', lcs: a.length };
  }
  const lcs = longestCommonSubstring(a, b);
  if (lcs >= minMatch) return { echo: true, reason: `lcs>=${minMatch}`, lcs };
  if (a.length >= MIN_LEN_FOR_FULL_MATCH && lcs >= Math.max(MIN_LCS_ABS, a.length * 0.8)) {
    return { echo: true, reason: 'mostly-equal', lcs };
  }
  return { echo: false, reason: 'no-match', lcs };
}

/** 有状态的守门器：记住最近播报内容并做时间窗判定 */
function createEchoGuard(opts = {}) {
  const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
  const maxEntries = opts.maxEntries || 80;
  const entries = [];   // { text, at }

  function remember(text, at = Date.now()) {
    const t = String(text || '').trim();
    if (!t) return;
    entries.push({ text: t, at });
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
  }

  function prune(now) {
    while (entries.length && now - entries[0].at > windowMs) entries.shift();
  }

  /** ASR 文本是否为我们刚说过的内容的回声 */
  function isEcho(asrText, now = Date.now()) {
    prune(now);
    const a = normalize(asrText);
    if (!a) return { echo: false, reason: 'empty', lcs: 0 };
    let best = { echo: false, reason: 'no-match', lcs: 0 };
    let newest = 0;
    for (const e of entries) {
      const v = classifyEcho(asrText, e.text, opts);
      if (v.echo && v.lcs >= best.lcs) { best = v; newest = now - e.at; }
    }
    if (best.echo) best.ageMs = newest;
    return best;
  }

  function clear() { entries.length = 0; }

  return { remember, isEcho, clear, get size() { return entries.length; }, get entries() { return entries.slice(); } };
}

module.exports = {
  createEchoGuard,
  classifyEcho,
  normalize,
  longestCommonSubstring,
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_MATCH,
};
