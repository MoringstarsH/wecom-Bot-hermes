import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ====== 配置读取 ======
function loadEnv(path = resolve(__dirname, '.env')) {
  if (!existsSync(path)) return;
  // 去掉 Windows 记事本/PowerShell 保存时常见的 UTF-8 BOM，避免首行键名匹配失败
  const text = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (Object.hasOwn(process.env, m[1])) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}
loadEnv();

const BOT_ID = process.env.WECOM_BOT_ID || '';
const BOT_SECRET = process.env.WECOM_BOT_SECRET || '';

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    console.warn(
      `[配置警告] ${name}=${raw} 非法，回退为 ${fallback}（允许范围: ${min}~${max}）`
    );
    return fallback;
  }
  return n;
}

function parseCsvToSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

const SOFT_TIMEOUT_MS = 5 * 60 * 1000;   // 5分钟：状态检查，任务仍在执行
const HARD_TIMEOUT_MS = 15 * 60 * 1000;  // 15分钟：强制中断任务
const SESSION_TTL_MS = parsePositiveInt('SESSION_TTL_MS', 24 * 60 * 60 * 1000, {
  min: 60_000,
  max: 30 * 24 * 60 * 60 * 1000,
});
const ALLOWED_USERIDS = parseCsvToSet(process.env.ALLOWED_USERIDS);
const HERMES_ENABLE_YOLO = parseBoolean(process.env.HERMES_ENABLE_YOLO, false);
const DEFAULT_MEDIA_BASE = resolve(homedir(), '.hermes', 'cache', 'screenshots');
const MEDIA_BASE_DIR = resolve(process.env.MEDIA_BASE_DIR || DEFAULT_MEDIA_BASE);
const MAX_MEDIA_FILE_SIZE_BYTES = parsePositiveInt('MAX_MEDIA_FILE_SIZE_BYTES', 10 * 1024 * 1024, {
  min: 1_024,
  max: 50 * 1024 * 1024,
});
const ALLOWED_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_GLOBAL_CONCURRENCY = parsePositiveInt('MAX_GLOBAL_CONCURRENCY', 15, { min: 1, max: 50 });
const IS_WINDOWS = process.platform === 'win32';
const HERMES_BIN = process.env.HERMES_BIN || (IS_WINDOWS ? 'hermes.cmd' : 'hermes');
const WECOM_STREAM_MAX_BYTES = 20000;

if (!BOT_ID || !BOT_SECRET) {
  console.error('缺少环境变量 WECOM_BOT_ID 或 WECOM_BOT_SECRET');
  process.exit(1);
}

// ====== 动态用户权限管理（users.json） ======
const USERS_FILE = resolve(__dirname, 'users.json');

function generatePairingCode() {
  return randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

let usersData = { admins: [], approved: [], pending: {} };

function loadUsers() {
  if (!existsSync(USERS_FILE)) {
    usersData = {
      admins: Array.from(ALLOWED_USERIDS),
      approved: [],
      pending: {},
    };
    saveUsers();
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
    usersData = {
      admins: Array.isArray(raw.admins) ? raw.admins : [],
      approved: Array.isArray(raw.approved) ? raw.approved : [],
      pending: typeof raw.pending === 'object' && raw.pending !== null ? raw.pending : {},
    };
  } catch (err) {
    console.error('加载 users.json 失败，使用默认管理员列表:', err.message);
    usersData = {
      admins: Array.from(ALLOWED_USERIDS),
      approved: [],
      pending: {},
    };
    saveUsers();
  }
}

function saveUsers() {
  try {
    writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
  } catch (err) {
    console.error('保存 users.json 失败:', err.message);
  }
}

loadUsers();

function isAdmin(userid) {
  return usersData.admins.includes(userid);
}

function isAuthorizedUser(userid) {
  return isAdmin(userid) || usersData.approved.includes(userid);
}

// ====== ANSI 颜色码与边框字符清理工具 ======
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const ANSI_SIMPLE_PATTERN = /\x1B[@-_]/g;
const BOX_DRAWING_PATTERN = /[\u2500-\u257F\u2550-\u256C]/g;
const ORNAMENT_PATTERN = /[\u26a1\u2728\u2b50\u2605\u2606\u25cf\u25cb\u2713\u2714\u2717\u2718]/g;
const BRAILLE_BLANK = /\u2800/g;

function stripFormatting(str) {
  return str
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_SIMPLE_PATTERN, '')
    .replace(BOX_DRAWING_PATTERN, '')
    .replace(ORNAMENT_PATTERN, '')
    .replace(BRAILLE_BLANK, ' ');
}

