'use strict';
/**
 * tools/calc.js — 安全表达式求值器（不使用 eval / Function）
 *
 * 递归下降解析：+ - * / % ^、括号、一元正负、常见函数与常量。
 * 语音助手会把它接给 LLM 当工具，输入来自模型，故必须严格白名单、限长、限深度。
 */

const FUNCS = {
  abs: Math.abs,
  round: (x, n = 0) => { const p = 10 ** n; return Math.round(x * p) / p; },
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

const CONSTS = { pi: Math.PI, e: Math.E };

class CalcError extends Error {}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new CalcError(`非法数字: ${src.slice(i, j)}`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      // 支持中文全角运算符
      tokens.push({ t: ch, v: ch });
      i++;
      continue;
    }
    if ('×÷−'.includes(ch)) {
      tokens.push({ t: ch === '×' ? '*' : ch === '÷' ? '/' : '-', v: ch });
      i++;
      continue;
    }
    throw new CalcError(`无法识别的字符: ${ch}`);
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  let depth = 0;                 // 括号嵌套深度（防深度攻击）
  const peek = () => tokens[pos];
  const eat = (t) => { if (peek() && peek().t === t) { pos++; return true; } return false; };

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = tokens[pos++].t;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
      const op = tokens[pos++].t;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new CalcError('除数为零');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  function parseUnary() {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (eat('^')) return base ** parseUnary();   // 右结合
    return base;
  }

  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new CalcError('表达式意外结束');
    if (tk.t === 'num') { pos++; return tk.v; }
    if (tk.t === '(') {
      pos++;
      if (++depth > 32) throw new CalcError('表达式嵌套过深');
      const v = parseExpr();
      depth--;
      if (!eat(')')) throw new CalcError('括号不匹配');
      return v;
    }
    if (tk.t === 'ident') {
      pos++;
      const name = tk.v.toLowerCase();
      if (eat('(')) {
        const args = [];
        if (!eat(')')) {
          args.push(parseExpr());
          while (eat(',')) args.push(parseExpr());
          if (!eat(')')) throw new CalcError('函数参数括号不匹配');
        }
        const fn = FUNCS[name];
        if (!fn) throw new CalcError(`不支持的函数: ${name}`);
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new CalcError(`未知标识符: ${name}`);
    }
    throw new CalcError(`语法错误: ${tk.v}`);
  }

  const value = parseExpr();
  if (pos !== tokens.length) throw new CalcError(`多余的内容: ${tokens[pos].v}`);
  return value;
}

/**
 * 计算表达式
 * @param {string} expr
 * @returns {{ok:true, value:number, display:string} | {ok:false, error:string}}
 */
function calculate(expr) {
  const src = String(expr ?? '').trim();
  if (!src) return { ok: false, error: '表达式为空' };
  if (src.length > 200) return { ok: false, error: '表达式过长' };
  if (!/^[0-9a-zA-Z_+\-*/%^().,\s×÷−]+$/.test(src)) {
    return { ok: false, error: '表达式含不允许的字符' };
  }
  try {
    const value = parse(tokenize(src));
    if (!Number.isFinite(value)) return { ok: false, error: '结果不是有限数' };
    // 浮点毛刺处理：12 位有效数字内取整
    const cleaned = Number(value.toPrecision(12));
    return { ok: true, value: cleaned, display: String(cleaned) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { calculate, CalcError };
