#!/usr/bin/env node
/**
 * bridge.js — 微信 ↔ Muse 桥接主进程
 *
 * 设计文档: ~/workspace/wechat-muse-bridge/DESIGN.md (v4)
 *
 * 流程: iLink getUpdates 长轮询 → 原始 message_id(字符串)去重 → SQLite 状态机
 * → 子进程 muse-cli(参数数组) → history 自轮询等标记
 * → sendmessage(固定 client_id, 单次发送无自动重试)
 *
 * 单进程串行: 一条消息完整走完才处理下一条。单实例: pidfile 原子创建 + stale 检查。
 * 凭据永不进日志: token/context_token/cookie 只出现 <redacted>。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(BRIDGE_DIR, "config.json");
const DB_PATH = path.join(BRIDGE_DIR, "tasks.db");
const PID_PATH = path.join(BRIDGE_DIR, "bridge.pid");
const LOG_DIR = path.join(BRIDGE_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "bridge.log");
const OLD_BRIDGE_STATE = path.join(
  os.homedir(),
  "workspace",
  "wechat-bridge",
  "state",
);

// vendored SDK 的状态目录（SDK 经 OPENCLAW_STATE_DIR 解析）
process.env.OPENCLAW_STATE_DIR = path.join(BRIDGE_DIR, "state", "weixin");

const sdkApi = await import("./dist/api/api.js");
const sdkTypes = await import("./dist/api/types.js");
const sdkSyncBuf = await import("./dist/storage/sync-buf.js");
const sdkSessionGuard = await import("./dist/api/session-guard.js");
const sdkAccounts = await import("./dist/auth/accounts.js");
const sdkInbound = await import("./dist/messaging/inbound.js");
const sdkMediaDownload = await import("./dist/media/media-download.js");
const sdkMediaUpload = await import("./dist/cdn/upload.js");
const sdkMediaSend = await import("./dist/messaging/send.js");
const silkWasm = await import("silk-wasm");

const { getUpdates, sendMessage } = sdkApi;
const { MessageItemType, MessageType, MessageState } = sdkTypes;
const {
  SESSION_EXPIRED_ERRCODE,
  pauseSession,
  isSessionPaused,
  getRemainingPauseMs,
} = sdkSessionGuard;

/**
 * 结束标记（每任务唯一，非空）。
 * 格式：任务<微信原始 message_id>回复完毕。（独立一行，置于最终回复末尾）
 * - 自然语言格式：实测 Muse 会过滤【】括号式系统标记，但会原样输出自然语言标记（含完整 19 位 ID）；
 * - 含任务唯一 ID：history 归因时只认领本任务的标记，
 *   结合 --thread 会话隔离与 seq > baseline 位置约束，避免认领迟到的旧回复；
 * - 19 位数字 ID 在正常对话中不会自然出现，误判率极低；
 * - message_id 持久化于 DB tasks 表，重启后可重构同一标记，恢复流程可用。
 */
function markerFor(taskId) {
  return `任务${taskId}回复完毕。`;
}
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 附件媒体常量
// ---------------------------------------------------------------------------
const MEDIA_DIR = path.join(BRIDGE_DIR, "media");
const MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20MB
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120000; // 120 秒
const MEDIA_TYPE_LABEL = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`缺少 ${CONFIG_PATH}，请先创建（见 config.example.json）`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  for (const k of ["ilink_user_id", "weixin_session_id", "muse_cli_path"]) {
    if (!cfg[k] || typeof cfg[k] !== "string")
      throw new Error(`config.json 缺少必填项: ${k}`);
  }
  return {
    // 任务总超时 8 分钟：计时起点为 runTask 开始（t0），覆盖 runTaskInner 全流程
    // 各阶段子超时：CLI 60s、单次history 15s、等待回复 180s、媒体下载 120s（独立）
    task_total_timeout_ms: 480000,
    muse_timeout_ms: 180000,
    muse_poll_interval_ms: 4000,
    history_limit: 50,
    history_call_timeout_ms: 15000, // 单次 history 调用超时 15 秒，可取消
    ...cfg,
  };
}

// ---------------------------------------------------------------------------
// 日志（脱敏 + 轮转）
// ---------------------------------------------------------------------------
const secrets = [];
function redact(s) {
  let out = String(s ?? "");
  for (const v of secrets) {
    if (v && v.length > 8 && out.includes(v))
      out = out.split(v).join("<redacted>");
  }
  return out;
}
function log(level, msg) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > LOG_ROTATE_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + ".1");
    }
  } catch {
    /* 文件不存在 */
  }
  const line = `${new Date().toISOString()} [${level}] ${redact(msg)}\n`;
  fs.appendFileSync(LOG_PATH, line);
  if (level === "ERROR") console.error(line.trim());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------
let db;
function openDb() {
  const first = !fs.existsSync(DB_PATH);
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS tasks(
message_id TEXT PRIMARY KEY,
status TEXT NOT NULL,
client_id TEXT,
from_user_id TEXT,
text TEXT,
context_token TEXT,
muse_baseline_seq INTEGER,
muse_stream_sid TEXT,
spawned_at INTEGER,
reply_text TEXT,
error TEXT,
send_attempts INTEGER DEFAULT 0,
media_type INTEGER DEFAULT 0,
media_path TEXT,
media_info TEXT,
media_status TEXT,
send_receipt TEXT,
created_at INTEGER,
updated_at INTEGER
);`);
  // 已有库的迁移：补齐媒体字段和发送回执
  for (const [col, ddl] of [
    ["media_type", "INTEGER DEFAULT 0"],
    ["media_path", "TEXT"],
    ["media_info", "TEXT"],
    ["media_status", "TEXT"],
    ["send_receipt", "TEXT"],
    ["text_send_results", "TEXT"],
    ["file_send_results", "TEXT"],
    ["account_id", "TEXT"],
    ["command_kind", "TEXT"],
  ]) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${ddl}`);
      log("INFO", `tasks 表新增列 ${col}`);
    } catch {
      /* 列已存在 */
    }
  }
  try {
    fs.chmodSync(DB_PATH, 0o600);
  } catch {
    /* best-effort */
  }
  if (first) log("INFO", "tasks.db 已创建 (WAL, 600)");

  // ===== 资料找回：文件索引表（修复6：加 original_task_id 用于归属验证） =====
  db.exec(`CREATE TABLE IF NOT EXISTS file_index(
id INTEGER PRIMARY KEY AUTOINCREMENT,
account_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
short_id TEXT NOT NULL,
file_name TEXT NOT NULL,
file_path TEXT NOT NULL,
file_size INTEGER DEFAULT 0,
direction TEXT NOT NULL,
original_task_id TEXT,
created_at INTEGER NOT NULL,
UNIQUE(account_id, sender_id, short_id)
);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_index_lookup
ON file_index(account_id, sender_id, created_at DESC);`);
  // 迁移：已存在的表加 original_task_id 列
  try { db.exec(`ALTER TABLE file_index ADD COLUMN original_task_id TEXT`); } catch {}

  // ===== 提醒：修复2/3 的状态机 =====
  // status: pending -> sending -> sent | failed | unknown | waiting_context | cancelled
  db.exec(`CREATE TABLE IF NOT EXISTS reminders(
id INTEGER PRIMARY KEY AUTOINCREMENT,
account_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
text TEXT NOT NULL,
remind_at INTEGER NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
context_token TEXT,
retry_count INTEGER DEFAULT 0,
next_attempt_at INTEGER,
created_at INTEGER NOT NULL,
sent_at INTEGER,
is_test INTEGER DEFAULT 0
);`);
  try { db.exec(`ALTER TABLE reminders ADD COLUMN next_attempt_at INTEGER`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_due
ON reminders(status, remind_at, next_attempt_at);`);
  // 迁移：加 unknown_noticed 列（跟踪是否已发送过状态说明）
  try { db.exec(`ALTER TABLE reminders ADD COLUMN unknown_noticed INTEGER`); } catch {}

  db.exec(`CREATE TABLE IF NOT EXISTS todos(
id INTEGER PRIMARY KEY AUTOINCREMENT,
account_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
text TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
created_at INTEGER NOT NULL,
completed_at INTEGER
);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_lookup
ON todos(account_id, sender_id, status, created_at DESC);`);

  // ===== 个人偏好 =====
  db.exec(`CREATE TABLE IF NOT EXISTS user_prefs(
account_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
brevity TEXT NOT NULL DEFAULT 'normal',
output_format TEXT,
index_retention INTEGER NOT NULL DEFAULT 1,
updated_at INTEGER NOT NULL,
PRIMARY KEY (account_id, sender_id)
);`);

  // ===== 最新 context_token 持久化（用于提醒主动发送） =====
  db.exec(`CREATE TABLE IF NOT EXISTS user_context(
account_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
context_token TEXT NOT NULL,
updated_at INTEGER NOT NULL,
PRIMARY KEY (account_id, sender_id)
);`);
}
const getTask = (id) =>
  db.prepare("SELECT * FROM tasks WHERE message_id =?").get(id);

/* ===== 资料找回：文件索引（修复6：归属验证） ===== */

function nextFileShortId(accountId, senderId) {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM file_index WHERE account_id = ? AND sender_id = ?`
  ).get(accountId, senderId);
  return String((row?.cnt ?? 0) + 1);
}