function truncateForWecom(text, maxBytes = WECOM_STREAM_MAX_BYTES) {
  if (!text) return text || '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const suffix = '\n\n…（内容过长已截断，完整结果请查看本地日志）';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  let end = budget;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.slice(0, end).toString('utf8') + suffix;
}

function isPathInside(baseDir, targetPath) {
  const rel = relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function validateMediaPath(rawPath) {
  const absPath = resolve(__dirname, rawPath);
  if (!existsSync(absPath)) {
    console.log(`[跳过不存在的路径] ${rawPath}`);
    return null;
  }

  let stat;
  try {
    stat = statSync(absPath);
  } catch (err) {
    console.log(`[跳过不可读取的路径] ${rawPath}: ${err.message}`);
    return null;
  }

  if (!stat.isFile()) {
    console.log(`[跳过非文件路径] ${rawPath}`);
    return null;
  }

  if (!isPathInside(MEDIA_BASE_DIR, absPath)) {
    console.log(`[跳过越界媒体路径] ${absPath}`);
    return null;
  }

  const ext = extname(absPath).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
    console.log(`[跳过不支持的媒体格式] ${absPath}`);
    return null;
  }

  if (stat.size > MAX_MEDIA_FILE_SIZE_BYTES) {
    console.log(
      `[跳过过大媒体文件] ${absPath} (${stat.size} bytes > ${MAX_MEDIA_FILE_SIZE_BYTES} bytes)`
    );
    return null;
  }

  return absPath;
}

// ====== 从完整清理输出中提取 MEDIA: 路径（支持折行拼接） ======
function extractMediaPaths(cleanText) {
  const paths = [];
  const lines = cleanText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const idx = line.indexOf('MEDIA:');
    if (idx === -1) continue;

    let path = line.slice(idx + 6).trim();

    const hasExt = /\.(png|jpg|jpeg|gif|webp|bmp|mp4|mov|pdf)$/i.test(path);
    if (!hasExt && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      if (nextLine && !nextLine.startsWith('MEDIA:')) {
        path += nextLine;
      }
    }

    const validatedPath = validateMediaPath(path);
    if (validatedPath) paths.push(validatedPath);
  }

  return paths;
}

// ====== 移除 MEDIA: 标记并清理多余空行 ======
function removeMediaMarkers(text) {
  const lines = text.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('MEDIA:')) {
      const pathPart = line.slice(line.indexOf('MEDIA:') + 6).trim();
      const hasExt = /\.(png|jpg|jpeg|gif|webp|bmp|mp4|mov|pdf)$/i.test(pathPart);
      if (!hasExt && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine && !nextLine.startsWith('MEDIA:')) {
          i++;
        }
      }
      continue;
    }
    result.push(lines[i]);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function dedentCommon(text) {
  const lines = text.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)/);
    const indent = m ? m[1].length : 0;
    if (indent < minIndent) minIndent = indent;
    if (minIndent === 0) break;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return text;
  return lines.map((line) => line.slice(minIndent)).join('\n');
}

