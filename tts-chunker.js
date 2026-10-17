'use strict';
/**
 * tts-chunker.js — 把 LLM 流式 token 切成适合语音合成(edge-tts)的片段。
 *
 * 解决的问题：
 *  1. 不能整段丢给 TTS（首响慢 / 无法打断）
 *  2. 标点、Markdown、emoji、代码块 不该被念出来
 *  3. 流式增量输入不能丢字、不能重复、不能把 "3.14" 切成两句
 *  4. 引号内的句号不该断句；纯标点碎片该并入上一句保留语调
 *
 * 用法：
 *   const { TtsChunker } = require('./tts-chunker');
 *   const c = new TtsChunker({ maxLen: 48 });
 *   for (const token of tokens) { for (const s of c.push(token)) sendTTS(s); }
 *   for (const s of c.flush()) sendTTS(s);        // 流结束时吐出尾巴
 */

// 强句末标点（中文 + 英文 + 换行）
const SENT_END = new Set(['。', '！', '？', '；', '!', '?', ';', '\n', '…']);
// 弱停顿（仅用于超长句强制切分）
const CLAUSE = ['，', '、', ',', '：', ':'];
// 成对引号/括号（内部不断句）
const QUOTE_OPEN = new Set(['「', '『', '“', '‘', '（', '(', '《', '【', '[', '{']);
const QUOTE_CLOSE = new Set(['」', '』', '”', '’', '）', ')', '》', '】', ']', '}']);

const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const PUNCT_ONLY_RE = /^[\p{P}\p{S}]+$/u;
const SPEAKABLE_RE = /[\p{Script=Han}\p{Letter}\p{Number}]/u;

const DEFAULT_MAX = 48;

