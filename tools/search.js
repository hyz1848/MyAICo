'use strict';
/**
 * tools/search.js — 联网搜索（博查 Web Search API）
 *
 * POST https://api.bochaai.com/v1/web-search
 *   header: Authorization: Bearer <key>
 *   body:   { query, summary: true, count, freshness }
 *   返回:   { code:200, data:{ webPages:{ value:[{ name, url, snippet, summary, siteName, datePublished }] } } }
 *
 * 密钥只从 config/tools.json 或环境变量读，不硬编码。
 */

const DEFAULT_URL = 'https://api.bochaai.com/v1/web-search';
const FRESHNESS = new Set(['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear']);

let configCache = null;
function loadConfig() {
  if (configCache) return configCache;
  let cfg = {};
  try {
    cfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'tools.json'), 'utf8'));
  } catch (e) { /* 无配置文件时走环境变量 */ }
  const s = cfg.search || {};
  configCache = {
    url: process.env.BOCHA_SEARCH_URL || s.url || DEFAULT_URL,
    apiKey: process.env.BOCHA_API_KEY || s.apiKey || '',
    count: Number(s.count) || 5,
    freshness: FRESHNESS.has(s.freshness) ? s.freshness : 'noLimit',
  };
  return configCache;
}

function trim(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 联网搜索
 * @param {string} query
 * @param {{maxResults?:number, freshness?:string}} [opts]
 * @returns {Promise<{ok:true, results:Array<{title:string,snippet:string,url:string,site?:string,date?:string}>}|{ok:false,error:string}>}
 */
async function webSearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '查询词为空' };

  const cfg = loadConfig();
  if (!cfg.apiKey) return { ok: false, error: '未配置搜索密钥（config/tools.json 的 search.apiKey 或 BOCHA_API_KEY）' };

  const count = Math.min(Math.max(1, Number(opts.maxResults) || cfg.count), 10);
  const freshness = FRESHNESS.has(opts.freshness) ? opts.freshness : cfg.freshness;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ query: q, summary: true, count, freshness }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `搜索服务 HTTP ${res.status}${body ? ': ' + trim(body, 120) : ''}` };
    }
    const body = await res.json();
    if (body.code !== 200) return { ok: false, error: `搜索服务返回异常: ${body.code} ${body.msg || ''}`.trim() };

    const pages = (body.data && body.data.webPages && body.data.webPages.value) || [];
    const results = pages.map((p) => ({
      title: trim(p.name, 80),
      // summary 是博查给的更完整摘要（snippet 常被截断），优先用 summary
      snippet: trim(p.summary || p.snippet, 500),
      url: trim(p.url, 200),
      site: trim(p.siteName, 40),
      date: trim(p.datePublished || p.dateLastCrawled, 30),
    }));
    if (!results.length) return { ok: false, error: '没有搜到结果' };
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '搜索超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { webSearch, loadConfig };
