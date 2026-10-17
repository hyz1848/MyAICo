'use strict';
/**
 * wake.js — 唤醒词门控（确定性规则，不依赖模型）
 *
 * 为什么需要：连续聆听时任何人的说话都会触发回复（电视、旁人、AI 自己的回声残留）。
 * 用「唤醒词 + 会话超时」把交互明确化：
 *   待命(idle)  --(说到唤醒词)-->  会话中(awake)  --(空闲超时 / 结束语)-->  待命(idle)
 *
 * 唤醒词「潞潞同学」用 **拼音匹配**（忽略声调）：中文 ASR 会把同音音节写成不同字
 * （潞/璐/露/路/卢/鲁/鹿/陆/噜…），手工列变体永远列不全。
 *
 * 防误唤醒：
 *   1) 必须在句首（可带 hey/嗨/嘿/喂/你好 等招呼语），或紧跟后缀（同学/小助手/在吗/你好）
 *   2) 句首且后面直接接话时，接的必须是命令/疑问线索词（否则"陆陆续续…"会误唤醒）
 */

const { pinyin } = require('pinyin-pro');

// 唤醒名的音节（忽略声调）：潞潞 → lu + lu
const NAME_SYLLABLES = ['lu', 'lu'];
// 可紧随其后的后缀词（有它就算明确点名）
const SUFFIXES = ['同学', '小助手', '助手', '在吗', '你好', '您好'];
// 招呼语（出现在名字之前不算内容）
const FILLER_RE = /^(?:hey|hi|hello|ok|okay|yo|嗨|嘿|喂|哎|那个|你好|您好)[\s,，、。.!！?？]*/i;
const FILLER_ONLY_RE = /^[\s,，、。.!！?？]*$/;
// 命令/疑问线索词：句首名字后面直接接话时，用来区分"点名"与"巧合同音词"
const CUE_WORDS = ['现在', '今天', '明天', '帮我', '请问', '我想', '我要', '怎么', '为什么', '多少', '几点', '天气',
  '提醒', '搜索', '搜一下', '算一下', '计算', '叫', '开', '关', '放', '来', '说', '讲', '唱', '告诉', '记得',
  '是不是', '有没有', '能不能', '可以', '在不在', '在吗', '介绍', '解释', '查'];

/** 把文本切成 token（中文按字，拉丁按词），带原文偏移 */
function tokenize(text) {
  const raw = pinyin(text, { type: 'all', toneType: 'none' });
  const out = [];
  let pos = 0;
  for (const t of raw) {
    const origin = t.origin || '';
    if (!origin) continue;
    if (t.isZh) out.push({ kind: 'zh', syl: t.pinyin, text: origin, start: pos, end: pos + origin.length });
    else if (/[a-z]/i.test(origin)) out.push({ kind: 'latin', text: origin, start: pos, end: pos + origin.length });
    else out.push({ kind: 'other', text: origin, start: pos, end: pos + origin.length });
    pos += origin.length;
  }
  // 合并连续拉丁字母为一个词（lulu）
  const merged = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (t.kind === 'latin' && last && last.kind === 'latinword') {
      last.text += t.text; last.end = t.end;
    } else if (t.kind === 'latin') {
      merged.push({ kind: 'latinword', text: t.text, start: t.start, end: t.end });
    } else {
      merged.push(t);
    }
  }
  return merged;
}

/** 命中位置是否可信 */
function plausible(text, tokens, i, len) {
  const first = tokens[i];
  const last = tokens[i + len - 1];
  const prefix = text.slice(0, first.start);
  const after = text.slice(last.end);
  // (1) 句首（前面只有招呼语/标点）
  if (FILLER_ONLY_RE.test(prefix) || FILLER_RE.test(prefix)) {
    const trimmed = after.replace(/^[\s,，、。.!！?？]+/, '');
    if (!trimmed) return true;                                 // "潞潞"
    if (SUFFIXES.some((s) => trimmed.startsWith(s))) return true;          // "潞潞同学…"
    if (CUE_WORDS.some((w) => trimmed.startsWith(w))) return true;         // "潞潞现在几点"
    return false;                                              // "陆陆续续…" 之类
  }
  // (2) 名字不在句首，但紧跟后缀 → 也算点名（"喂，潞潞同学"）
  return SUFFIXES.some((s) => after.startsWith(s));
}

/** 命中后把紧跟的后缀词（同学/在吗…）一起吞掉，避免残留在指令里 */
function extendWithSuffix(text, span) {
  const after = text.slice(span.end);
  let end = span.end;
  let prev;
  do {
    prev = end;
    for (const s of SUFFIXES) {
      if (text.slice(end).startsWith(s)) { end += s.length; break; }
    }
  } while (end !== prev);
  return { start: span.start, end };
}