function extractHermesReply(raw) {
  const clean = stripFormatting(raw);
  const mediaPaths = extractMediaPaths(clean);

  const sessionMatch = clean.match(/Resume this session with:\s+hermes --resume\s+(\S+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;

  const replyMatch = clean.match(
    /(?:\u2695\s*)?Hermes\s*\n\s*\n([\s\S]*?)\n\s*\n\s*\nResume this session with:/
  );
  let reply = replyMatch ? replyMatch[1] : null;
  if (reply) {
    reply = dedentCommon(reply).trim();
    return { sessionId, reply: removeMediaMarkers(reply), mediaPaths };
  }

  const resumeIndex = clean.lastIndexOf('Resume this session with:');
  if (resumeIndex !== -1) {
    let fallback = clean.slice(0, resumeIndex).trim();
    fallback = fallback.replace(/^(?:\u2695\s*)?Hermes\s*\n+/, '').trim();
    fallback = dedentCommon(fallback).trim();
    if (fallback) return { sessionId, reply: removeMediaMarkers(fallback), mediaPaths };
  }

  const tail = clean.trim();
  if (tail) {
    return { sessionId, reply: removeMediaMarkers(tail.slice(-2000)), mediaPaths };
  }

  return { sessionId: null, reply: null, mediaPaths };
}

// ====== 会话存储（带过期时间的内存缓存） ======
class SessionStore {
  constructor() {
    this.map = new Map();
  }

  get(userid) {
    const rec = this.map.get(userid);
    if (!rec) return null;
    if (Date.now() - rec.ts > SESSION_TTL_MS) {
      this.map.delete(userid);
      return null;
    }
    return rec.sessionId;
  }

  set(userid, sessionId) {
    this.map.set(userid, { sessionId, ts: Date.now() });
  }

  delete(userid) {
    this.map.delete(userid);
  }
}

const userSessions = new SessionStore();

// ====== 用户最近图片缓存（用于图文上下文） ======
const userLastImages = new Map();
const IMAGE_CONTEXT_TTL_MS = 10 * 60 * 1000;

function setUserLastImage(userid, path) {
  userLastImages.set(userid, { path, ts: Date.now() });
}

function getUserLastImage(userid) {
  const rec = userLastImages.get(userid);
  if (!rec) return null;
  if (Date.now() - rec.ts > IMAGE_CONTEXT_TTL_MS) {
    userLastImages.delete(userid);
    return null;
  }
  return rec.path;
}

// ====== 全局并发控制（限制同时运行的 Hermes 进程数量） ======
let activeGlobalCount = 0;
const globalWaitQueue = [];

function acquireGlobalSlot() {
  return new Promise((resolve) => {
    if (activeGlobalCount < MAX_GLOBAL_CONCURRENCY) {
      activeGlobalCount++;
      resolve();
    } else {
      globalWaitQueue.push(resolve);
    }
  });
}

function releaseGlobalSlot() {
  activeGlobalCount--;
  if (globalWaitQueue.length > 0) {
    const next = globalWaitQueue.shift();
    activeGlobalCount++;
    next();
  }
}

// ====== 用户消息队列（保证同一用户消息串行执行） ======
const userQueues = new Map();

async function processQueue(userid) {
  const queue = userQueues.get(userid);
  if (!queue || queue.processing) return;
  queue.processing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      let notifiedWaiting = false;
      try {
        if (activeGlobalCount >= MAX_GLOBAL_CONCURRENCY) {
          await item.context.ws.replyStream(
            item.context.frame,
            generateReqId('stream'),
            '当前请求较多，正在排队，请稍候...',
            true
          );
          notifiedWaiting = true;
        }
        await acquireGlobalSlot();
        if (notifiedWaiting) {
          await item.context.ws.replyStream(
            item.context.frame,
            generateReqId('stream'),
            '排队到你啦，正在做你的请求...',
            false
          );
        }

        const result = await callHermes(userid, item.query, item.context);
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        releaseGlobalSlot();
      }
    }
  } finally {
    queue.processing = false;
    if (queue.length === 0 && userQueues.get(userid) === queue) {
      userQueues.delete(userid);
    }
  }
}

function enqueueHermes(userid, query, context) {
  return new Promise((resolve, reject) => {
    if (!userQueues.has(userid)) userQueues.set(userid, []);
    const queue = userQueues.get(userid);
    queue.push({ query, resolve, reject, context });
    processQueue(userid);
  });
}

// ====== 消息去重（短期缓存 60 秒） ======
const recentMessages = new Map();
const DEDUP_TTL_MS = 60_000;
const MAX_DEDUP_SIZE = 5_000;

