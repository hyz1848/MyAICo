/**
 * logger.js — 统一日志（winston）
 *
 * 为什么：console.* 只在终端活一次，出事之后没有痕迹。语音助手是常驻服务，
 * 需要能"事后翻账"：谁在什么时候说了什么、LLM 花了多久、缓存命中多少、worker 有没有重启。
 *
 * 行为：
 *  - 控制台：保持 `[TAG] 消息` 原样式（人和脚本都在按这个 grep），不额外加时间戳避免刷屏
 *  - 文件：logs/voiceai-YYYY-MM-DD.log，`ISO时间 LEVEL [TAG] 消息`，10MB 轮转保留 5 份
 *  - 级别：VOICEAI_LOG_LEVEL=error|warn|info|debug（默认 info；debug 会打印音频帧统计等噪声）
 *  - 目录：VOICEAI_LOG_DIR（默认 <项目>/logs）；VOICEAI_LOG_FILE=0 关闭文件输出
 *
 * 用法（保持字符串前缀风格，便于 grep）：
 *   const { log } = require('./logger');
 *   log.info('[LLM] done, ...');  log.warn('[KV] ...');  log.error('[Worker] ...');
 */
'use strict';
const path = require('path');
const fs = require('fs');
const util = require('util');
const winston = require('winston');

const LEVEL = (process.env.VOICEAI_LOG_LEVEL || 'info').toLowerCase();
const LOG_DIR = process.env.VOICEAI_LOG_DIR || path.join(__dirname, 'logs');
const FILE_ENABLED = process.env.VOICEAI_LOG_FILE !== '0';

/** 控制台：只留 [TAG] 消息（保持原有观感，避免时间戳刷屏） */
const consoleFormat = winston.format.printf(({ message }) => String(message));

/** 文件：带时间与级别，便于事后 grep / 统计 */
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ level, message, timestamp }) =>
    `${timestamp} ${String(level).toUpperCase().padEnd(5)} ${message}`),
);

const transports = [new winston.transports.Console({ format: consoleFormat })];

if (FILE_ENABLED) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    transports.push(new winston.transports.File({
      filename: path.join(LOG_DIR, `voiceai-${day}.log`),
      format: winston.format.combine(winston.format.timestamp(), fileFormat),
      maxsize: 10 * 1024 * 1024,   // 10MB
      maxFiles: 5,
      tailable: true,
    }));
  } catch (e) {
    // 日志目录不可写不能拖垮服务
    process.stdout.write(`[Logger] 无法写日志文件（${LOG_DIR}）: ${e.message}\n`);
  }
}

const winstonLogger = winston.createLogger({
  level: LEVEL,
  transports,
  exitOnError: false,
});

// 与 console.log 完全一致的调用语义（多参数、对象、%s/%d 占位符都按 util.format 处理）。
// 不用 winston 的 splat：它只在消息含占位符时才合并附加参数，容易静默丢内容。
const fmt = (...args) => util.format(...args);
const log = {
  error: (...a) => winstonLogger.error(fmt(...a)),
  warn: (...a) => winstonLogger.warn(fmt(...a)),
  info: (...a) => winstonLogger.info(fmt(...a)),
  debug: (...a) => winstonLogger.debug(fmt(...a)),
  level: LEVEL,
};

module.exports = { log, LOG_DIR, LEVEL, FILE_ENABLED };