/** 去掉 Markdown / 符号 / emoji，留下可朗读文本。全空白/纯符号返回 '' */
function ttsClean(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(EMOJI_RE, '');                        // emoji
  s = s.replace(/<[^>]{1,80}>/g, '');                 // HTML 标签
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');     // 图片 → alt
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');      // 链接 → 文本
  s = s.replace(/`{1,3}/g, '');                       // 行内代码/残留反引号
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');           // 标题
  s = s.replace(/^\s{0,3}>\s?/gm, '');                // 引用
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '');  // 列表项
  s = s.replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ''); // 分隔线
  s = s.replace(/\*\*|__|~~/g, '');
  s = s.replace(/[*_#>~|]/g, '');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 有可朗读内容（汉字/字母/数字）才值得送去合成 */
function isSpeakable(text) {
  if (!text) return false;
  return SPEAKABLE_RE.test(text);
}

/** 清洗 + 可朗读判定，一步到位 */
function cleanChunk(text) {
  const s = ttsClean(text);
  return isSpeakable(s) ? s : '';
}

function quoteDepthOf(str) {
  let d = 0;
  for (const ch of str) {
    if (QUOTE_OPEN.has(ch)) d++;
    else if (QUOTE_CLOSE.has(ch) && d > 0) d--;
  }
  return d;
}

class TtsChunker {
  constructor(opts = {}) {
    this.maxLen = opts.maxLen || DEFAULT_MAX;
    this.pending = '';        // 尚未成句的原文
    this.inCode = false;      // 是否处于 ``` 代码块内
    this.pendingDepth = 0;    // pending 起始处的引号深度
    this.spoken = '';         // 已吐出的可朗读文本（调试用）
  }

  /** 喂入一段流式文本，返回本次切出的可朗读片段 */
  push(token) {
    if (!token) return [];
    this.pending += token;
    return this._process(false);
  }

  /** 流结束，吐出剩余文本 */
  flush() {
    const out = this._process(true);
    const tail = this.inCode ? '' : cleanChunk(this.pending);
    this.pending = '';
    this.inCode = false;
    this.pendingDepth = 0;
    if (tail) { out.push(tail); this.spoken += tail; }
    return out;
  }

  /** 未成句的原文（原始，未清洗） */
  get rest() {
    return this.pending;
  }

  // ---- 内部 ----

  _process(final) {
    const out = [];
    let guard = 0;
    while (guard++ < 10000) {
      if (this.inCode) {
        const i = this.pending.indexOf('```');
        if (i === -1) {
          // 保留末尾 2 字符，避免逐字喂入时丢失半个围栏
          this.pending = this.pending.slice(-2);
          break;
        }
        this.pending = this.pending.slice(i + 3);
        this.inCode = false;
        continue;
      }
      const fence = this.pending.indexOf('```');
      if (fence === -1) {
        const { chunks, rest } = this._scan(this.pending, final);
        this.pending = rest;
        this._emit(out, chunks);
        break;
      }
      const before = this.pending.slice(0, fence);
      this.pending = this.pending.slice(fence + 3);
      this.inCode = true;
      const { chunks, rest } = this._scan(before, final);
      this.pending = rest + this.pending;   // 边界前残留 + 代码块之后的内容
      this._emit(out, chunks);
    }
    this.spoken += out.join('');
    return out;
  }

  _emit(out, chunks) {
    for (const c of chunks) {
      const s = cleanChunk(c);
      if (s) { out.push(s); continue; }
      // 纯标点碎片（如 "。" "！" "……"）并入上一段，保留语调
      if (out.length) {
        const tail = this._punctTail(c);
        if (tail) out[out.length - 1] += tail;
      }
    }
  }

  _punctTail(raw) {
    const t = (raw || '').replace(/[*_#>~|`]/g, '').replace(/\s+/g, '');
    if (!t || !PUNCT_ONLY_RE.test(t)) return '';
    if (/^[-=*_]{2,}$/.test(t)) return '';   // 分隔线残渣
    return t.slice(0, 3);
  }

  /** 按句边界切分；返回 { chunks, rest } */
  _scan(s, final) {
    const chunks = [];
    let start = 0;
    let d = this.pendingDepth;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (d === 0 && this._isEnd(s, i, final)) {
        chunks.push(s.slice(start, i + 1));
        start = i + 1;
      } else if (i - start + 1 >= this.maxLen) {
        const seg = s.slice(start, i + 1);
        let cut = -1;
        for (const c of CLAUSE) cut = Math.max(cut, seg.lastIndexOf(c));
        if (cut > 8) {
          chunks.push(seg.slice(0, cut + 1));
          start += cut + 1;
        } else {
          chunks.push(seg);
          start = i + 1;
        }
      }
      if (QUOTE_OPEN.has(ch)) d++;
      else if (QUOTE_CLOSE.has(ch) && d > 0) d--;
    }
    this.pendingDepth = this.pendingDepth + quoteDepthOf(s.slice(0, start));
    return { chunks, rest: s.slice(start) };
  }

  _isEnd(s, i, final) {
    const ch = s[i];
    if (ch === '!' || ch === '?' || ch === '！' || ch === '？') {
      const next = s[i + 1];
      if (next === '[' || next === '(') return false;   // ![img](..) 或 [?](..)
      return SENT_END.has(ch);
    }
    if (SENT_END.has(ch)) return true;
    if (ch !== '.') return false;
    const prev = s[i - 1];
    if (prev && /\d/.test(prev)) return false;            // 3.14
    if (prev && /[A-Za-z]/.test(prev)) {
      const m = s.slice(0, i).match(/([A-Za-z]+)$/);
      if (m && m[1].length === 1) return false;           // e.g. / i.e. / Mr.
    }
    const next = s[i + 1];
    if (next === undefined) return final;                 // 未定：等下一个字符
    return /\s/.test(next);                               // 英文句号后需空白
  }
}

module.exports = { TtsChunker, ttsClean, isSpeakable, cleanChunk, quoteDepthOf, SENT_END, CLAUSE, DEFAULT_MAX };