function isDuplicate(msgid) {
  if (!msgid) return false;
  const ts = recentMessages.get(msgid);
  if (ts && Date.now() - ts < DEDUP_TTL_MS) return true;
  if (recentMessages.size >= MAX_DEDUP_SIZE) {
    const firstKey = recentMessages.keys().next().value;
    if (firstKey !== undefined) recentMessages.delete(firstKey);
  }
  recentMessages.set(msgid, Date.now());
  return false;
}

const dedupCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of recentMessages) {
    if (now - ts > DEDUP_TTL_MS) recentMessages.delete(id);
  }
}, DEDUP_TTL_MS);
if (typeof dedupCleanupTimer.unref === 'function') dedupCleanupTimer.unref();

class HermesBridgeError extends Error {
  constructor(userMessage, logDetail = '') {
    super(userMessage);
    this.name = 'HermesBridgeError';
    this.userMessage = userMessage;
    this.logDetail = logDetail || userMessage;
  }
}

// ====== 调用本地 Hermes CLI ======
function callHermes(userid, query, context) {
  return new Promise((resolve, reject) => {
    const sessionId = userSessions.get(userid);
    const args = sessionId ? ['--resume', sessionId, 'chat', '-q', query] : ['chat', '-q', query];
    if (HERMES_ENABLE_YOLO) args.push('--yolo');

    const child = spawn(HERMES_BIN, args, {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: IS_WINDOWS && /\.(cmd|bat|ps1)$/i.test(HERMES_BIN),
      windowsHide: true,
    });

    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stdout += d.toString()));

    let softTimeoutFired = false;
    let resolved = false;

    const softTimer = setTimeout(() => {
      softTimeoutFired = true;
      if (context?.ws && context?.frame) {
        context.ws.replyStream(
          context.frame,
          generateReqId('stream'),
          'Hermes 仍在努力执行中，任务尚未完成。\n\n你可以稍后发送「是否执行完毕」来查询结果。',
          true
        ).catch((e) => console.error('软超时状态消息发送失败:', e.message));
      }
    }, SOFT_TIMEOUT_MS);

    const hardTimer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
      if (!resolved) {
        resolved = true;
        reject(
          new HermesBridgeError(
            '任务执行超时（超过15分钟），已被中断，请重新发起任务。',
            `Hermes hard timeout after ${HARD_TIMEOUT_MS}ms for user ${userid}`
          )
        );
      }
    }, HARD_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      if (!resolved) {
        resolved = true;
        reject(
          new HermesBridgeError(
            'Hermes 服务不可用，请联系管理员。',
            `Hermes spawn error for user ${userid}: ${err.message}`
          )
        );
      }
    });

    child.on('close', (code) => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      if (resolved) return;

      const { sessionId: sid, reply, mediaPaths } = extractHermesReply(stdout);

      if (softTimeoutFired && context?.ws && context?.frame && (reply || mediaPaths.length > 0)) {
        // 软超时后任务完成，主动推送结果
        (async () => {
          try {
            if (reply) {
              await context.ws.replyStream(
                context.frame,
                generateReqId('stream'),
                truncateForWecom(reply),
                true
              );
            }
            if (mediaPaths.length > 0) {
              await sendMediaReplies(context.ws, context.frame, mediaPaths);
            }
          } catch (e) {
            console.error('后台结果推送失败:', e.message);
          }
        })();
        resolved = true;
        resolve({ sessionId: sid, reply: '', mediaPaths: [] });
        return;
      }

      if (reply || mediaPaths.length > 0) {
        resolved = true;
        resolve({ sessionId: sid, reply, mediaPaths });
      } else {
        resolved = true;
        const tail = stdout.slice(-800).trim();
        reject(
          new HermesBridgeError(
            'Hermes 返回异常，请稍后重试。',
            `Parse failure (exit code: ${code}) for user ${userid}. Output tail:\n${tail}`
          )
        );
      }
    });
  });
}

// ====== 发送图片消息 ======
async function sendMediaReplies(ws, frame, mediaPaths) {
  for (const path of mediaPaths) {
    try {
      const buffer = readFileSync(path);
      const filename = basename(path);
      const result = await ws.uploadMedia(buffer, { type: 'image', filename });
      await ws.replyMedia(frame, 'image', result.media_id);
    } catch (e) {
      console.error('发送图片失败:', path, e.message);
      await ws.replyStream(frame, generateReqId('stream'), '【图片发送失败】', true);
    }
  }
}

