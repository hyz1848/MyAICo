'use strict';
/**
 * tools/index.js — 工具注册表
 *
 * 统一的工具定义 + 执行入口，供 server 的工具循环使用：
 *   const defs = getToolDefs();                     // 传给 LLM（pi-ai 的 context.tools）
 *   const out  = await executeTool(name, args);     // 本地执行，返回字符串/对象
 *
 * 加工具只需在 REGISTRY 里加一项。工具是"语音场景"导向的：
 * 描述里要求模型用口语播报结果，不要把 URL、JSON、长列表念出来。
 */

const { calculate } = require('./calc');
const { webSearch } = require('./search');
const { dateMath } = require('./datetime');
const { convert } = require('./units');
const reminders = require('./reminders');

const REGISTRY = {
  get_current_datetime: {
    description: '获取当前日期和时间。当用户问"现在几点""今天几号""今天星期几""今年是哪一年"时必须调用，不要凭记忆回答。',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区，例如 Asia/Shanghai；不传则用服务器本地时区' },
      },
      required: [],
    },
    async run({ timezone }) {
      const now = new Date();
      const tz = timezone || '本地时区';
      const opts = { dateStyle: 'full', timeStyle: 'medium' };
      let local;
      try {
        local = timezone ? new Intl.DateTimeFormat('zh-CN', { ...opts, timeZone: timezone }).format(now) : now.toLocaleString('zh-CN');
      } catch (e) {
        return { error: `无效时区: ${timezone}` };
      }
      return {
        timezone: tz,
        iso: now.toISOString(),
        local,
        weekday: [ '周日', '周一', '周二', '周三', '周四', '周五', '周六' ][now.getDay()],
        unixMs: now.getTime(),
      };
    },
  },

  set_reminder: {
    description: '设置提醒/闹钟（到点会用语音播报）。用户说"提醒我…""X点叫我""N分钟后提醒我"时**必须调用本工具**——只回复"好的，我会提醒你"而不调用工具，提醒是不会真的创建的。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容，例如"喝水""给妈妈打电话"' },
        when: { type: 'string', description: '时间说法，原样传用户的话即可，例如"3分钟后""明天早上八点""下午三点半"' },
      },
      required: ['text', 'when'],
    },
    async run({ text, when }) { return reminders.addReminder({ text, when }); },
  },

  list_reminders: {
    description: '列出所有还没触发的提醒。用户问"我设了哪些提醒""还有什么要做的"时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() { return reminders.listReminders(); },
  },

  cancel_reminder: {
    description: '取消提醒。按内容关键词或 id 取消（用户说"取消喝水的提醒"就传 text="喝水"）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容里的关键词' },
        id: { type: 'string', description: '提醒 id（来自 list_reminders）' },
      },
      required: [],
    },
    async run(args) { return reminders.cancelReminder(args); },
  },

  date_math: {
    description: '日期计算：某天加/减若干天（周/月/年），或算两个日期相差多少天、某天是星期几。用户问"三天后是几号""离国庆还有几天"时必须调用，不要心算。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'add（推算日期）或 diff（日期差）' },
        base: { type: 'string', description: '基准日期，可写"今天""明天""2026-10-01"，默认今天' },
        value: { type: 'number', description: 'op=add 时增减的数量，例如 3 或 -7' },
        unit: { type: 'string', description: 'op=add 的单位：day/week/month/year/hour/minute' },
        target: { type: 'string', description: 'op=diff 时的目标日期' },
      },
      required: ['op'],
    },
    async run(args) { return dateMath(args); },
  },

  unit_convert: {
    description: '单位换算：长度/质量/面积/体积/速度/温度/数据/时间（如"180磅是多少斤""30摄氏度是多少华氏"）。',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number', description: '数值' },
        from: { type: 'string', description: '原单位，例如 磅/摄氏度/千米每小时' },
        to: { type: 'string', description: '目标单位，例如 斤/华氏度/米每秒' },
      },
      required: ['value', 'from', 'to'],
    },
    async run(args) { return convert(args); },
  },

  calculator: {
    description: '精确计算数学表达式（加减乘除、取余、乘方、括号、sqrt/abs/round/floor/ceil/min/max/log/exp/sin/cos 等）。凡是涉及算术都必须调用它，不要口算。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式，例如 (1+2)*3^2 或 sqrt(16)+round(3.14159,2)' },
      },
      required: ['expression'],
    },
    async run({ expression }) {
      const r = calculate(expression);
      return r.ok ? { expression, result: r.value, display: r.display } : { error: r.error };
    },
  },

  web_search: {
    description: '联网搜索获取实时信息。凡涉及最新版本号、新闻、今天/近期发生的事、价格、股价、政策、比赛结果、天气等可能变化的信息，必须先调用本工具，禁止凭记忆回答（猜错数字的代价很大）。结果仅供你概括，不要把网址或原文念给用户。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，尽量具体' },
        max_results: { type: 'number', description: '返回条数，1~10，默认 5' },
        freshness: { type: 'string', description: '时间范围：noLimit（默认）/oneDay（今天）/oneWeek/oneMonth/oneYear；问"今天/最新"时用 oneDay 或 oneWeek' },
      },
      required: ['query'],
    },
    async run({ query, max_results, freshness }) {
      const r = await webSearch(query, { maxResults: max_results, freshness });
      if (!r.ok) return { error: r.error };
      return { query, results: r.results.map((x, i) => ({ index: i + 1, title: x.title, snippet: x.snippet, url: x.url, site: x.site, date: x.date })) };
    },
  },
};

/** 工具定义列表（给 LLM） */
function getToolDefs() {
  return Object.entries(REGISTRY).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** 执行工具；始终返回 JSON 可序列化对象（失败也返回 { error }，便于模型自我纠正） */
const { cfg } = require('../config');
const TOOL_TIMEOUT_MS = cfg.tools.timeoutMs;

async function executeTool(name, args) {
  const tool = REGISTRY[name];
  if (!tool) return { error: `未知工具: ${name}` };
  let timer;
  try {
    // 工具卡住会连累整轮对话（LLM 在等工具结果）→ 统一加超时兜底
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`工具执行超时（${Math.round(TOOL_TIMEOUT_MS / 1000)}s）`)), TOOL_TIMEOUT_MS);
      timer.unref?.();
    });
    const out = await Promise.race([tool.run(args || {}), timeout]);
    return out === undefined ? { ok: true } : out;
  } catch (e) {
    return { error: `工具执行异常: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getToolDefs, executeTool, REGISTRY };