/** 提取命中 span 之外的剩余内容 */
function buildResult(text, span) {
  const before = text.slice(0, span.start);
  let rest = `${before}${text.slice(span.end)}`.replace(/^[\s,，、。.!！?？]+/, '');
  let prev;
  do { prev = rest; rest = rest.replace(FILLER_RE, ''); } while (rest !== prev);
  return { woke: true, rest: rest.trim(), matched: text.slice(span.start, span.end) };
}

/**
 * 从识别文本里提取唤醒信息
 * @returns {{woke:boolean, rest:string, matched:string}}
 */
function detectWake(text) {
  const t = String(text || '');
  if (!t.trim()) return { woke: false, rest: '', matched: '' };
  const tokens = tokenize(t);
  for (let i = 0; i < tokens.length; i++) {
    // 中文：连续两个 lu 音节
    if (tokens[i].kind === 'zh' && tokens[i].syl === NAME_SYLLABLES[0]) {
      const nxt = tokens[i + 1];
      if (nxt && nxt.kind === 'zh' && nxt.syl === NAME_SYLLABLES[1] && plausible(t, tokens, i, 2)) {
        return buildResult(t, extendWithSuffix(t, { start: tokens[i].start, end: nxt.end }));
      }
    }
    // 拉丁：lulu / LuLu
    if (tokens[i].kind === 'latinword' && /^lu+lu+$/i.test(tokens[i].text) && plausible(t, tokens, i, 1)) {
      return buildResult(t, extendWithSuffix(t, { start: tokens[i].start, end: tokens[i].end }));
    }
  }
  return { woke: false, rest: t.trim(), matched: '' };
}

// 明确的结束语：说完立即回到待命，不用等超时
const SLEEP_RE = /^[\s]*(退下|结束对话|不聊了|先这样|就这样吧|先这样吧|没事了|再见|拜拜|晚点聊|不用聊了|打扰了|睡吧|休息吧|待命)[\s。.!！?？]*$/;

/** 是否是"结束会话"指令 */
function isSleepPhrase(text) {
  return SLEEP_RE.test(String(text || ''));
}

/** 有状态的会话门控 */
function createWakeGate(opts = {}) {
  const idleMs = opts.idleMs ?? 25000;
  const minChars = opts.minChars ?? 4;      // 会话中过短碎片（环境闲聊）不算指令
  const required = opts.required !== false;
  let awake = !required;          // 不启用唤醒词时始终视为会话中
  let lastActive = Date.now();

  return {
    get awake() { return awake; },
    get idleMs() { return idleMs; },
    get minChars() { return minChars; },
    /** 长度是否够当作指令（停止词由调用方另行放行） */
    isLongEnough(text) { return String(text || '').trim().length >= minChars; },
    /** 现在是否应该在待命（超时未活动） */
    shouldSleep(now = Date.now()) { return awake && required && now - lastActive > idleMs; },
    /** 距离超时还剩多少毫秒 */
    remainingMs(now = Date.now()) { return Math.max(0, idleMs - (now - lastActive)); },

    /**
     * 处理一条语音输入
     * @returns {{accept:boolean, woke:boolean, text:string, reason:string}}
     */
    handle(text, now = Date.now()) {
      const t = String(text || '').trim();
      if (!t) return { accept: false, woke: false, text: '', reason: 'empty' };
      if (!required) { lastActive = now; return { accept: true, woke: false, text: t, reason: 'no-gate' }; }

      const det = detectWake(t);
      if (det.woke) {
        const wasAwake = awake;
        awake = true;
        lastActive = now;
        if (det.rest) return { accept: true, woke: true, text: det.rest, reason: wasAwake ? 're-wake-with-command' : 'wake-with-command' };
        return { accept: false, woke: true, text: '', reason: 'wake-only' };
      }
      if (!awake) return { accept: false, woke: false, text: t, reason: 'not-awake' };
      lastActive = now;
      return { accept: true, woke: false, text: t, reason: 'awake' };
    },

    /** 记录一次有效活动（例如用户打字），刷新空闲计时 */
    touch(now = Date.now()) { lastActive = now; },
    /** 强制回到待命 */
    sleep() { awake = false; },
    /** 手动唤醒（例如用户点按钮） */
    forceWake(now = Date.now()) { awake = true; lastActive = now; },
  };
}

module.exports = {
  createWakeGate, detectWake, tokenize, isSleepPhrase, SLEEP_RE,
  NAME_SYLLABLES, SUFFIXES, CUE_WORDS,
};