function indexFile(accountId, senderId, fileName, filePath, direction, originalTaskId = null) {
  try {
    // ④修复：索引时也验证路径（防恶意路径入库）
    if (originalTaskId) {
      const verified = verifyFilePath(filePath, accountId, senderId, originalTaskId);
      if (!verified) {
        log("WARN", `文件索引拒绝：路径验证失败`);
        return null;
      }
      filePath = verified; // 使用验证后的真实路径
    } else {
      return null;
    }
    if (!shouldIndexFile(accountId, senderId)) return null;
    const existing = db.prepare(`SELECT short_id FROM file_index
      WHERE account_id = ? AND sender_id = ? AND file_path = ? AND original_task_id = ?`)
      .get(accountId, senderId, filePath, originalTaskId);
    if (existing) return existing.short_id;
    const stat = fs.statSync(filePath);
    const shortId = nextFileShortId(accountId, senderId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO file_index(account_id, sender_id, short_id, file_name, file_path, file_size, direction, original_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(accountId, senderId, shortId, fileName, filePath, stat.size, direction, originalTaskId, now);
    return shortId;
  } catch (e) {
    log("WARN", `文件索引失败`);
    return null;
  }
}

function listRecentFiles(accountId, senderId, limit = 10) {
  return db.prepare(
    `SELECT short_id, file_name, file_size, direction, created_at
     FROM file_index WHERE account_id = ? AND sender_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(accountId, senderId, limit);
}

function searchFiles(accountId, senderId, keyword, limit = 10) {
  return db.prepare(
    `SELECT short_id, file_name, file_size, direction, created_at
     FROM file_index WHERE account_id = ? AND sender_id = ? AND file_name LIKE ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(accountId, senderId, `%${keyword}%`, limit);
}

/**
 * 修复7：自然语言日期+类型匹配
 * "把昨天那份表格再发我" → 昨天 + 表格类扩展名
 */
function searchFilesByDateAndType(accountId, senderId, dateDesc, extensions, limit = 10) {
  // 解析日期描述 → 时间范围（北京时间）
  const now = Date.now();
  const beijingOffset = 8 * 3600000;
  const beijingNow = new Date(now + beijingOffset);
  let startTs, endTs;
  if (dateDesc === '昨天') {
    const y = new Date(beijingNow);
    y.setUTCHours(0, 0, 0, 0);
    y.setUTCDate(y.getUTCDate() - 1);
    startTs = y.getTime() - beijingOffset;
    endTs = startTs + 86400000;
  } else if (dateDesc === '今天') {
    const t = new Date(beijingNow);
    t.setUTCHours(0, 0, 0, 0);
    startTs = t.getTime() - beijingOffset;
    endTs = startTs + 86400000;
  } else {
    return [];
  }
  const extPattern = extensions.map(e => `%${e}`).join('|');
  // SQLite 不支持正则，用多个 LIKE
  const likes = extensions.map(() => `file_name LIKE ?`).join(' OR ');
  const params = [accountId, senderId, startTs, endTs, ...extensions.map(e => `%${e}`)];
  return db.prepare(
    `SELECT short_id, file_name, file_size, direction, created_at
     FROM file_index WHERE account_id = ? AND sender_id = ?
     AND created_at >= ? AND created_at < ? AND (${likes})
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit);
}

function getFileByShortId(accountId, senderId, shortId) {
  return db.prepare(
    `SELECT short_id, file_name, file_path, file_size, original_task_id
     FROM file_index WHERE account_id = ? AND sender_id = ? AND short_id = ?`
  ).get(accountId, senderId, shortId) ?? null;
}

/**
 * ④修复：发送时验证归属（严格版）
 * - originalTaskId 必须存在
 * - tasks 表中 account+sender 必须匹配
 * - realpath 必须在 MEDIA_DIR 内，且在原任务目录内
 * - 不可 catch 忽略，失败返回 null 并记录原因
 */
function verifyFilePath(filePath, accountId, senderId, originalTaskId = null) {
  // ④：originalTaskId 必须提供
  if (!originalTaskId) {
    log("WARN", `文件验证拒绝：缺少 originalTaskId`);
    return null;
  }
  const task = getTask(originalTaskId);
  if (!task) {
    log("WARN", `文件验证拒绝：原任务不存在`);
    return null;
  }
  // ④：账号+发送者必须匹配（从 task 的 from_user_id 验证）
  // 注意：accountId 通过调用方传入，这里验证 sender
  if (task.from_user_id !== senderId || task.account_id !== accountId) {
    log("WARN", `文件验证拒绝：发送者不匹配`);
    return null;
  }

  let real, mediaReal;
  try {
    real = fs.realpathSync(filePath);
    mediaReal = fs.realpathSync(MEDIA_DIR);
  } catch (e) {
    log("WARN", `文件验证拒绝：路径解析失败`);
    return null;
  }
  if (!real.startsWith(mediaReal + path.sep) && real !== mediaReal) {
    log("WARN", `文件验证拒绝：路径逃逸`);
    return null;
  }
  if (!fs.existsSync(real) || !fs.statSync(real).isFile()) {
    log("WARN", `文件验证拒绝：文件不存在`);
    return null;
  }
  // ④：验证在原任务目录内（即使无 media_path 也检查目录）
  try {
    const taskDir = path.join(MEDIA_DIR, originalTaskId);
    const taskDirReal = fs.realpathSync(taskDir);
    if (!taskDirReal.startsWith(mediaReal + path.sep)) return null;
    if (!real.startsWith(taskDirReal + path.sep)) {
      log("WARN", `文件验证拒绝：不在原任务目录内`);
      return null;
    }
  } catch {
    log("WARN", `文件验证拒绝：原任务目录不存在`);
    return null;
  }
  return real;
}

function formatFileList(files) {
  if (!files.length) return "没找到相关文件。";
  return files.map((f) => {
    const date = new Date(f.created_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const size = f.file_size > 1048576
      ? `${(f.file_size / 1048576).toFixed(1)}MB`
      : `${Math.ceil(f.file_size / 1024)}KB`;
    const dir = f.direction === 'inbound' ? '收到' : '发出';
    return `${f.short_id}. ${f.file_name}（${size}，${date}，${dir}）`;
  }).join('\n');
}

/**
 * 修复5：幂等 client_id（固定消息+用途，不用时间戳）
 * 命令崩溃恢复不重复执行
 */
async function sendTextDirect(account, to, contextToken, messageId, purpose, text) {
  const clientId = `${messageId}:${purpose}`;
  const result = await sendOnce(account, to, text, contextToken, clientId, messageId);
  db.prepare(`UPDATE tasks SET text_send_results = ?, send_receipt = ?, reply_text = ?, updated_at = ? WHERE message_id = ?`)
    .run(JSON.stringify([{clientId,status:result,purpose,at:Date.now()}]),
      `text:${result}`,text,Date.now(),messageId);
  return result; // 返回实际结果：sent/failed/unknown
}

/* ===== 提醒和待办（修复1/2/3） ===== */

/**
 * 修复1：时间解析（UTC 服务器正确）
 * - 相对时间：Date.now() + delta（不经过北京时间转换）
 * - 绝对时间：Date.UTC(...) - 8h
 * - 校验溢出，过去时间拒绝
 * - needClarify 时不落库，由调用方先澄清
 */
function parseReminderTime(input) {
  const now = Date.now();

  // 相对时间：X分钟后 / X小时后 → 直接 Date.now() + delta
  let m = input.match(/^(\d+)\s*分钟后$/);
  if (m) {
    const mins = parseInt(m[1]);
    if (mins <= 0 || mins > 10080) return null; // 超过7天拒绝
    return { timestamp: now + mins * 60000, needClarify: false };
  }
  m = input.match(/^(\d+)\s*小时后$/);
  if (m) {
    const hours = parseInt(m[1]);
    if (hours <= 0 || hours > 168) return null;
    return { timestamp: now + hours * 3600000, needClarify: false };
  }

  // 明天/今天 + 时间（北京时间）
  m = input.match(/^(明天|今天)\s*(上午|下午|晚上)?\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?)?$/);
  if (m) {
    const isTomorrow = m[1] === '明天';
    let hour = parseInt(m[3]);
    const minute = m[4] ? parseInt(m[4]) : 0;
    if (hour > 23 || minute > 59) return null; // 溢出校验
    const period = m[2];
    if (period === '上午' && hour > 12) return null;
    if ((period === '下午' || period === '晚上') && hour === 0) return null;
    const ambiguous = (!period && hour >= 1 && hour <= 12) || (period && hour === 12);
    if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
    if (period === '上午' && hour === 12) hour = 0;

    // 修复1：needClarify 时返回标记，不自动改明天，由调用方澄清
    const needClarify = Boolean(ambiguous);

    // 计算北京时间的目标日期
    const beijingNow = new Date(now + 8 * 3600000);
    const year = beijingNow.getUTCFullYear();
    const month = beijingNow.getUTCMonth();
    let day = beijingNow.getUTCDate();
    if (isTomorrow) day += 1;

    // Date.UTC(...) - 8h 得到 UTC 时间戳
    const timestamp = Date.UTC(year, month, day, hour, minute, 0) - 8 * 3600000;

    // 过去时间拒绝（不自动改明天）
    if (timestamp <= now) {
      return { timestamp, needClarify: true, isPast: true };
    }
    return { timestamp, needClarify };
  }

  // 绝对时间：YYYY-MM-DD HH:mm（按北京时间）
  m = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
    const h = parseInt(m[4]), mi = parseInt(m[5]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    // ⑦修复：Date.UTC 后反向校验，防止 2月30日 溢出成 3月
    const check = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      return null; // 日期不存在（如2月30日）
    }
    const timestamp = check.getTime() - 8 * 3600000;
    if (timestamp <= now) return { timestamp, needClarify: false, isPast: true };
    return { timestamp, needClarify: false };
  }

  return null;
}

function createReminder(accountId, senderId, text, remindAt, contextToken, isTest = false) {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO reminders(account_id, sender_id, text, remind_at, status, context_token, created_at, is_test)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(accountId, senderId, text, remindAt, contextToken, now, isTest ? 1 : 0);
  // 持久化最新 context_token
  saveUserContext(accountId, senderId, contextToken);
  return r.lastInsertRowid;
}

function createTodo(accountId, senderId, text) {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO todos(account_id, sender_id, text, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(accountId, senderId, text, now);
  return r.lastInsertRowid;
}

function listReminders(accountId, senderId) {
  return db.prepare(
    `SELECT id, text, remind_at, status, is_test FROM reminders
     WHERE account_id = ? AND sender_id = ? AND status IN ('pending', 'waiting_context', 'unknown')
     ORDER BY remind_at ASC LIMIT 10`
  ).all(accountId, senderId);
}

function listTodos(accountId, senderId, includeDone = false) {
  const statusFilter = includeDone ? `status IN ('pending', 'done')` : `status = 'pending'`;
  return db.prepare(
    `SELECT id, text, created_at, status FROM todos
     WHERE account_id = ? AND sender_id = ? AND ${statusFilter}
     ORDER BY created_at DESC LIMIT 10`
  ).all(accountId, senderId);
}

function completeTodo(accountId, senderId, todoId) {
  const r = db.prepare(
    `UPDATE todos SET status = 'done', completed_at = ?
     WHERE account_id = ? AND sender_id = ? AND id = ? AND status = 'pending'`
  ).run(Date.now(), accountId, senderId, todoId);
  return r.changes > 0;
}

/** 修复10：待办取消命令 */
function cancelTodo(accountId, senderId, todoId) {
  const r = db.prepare(
    `UPDATE todos SET status = 'cancelled'
     WHERE account_id = ? AND sender_id = ? AND id = ? AND status = 'pending'`
  ).run(accountId, senderId, todoId);
  return r.changes > 0;
}

function cancelReminder(accountId, senderId, reminderId) {
  const r = db.prepare(
    `UPDATE reminders SET status = 'cancelled'
     WHERE account_id = ? AND sender_id = ? AND id = ? AND status IN ('pending', 'waiting_context', 'unknown')`
  ).run(accountId, senderId, reminderId);
  return r.changes > 0;
}

/** 持久化用户最新 context_token */
function saveUserContext(accountId, senderId, contextToken) {
  if (!contextToken) return;
  db.prepare(
    `INSERT INTO user_context(account_id, sender_id, context_token, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, sender_id) DO UPDATE SET context_token = ?, updated_at = ?`
  ).run(accountId, senderId, contextToken, Date.now(), contextToken, Date.now());
}

function getUserContext(accountId, senderId) {
  const row = db.prepare(
    `SELECT context_token FROM user_context WHERE account_id = ? AND sender_id = ?`
  ).get(accountId, senderId);
  return row?.context_token ?? null;
}

/**
 * 修复2：后台调度获取到期提醒（按 account 过滤，防重入）
 */
let reminderSchedulerRunning = false;
function getDueReminders(accountId) {
  const now = Date.now();
  return db.prepare(
    `SELECT * FROM reminders
     WHERE account_id = ? AND status = 'pending'
     AND remind_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY remind_at ASC LIMIT 5`
  ).all(accountId, now, now);
}

/**
 * 修复3：发送状态机
 * - sent: 成功
 * - failed: 明确拒绝，有 next_attempt_at 退避，重试耗尽 → waiting_context
 * - unknown: 独立状态，下次明确告知可能送达，不再自动发送
 */
function markReminderSent(reminderId) {
  db.prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?`)
    .run(Date.now(), reminderId);
}

function markReminderFailed(reminderId, isNetworkError) {
  const r = db.prepare(`SELECT retry_count FROM reminders WHERE id = ?`).get(reminderId);
  if (!r) return;
  if (isNetworkError) {
    // unknown 独立状态，不再自动发送
    db.prepare(`UPDATE reminders SET status = 'unknown' WHERE id = ?`).run(reminderId);
  } else {
    const newCount = (r.retry_count ?? 0) + 1;
    if (newCount >= 3) {
      // ①修复：重试耗尽 → waiting_context（从 sending 恢复）
      db.prepare(`UPDATE reminders SET status = 'waiting_context', retry_count = ? WHERE id = ?`)
        .run(newCount, reminderId);
    } else {
      // ①修复：明确失败恢复为 pending（带退避），不留在 sending
      const backoff = [60000, 300000, 900000][newCount - 1] ?? 900000;
      db.prepare(
        `UPDATE reminders SET status = 'pending', retry_count = ?, next_attempt_at = ? WHERE id = ?`
      ).run(newCount, Date.now() + backoff, reminderId);
    }
  }
}

function getOverdueReminders(accountId, senderId) {
  const now = Date.now();
  return db.prepare(
    `SELECT * FROM reminders
     WHERE account_id = ? AND sender_id = ?
     AND status IN ('pending', 'waiting_context')
     AND remind_at <= ?
     AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY remind_at ASC`
  ).all(accountId, senderId, now, now);
}

/**
 * 获取需要发送一次状态说明的 unknown 提醒
 * （单独跟踪，避免重复发送）
 */
function getUnknownRemindersNeedingNotice(accountId, senderId) {
  return db.prepare(
    `SELECT * FROM reminders
     WHERE account_id = ? AND sender_id = ?
     AND status = 'unknown' AND unknown_noticed IS NULL`
  ).all(accountId, senderId);
}

/** 启动时恢复：sending 中间态 → unknown（不盲重发） */
function recoverRemindersOnStartup() {
  const r = db.prepare(
    `UPDATE reminders SET status = 'unknown' WHERE status = 'sending'`
  ).run();
  if (r.changes > 0) log("INFO", `提醒恢复：${r.changes} 个 sending → unknown`);
}

/* ===== 个人偏好（修复4） ===== */

const VALID_BREVITY = ['brief', 'normal', 'detailed'];
const VALID_FORMATS = ['text', 'markdown', 'list'];

function getUserPrefs(accountId, senderId) {
  const row = db.prepare(
    `SELECT * FROM user_prefs WHERE account_id = ? AND sender_id = ?`
  ).get(accountId, senderId);
  if (row) return row;
  return { account_id: accountId, sender_id: senderId, brevity: 'normal', output_format: null, index_retention: 1 };
}

function setUserPref(accountId, senderId, key, value) {
  const now = Date.now();
  if (key === 'brevity') {
    if (!VALID_BREVITY.includes(value)) return false;
  } else if (key === 'output_format') {
    // 修复4：text 也是有效值，有实际提示效果
    if (value !== null && !VALID_FORMATS.includes(value)) return false;
  } else if (key === 'index_retention') {
    value = value ? 1 : 0;
  } else {
    return false;
  }
  db.prepare(
    `INSERT INTO user_prefs(account_id, sender_id, ${key}, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, sender_id) DO UPDATE SET ${key} = ?, updated_at = ?`
  ).run(accountId, senderId, value, now, value, now);
  return true;
}

function prefsToPromptFields(prefs) {
  const parts = [];
  if (prefs.brevity === 'brief') parts.push('回复风格：简短，直接给结论');
  else if (prefs.brevity === 'detailed') parts.push('回复风格：详细，多给背景和步骤');
  // 修复4：text 也有实际效果
  if (prefs.output_format === 'text') parts.push('输出格式：纯文本，不要用 Markdown 符号');
  else if (prefs.output_format === 'markdown') parts.push('输出格式：Markdown');
  else if (prefs.output_format === 'list') parts.push('输出格式：用列表分点');
  return parts.length ? `\n[用户偏好]\n${parts.join('\n')}` : '';
}

function shouldIndexFile(accountId, senderId) {
  const prefs = getUserPrefs(accountId, senderId);
  return prefs.index_retention === 1;
}

/* ===== 长任务进度通知（修复9） ===== */

class ProgressNotifier {
  constructor(account, to, contextToken, messageId) {
    this.account = account;
    this.to = to;
    this.contextToken = contextToken;
    this.messageId = messageId;
    this.timers = [];
    this.stopped = false;
    this.stageCount = 0;
    this.lastSentAt = 0;
  }
  start() {
    // 修复9：去掉"马上就好"无依据承诺，改用中性表述
    this.timers.push(setTimeout(() => this.notify('已收到，正在处理中，请稍候。'), 10000));
    this.timers.push(setTimeout(() => this.notify('仍在处理中，感谢耐心等待。'), 90000));
    this.timers.push(setTimeout(() => this.notify('处理时间较长，仍在继续，请稍等。'), 240000));
  }
  async notify(text) {
    if (this.stopped) return;
    const row = getTask(this.messageId);
    if (!row || ['sent','failed','unknown','timeout'].includes(row.status)) return;
    // 修复9：节流 - 距上次不足30秒不发送
    const now = Date.now();
    if (now - this.lastSentAt < 30000 && this.stageCount > 0) return;
    this.stageCount++;
    this.lastSentAt = now;
    const clientId = `${this.messageId}:progress:${this.stageCount}`;
    try {
      // 修复9：检查真实发送结果
      const res = await sendOnce(this.account, this.to, text, this.contextToken, clientId, this.messageId);
      if (res === 'sent') {
        this.lastSentAt = now;
        log("INFO", `进度通知已发送 (${this.stageCount})`);
      } else {
        log("WARN", `进度通知发送结果: ${res}`);
      }
    } catch (e) {
      log("WARN", `进度通知异常: ${e.message}`);
    }
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/* ===== 修复8：重试最近失败任务 ===== */

const retryInProgress = new Set(); // 防同一原任务并发重试

async function retryFailedTask(account, from, contextToken, newMessageId, originalTaskId) {
  // 防并发
  if (retryInProgress.has(originalTaskId)) {
    return { ok: false, reason: '该任务正在重试中，请稍候' };
  }
  const orig = getTask(originalTaskId);
  if (!orig) return { ok: false, reason: '没找到原任务' };
  // 归属检查
  if (orig.from_user_id !== from || orig.account_id !== account.accountId || orig.command_kind) return { ok: false, reason: '此任务无法安全重试，请重新描述需求或重传附件' };
  // 排除 unknown（避免意外重复）
  if (orig.status === 'unknown') {
    return { ok: false, reason: '原任务状态不明确，为避免重复发送，请重新描述需求' };
  }
  if (!['failed', 'timeout'].includes(orig.status)) {
    return { ok: false, reason: '只能重试失败或超时的任务' };
  }

  let mediaPaths = [], info = [];
  try {
    mediaPaths = orig.media_path ? JSON.parse(orig.media_path) : [];
    info = orig.media_info ? JSON.parse(orig.media_info) : [];
    if (!Array.isArray(mediaPaths) || !Array.isArray(info)) throw new Error('invalid media');
    if (orig.media_status === 'failed' || orig.media_status === 'pending' ||
        ((orig.media_type ?? 0) > 0 && (!mediaPaths.length || orig.media_status !== 'downloaded'))) {
      return {ok:false,reason:'原附件未下载完整，请重新发送附件。'};
    }
    if (mediaPaths.length && (info.length !== mediaPaths.length ||
        mediaPaths.some(p => !verifyFilePath(p,account.accountId,from,originalTaskId)))) {
      return {ok:false,reason:'原附件已不存在或无法验证，请重新发送附件。'};
    }
  } catch {return {ok:false,reason:'原附件无法验证，请重新发送附件。'};}
  retryInProgress.add(originalTaskId);
  let ready = false;
  try {
    const now = Date.now();
    const newPaths = [];
    if (mediaPaths.length) {
      const dir=path.join(MEDIA_DIR,newMessageId);
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      for (let i=0;i<mediaPaths.length;i++) {
        const safe=verifyFilePath(mediaPaths[i],account.accountId,from,originalTaskId);
        if (!safe || fs.statSync(safe).size > MEDIA_MAX_BYTES) throw new Error('attachment unavailable');
        const dest=path.join(dir,`${i+1}_${path.basename(safe)}`);
        fs.copyFileSync(safe,dest); fs.chmodSync(dest,0o600); newPaths.push(dest);
      }
    }
    // 创建新任务（新 ID，新结束标记），不改写原任务
    db.prepare(
      `INSERT INTO tasks(message_id, status, from_user_id, text, context_token, created_at, updated_at, media_type, media_path, media_info, media_status, account_id)
       VALUES (?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newMessageId, from, orig.text, contextToken, now, now,
      orig.media_type ?? 0, newPaths.length ? JSON.stringify(newPaths) : null, orig.media_info ?? null,
      newPaths.length ? 'downloaded' : null, account.accountId
    );

    log("INFO", `重试任务创建: ${originalTaskId} -> ${newMessageId}`);
    ready = true;
    return { ok: true, newId: newMessageId };
  } catch {
    return {ok:false,reason:'重试准备失败，请重新描述需求或重传附件。'};
  } finally {
    if (!ready) retryInProgress.delete(originalTaskId);
  }
}

function getLastFailedTask(accountId, senderId) {
  return db.prepare(
    `SELECT message_id, status, substr(text, 1, 50) as preview, updated_at
     FROM tasks WHERE from_user_id = ? AND account_id = ? AND command_kind IS NULL
     AND status IN ('failed', 'timeout')
     ORDER BY updated_at DESC LIMIT 1`
  ).get(senderId, accountId);
}
function setStatus(id, status, extra = {}) {
  const keys = Object.keys(extra);
  const setClause = [
    "status =?",
    "updated_at =?",
    ...keys.map((k) => `${k} =?`),
  ].join(", ");
  db.prepare(`UPDATE tasks SET ${setClause} WHERE message_id =?`).run(
    status,
    Date.now(),
    ...keys.map((k) => extra[k]),
    id,
  );
  log("INFO", `任务 ${id} 状态 → ${status}`);
}

// R4 修复：条件状态更新——仅当任务未进入终态时才更新，防止晚到发送覆盖 timeout
// 终态：timeout / failed / sent / unknown（一旦进入，不再被覆盖）
const FINAL_STATES = new Set(["timeout", "failed", "sent", "unknown"]);
function setStatusIfNotFinal(id, status, extra = {}) {
  const cur = db.prepare("SELECT status FROM tasks WHERE message_id = ?").get(id);
  if (cur && FINAL_STATES.has(cur.status)) {
    log("WARN", `任务 ${id} 已为终态 ${cur.status}，拒绝覆盖为 ${status}`);
    return false;
  }
  setStatus(id, status, extra);
  return true;
}
function setFailed(id, error) {
  setStatusIfNotFinal(id, "failed", { error: redact(String(error)).slice(0, 500) });
  log("ERROR", `任务 ${id} 失败: ${redact(error)}`);
}

// ---------------------------------------------------------------------------
// 附件媒体处理
// ---------------------------------------------------------------------------
/**
 * 文件名消毒：剥离路径分隔符，长度上限 100，不拼 shell 命令。
 */
function sanitizeFilename(name) {
  let n = String(name ?? "file").replace(/[/\\]/g, "_").replace(/\0/g, "");
  n = n.replace(/^\.+/, "").trim() || "file";
  if (n.length > 100) {
    const ext = path.extname(n);
    n = n.slice(0, 100 - ext.length) + ext;
  }
  return n;
}

/**
 * 从 item_list 中提取媒体项（图片/语音/文件/视频）。
 * 返回 [{type, item, fileName}]
 */
function extractMediaItems(itemList) {
  const items = [];
  if (!itemList?.length) return items;
  for (const item of itemList) {
    const t = item.type;
    if (t === MessageItemType.IMAGE) {
      items.push({ type: 2, item, fileName: "image.jpg" });
    } else if (t === MessageItemType.VOICE) {
      // 提取微信服务端转写（若有）
      const wechatText = item.voice_item?.text ?? null;
      items.push({ type: 3, item, fileName: "voice.wav", wechatText });
    } else if (t === MessageItemType.FILE) {
      const fn = item.file_item?.file_name ?? "file.bin";
      items.push({ type: 4, item, fileName: fn });
    } else if (t === MessageItemType.VIDEO) {
      items.push({ type: 5, item, fileName: "video.mp4" });
    }
  }
  return items;
}

/**
 * 下载媒体到任务隔离目录。
 * 使用 SDK 的 downloadMediaFromItem，自定义 saveMedia 保存到任务目录。
 * 返回 [{type, path, size, fileName}] 或抛出异常。
 */
async function downloadMedia(taskId, mediaItems, account) {
  const taskDir = path.join(MEDIA_DIR, taskId);
  fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const results = [];
  let idx = 0;
  for (const { type, item, fileName, wechatText } of mediaItems) {
    idx++;
    const safeName = sanitizeFilename(fileName);
    const destName = `${String(idx).padStart(2, "0")}_${safeName}`;
    const destPath = path.join(taskDir, destName);
    // saveMedia 回调：保存到任务目录，大小上限 20MB
    const saveMedia = async (buf, mime, _kind, _maxBytes, _origName) => {
      if (buf.length > MEDIA_MAX_BYTES) {
        throw new Error(`文件过大: ${buf.length} > ${MEDIA_MAX_BYTES}`);
      }
      fs.writeFileSync(destPath, buf, { mode: 0o600 });
      return { path: destPath };
    };
    const deps = {
      cdnBaseUrl: account.cdnBaseUrl,
      saveMedia,
      log: (m) => log("INFO", `[媒体] ${m}`),
      errLog: (m) => log("ERROR", `[媒体] ${m}`),
      label: `任务${taskId}`,
    };
    // 120 秒超时
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("媒体下载超时 120 秒")), MEDIA_DOWNLOAD_TIMEOUT_MS)
    );
    const result = await Promise.race([
      sdkMediaDownload.downloadMediaFromItem(item, deps),
      timeoutPromise,
    ]);
    // 检查是否实际下载成功
    const savedPath =
      result.decryptedPicPath ?? result.decryptedVoicePath ??
      result.decryptedFilePath ?? result.decryptedVideoPath ?? null;
    if (!savedPath || !fs.existsSync(savedPath)) {
      throw new Error(`${MEDIA_TYPE_LABEL[type]} 下载失败：SDK 未返回有效路径`);
    }
    const stat = fs.statSync(savedPath);
    results.push({ type, path: savedPath, size: stat.size, fileName: destName, wechatText: wechatText ?? null });
    log("INFO", `任务 ${taskId} 媒体下载完成: ${destName} (${stat.size}字节)`);
  }
  return results;
}

/**
 * 视频抽帧：ffmpeg 提取第 5 秒/中段/倒数 5 秒三帧为 PNG。
 * 返回帧文件路径数组。
 */
async function extractVideoFrames(videoPath, taskDir, taskSignal) {
  // 获取视频时长
  const { stdout: durOut } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
  ], { timeout: 15000, signal: taskSignal });
  const duration = parseFloat(durOut.trim()) || 0;
  const overLimit = duration > 120;
  const effDuration = overLimit ? 120 : duration;
  const times = [5, effDuration / 2, Math.max(effDuration - 5, 6)].map((t) =>
    Math.max(0, Math.min(t, effDuration - 1)).toFixed(1)
  );
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const framePath = path.join(taskDir, `frame_${i + 1}.png`);
    await execFileAsync("ffmpeg", [
      "-y", "-ss", times[i], "-i", videoPath,
      "-vframes", "1", "-q:v", "2", framePath,
    ], { timeout: 30000, signal: taskSignal });
    frames.push({ path: framePath, time: times[i] });
  }
  return { frames, duration, overLimit };
}

/**
 * SILK 转 WAV：微信语音为 SILK_V3 格式，faster-whisper 无法直接读取。
 * 使用 silk-wasm 解码为 PCM，再封装为 WAV。
 * 返回 WAV 文件路径（与原文件同目录，.wav 后缀）。
 */
async function decodeSilkToWav(silkPath) {
  const silkData = fs.readFileSync(silkPath);
  // silk-wasm 的 isSilk 检查
  if (!silkWasm.isSilk(silkData)) {
    return null; // 非 SILK 格式，返回 null 由调用方处理
  }
  const result = await silkWasm.decode(silkData, 24000);
  const pcmData = Buffer.from(result.data);
  const sampleRate = 24000;
  // 构造 WAV 文件头（16-bit PCM，单声道）
  const buffer = Buffer.alloc(44 + pcmData.length);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmData.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmData.length, 40);
  pcmData.copy(buffer, 44);
  const wavPath = silkPath.replace(/\.[^.]+$/, "_decoded.wav");
  fs.writeFileSync(wavPath, buffer, { mode: 0o600 });
  log("INFO", `SILK 解码完成: ${silkPath} -> ${wavPath} (${result.duration}ms)`);
  return wavPath;
}

/**
 * 语音转写：优先 VoiceItem.text，无则 faster-whisper。
 * 返回 {source: "wechat"|"local", text} 或 null（不可用）。
 */
async function transcribeVoice(audioPath, wechatText, taskSignal) {
  // 优先微信服务端转写（字符串）
  if (typeof wechatText === "string" && wechatText.trim()) {
    return { source: "wechat", text: wechatText.trim() };
  }
  // 兼容旧调用：voiceItem 对象
  if (wechatText?.text?.trim()) {
    return { source: "wechat", text: wechatText.text.trim() };
  }
  // 回退 faster-whisper（本地模型）
  try {
    // 微信语音为 SILK 格式，需先解码为 WAV
    let whisperInput = audioPath;
    const wavPath = await decodeSilkToWav(audioPath);
    if (wavPath) {
      whisperInput = wavPath;
    }
    const { stdout } = await execFileAsync("faster-whisper", [whisperInput, "--language", "zh", "--output_format", "txt"], {
      timeout: 120000, // 转写可能较慢，120 秒超时
      signal: taskSignal, // R2: 任务超时可取消转写子进程
    });
    // faster-whisper 输出到同名 .txt 文件
    const txtPath = whisperInput.replace(/\.[^.]+$/, ".txt");
    let text = null;
    if (fs.existsSync(txtPath)) {
      text = fs.readFileSync(txtPath, "utf-8").trim() || null;
    } else {
      text = stdout.trim() || null;
    }
    return text ? { source: "local", text } : null;
  } catch (e) {
    log("WARN", `faster-whisper 转写失败: ${e.message}`);
    return null;
  }
}

/**
 * 构造给 Muse 的附件提示词。
 */
function buildMediaPrompt(mediaFiles, userText, taskId, videoFrames = null, transcription = null, videoOverLimit = false) {
  const lines = ["[微信附件任务]"];
  
  // 语音且有服务端转写：专用规则，转写即用户输入，不列附件、不要求读文件
  const isVoiceWithServerText = transcription?.source === "wechat" && mediaFiles.length === 1 && mediaFiles[0].type === 3;
  
  if (!isVoiceWithServerText) {
    for (const mf of mediaFiles) {
      const label = MEDIA_TYPE_LABEL[mf.type] ?? "附件";
      const sizeKB = (mf.size / 1024).toFixed(1);
      lines.push(`附件：${mf.path}（${label}，${sizeKB}KB）`);
    }
  }
  if (videoFrames) {
    lines.push("视频帧（抽样）：");
    for (const f of videoFrames) {
      lines.push(`  第 ${f.time} 秒：${f.path}`);
    }
    lines.push("本分析基于以上 3 帧画面的视觉内容及音频转写，未观看完整视频连续画面。");
    if (videoOverLimit) {
      lines.push("注意：视频超过 120 秒，本次仅分析前 120 秒的内容。");
    }
  }
  if (transcription) {
    // 区分微信服务端转写（较准）和本地模型识别（需标注不确定性）
    const isWechatServer = transcription.source === "wechat";
    const text = transcription.text ?? transcription;
    if (isWechatServer) {
      // 服务端转写：作为用户输入，不触发本地识别
      lines.push(`用户语音转写（微信服务端提供，请直接作为用户说的话处理）：${text}`);
      lines.push("说明：以上是微信服务端的语音转写结果，可直接使用。不要重复识别音频文件，不要声称自己运行了识别模型或下载了模型。原音频已保存备查，仅在用户明确要求分析原音时才需读取。");
    } else {
      lines.push(`语音识别结果（本地模型，未经人工核实，仅供参考）：${text}`);
      lines.push("注意：以上为机器识别结果，可能有误。请称其为\"识别结果\"，不要称为\"音频原话\"；不要据此断言用户说错；对不确定的词、数字、人名请明确标注不确定，必要时请用户确认。不要编造模型调用、下载或复核过程。");
    }
  }
  if (!isVoiceWithServerText) {
    lines.push("请使用你的文件读取工具直接读取上述文件，不要猜测内容。");
  }
  if (userText?.trim()) {
    lines.push(`用户文字：${userText.trim()}`);
  }
  lines.push("要求：基于文件实际内容回答。");
  lines.push("若你修改了附件或生成了新文件（包括在原文件上修改后保存），必须保存到目录：" + path.join(MEDIA_DIR, taskId) + "（不要存到其他目录，否则文件无法送达微信），并在回复末尾、任务标记之前，单独一行写：生成文件：<文件的绝对路径>。");
  lines.push(`直接说明结果，不加机械引用头，不显示内部文件路径；末尾单独一行写：任务${taskId}回复完毕。`);
  return lines.join("\n");
}

/**
 * 验证路径在任务目录内（防路径遍历）。
 */
function isPathInTaskDir(filePath, taskId) {
  const taskDir = path.join(MEDIA_DIR, taskId);
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(taskDir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

/**
 * 从 Muse 回复中提取文件路径（若 Muse 生成/修改了文件）。
 * 查找回复中提及的任务目录内文件路径。
 */
function extractReturnedFilePath(replyText, taskId) {
  const taskDir = path.join(MEDIA_DIR, taskId);
  const matches = [];
  let idx = 0;
  while ((idx = replyText.indexOf(taskDir, idx)) !== -1) {
    let end = idx + taskDir.length;
    while (end < replyText.length && !/[\s"'<>\n]/.test(replyText[end])) end++;
    const p = replyText.slice(idx, end);
    if (fs.existsSync(p) && isPathInTaskDir(p, taskId)) {
      matches.push(p);
    }
    idx = end;
  }
  return matches;
}

/**
 * 上传并发送文件到微信。
 */
/**
 * Excel 公式重算：用 LibreOffice headless 打开并保存，填充公式计算结果缓存。
 * 保留公式本身，仅补充缓存值，避免预览工具显示空白。
 * 返回 { path, recalculated }：recalculated 为 false 表示重算失败（返回原路径）。
 * 失败时不抛错，由调用方决定是否通知用户。
 */
async function recalcExcel(filePath, taskSignal) {
  const ext = path.extname(filePath).toLowerCase();
  // 仅处理 .xlsx（输入输出同名，逻辑成立）；.xls 不在此处理，避免死分支
  // 非 Excel 文件：无需重算，标记为成功（无操作）
  if (ext !== ".xlsx") {
    return { path: filePath, recalculated: true, skipped: true };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "excel-recalc-"));
  try {
    const base = path.basename(filePath);
    // LibreOffice 输出到临时目录，避免覆盖输入文件导致写入失败
    // R1: 传递 taskSignal，任务超时可取消重算子进程
    await execFileAsync("libreoffice", [
      "--headless",
      "--convert-to", "xlsx:Calc MS Excel 2007 XML",
      filePath,
      "--outdir", tmpDir,
    ], { timeout: 90000, signal: taskSignal });
    const outPath = path.join(tmpDir, base);
    if (fs.existsSync(outPath)) {
      // 先写临时名再原子 rename，避免拷贝中途失败损坏原文件
      const tmpName = filePath + ".recalc";
      fs.copyFileSync(outPath, tmpName);
      fs.renameSync(tmpName, filePath);
      log("INFO", `Excel 公式重算完成: ${base}`);
      return { path: filePath, recalculated: true };
    }
    log("WARN", `Excel 重算输出不存在，保留原文件: ${base}`);
    return { path: filePath, recalculated: false, reason: "无重算输出" };
  } catch (e) {
    const reason = redact(e.message).slice(0, 200);
    log("WARN", `Excel 公式重算失败，保留原文件: ${reason}`);
    return { path: filePath, recalculated: false, reason };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function sendMediaReply(account, to, contextToken, taskId, filePath, mediaType, caption, taskSignal, indexTaskId = taskId) {
  const opts = {
    baseUrl: account.baseUrl,
    token: account.token,
    timeoutMs: 15000,
    contextToken,
  };
  // R1: 进入时检查，中止则抛错由调用方记为 failed（不盲重试）
  if (taskSignal?.aborted) {
    throw new Error("任务已总超时，取消文件发送");
  }
  // Excel 文件：先重算公式填充缓存，再上传（保留公式，仅补充缓存值）
  // 重算失败时仍发送原文件，但必须明确告知用户"公式结果未验证"
  const recalc = await recalcExcel(filePath, taskSignal);
  const sendPath = recalc.path;
  let uploaded;
  const label = `任务${taskId}回传`;
  // CDN 上传地址必须用 cdnBaseUrl（novac2c.cdn.weixin.qq.com），不能用 API 的 baseUrl（ilinkai.weixin.qq.com）
  const cdnBaseUrl = account.cdnBaseUrl;
  if (mediaType === 2) {
    uploaded = await sdkMediaUpload.uploadFileToWeixin({
      filePath: sendPath, toUserId: to, opts, cdnBaseUrl, label,
    });
    // R1: 上传结束后、发送前再次检查；已超时则禁止新发送，按实际记账
    if (taskSignal?.aborted) {
      throw new Error("任务已总超时，上传完成但禁止发送");
    }
    await sdkMediaSend.sendImageMessageWeixin({ to, text: caption, uploaded, opts });
  } else if (mediaType === 5) {
    uploaded = await sdkMediaUpload.uploadVideoToWeixin({
      filePath: sendPath, toUserId: to, opts, cdnBaseUrl, label,
    });
    if (taskSignal?.aborted) {
      throw new Error("任务已总超时，上传完成但禁止发送");
    }
    await sdkMediaSend.sendVideoMessageWeixin({ to, text: caption, uploaded, opts });
  } else {
    const fileName = sanitizeFilename(path.basename(sendPath));
    uploaded = await sdkMediaUpload.uploadFileAttachmentToWeixin({
      filePath: sendPath, toUserId: to, opts, cdnBaseUrl, label,
    });
    if (taskSignal?.aborted) {
      throw new Error("任务已总超时，上传完成但禁止发送");
    }
    await sdkMediaSend.sendFileMessageWeixin({ to, text: caption, fileName, uploaded, opts });
  }
  log("INFO", `任务 ${taskId} 文件已发送: ${path.basename(sendPath)}`);
  // 资料找回：索引发出的文件（含 original_task_id，尊重索引开关）
  // 修复6：重发成功不重复索引（检查是否已存在）
  try {
    const taskRow = getTask(indexTaskId);
    if (taskRow && shouldIndexFile(account.accountId ?? 'default', to)) {
      const existing = db.prepare(
        `SELECT id FROM file_index WHERE account_id = ? AND sender_id = ?
         AND file_path = ? AND original_task_id = ?`
      ).get(account.accountId ?? 'default', to, sendPath, indexTaskId);
      if (!existing) {
        indexFile(account.accountId ?? 'default', to, path.basename(sendPath), sendPath, 'outbound', indexTaskId);
      }
    }
  } catch (e) {
    log("WARN", `发出文件索引失败: ${e.message}`);
  }
  // 重算失败：明确告知用户，不能宣称重算成功
  if (!recalc.recalculated && !recalc.skipped) {
    const fileBase = path.basename(sendPath);
    const notice = `文件「${fileBase}」已修改并发出，但自动重算失败（${recalc.reason || "未知原因"}），公式结果未验证。请在 Excel 中手动重算确认。`;
    log("WARN", `任务 ${taskId} 重算失败已通知用户: ${fileBase} - ${recalc.reason}`);
    try {
      // client_id 加入文件名，避免多文件任务的去重冲突（D2）
      await sendNotice(
        account,
        { ...getTask(taskId), client_id: `wechat-muse:${taskId}:recalc-${fileBase}` },
        notice,
      );
    } catch (ne) {
      log("WARN", `任务 ${taskId} 重算失败通知发送失败: ${ne.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 单实例
// ---------------------------------------------------------------------------
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireSingleInstance() {
  try {
    const fd = fs.openSync(PID_PATH, "wx", 0o644);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let oldPid = null;
    try {
      oldPid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
    } catch {
      /* ignore */
    }
    if (oldPid && isPidAlive(oldPid)) {
      log("ERROR", `另一个桥接实例正在运行 (pid=${oldPid})，本实例退出`);
      return false;
    }
    log("WARN", `pidfile 残留 (pid=${oldPid})，判定 stale，接管`);
    fs.unlinkSync(PID_PATH);
    return acquireSingleInstance();
  }
}

// ---------------------------------------------------------------------------
// 微信账号：显式 profile 隔离，默认不自动导入
// ---------------------------------------------------------------------------
// 安全约束：
// - 仅使用本 profile state 目录中的账号
// - 绝不自动读取其他 profile 或旧桥的 session.json
// - 新用户无账号时抛错，引导运行 scripts/qr-login.mjs
// - 旧账号迁移仅通过环境变量 WECHAT_MUSE_ALLOW_OLD_IMPORT=1 显式 opt-in
function verifyBoundWechatAccount(account) {
  const saved = sdkAccounts.loadWeixinAccount(account.accountId);
  if (!saved?.userId || saved.userId !== config.ilink_user_id) {
    throw new Error("当前微信登录态的扫描者与 config.ilink_user_id 不匹配或缺失；保留现有状态，请核对本账号配置或显式迁移");
  }
  return account;
}
function ensureWechatAccount() {
  const ids = sdkAccounts.listWeixinAccountIds();
  if (ids.length > 0) {
    // 显式选择：如有多账号，需通过环境变量指定，不随意取 ids[0]
    // P2 修复：即使只有一个账号，也核对是否与显式指定的 ID 匹配
    const wantId = process.env.WECHAT_MUSE_ACCOUNT_ID ? sdkAccounts.normalizeAccountId(process.env.WECHAT_MUSE_ACCOUNT_ID) : null;
    let accountId = ids[0];
    if (wantId) {
      if (!ids.includes(wantId)) {
        throw new Error(
          `指定的微信账号 ${wantId} 不在已登录列表中 (现有: ${ids.join(", ")})`
        );
      }
      accountId = wantId;
    } else if (ids.length > 1) {
      throw new Error(
        `发现多个微信账号 (${ids.join(", ")})，请通过环境变量 WECHAT_MUSE_ACCOUNT_ID 显式指定`
      );
    }
    const acc = sdkAccounts.resolveWeixinAccount(accountId);
    if (!acc.configured) throw new Error("微信账号无 token，需重新扫码登录");
    return verifyBoundWechatAccount(acc);
  }
  // 无账号：检查是否显式允许旧导入
  if (process.env.WECHAT_MUSE_ALLOW_OLD_IMPORT === "1") {
    const oldSession = path.join(OLD_BRIDGE_STATE, "session.json");
    if (!fs.existsSync(oldSession)) {
      throw new Error(
        `未找到微信登录账号。请运行 scripts/qr-login.mjs --profile <name> 进行扫码登录。` +
        `（旧桥 session.json 也不存在）`
      );
    }
    log("WARN", "通过 WECHAT_MUSE_ALLOW_OLD_IMPORT=1 显式导入旧桥账号");
    const s = JSON.parse(fs.readFileSync(oldSession, "utf-8"));
    const accountId = sdkAccounts.normalizeAccountId(s.ilink_bot_id);
    const requested = process.env.WECHAT_MUSE_ACCOUNT_ID;
    if (s.ilink_user_id !== config.ilink_user_id || (requested && sdkAccounts.normalizeAccountId(requested) !== accountId)) {
      throw new Error("旧桥账号与当前 profile 配置不匹配，拒绝迁移，不修改登录态");
    }
    sdkAccounts.saveWeixinAccount(accountId, {
      token: s.bot_token,
      baseUrl: s.baseurl,
      userId: s.ilink_user_id,
    });
    sdkAccounts.registerWeixinAccountId(accountId);
    log("INFO", "已从旧桥 session.json 导入微信账号（显式 opt-in）");
    const acc = sdkAccounts.resolveWeixinAccount(accountId);
    if (!acc.configured) throw new Error("账号导入后仍无 token");
    return verifyBoundWechatAccount(acc);
  }
  // 默认：无账号时抛错，不自动导入
  throw new Error(
    "未找到微信登录账号。请运行 scripts/qr-login.mjs --profile <name> 进行扫码登录。" +
    "（默认不自动导入旧账号，防止误用他人登录态）"
  );
}
function seedDedup(account) {
  let ids = [];
  // 去重种子：仅在显式 opt-in 时从旧桥导入，防止新用户误用他人消息 ID
  if (process.env.WECHAT_MUSE_ALLOW_OLD_IMPORT !== "1") {
    log("INFO", "去重种子: 跳过旧桥导入（未显式 opt-in）");
    return ids;
  }
  // P2 修复：导入前确认旧账号与当前账号为同一账号（比对 ilink_bot_id 和 ilink_user_id）
  try {
    const oldSessionPath = path.join(OLD_BRIDGE_STATE, "session.json");
    const oldSession = JSON.parse(fs.readFileSync(oldSessionPath, "utf-8"));
    const currentIds = sdkAccounts.listWeixinAccountIds();
    const oldBotId = sdkAccounts.normalizeAccountId(oldSession.ilink_bot_id);
    if (!currentIds.includes(oldBotId) || account.accountId !== oldBotId) {
      log("ERROR", `去重种子拒绝导入：旧桥账号 ${oldBotId} 与当前登录账号 (${currentIds.join(", ")}) 不一致`);
      return ids;
    }
    // 进一步核对 userId（扫描者）一致
    const currentAcc = sdkAccounts.loadWeixinAccount(oldBotId);
    if (!currentAcc?.userId || currentAcc.userId !== oldSession.ilink_user_id || currentAcc.userId !== config.ilink_user_id) {
      log("ERROR", `去重种子拒绝导入：旧桥扫描者与当前扫描者不一致`);
      return ids;
    }
    log("INFO", `去重种子账号核对通过：${oldBotId}`);
  } catch (e) {
    log("WARN", `去重种子账号核对失败，跳过导入: ${e.message}`);
    return ids;
  }
  // 数据源优先级：v2.db（旧桥完整 86 条）> processed.json（69 条快照，缺 17 条）。
  // B3 发现 processed.json 非完整，2026-10-10 起改用 v2.db。
  try {
    const v2 = new DatabaseSync(path.join(OLD_BRIDGE_STATE, "v2.db"), {
      readOnly: true,
    });
    ids = v2
      .prepare("SELECT message_id FROM messages")
      .all()
      .map((r) => String(r.message_id));
    v2.close();
    log("INFO", `去重种子源: v2.db（${ids.length} 条）`);
  } catch (e) {
    log("WARN", `v2.db 读取失败，回退 processed.json: ${e.message}`);
    try {
      ids = JSON.parse(
        fs.readFileSync(path.join(OLD_BRIDGE_STATE, "processed.json"), "utf-8"),
      );
      if (!Array.isArray(ids)) ids = [];
    } catch (e2) {
      log("WARN", `旧 processed.json 读取失败，跳过去重种子: ${e2.message}`);
      return;
    }
  }
  const ins = db.prepare(
    `INSERT OR IGNORE INTO tasks(message_id, status, created_at, updated_at) VALUES (?, 'seeded',?,?)`,
  );
  const now = Date.now();
  let n = 0;
  // node:sqlite 无 db.transaction()（那是 better-sqlite3 的 API），手动 BEGIN/COMMIT
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      if (typeof id === "string" && id) {
        ins.run(id, now, now);
        n++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  log("INFO", `去重种子导入 ${n} 个历史 message_id（字符串比对）`);
}

// ---------------------------------------------------------------------------
// muse-cli 调用
// ---------------------------------------------------------------------------
function buildMuseText(userText, taskId) {
  const marker = markerFor(taskId);
  const taskDir = path.join(MEDIA_DIR, taskId);
  return (
    `[微信任务] 你是用户的微信助手。请直接处理下面的用户消息并给出最终回复。\n` +
    `要求：\n` +
    `1. 直接说明结果，不加机械引用头，不显示内部文件路径。\n` +
    `2. 中文回复，简洁。\n` +
    `3. 回复的最后一行必须原样输出：${marker}（独立一行，数字一个不能少，这是任务完成的确认信号，缺一不可）\n` +
    `4. 需要动手做事（查资料、操作文件、执行命令）就直接做，不要只说空话。\n` +
    `5. 如需生成文件发给用户（如表格、文档、图片），必须保存到目录：${taskDir}（不要存到其他目录，否则文件无法送达微信），并在回复末尾、任务标记之前单独一行写：生成文件：<文件的绝对路径>。\n\n` +
    `用户消息：\n${userText}`
  );
}
function stripMarker(t, taskId) {
  const marker = markerFor(taskId);
  const i = t.lastIndexOf(marker);
  return (i >= 0 ? t.slice(0, i) : t).trimEnd();
}
async function getHistoryRaw(limit, abortSignal) {
  const out = await execFileAsync(
    config.muse_cli_path,
    [
      "history",
      "--thread",
      config.weixin_session_id,
      "--limit",
      String(limit ?? config.history_limit),
      "--raw",
    ],
    {
      timeout: config.history_call_timeout_ms,
      maxBuffer: 20 * 1024 * 1024,
      signal: abortSignal,
    },
  );
  const parsed = JSON.parse(out.stdout);
  return parsed.chat_events ?? [];
}
async function getMaxSeq(abortSignal) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    if (abortSignal?.aborted) throw new Error("task total timeout");
    try {
      const events = await getHistoryRaw(5, abortSignal);
      return events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    } catch (e) {
      if (abortSignal?.aborted) throw e;
      lastErr = e;
      await sleep(2000);
    }
  }
  throw new Error(`history baseline 查询失败(3次): ${lastErr?.message}`);
}
/**
 * 启动预热：首次调用 muse-cli，建立连接，避免首条真实消息承担冷启动延迟。
 * 成功才继续；失败则抛错，桥接退出（systemd 会重启重试）。
 * 不删除 baseline，不放松回复归属校验。
 */
async function warmupMuse() {
  const t0 = Date.now();
  log("INFO", "Muse 连接预热开始");
  try {
    const seq = await getMaxSeq();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log("INFO", `Muse 连接预热成功（${dt}s，当前 maxSeq=${seq}），服务就绪`);
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    throw new Error(`Muse 连接预热失败（${dt}s）: ${e.message}，桥接拒绝启动`);
  }
}
/** 在 history 中找 seq > baseline、带本任务结束标记的最新 assistant 回复 */
function findMarkedReply(events, baseline, taskId) {
  const marker = markerFor(taskId);
  let best = null;
  for (const ev of events) {
    if (ev.event_name !== "message.assistant") continue;
    if ((ev.seq ?? 0) <= baseline) continue;
    const p = ev.payload ?? {};
    const t = p.display_text ?? p.content ?? "";
    if (t && t.includes(marker) && (!best || ev.seq > best.seq))
      best = { seq: ev.seq, text: t };
  }
  return best;
}
/** 等待 Muse 最终回复；返回 {ok, text?, via?, timeout?, unknown?, stopped?}
 * 认领规则（用户 2026-10-10 决策）：只认领本任务的有效结束标记
 * 任务<message_id>回复完毕。。history 事件无服务端请求 ID 可关联无标记回复
 * 到具体任务（reply_to 为空，root_message_execution_id 自衍生），会话/seq/静默时间
 * 均不足以证明归属，故取消无标记兜底（原 D15），不猜测结果、不自动重提。
 * 超时按既定策略：通知用户，baseline 前推，任务记 timeout。
 */
async function waitForReply(id, baseline, taskSignal) {
  // 3 分钟：等待 Muse 回复阶段（任务总超时由外层 runTask 控制）
  let deadline = Date.now() + config.muse_timeout_ms;
  let maxSeqSeen = baseline;
  let failStreak = 0;
  // AbortController 用于取消卡住的 history 子进程，确保超时能终止本地等待
  // 同时监听任务级 signal，实现总超时联动取消
  const controller = new AbortController();
  const onTaskAbort = () => controller.abort();
  if (taskSignal) {
    if (taskSignal.aborted) controller.abort();
    else taskSignal.addEventListener("abort", onTaskAbort, { once: true });
  }
  const timeoutId = setTimeout(() => {
    controller.abort();
    log("WARN", `任务 ${id} 回复等待超时，取消 history 等待`);
  }, config.muse_timeout_ms + 10000); // 上限 + 缓冲

  try {
    for (;;) {
      if (stopping) return { ok: false, stopped: true };
      if (controller.signal.aborted) {
        return { ok: false, timeout: true, maxSeq: maxSeqSeen, aborted: true };
      }
      let events;
      try {
        // 用 race 确保单次 history 调用不阻塞超时检查
        const historyPromise = getHistoryRaw(undefined, controller.signal);
        const deadlinePromise = new Promise((_, reject) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            reject(new Error("deadline exceeded"));
          } else {
            setTimeout(() => reject(new Error("deadline exceeded")), remaining);
          }
        });
        events = await Promise.race([historyPromise, deadlinePromise]);
        failStreak = 0;
      } catch (e) {
        if (e.message === "deadline exceeded" || controller.signal.aborted) {
          return { ok: false, timeout: true, maxSeq: maxSeqSeen };
        }
        failStreak++;
        log(
          "ERROR",
          `任务 ${id} history 查询失败(${failStreak}): ${redact(e.message)}`,
        );
        if (failStreak >= 5) return { ok: false, unknown: true }; // D11: 查不到≠没回复
        await sleep(config.muse_poll_interval_ms);
        continue;
      }
      // 唯一认领依据：本任务的有效结束标记（三重约束：--thread 会话 + seq>baseline + 任务 ID）
      // 严格归属校验：迟到回复不能被后续任务认领，无标记不兜底
      const marked = findMarkedReply(events, baseline, id);
      if (marked)
        return { ok: true, text: stripMarker(marked.text, id), via: "marker" };
      for (const ev of events) {
        if ((ev.seq ?? 0) <= baseline) continue;
        if ((ev.seq ?? 0) > maxSeqSeen) {
          maxSeqSeen = ev.seq;
        }
      }
      if (Date.now() >= deadline) {
        return { ok: false, timeout: true, maxSeq: maxSeqSeen };
      }
      await sleep(config.muse_poll_interval_ms);
    }
  } finally {
    clearTimeout(timeoutId);
    if (taskSignal) taskSignal.removeEventListener("abort", onTaskAbort);
  }
}

// ---------------------------------------------------------------------------
// 微信发送（固定 client_id；单次发送，无自动重试）
// ---------------------------------------------------------------------------
function buildTextReq({ to, text, contextToken, clientId }) {
  if (!contextToken) throw new Error("context_token 缺失，拒绝发送");
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      context_token: contextToken,
    },
  };
}
function isNetworkError(e) {
  const m = e?.message ?? String(e);
  return (
    e?.name === "AbortError" ||
    m.includes("fetch failed") ||
    m.includes("ECONNREFUSED") ||
    m.includes("ETIMEDOUT") ||
    m.includes("ENOTFOUND") ||
    m.includes("EAI_AGAIN") ||
    m.includes("ECONNRESET")
  );
}
function splitText(t, n) {
  const segs = [];
  let s = t;
  while (s.length > n) {
    let cut = s.lastIndexOf("\n", n);
    if (cut < n * 0.5) cut = n;
    segs.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s) segs.push(s);
  return segs.length ? segs : [""];
}
/**
 * 单次发送（无自动重试）。
 * 用户决策（2026-10-10）：网络错误/超时时服务端可能已接受消息，重试可能导致
 * 重复发送；在 T-36（同 client_id 去重）实测通过前，结果不明确的发送记 unknown，
 * 暂停自动补发。T-36 通过后可重新评估是否恢复同 client_id 重试。
 * 返回：'sent' | 'failed' | 'unknown'
 */
async function sendOnce(account, to, text, contextToken, clientId, id) {
  try {
    await sendMessage({
      baseUrl: account.baseUrl,
      token: account.token,
      timeoutMs: 15000,
      body: buildTextReq({ to, text, contextToken, clientId }),
    });
    return "sent";
  } catch (e) {
    const emsg = e?.message ?? String(e);
    db.prepare(
      "UPDATE tasks SET error = ?, send_attempts = 1, updated_at = ? WHERE message_id = ?",
    ).run(`${emsg.slice(0, 300)}`, Date.now(), id);
    if (isNetworkError(e)) {
      // 结果不明确：服务端可能已接受。不重试，记 unknown，待人工确认。
      log(
        "ERROR",
        `任务 ${id} 发送结果不明确(网络错误)，未自动重试: ${redact(emsg)}`,
      );
      return "unknown";
    }
    // 服务端明确拒绝（HTTP 非 2xx 或返回体 errcode != 0）→ failed，不重试
    log("ERROR", `任务 ${id} 发送失败(服务端拒绝): ${redact(emsg)}`);
    return "failed";
  }
}
/**
 * 清理微信展示层：移除内部实现细节，保留用户可见内容
 * P2 修复：只清理内部生成文件指令与已核实本地附件路径，
 *          不删除用户正文中的正常 URL（含 /home 路径的网址）。
 * - 移除"生成文件：<路径>"（附件已单独发送）
 * - 移除本任务目录下的已核实附件路径
 * - 移除任务协议标记（如"任务<id>回复完毕。"）
 * - 保留普通网址、用户正文
 */
function cleanReplyForWechat(text, taskId, knownFilePaths = []) {
  if (!text) return text;
  let cleaned = text.replace(/^\s*回「[^」\r\n]*」\s*[：:]\s*/, "");
  // 1. 移除"生成文件：<路径>"指令（附件已单独发送）
  cleaned = cleaned.replace(/生成文件：[^\s"'<>\n]*/g, "");
  // 2. 移除已核实的本任务附件路径（精确匹配，不误删 URL）
  for (const fp of knownFilePaths) {
    cleaned = cleaned.split(fp).join("");
  }
  // 3. 移除任务结束标记（已用于归属校验，不展示给用户）
  const marker = markerFor(taskId);
  cleaned = cleaned.replace(marker, "");
  // 4. 清理多余空行和行尾空格
  cleaned = cleaned.replace(/[ \t]+$/gm, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  const result = cleaned.trim();
  // P2：纯文件清理后空文字也要处理，避免发送空消息
  return result;
}

/**
 * 发送文字回复。返回发送结果（不设置任务终态，由调用方统一决定）。
 * @returns "sent" | "failed" | "unknown" | "skipped" | "aborted"
 */
function deliveryOutcome(textResult, files) {
  if (textResult === "aborted") return null;
  if (textResult === "failed" || files.some(r => r.status === "failed")) return "failed";
  if (textResult === "unknown" || files.some(r => r.status !== "ok")) return "unknown";
  if (textResult === "sent") return "sent";
  return textResult === "skipped" && files.length > 0 ? "sent" : "unknown";
}
async function sendReply(account, row, taskSignal, fileResults = []) {
  // 展示层清理：移除内部路径和协议标记（附件已单独发送，不丢失）
  // P2：传入已核实的附件路径，仅清理这些精确路径，不误删 URL
  const knownPaths = extractReturnedFilePath(row.reply_text ?? "", row.message_id);
  let cleanedText = cleanReplyForWechat(row.reply_text ?? "", row.message_id, knownPaths);
  if (fileResults.some(r => r.status !== "ok")) {
    cleanedText = cleanedText.replace(/正在发给你|已经发给你|已发给你|已发送给你|已发送|已发出/g, "已生成");
  }
  // P2：纯文件清理后若文字为空，跳过文字发送（附件已单独发出）
  if (!cleanedText) {
    log("INFO", `任务 ${row.message_id} 文字清理后为空，跳过文字发送（附件已处理）`);
    return "skipped";
  }
  const segments = splitText(cleanedText, 1500);
  const results = [];
  const record = () => db.prepare("UPDATE tasks SET text_send_results = ?, send_receipt = ?, updated_at = ? WHERE message_id = ?")
    .run(JSON.stringify(results), results.length === segments.length && results.every(r => r.status === "sent") ? "sent" : "partial", Date.now(), row.message_id);
  for (let i = 0; i < segments.length; i++) {
    // P2：每段发送前检查 abort，总超时后不新增发送
    if (taskSignal?.aborted) {
      log("WARN", `任务 ${row.message_id} 文字分段 ${i+1}/${segments.length} 前检测到总超时，停止后续分段`);
      // P2 修复：首段已接受时保留真实已接受信息，不覆盖为 aborted
      // 仅当尚未有成功发送记录时才记 aborted
      return "aborted";
    }
    const segClientId =
      segments.length === 1 ? row.client_id : `${row.client_id}:seg${i + 1}`;
    results.push({ client_id: segClientId, status: "pending" });
    record();
    const res = await sendOnce(
      account,
      row.from_user_id,
      segments[i],
      row.context_token,
      segClientId,
      row.message_id,
    );
    results[i].status = res;
    record();
    if (taskSignal?.aborted) return "aborted";
    if (res !== "sent") {
      // 独立记录发送回执（不设置终态，由调用方统一决定）
      db.prepare("UPDATE tasks SET send_receipt = ?, updated_at = ? WHERE message_id = ?")
        .run(res, Date.now(), row.message_id);
      return res; // 'failed' 或 'unknown'
    }
    if (i < segments.length - 1) {
      await sleep(1000); // D14: 段间隔
      // P2：间隔后再次检查
      if (taskSignal?.aborted) {
        log("WARN", `任务 ${row.message_id} 文字分段间隔后检测到总超时，停止后续分段`);
        return "aborted";
      }
    }
  }
  // 全部发送成功：记录回执，不设置终态（由调用方结合文件结果统一决定）
  db.prepare("UPDATE tasks SET send_receipt = ?, updated_at = ? WHERE message_id = ?")
    .run("sent", Date.now(), row.message_id);
  log("INFO", `任务 ${row.message_id} 文字微信接口已接受发送（仅代表接口接受，不代表用户已收到）`);
  return "sent";
}
/** 通知类短消息（超时/纯媒体降级）：同样单次发送，结果不明确仅记日志；返回发送结果 */
async function sendNotice(account, row, text) {
  const res = await sendOnce(
    account,
    row.from_user_id,
    text,
    row.context_token,
    `${row.client_id ?? `wechat-muse:${row.message_id}`}:notice`,
    row.message_id,
  );
  log(
    res === "sent" ? "INFO" : "WARN",
    `任务 ${row.message_id} 通知发送结果: ${res}`,
  );
  return res;
}

// ---------------------------------------------------------------------------
// 任务执行（含总超时包装）
// ---------------------------------------------------------------------------
// 任务总超时 8 分钟：计时起点为 runTask 开始（t0），覆盖 runTaskInner 全流程：
//   媒体处理 → baseline → CLI提交（60s）→ 等待回复（180s）→ 文件回传 → 发送
// 超时可取消卡住的本地子进程/等待并释放队列；回复归属校验、去重、发送失败策略不变
async function runTask(id, account) {
  const taskController = new AbortController();
  const totalTimeoutId = setTimeout(() => {
    taskController.abort();
    log("ERROR", `任务 ${id} 总超时 ${config.task_total_timeout_ms / 1000}s，强制终止`);
  }, config.task_total_timeout_ms);
  try {
    const taskPromise = runTaskInner(id, account, taskController.signal);
    const timeoutPromise = new Promise((_, reject) => {
      const onAbort = () => reject(new Error("task total timeout"));
      if (taskController.signal.aborted) onAbort();
      else taskController.signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([taskPromise, timeoutPromise]);
    if (taskController.signal.aborted) throw new Error("task total timeout");
  } catch (e) {
    if (e.message === "task total timeout") {
      log("ERROR", `任务 ${id} 总超时，标记为 timeout 并释放队列`);
      try {
        // D2 修复：检查是否已被内层处理，避免双重通知
        // A32 附加：用条件更新防止覆盖已完成任务的 sent 状态
        const updated = setStatusIfNotFinal(id, "timeout");
        if (updated) {
          await sendNotice(
            account,
            { ...getTask(id), client_id: `wechat-muse:${id}` },
            "处理超时，请换个问法或稍后重试。",
          ).catch(() => {});
        }
      } catch (ce) {
        log("WARN", `任务 ${id} 超时清理失败: ${ce.message}`);
      }
    } else {
      throw e;
    }
  } finally {
    clearTimeout(totalTimeoutId);
  }
}

async function runTaskInner(id, account, taskSignal) {
  const row = getTask(id);
  if (!row || row.status !== "received" || taskSignal.aborted) return;
  // 延迟测量：各阶段耗时（用户验收要求）
  const t0 = Date.now();
  const tMark = (name) => {
    const t = Date.now();
    log("INFO", `任务 ${id} 计时 ${name}: +${((t - t0) / 1000).toFixed(1)}s`);
    return t;
  };
  setStatus(id, "running");
  const text = row.text ?? "";
  const hasMedia = (row.media_type ?? 0) > 0 && row.media_status === "downloaded";

  if (!text.trim() && !hasMedia) {
    const res = await sendNotice(
      account,
      { ...row, client_id: `wechat-muse:${id}` },
      "暂只支持文字消息，图片/语音/视频/文件暂不处理。",
    );
    setStatusIfNotFinal(id, res); // 通知即本次任务的交付，迟到结果不改终态
    return;
  }

  // 构造给 Muse 的提示词：有媒体用媒体提示词，否则用文字提示词
  let musePrompt;
  let videoFrames = null;
  let videoOverLimit = false;
  let transcription = null;
  if (hasMedia) {
    try {
      const mediaPaths = JSON.parse(row.media_path ?? "[]");
      const mediaInfos = JSON.parse(row.media_info ?? "[]");
      const mediaFiles = mediaPaths.map((p, i) => ({
        type: mediaInfos[i]?.type ?? row.media_type,
        path: p,
        size: mediaInfos[i]?.size ?? 0,
        fileName: mediaInfos[i]?.fileName ?? path.basename(p),
        wechatText: mediaInfos[i]?.wechatText ?? null,
      }));
      const taskDir = path.join(MEDIA_DIR, id);
      // 视频：抽帧
      if (row.media_type === 5 && mediaFiles[0]) {
        const vf = await extractVideoFrames(mediaFiles[0].path, taskDir, taskSignal);
        videoFrames = vf.frames;
        if (vf.overLimit) {
          videoOverLimit = true;
        }
        // 视频音频转写：先用 ffmpeg 提取音轨为 WAV，再 faster-whisper
        try {
          const audioPath = path.join(taskDir, "video_audio.wav");
          await execFileAsync("ffmpeg", [
            "-y", "-i", mediaFiles[0].path,
            "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", audioPath,
          ], { timeout: 60000, signal: taskSignal });
          transcription = await transcribeVoice(audioPath, null, taskSignal);
        } catch (e) {
          log("WARN", `视频音轨提取失败: ${e.message}`);
        }
      }
      // 语音：优先微信服务端转写（media_info.wechatText），无则 faster-whisper
      if (row.media_type === 3 && mediaFiles[0]) {
        transcription = await transcribeVoice(mediaFiles[0].path, mediaFiles[0].wechatText ?? null, taskSignal);
        if (taskSignal.aborted) return;
        if (!transcription) {
          await sendNotice(
            account,
            { ...row, client_id: `wechat-muse:${id}` },
            "语音转写不可用，无法处理这条语音消息。",
          );
          setStatusIfNotFinal(id, "failed", { error: "语音转写不可用" });
          return;
        }
      }
      musePrompt = buildMediaPrompt(mediaFiles, text, id, videoFrames, transcription, videoOverLimit);
      log("INFO", `任务 ${id} 使用媒体提示词 (${mediaFiles.length} 个附件)`);
    } catch (e) {
      if (taskSignal.aborted) return;
      const errMsg = `附件处理失败：${e.message}。请稍后重试或发送文字消息。`;
      log("ERROR", `任务 ${id} ${errMsg}`);
      try {
        await sendNotice(account, { ...row, client_id: `wechat-muse:${id}` }, errMsg);
      } catch (ne) {
        log("WARN", `任务 ${id} 失败通知发送失败: ${ne.message}`);
      }
      setFailed(id, `媒体处理失败: ${e.message}`);
      return;
    }
  } else {
    // 纯文本任务也建任务目录：Muse 生成的文件必须落在这里才能被回传微信
    fs.mkdirSync(path.join(MEDIA_DIR, id), { recursive: true, mode: 0o700 });
    musePrompt = buildMuseText(text, id);
  }

  // 修复4：个人偏好（用 row.from_user_id，不是未定义的 from）
  try {
    const acctId = account.accountId ?? 'default';
    const prefs = getUserPrefs(acctId, row.from_user_id);
    musePrompt += prefsToPromptFields(prefs);
  } catch (e) {
    log("WARN", `偏好加载失败: ${e.message}`);
  }

  // R2: 媒体处理完成后检查，已超时则不再提交 Muse
  if (taskSignal.aborted) {
    log("WARN", `任务 ${id} 媒体处理后已总超时，不再提交 Muse`);
    return;
  }

  const clientId = `wechat-muse:${id}`;
  db.prepare(
    "UPDATE tasks SET client_id = ?, updated_at = ? WHERE message_id = ?",
  ).run(clientId, Date.now(), id);

  // baseline（发送前 history 最大 seq；失败则任务记 failed，不静默丢）
  let baseline;
  try {
    baseline = await getMaxSeq(taskSignal);
  } catch (e) {
    if (taskSignal.aborted) return;
    setFailed(id, e.message);
    return;
  }
  if (taskSignal.aborted) return;
  db.prepare(
    "UPDATE tasks SET muse_baseline_seq = ?, spawned_at = ?, updated_at = ? WHERE message_id = ?",
  ).run(baseline, Date.now(), Date.now(), id);
  const t1 = tMark("baseline_done");

  // 提交给 Muse（参数数组，不拼 shell；-- 防 - 开头文本被误解析）
  // 注意：--wait 不能为 0。实测 send --wait 0（发后即忘）CLI 退出太快，
  // 服务端丢弃未处理完的 stream，消息 4/4 丢失且 history 无记录；
  // --wait 8/25 均正常送达。此处用 --wait 30 保活连接确保注册，
  // CLI 若提前拿到回复会直接返回，否则 30s 后由桥接自轮询继续等。
  try {
    const out = await execFileAsync(
      config.muse_cli_path,
      [
        "send",
        "--thread",
        config.weixin_session_id,
        "--wait",
        "30",
        "--",
        musePrompt,
      ],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024, signal: taskSignal },
    );
    let streamSid = null;
    let cliReply = null;
    let cliNote = null;
    try {
      const parsed = JSON.parse(out.stdout);
      streamSid = parsed?.stream ?? null;
      cliReply = parsed?.reply ?? null;
      cliNote = parsed?.note ?? null;
    } catch {
      /* 非 JSON 按失败处理 */
    }
    if (!out.stdout.trim().startsWith("{") || streamSid === null) {
      throw new Error(`muse-cli 输出非预期 JSON: ${out.stdout.slice(0, 200)}`);
    }
    db.prepare(
      "UPDATE tasks SET muse_stream_sid = ?, updated_at = ? WHERE message_id = ?",
    ).run(String(streamSid), Date.now(), id);
    // 埋点：记录 CLI --wait 是否在限时内找到回复（用于定位 30s 超时原因）
    if (cliReply) {
      log("INFO", `任务 ${id} CLI 在等待期内找到回复`);
    } else {
      log("INFO", `任务 ${id} CLI 等待超时未找到回复: ${cliNote || "无"}`);
    }
    log("INFO", `任务 ${id} 已提交 muse-cli`);
    tMark("cli_send_done");
  } catch (e) {
    if (taskSignal.aborted) return;
    setFailed(id, `muse-cli send 失败: ${redact(e.stderr || e.message)}`);
    return;
  }

  const reply = await waitForReply(id, baseline, taskSignal);
  const t3 = tMark("reply_found");
  // R1/D1: 总超时后后台任务必须停止，不能再发送或修改状态
  if (taskSignal.aborted) {
    log("WARN", `任务 ${id} 已总超时，停止后续处理（不发送、不改状态）`);
    return;
  }
  if (reply.stopped) {
    log("WARN", `任务 ${id} 等待被中断，保持 running 待重启恢复`);
    return;
  }
  if (reply.unknown) {
    setStatusIfNotFinal(id, "unknown", { error: "history 查询持续失败，无法判定" });
    return;
  }
  if (reply.timeout) {
    const updated = setStatusIfNotFinal(id, "timeout");
    if (!updated || taskSignal.aborted) return;
    // 超时后迟到的回复不再被认领：baseline 推到当前 max seq
    db.prepare(
      "UPDATE tasks SET muse_baseline_seq = ?, updated_at = ? WHERE message_id = ?",
    ).run(reply.maxSeq ?? baseline, Date.now(), id);
    await sendNotice(
      account,
      { ...getTask(id), client_id: clientId },
      "处理超时，请换个问法或稍后重试。",
    );
    return;
  }
  db.prepare(
    "UPDATE tasks SET reply_text = ?, status = ?, updated_at = ? WHERE message_id = ?",
  ).run(reply.text, "replied", Date.now(), id);
  log(
    "INFO",
    `任务 ${id} 取得最终回复 (via=${reply.via}, ${reply.text.length}字)`,
  );
  // 附件任务：检查 Muse 是否生成/修改了文件需要回传
  // 注意：修改指令可能是纯文字消息（media_type=0），但 Muse 生成了文件；
  // 因此不以 media_type 为 gate，改为直接检查回复中的"生成文件："路径。
  // 路径归属由 extractReturnedFilePath + isPathInTaskDir 校验（必须在当前任务目录内）。
  // 文件结果跟踪：ok / failed / unknown（网络错误→unknown，复用 isNetworkError）
  // R1: 总超时后跳过文件回传，避免后台迟发
  if (taskSignal.aborted) {
    log("WARN", `任务 ${id} 已总超时，跳过文件回传`);
    return;
  }
  const fileResults = [];
  const recordFiles = () => db.prepare("UPDATE tasks SET file_send_results = ?, updated_at = ? WHERE message_id = ?")
    .run(JSON.stringify(fileResults), Date.now(), id);
  recordFiles();
  {
    const returnedFiles = extractReturnedFilePath(reply.text, id);
    if (returnedFiles.length > 0) {
      log("INFO", `任务 ${id} 检测到 ${returnedFiles.length} 个回传文件`);
      const row = getTask(id);
      for (const fp of returnedFiles) {
        // R1: 每个文件迭代开始检查，中止则 break（在途的本次发送按实际响应记账，不盲重试）
        if (taskSignal.aborted) {
          log("WARN", `任务 ${id} 文件循环中检测到总超时，停止后续文件`);
          break;
        }
        const result = { file: path.basename(fp), status: "pending" };
        fileResults.push(result);
        recordFiles();
        try {
          // 判断文件类型：图片用图片发送，其他用文件发送
          const ext = path.extname(fp).toLowerCase();
          const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext);
          await sendMediaReply(
            account,
            row.from_user_id,
            row.context_token,
            id,
            fp,
            isImage ? 2 : 4,
            "文件已生成。",
            taskSignal,
          );
          result.status = "ok";
        } catch (e) {
          const st = isNetworkError(e) ? "unknown" : "failed";
          log("ERROR", `任务 ${id} 文件回传${st === "unknown" ? "结果未知" : "失败"}: ${path.basename(fp)} - ${redact(e.message)}`);
          result.status = st;
          result.error = redact(e.message).slice(0, 200);
        }
        recordFiles();
      }
    }
  }
  // R1: 发送文字前再次检查（文件回传循环可能耗时）
  if (taskSignal.aborted) {
    log("WARN", `任务 ${id} 已总超时，跳过文字发送`);
    return;
  }
  // P2 修复：sendReply 返回结果不设终态，调用方结合文件结果统一决定最终状态
  const textResult = await sendReply(account, getTask(id), taskSignal, fileResults);
  if (taskSignal.aborted) return;
  const outcome = deliveryOutcome(textResult, fileResults);
  if (outcome) {
    db.prepare("UPDATE tasks SET send_receipt = ?, updated_at = ? WHERE message_id = ?")
      .run(outcome, Date.now(), id);
    const errors = fileResults.filter(r => r.status !== "ok").map(r => `${r.file}: ${r.status}`).join("、");
    setStatusIfNotFinal(id, outcome, errors ? { error: `附件交付: ${errors}` } : outcome === "unknown" ? { error: "交付结果不明确，不自动重发" } : {});
  }
  // 文件结果影响最终状态：不能仅因文字成功就记为完成
  const failedFiles = fileResults.filter((r) => r.status === "failed");
  // P2：统一收尾决定最终 status
  // 优先级：timeout（已由外层处理）> 文件失败 > 文字失败 > 全部成功
  if (failedFiles.length > 0) {
    const names = failedFiles.map((r) => r.file).join("、");
    const errmsg = `文件回传失败: ${names}`;
    // 条件更新，防止覆盖已标记的 timeout
    log("ERROR", `任务 ${id} ${errmsg}`);
    // 明确告知用户文字已发但文件未发出（措辞按实际状态，不假称全部成功）
    try {
      const textNote = textResult === "sent" ? "文字回复已发送，但" : "";
      await sendNotice(
        account,
        { ...getTask(id), client_id: `wechat-muse:${id}` },
        `${textNote}以下文件未能发出：${names}。请确认后再请求处理。`,
      );
    } catch (ne) {
      log("WARN", `任务 ${id} 文件失败通知发送失败: ${ne.message}`);
    }
  }
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  log("INFO", `任务 ${id} 全程耗时: ${total}s (入库→baseline→CLI→回复→发送)`);
}

async function handleMessage(msg, account) {
  // D1: 去重键只能是原始消息 ID（字符串）；绝不用文本/context_token 代替
  const id = msg.message_id_str ?? msg.item_list?.[0]?.msg_id ?? null;
  if (!id || typeof id !== "string") {
    log("WARN", "收到无原始消息 ID 的消息，跳过");
    return;
  }
  const from = msg.from_user_id ?? "";
  if (from !== config.ilink_user_id) {
    log("INFO", `忽略非绑定用户消息 from=${from.slice(0, 12)}…`);
    return;
  }
  const text = sdkInbound.bodyFromItemList(msg.item_list);
  const contextToken = msg.context_token ?? null;
  // CR-06: context_token 加入脱敏表（纵深防御；数组设上限防长期运行膨胀）
  if (contextToken && secrets.length < 200) secrets.push(contextToken);
  // 附件检测：从 item_list 提取媒体项
  const mediaItems = extractMediaItems(msg.item_list);
  const hasMedia = mediaItems.length > 0;
  const now = Date.now();
  const trimmed = text.trim();
  const accountId = account.accountId ?? 'default';
  const commandKind = /^(?:最近文件$|找文件\s|再发文件\s|把(?:昨天|今天)|提醒|取消提醒\s|取消待办\s|待办|todo\s|完成\s|偏好|重试(?:最近失败任务)?$)/i.test(trimmed) ? 'daily' : null;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO tasks(message_id, status, from_user_id, text, context_token, created_at, updated_at, account_id, command_kind)
     VALUES (?, 'received', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, from, text, contextToken, now, now, accountId, commandKind);
  if (r.changes === 0) {
    log("INFO", `重复消息，已跳过 message_id=${id}`);
    return;
  }
  log("INFO", `收到消息 message_id=${id} 文本长度=${text.length} 媒体数=${mediaItems.length}`);

  // 持久化最新 context_token（用于提醒）
  if (contextToken) saveUserContext(accountId, from, contextToken);

  // ===== 修复3：先处理取消类命令，避免与到期补送竞态 =====
  const cancelRemMatch0 = trimmed.match(/^取消提醒\s+(\d+)$/);
  if (cancelRemMatch0) {
    const ok = cancelReminder(accountId, from, parseInt(cancelRemMatch0[1]));
    const reply = ok ? `已取消 ${cancelRemMatch0[1]} 号提醒。` : `没找到 ${cancelRemMatch0[1]} 号提醒。`;
    const res = await sendTextDirect(account, from, contextToken, id, 'cancel-reminder', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }
  const cancelTodoMatch0 = trimmed.match(/^取消待办\s+(\d+)$/);
  if (cancelTodoMatch0) {
    const ok = cancelTodo(accountId, from, parseInt(cancelTodoMatch0[1]));
    const reply = ok ? `已取消 ${cancelTodoMatch0[1]} 号待办。` : `没找到 ${cancelTodoMatch0[1]} 号待办。`;
    const res = await sendTextDirect(account, from, contextToken, id, 'cancel-todo', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  // ===== 修复3/②：补送到期提醒（条件 claim） =====
  // 注意：取消类已在上面处理，避免竞态
  try {
    const overdue = getOverdueReminders(accountId, from);
    if (overdue.length > 0 && contextToken) {
      for (const rem of overdue) {
        // ②修复：条件 claim，防并发
        const claimed = db.prepare(
          `UPDATE reminders SET status = 'sending'
           WHERE id = ? AND status IN ('pending', 'waiting_context')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
        ).run(rem.id, Date.now());
        if (claimed.changes !== 1) continue;

        const testMark = rem.is_test ? '[测试] ' : '';
        const text = `${testMark}提醒时间到：${rem.text}`;
        const clientId = `${id}:reminder:${rem.id}`;
        const res = await sendOnce(account, from, text, contextToken, clientId, id);
        if (res === 'sent') {
          markReminderSent(rem.id);
        } else if (res === 'failed') {
          markReminderFailed(rem.id, false);
        } else {
          markReminderFailed(rem.id, true);
        }
      }
    }
    // ②修复：unknown 状态说明（只发一次，保留 unknown）
    const unknowns = getUnknownRemindersNeedingNotice(accountId, from);
    if (unknowns.length > 0 && contextToken) {
      for (const rem of unknowns) {
        const text = `之前有个提醒可能已发送（网络不确定）：${rem.text}。如需重设请告诉我。`;
        const clientId = `${id}:reminder-unknown:${rem.id}`;
        const result = await sendOnce(account, from, text, contextToken, clientId, id);
        // 标记已通知，保留 unknown 状态
        if (result !== 'failed') db.prepare(`UPDATE reminders SET unknown_noticed = 1 WHERE id = ?`).run(rem.id);
      }
    }
  } catch (e) {
    log("WARN", `补送提醒失败`);
  }

  // ===== 资料找回命令 =====
  if (trimmed === '最近文件') {
    const files = listRecentFiles(accountId, from, 10);
    const reply = files.length
      ? `最近的文件：\n${formatFileList(files)}\n\n回复"再发文件 编号"可重新发送。`
      : "你还没有收发过文件。";
    const res = await sendTextDirect(account, from, contextToken, id, 'list-files', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  const searchMatch = trimmed.match(/^找文件\s+(.+)$/);
  if (searchMatch) {
    const keyword = searchMatch[1].trim();
    if (!keyword) {
      const reply = "请告诉我要找什么文件，例如：找文件 报告";
      const res = await sendTextDirect(account, from, contextToken, id, 'search-files', reply);
      setStatus(id, res);
      return;
    }
    const files = searchFiles(accountId, from, keyword, 10);
    const reply = files.length
      ? `找到 ${files.length} 个相关文件：\n${formatFileList(files)}\n\n回复"再发文件 编号"可重新发送。`
      : `没找到包含"${keyword}"的文件。试试"最近文件"看看。`;
    const res = await sendTextDirect(account, from, contextToken, id, 'search-files', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  // 修复7：口语 "把昨天那份表格再发我" / "把今天的图片再发我"
  const oralMatch = trimmed.match(/^把(昨天|今天)的?(.+?)(再发我|发我|重发)$/);
  if (oralMatch) {
    const dateDesc = oralMatch[1];
    const typeDesc = oralMatch[2].trim().replace(/^(?:那份|这份|那个|这个|一份|的)/, '');
    // 类型映射到扩展名
    const typeMap = {
      '表格': ['.xlsx', '.xls', '.csv'],
      '文档': ['.docx', '.doc', '.pdf', '.txt'],
      '图片': ['.jpg', '.jpeg', '.png', '.gif'],
      '视频': ['.mp4', '.mov'],
    };
    const exts = typeMap[typeDesc];
    if (!exts) {
      const reply = `我理解你要找${dateDesc}的${typeDesc}，但我只支持表格/文档/图片/视频。试试"找文件 关键词"。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'oral-search', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    const files = searchFilesByDateAndType(accountId, from, dateDesc, exts, 10);
    if (files.length === 0) {
      const reply = `没找到${dateDesc}的${typeDesc}文件。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'oral-search', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    if (files.length === 1) {
      // 唯一匹配：直接发送
      const f = files[0];
      const full = getFileByShortId(accountId, from, f.short_id);
      const safePath = verifyFilePath(full.file_path, accountId, from, full.original_task_id);
      if (!safePath) {
        const reply = `文件"${f.file_name}"已不存在，无法发送。`;
        const res = await sendTextDirect(account, from, contextToken, id, 'oral-resend', reply);
        setStatus(id, res, { reply_text: reply });
        return;
      }
      try {
        const taskSignal = AbortSignal.timeout(8 * 60 * 1000);
        await sendMediaReply(account, from, contextToken, id, safePath, 0, `按你的要求重新发送：${f.file_name}`, taskSignal, full.original_task_id);
        db.prepare(`UPDATE tasks SET file_send_results = ?, send_receipt = ? WHERE message_id = ?`)
          .run(JSON.stringify([{name:f.file_name,status:'sent',at:Date.now()}]),'file:sent',id);
        setStatus(id, 'sent');
      } catch (e) {
        const status = isNetworkError(e) ? 'unknown' : 'failed';
        db.prepare(`UPDATE tasks SET file_send_results = ?, send_receipt = ? WHERE message_id = ?`)
          .run(JSON.stringify([{name:f.file_name,status,at:Date.now()}]),`file:${status}`,id);
        const reply = `发送失败，请稍后重试。`;
        if (status === 'failed') await sendTextDirect(account, from, contextToken, id, 'oral-resend-fail', reply);
        setStatus(id, status);
      }
      return;
    }
    // 修复7：不唯一 → 列候选，不猜
    const reply = `找到 ${files.length} 个${dateDesc}的${typeDesc}，请指定编号：\n${formatFileList(files)}`;
    const res = await sendTextDirect(account, from, contextToken, id, 'oral-candidates', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  const resendMatch = trimmed.match(/^再发文件\s+(\d+)$/);
  if (resendMatch) {
    const shortId = resendMatch[1];
    const file = getFileByShortId(accountId, from, shortId);
    if (!file) {
      const reply = `没找到编号为 ${shortId} 的文件。回复"最近文件"查看列表。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'resend-notfound', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    // 修复6：带归属验证
    const safePath = verifyFilePath(file.file_path, accountId, from, file.original_task_id);
    if (!safePath) {
      const reply = `文件"${file.file_name}"已不存在或已过期，无法重新发送。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'resend-expired', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    try {
      const taskSignal = AbortSignal.timeout(8 * 60 * 1000);
      await sendMediaReply(account, from, contextToken, id, safePath, 0, `重新发送：${file.file_name}`, taskSignal, file.original_task_id);
      db.prepare(`UPDATE tasks SET file_send_results = ?, send_receipt = ? WHERE message_id = ?`)
        .run(JSON.stringify([{name:file.file_name,status:'sent',at:Date.now()}]),'file:sent',id);
      // 修复6：重发成功不重复索引（已存在）
      setStatus(id, 'sent');
    } catch (e) {
      const status = isNetworkError(e) ? 'unknown' : 'failed';
      db.prepare(`UPDATE tasks SET file_send_results = ?, send_receipt = ? WHERE message_id = ?`)
        .run(JSON.stringify([{name:file.file_name,status,at:Date.now()}]),`file:${status}`,id);
      // 修复5：自然语言，不漏路径
      const reply = `重新发送失败，请稍后重试。`;
      if (status === 'failed') await sendTextDirect(account, from, contextToken, id, 'resend-fail', reply);
      setStatus(id, status);
    }
    return;
  }

  // ===== 提醒命令（修复1：needClarify 时不落库） =====
  const remindMatch = trimmed.match(/^(?:提醒我|提醒)\s*(.*)$/);
  if (remindMatch) {
    const rest = remindMatch[1].trim();
    const timePatterns = [
      /^(\d+\s*分钟后)(.+)/, /^(\d+\s*小时后)(.+)/,
      /^((?:明天|今天)\s*(?:上午|下午|晚上)?\s*\d{1,2}\s*点(?:\s*\d{1,2}\s*分?)?)(.+)/,
      /^(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})(.+)/,
    ];
    let timeStr = null, content = null;
    for (const pat of timePatterns) {
      const m = rest.match(pat);
      if (m) { timeStr = m[1].trim(); content = m[2].trim(); break; }
    }
    if (!timeStr || !content) {
      const reply = "请这样说：提醒我 10分钟后 开会\n或：提醒我 明天上午9点 交报告";
      const res = await sendTextDirect(account, from, contextToken, id, 'remind-help', reply);
      setStatus(id, res);
      return;
    }
    const parsed = parseReminderTime(timeStr);
    if (!parsed) {
      const reply = `没理解时间"${timeStr}"，请换个说法，例如"10分钟后"或"明天下午3点"。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'remind-parse-fail', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    // 修复1：过去时间拒绝
    if (parsed.isPast) {
      const reply = `这个时间已经过去了，请说一个未来的时间。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'remind-past', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    // 修复1：needClarify 时直接澄清，不落库
    if (parsed.needClarify) {
      const timeDesc = new Date(parsed.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const reply = `你说的是${timeDesc}吗？请明确上午/下午，例如"明天下午3点"，我再帮你设置。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'remind-clarify', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    const rid = createReminder(accountId, from, content, parsed.timestamp, contextToken);
    const timeDesc = new Date(parsed.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const reply = `好的，已设置提醒（${rid}号）：\n${content}\n时间：${timeDesc}`;
    const res = await sendTextDirect(account, from, contextToken, id, 'remind-created', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  // 待办命令
  const todoMatch = trimmed.match(/^(?:待办|todo)\s+(.+)$/i);
  if (todoMatch) {
    const content = todoMatch[1].trim();
    if (!content) {
      const res = await sendTextDirect(account, from, contextToken, id, 'todo-help', "请告诉我待办内容，例如：待办 买牛奶");
      setStatus(id, res);
      return;
    }
    const tid = createTodo(accountId, from, content);
    const reply = `已记录待办（${tid}号）：${content}\n\n完成后回复"完成 ${tid}"，取消回复"取消待办 ${tid}"。`;
    const res = await sendTextDirect(account, from, contextToken, id, 'todo-created', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  if (trimmed === '提醒列表') {
    const rems = listReminders(accountId, from);
    const reply = rems.length
      ? `待发送的提醒：\n` + rems.map(r => {
          const t = new Date(r.remind_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
          const test = r.is_test ? '[测试]' : '';
          const st = r.status === 'unknown' ? '(可能已发送)' : r.status === 'waiting_context' ? '(等待发送)' : '';
          return `${r.id}. ${test}${r.text}（${t}）${st}`;
        }).join('\n') + `\n\n回复"取消提醒 编号"可取消。`
      : "没有待发送的提醒。";
    const res = await sendTextDirect(account, from, contextToken, id, 'list-reminders', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }
  if (trimmed === '待办列表') {
    const todos = listTodos(accountId, from);
    const reply = todos.length
      ? `待办事项：\n` + todos.map(t => `${t.id}. ${t.text}`).join('\n') + `\n\n回复"完成 编号"标记完成，"取消待办 编号"取消。`
      : "没有待办事项。";
    const res = await sendTextDirect(account, from, contextToken, id, 'list-todos', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  const doneMatch = trimmed.match(/^完成\s+(\d+)$/);
  if (doneMatch) {
    const ok = completeTodo(accountId, from, parseInt(doneMatch[1]));
    const reply = ok ? `好的，第 ${doneMatch[1]} 号待办已完成。` : `没找到 ${doneMatch[1]} 号待办。`;
    const res = await sendTextDirect(account, from, contextToken, id, 'complete-todo', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  // ===== 修复8：重试最近失败任务 =====
  if (trimmed === '重试最近失败任务' || trimmed === '重试') {
    const lastFailed = getLastFailedTask(accountId, from);
    if (!lastFailed) {
      const reply = "没有可重试的失败任务。";
      const res = await sendTextDirect(account, from, contextToken, id, 'retry-none', reply);
      setStatus(id, res, { reply_text: reply });
      return;
    }
    const newId = `${id}:retry`;
    const result = await retryFailedTask(account, from, contextToken, newId, lastFailed.message_id);
    if (!result.ok) {
      const res = await sendTextDirect(account, from, contextToken, id, 'retry-fail', result.reason);
      setStatus(id, res, { reply_text: result.reason });
      return;
    }
    const progress = new ProgressNotifier(account, from, contextToken, result.newId);
    try {
      const reply = `正在重试上次失败的任务。`;
      const res = await sendTextDirect(account, from, contextToken, id, 'retry-created', reply);
      setStatus(id, res, { reply_text: reply });
      progress.start();
      await runTask(result.newId, account);
    } finally {
      progress.stop();
      retryInProgress.delete(lastFailed.message_id);
    }
    return;
  }

  // ===== 个人偏好命令（修复4：完整 output_format） =====
  if (trimmed === '偏好查看') {
    const p = getUserPrefs(accountId, from);
    const brevityDesc = { brief: '简短', normal: '标准', detailed: '详细' }[p.brevity];
    const formatDesc = p.output_format ? { text: '纯文本', markdown: 'Markdown', list: '列表' }[p.output_format] : '未设置';
    const indexDesc = p.index_retention ? '开（会索引收发的文件）' : '关（不再索引新文件，已有保留）';
    const reply = `你的偏好设置：\n回复风格：${brevityDesc}\n输出格式：${formatDesc}\n微信桥资料索引保留：${indexDesc}\n\n修改方法：\n- 偏好 简短 / 偏好 详细 / 偏好 标准\n- 偏好 纯文本 / 偏好 Markdown / 偏好 列表\n- 偏好 索引开 / 偏好 索引关`;
    const res = await sendTextDirect(account, from, contextToken, id, 'prefs-view', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }
  const prefMatch = trimmed.match(/^偏好\s+(简短|详细|标准|纯文本|Markdown|列表|索引开|索引关)$/);
  if (prefMatch) {
    const opt = prefMatch[1];
    let ok = false, desc = '';
    if (opt === '简短') { ok = setUserPref(accountId, from, 'brevity', 'brief'); desc = '回复风格已设为简短'; }
    else if (opt === '详细') { ok = setUserPref(accountId, from, 'brevity', 'detailed'); desc = '回复风格已设为详细'; }
    else if (opt === '标准') { ok = setUserPref(accountId, from, 'brevity', 'normal'); desc = '回复风格已设为标准'; }
    else if (opt === '纯文本') { ok = setUserPref(accountId, from, 'output_format', 'text'); desc = '输出格式已设为纯文本'; }
    else if (opt === 'Markdown') { ok = setUserPref(accountId, from, 'output_format', 'markdown'); desc = '输出格式已设为 Markdown'; }
    else if (opt === '列表') { ok = setUserPref(accountId, from, 'output_format', 'list'); desc = '输出格式已设为列表'; }
    else if (opt === '索引开') { ok = setUserPref(accountId, from, 'index_retention', 1); desc = '微信桥资料索引已开启'; }
    else if (opt === '索引关') { ok = setUserPref(accountId, from, 'index_retention', 0); desc = '微信桥资料索引已关闭，不再索引新文件（已有索引保留，不删除）'; }
    const reply = ok ? desc : '设置失败，请重试。';
    const res = await sendTextDirect(account, from, contextToken, id, 'prefs-set', reply);
    setStatus(id, res, { reply_text: reply });
    return;
  }

  // ===== 长任务进度通知（修复9：try/finally 全覆盖） =====
  const progress = new ProgressNotifier(account, from, contextToken, id);
  progress.start();
  try {
    // 有媒体：先下载，再执行任务（进度覆盖下载阶段）
    if (hasMedia) {
      setStatus(id, "received", { media_status: "pending" });
      try {
        const downloaded = await downloadMedia(id, mediaItems, account);
        const primaryType = downloaded[0]?.type ?? 0;
        setStatus(id, "received", {
          media_type: primaryType,
          media_path: JSON.stringify(downloaded.map((d) => d.path)),
          media_info: JSON.stringify(downloaded.map((d) => ({
            type: d.type, fileName: d.fileName, size: d.size,
            wechatText: d.wechatText ?? null,
          }))),
          media_status: "downloaded",
        });
        log("INFO", `任务 ${id} 媒体下载完成，共 ${downloaded.length} 个`);
        // 资料找回：索引收到的文件（含 original_task_id，尊重索引开关）
        try {
          const taskFrom = getTask(id)?.from_user_id ?? from;
          const acctId = account.accountId ?? 'default';
          if (shouldIndexFile(acctId, taskFrom)) {
            for (const d of downloaded) {
              if (d.path && d.fileName) {
                indexFile(acctId, taskFrom, d.fileName, d.path, 'inbound', id);
              }
            }
          }
        } catch (e) {
          log("WARN", `文件索引失败: ${e.message}`);
        }
      } catch (e) {
        setStatus(id, "failed", {
          media_status: "failed",
          error: `媒体下载失败`,
        });
        // 固定自然语言，不漏 e.message 路径
        await sendNotice(
          account,
          { ...getTask(id), client_id: `wechat-muse:${id}` },
          `附件下载失败，请重试。`,
        );
        return;
      }
    }
    await runTask(id, account);
  } finally {
    progress.stop(); // 终态后不再发送通知
  }
}

// ---------------------------------------------------------------------------
// 启动恢复（DESIGN.md §7）
// ---------------------------------------------------------------------------
async function recoverOnStartup(account) {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('received','running','replied') ORDER BY created_at`,
    )
    .all();
  if (!rows.length) {
    log("INFO", "无需要恢复的中间态任务");
    return;
  }
  log("INFO", `启动恢复：${rows.length} 个中间态任务`);
  for (const row of rows) {
    if (stopping) break;
    if (row.account_id && row.account_id !== account.accountId) continue;
    try {
      if (row.status === "received") {
        if (row.command_kind) {
          setStatus(row.message_id,'unknown',{error:'重启时命令执行进度不明确，请先查看列表或偏好；不自动重复操作。'});
          continue;
        }
        // 媒体任务：检查是否已下载完成
        if ((row.media_type ?? 0) > 0 && row.media_status !== "downloaded") {
          // 下载未完成且原始消息已丢失，无法恢复
          setStatus(row.message_id, "failed", {
            error: "重启时媒体未下载完成，原始消息已丢失，无法恢复",
          });
          log("WARN", `恢复 received→媒体未下载，标记失败 ${row.message_id}`);
        } else {
          log("INFO", `恢复 received→重跑 ${row.message_id}`);
          await runTask(row.message_id, account);
        }
      } else {
        // A crash can occur after the gateway accepted a segment/file but before
        // the local receipt commit. Gateway client-id dedup has not been verified.
        // Preserve any output/receipts and require confirmation instead of replay.
        if (row.status === "running") {
          const events = await getHistoryRaw(50).catch(() => null);
          const marked = events ? findMarkedReply(events, row.muse_baseline_seq ?? 0, row.message_id) : null;
          if (marked) db.prepare("UPDATE tasks SET reply_text = ?, updated_at = ? WHERE message_id = ?")
            .run(stripMarker(marked.text, row.message_id), Date.now(), row.message_id);
        }
        setStatusIfNotFinal(row.message_id, "unknown", { error: "重启时发送进度不明确，保留结果与回执，不自动重发" });
      }
    } catch (e) {
      log("ERROR", `恢复任务 ${row.message_id} 异常: ${redact(e.message)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let stopping = false;
const loopAbort = new AbortController();
/* ===== 修复2：后台提醒调度器（单进程防重入） ===== */
let schedulerTimer = null;

function startReminderScheduler(account) {
  if (schedulerTimer) return; // 防重入
  recoverRemindersOnStartup();
  schedulerTimer = setInterval(async () => {
    if (stopping || reminderSchedulerRunning) return;
    reminderSchedulerRunning = true;
    try {
      const due = getDueReminders(account.accountId ?? 'default');
      for (const rem of due) {
        if (stopping) break;
        // ②修复：条件 UPDATE claim，检查 changes=1 防并发重复
        const claimed = db.prepare(
          `UPDATE reminders SET status = 'sending' WHERE id = ? AND status = 'pending'`
        ).run(rem.id);
        if (claimed.changes !== 1) continue; // 已被其他进程认领
        const token = getUserContext(rem.account_id, rem.sender_id);
        if (!token) {
          db.prepare(`UPDATE reminders SET status = 'waiting_context' WHERE id = ?`)
            .run(rem.id);
          continue;
        }
        const testMark = rem.is_test ? '[测试] ' : '';
        const text = `${testMark}提醒时间到：${rem.text}`;
        const clientId = `reminder:${rem.id}:${Date.now()}`;
        try {
          const res = await sendOnce(account, rem.sender_id, text, token, clientId, `reminder-${rem.id}`);
          if (res === 'sent') markReminderSent(rem.id);
          else if (res === 'failed') markReminderFailed(rem.id, false);
          else markReminderFailed(rem.id, true);
        } catch (e) {
          markReminderFailed(rem.id, true);
        }
      }
    } finally {
      reminderSchedulerRunning = false;
    }
  }, 30000);
  log("INFO", "提醒后台调度器已启动（30s 间隔）");
}

function stopReminderScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    log("INFO", "提醒后台调度器已停止");
  }
}

async function mainLoop(account) {
  const syncBufPath = sdkSyncBuf.getSyncBufFilePath(account.accountId);
  let buf = sdkSyncBuf.loadGetUpdatesBuf(syncBufPath) ?? "";
  log("INFO", `启动长轮询，buf长度=${buf.length}`);
  let backoffMs = 2000;
  while (!stopping) {
    if (isSessionPaused(account.accountId)) {
      const remainS = Math.ceil(getRemainingPauseMs(account.accountId) / 1000);
      log("WARN", `微信会话暂停中（需重新扫码），${remainS}s 后重试`);
      await sleep(Math.min(remainS * 1000, 60000));
      continue;
    }
    let resp;
    try {
      resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: buf,
        timeoutMs: 35000,
        abortSignal: loopAbort.signal,
      });
    } catch (e) {
      log(
        "ERROR",
        `getUpdates 异常: ${redact(e.message)}，${backoffMs}ms 后重试`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
      continue;
    }
    backoffMs = 2000;
    const errcode = resp.errcode ?? resp.ret ?? 0;
    if (errcode === SESSION_EXPIRED_ERRCODE) {
      pauseSession(account.accountId);
      log(
        "ERROR",
        "微信登录态过期 (errcode=-14)，暂停 1 小时，需用户重新扫码登录",
      );
      continue;
    }
    if (errcode !== 0) {
      log(
        "ERROR",
        `getUpdates 业务错误 errcode=${errcode} errmsg=${redact(resp.errmsg)}`,
      );
      await sleep(5000);
      continue;
    }
    // 崩溃安全：先处理本批全部消息（落库去重），再推进游标。
    // 若在处理中途崩溃，buf 未推进，重启后重拉本批；已落库的消息靠 INSERT OR IGNORE 去重，
    // 不会丢失也不会重复执行。绝不能先存 buf 后处理。
    const batchAt = Date.now();
    const n = (resp.msgs ?? []).length;
    if (n > 0) log("INFO", `收到微信消息 ${n} 条`);
    for (const msg of resp.msgs ?? []) {
      if (stopping) break;
      try {
        // 排队耗时：串行处理中，本条消息等待前一条完成的时长（>1s 才记）
        const waitS = (Date.now() - batchAt) / 1000;
        if (waitS > 1)
          log("INFO", `消息开始处理，排队等待 ${waitS.toFixed(1)}s（前序任务阻塞）`);
        await handleMessage(msg, account);
      } catch (e) {
        log("ERROR", `handleMessage 异常: ${redact(e.stack || e.message)}`);
      }
    }
    // D16: buf 生命周期——本批处理完后持久化
    if (!stopping && resp.get_updates_buf) {
      sdkSyncBuf.saveGetUpdatesBuf(syncBufPath, resp.get_updates_buf);
      buf = resp.get_updates_buf;
    }
  }
  log("INFO", "主循环退出");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
let config;
async function main() {
  const cmd = process.argv[2];
  openDb();

  if (cmd === "status") {
    // 只读状态查看（D13）
    const counts = db
      .prepare("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status")
      .all();
    const recent = db
      .prepare(
        `SELECT message_id, status, substr(text,1,40) AS text_head,
              datetime(updated_at/1000, 'unixepoch', 'localtime') AS updated
       FROM tasks ORDER BY updated_at DESC LIMIT 10`,
      )
      .all();
    console.log(JSON.stringify({ counts, recent }, null, 2));
    process.exit(0);
  }

  config = loadConfig();
  if (!acquireSingleInstance()) process.exit(1);
  process.on("SIGTERM", () => {
    log("WARN", "收到 SIGTERM，中断长轮询，当前任务处理完后退出");
    stopping = true;
    loopAbort.abort();
  });
  process.on("SIGINT", () => {
    stopping = true;
    loopAbort.abort();
  });

  try {
    const account = ensureWechatAccount();
    secrets.push(account.token);
    if (!account.configured) throw new Error("微信账号未配置 token");
    // userId 校验已在 ensureWechatAccount() → verifyBoundWechatAccount() 中完成
    // （使用 sdkAccounts.loadWeixinAccount 读取持久化扫码者）
    log(
      "INFO",
      `微信账号就绪 account=${account.accountId} baseUrl=${account.baseUrl}`,
    );
    seedDedup(account);
    await recoverOnStartup(account);
    await warmupMuse();
    startReminderScheduler(account); // 修复2：启动后台调度
    try {
      await mainLoop(account);
    } finally {
      stopReminderScheduler(); // 修复2：退出时停止
    }
  } catch (e) {
    log("ERROR", `桥接异常退出: ${redact(e.stack || e.message)}`);
    process.exitCode = 1;
  } finally {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {
      /* ignore */
    }
  }
}

main();

// 测试导出（不影响生产运行）：纯函数供 node:test 真实加载验证
export {
  parseReminderTime,
  verifyFilePath,
  getUserPrefs,
  setUserPref,
  prefsToPromptFields,
  formatFileList,
  VALID_BREVITY,
  VALID_FORMATS,
};