// ====== 企业微信 WebSocket 客户端 ======
const wsClient = new WSClient({
  botId: BOT_ID,
  secret: BOT_SECRET,
  heartbeatInterval: 30_000,
  maxReconnectAttempts: 20,
  maxAuthFailureAttempts: 5,
});

wsClient.on('authenticated', () => {
  console.log(`[${new Date().toISOString()}] 企业微信认证成功`);
});

wsClient.on('message', async (frame) => {
  const body = frame.body;
  const userid = body.from?.userid;
  if (!userid) return;

  // 去重检查：避免网络抖动导致重复处理
  const msgid = body.msgid || body.msg_id || `${userid}-${Date.now()}`;
  if (isDuplicate(msgid)) {
    console.log(`[${new Date().toISOString()}] 忽略重复消息 ${msgid}`);
    return;
  }

  // ====== 动态配对：未授权用户 ======
  if (!isAuthorizedUser(userid)) {
    let code = usersData.pending[userid];
    if (!code) {
      code = generatePairingCode();
      usersData.pending[userid] = code;
      saveUsers();
    }
    console.warn(`[${new Date().toISOString()}] 未授权用户请求配对: ${userid}, code=${code}`);
    try {
      await wsClient.replyStream(
        frame,
        generateReqId('stream'),
        `你还没有权限使用此机器人。\n\n配对码：${code}\n请让管理员发送 /approve ${code} 来授权你。`,
        true
      );
    } catch (e) {
      console.error('配对提示发送失败:', e.message);
    }
    return;
  }

  // ====== 管理员审批命令 ======
  if (body.msgtype === 'text') {
    const content = body.text?.content?.trim() || '';
    if (content.startsWith('/approve ')) {
      if (!isAdmin(userid)) {
        try {
          await wsClient.replyStream(frame, generateReqId('stream'), '只有管理员可以执行审批。', true);
        } catch (e) {
          console.error('审批权限提示失败:', e.message);
        }
        return;
      }
      const code = content.replace('/approve ', '').trim().toUpperCase();
      const entry = Object.entries(usersData.pending).find(([_, c]) => c === code);
      if (entry) {
        const [approvedUser, approvedCode] = entry;
        delete usersData.pending[approvedUser];
        usersData.approved.push(approvedUser);
        saveUsers();
        console.log(`[${new Date().toISOString()}] 管理员 ${userid} 审批通过: ${approvedUser}, code=${approvedCode}`);
        try {
          await wsClient.replyStream(
            frame,
            generateReqId('stream'),
            `已批准用户 ${approvedUser} 使用机器人。`,
            true
          );
        } catch (e) {
          console.error('审批成功回复失败:', e.message);
        }
      } else {
        try {
          await wsClient.replyStream(
            frame,
            generateReqId('stream'),
            `未找到配对码 ${code}，可能已经过期或被批准。`,
            true
          );
        } catch (e) {
          console.error('审批失败回复失败:', e.message);
        }
      }
      return;
    }
  }

  // ====== 处理图片消息 ======
  if (body.msgtype === 'image') {
    const imageUrl = body.image?.url;
    const aesKey = body.image?.aeskey;
    if (!imageUrl || !aesKey) {
      try {
        await wsClient.replyStream(frame, generateReqId('stream'), '图片信息不完整，无法下载。', true);
      } catch (e) {
        console.error('图片提示发送失败:', e.message);
      }
      return;
    }
    try {
      const { buffer, filename } = await wsClient.downloadFile(imageUrl, aesKey);
      const saveDir = resolve(__dirname, 'received_images');
      mkdirSync(saveDir, { recursive: true });
      const saveName = filename ? `${Date.now()}_${filename}` : `${Date.now()}_image.png`;
      const savePath = resolve(saveDir, saveName);
      writeFileSync(savePath, buffer);
      setUserLastImage(userid, savePath);
      console.log(`[${new Date().toISOString()}] 保存图片 from ${userid}: ${savePath}`);
      await wsClient.replyStream(frame, generateReqId('stream'), '图片已收到并保存，请继续发送文字指令处理它。', true);
    } catch (e) {
      console.error('保存图片失败:', e.message);
      try {
        await wsClient.replyStream(frame, generateReqId('stream'), '图片保存失败，请重试。', true);
      } catch (err) {
        console.error('图片失败提示发送失败:', err.message);
      }
    }
    return;
  }

  // ====== 处理文字消息 ======
  if (body.msgtype !== 'text') return;
  const content = body.text?.content?.trim();
  if (!content) return;

  console.log(`[${new Date().toISOString()}] 收到消息 from ${userid}: ${content}`);

  // /clear 命令：清空用户会话
  if (content === '/clear') {
    userSessions.delete(userid);
    userLastImages.delete(userid);
    try {
      await wsClient.replyStream(frame, generateReqId('stream'), '会话已清空，重新开始聊天！', true);
    } catch (e) {
      console.error('回复失败:', e.message);
    }
    return;
  }

  // /help 命令：显示帮助信息
  if (content === '/help') {
    const helpText = [
      '可用命令：',
      '/clear – 清空当前 Hermes 会话',
      '/help  – 显示此帮助信息',
      '',
      '其他任何文字都会直接发给 Hermes Agent，享受完整本地工具权限。',
    ].join('\n');
    try {
      await wsClient.replyStream(frame, generateReqId('stream'), helpText, true);
    } catch (e) {
      console.error('回复失败:', e.message);
    }
    return;
  }

  // 输入中/缓冲提示
  try {
    await wsClient.replyStream(frame, generateReqId('stream'), ' Hermes 正在思考... ', false);
  } catch (e) {
    // 非致命错误
  }

  try {
    let query = content;
    const lastImagePath = getUserLastImage(userid);
    if (lastImagePath) {
      query = `[系统提示：用户刚刚发送了一张图片，本地保存路径为: ${lastImagePath}]\n用户的指令：${content}`;
    }
    const { sessionId, reply, mediaPaths } = await enqueueHermes(userid, query, {
      ws: wsClient,
      frame,
    });
    if (sessionId) userSessions.set(userid, sessionId);

    // 先发送文字部分（如果有）
    if (reply) {
      await wsClient.replyStream(frame, generateReqId('stream'), truncateForWecom(reply), true);
    }

    // 再发送图片（如果有）
    if (mediaPaths.length > 0) {
      await sendMediaReplies(wsClient, frame, mediaPaths);
    }
  } catch (err) {
    const userMessage = err?.userMessage || '服务暂时不可用，请稍后重试。';
    const logDetail = err?.logDetail || err?.stack || err?.message || String(err);
    console.error('Hermes 调用错误:', logDetail);
    try {
      await wsClient.replyStream(
        frame,
        generateReqId('stream'),
        `${userMessage}\n\n小贴士: 发送 "/clear" 可以重置会话。`,
        true
      );
    } catch (e) {
      console.error('错误回复发送失败:', e.message);
    }
  }
});

wsClient.on('error', (err) => {
  console.error('WSClient 错误:', err.message);
});

wsClient.on('close', () => {
  console.log(`[${new Date().toISOString()}] WS 连接已关闭`);
});

// 优雅关闭
function shutdown() {
  console.log('正在关闭服务...');
  try {
    wsClient.disconnect && wsClient.disconnect();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 隐藏启动日志中的完整 Bot ID，只显示尾部四位
const maskedBotId = BOT_ID.length > 4 ? `***${BOT_ID.slice(-4)}` : '***';
console.log(`[${new Date().toISOString()}] 正在连接企业微信机器人 ${maskedBotId}...`);
console.log(
  `[${new Date().toISOString()}] 安全配置: admins=${usersData.admins.length}, approved=${usersData.approved.length}, pending=${Object.keys(usersData.pending).length}, yolo=${HERMES_ENABLE_YOLO}, mediaBaseDir=${MEDIA_BASE_DIR}, maxConcurrency=${MAX_GLOBAL_CONCURRENCY}`
);
wsClient.connect();
