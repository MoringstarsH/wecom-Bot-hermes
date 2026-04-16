import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { spawn } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ====== 配置读取 ======
function loadEnv(path = resolve(__dirname, '.env')) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !Object.hasOwn(process.env, m[1])) {
      process.env[m[1]] = m[2];
    }
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

const HERMES_TIMEOUT_MS = parsePositiveInt('HERMES_TIMEOUT_MS', 300_000, {
  min: 1_000,
  max: 30 * 60 * 1000,
});
const SESSION_TTL_MS = parsePositiveInt('SESSION_TTL_MS', 24 * 60 * 60 * 1000, {
  min: 60_000,
  max: 30 * 24 * 60 * 60 * 1000,
});
const ALLOWED_USERIDS = parseCsvToSet(process.env.ALLOWED_USERIDS);
const HERMES_ENABLE_YOLO = parseBoolean(process.env.HERMES_ENABLE_YOLO, false);
const MEDIA_BASE_DIR = resolve(__dirname, process.env.MEDIA_BASE_DIR || './media');
const MAX_MEDIA_FILE_SIZE_BYTES = parsePositiveInt('MAX_MEDIA_FILE_SIZE_BYTES', 10 * 1024 * 1024, {
  min: 1_024,
  max: 50 * 1024 * 1024,
});
const ALLOWED_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

if (!BOT_ID || !BOT_SECRET) {
  console.error('缺少环境变量 WECOM_BOT_ID 或 WECOM_BOT_SECRET');
  process.exit(1);
}

if (ALLOWED_USERIDS.size === 0) {
  console.error('缺少环境变量 ALLOWED_USERIDS，必须配置允许调用机器人的用户列表');
  process.exit(1);
}

// ====== ANSI 颜色码与边框字符清理工具 ======
const ANSI_PATTERN = /\x1B\[[0-9;]*[mGKHFfnsut]/g;
const BOX_DRAWING_PATTERN = /[\u2500-\u257F\u2550-\u256C]/g;
const ORNAMENT_PATTERN = /[\u26a1\u2728\u2b50\u2605\u2606\u25cf\u25cb\u2713\u2714\u2717\u2718]/g;
const BRAILLE_BLANK = /\u2800/g;

function stripFormatting(str) {
  return str
    .replace(ANSI_PATTERN, '')
    .replace(BOX_DRAWING_PATTERN, '')
    .replace(ORNAMENT_PATTERN, '')
    .replace(BRAILLE_BLANK, ' ');
}

function isAuthorizedUser(userid) {
  return ALLOWED_USERIDS.has(userid);
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

    // 如果当前行没有以常见扩展名结尾，尝试把下一行非 MEDIA 开头的内容拼上来
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
  return text
    .replace(/MEDIA:[^\s\n]+(\n(?![A-Z]|\n)[^\s\n]+)?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHermesReply(raw) {
  const clean = stripFormatting(raw);

  // 从完整输出中提取所有 MEDIA: 路径
  const mediaPaths = extractMediaPaths(clean);

  // 提取会话 ID（用于多轮对话记忆）
  const sessionMatch = clean.match(/Resume this session with:\s+hermes --resume\s+(\S+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;

  // 精确匹配：提取 Hermes 真正的回复内容
  const replyMatch = clean.match(
    /(?:\u2695\s*)?Hermes\s*\n\s*\n([\s\S]*?)\n\s*\n\s*\nResume this session with:/
  );
  let reply = replyMatch ? replyMatch[1] : null;
  if (reply) {
    reply = reply
      .split('\n')
      .map((l) => l.replace(/^(\s{3,})/, ''))
      .join('\n')
      .trim();
    return { sessionId, reply: removeMediaMarkers(reply), mediaPaths };
  }

  // fallback 1：按 "Resume this session with:" 切割，取前面所有内容
  const resumeIndex = clean.lastIndexOf('Resume this session with:');
  if (resumeIndex !== -1) {
    let fallback = clean.slice(0, resumeIndex).trim();
    fallback = fallback.replace(/^(?:\u2695\s*)?Hermes\s*\n+/, '').trim();
    fallback = fallback
      .split('\n')
      .map((l) => l.replace(/^(\s{3,})/, ''))
      .join('\n')
      .trim();
    if (fallback) return { sessionId, reply: removeMediaMarkers(fallback), mediaPaths };
  }

  // fallback 2：如果连 "Resume this session with:" 都没有，直接取清理后末尾内容
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

// ====== 用户消息队列（保证同一用户消息串行执行） ======
const userQueues = new Map();

async function processQueue(userid) {
  const queue = userQueues.get(userid);
  if (!queue || queue.processing) return;
  queue.processing = true;
  while (queue.length > 0) {
    const item = queue.shift();
    try {
      const result = await callHermes(userid, item.query);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }
  queue.processing = false;
}

function enqueueHermes(userid, query) {
  return new Promise((resolve, reject) => {
    if (!userQueues.has(userid)) userQueues.set(userid, []);
    const queue = userQueues.get(userid);
    queue.push({ query, resolve, reject });
    processQueue(userid);
  });
}

// ====== 消息去重（短期缓存 60 秒） ======
const recentMessages = new Map();
const DEDUP_TTL_MS = 60_000;

function isDuplicate(msgid) {
  if (!msgid) return false;
  const ts = recentMessages.get(msgid);
  if (ts && Date.now() - ts < DEDUP_TTL_MS) return true;
  recentMessages.set(msgid, Date.now());
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of recentMessages) {
    if (now - ts > DEDUP_TTL_MS) recentMessages.delete(id);
  }
}, DEDUP_TTL_MS);

class HermesBridgeError extends Error {
  constructor(userMessage, logDetail = '') {
    super(userMessage);
    this.name = 'HermesBridgeError';
    this.userMessage = userMessage;
    this.logDetail = logDetail || userMessage;
  }
}

// ====== 调用本地 Hermes CLI ======
function callHermes(userid, query) {
  return new Promise((resolve, reject) => {
    const sessionId = userSessions.get(userid);
    const args = sessionId ? ['--resume', sessionId, 'chat', '-q', query] : ['chat', '-q', query];
    if (HERMES_ENABLE_YOLO) args.push('--yolo');

    const child = spawn('hermes', args, {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stdout += d.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
      reject(
        new HermesBridgeError(
          'Hermes 响应超时，请稍后重试。',
          `Hermes timeout after ${HERMES_TIMEOUT_MS}ms for user ${userid}`
        )
      );
    }, HERMES_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new HermesBridgeError(
          'Hermes 服务不可用，请联系管理员。',
          `Hermes spawn error for user ${userid}: ${err.message}`
        )
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const { sessionId: sid, reply, mediaPaths } = extractHermesReply(stdout);

      if (reply || mediaPaths.length > 0) {
        resolve({ sessionId: sid, reply, mediaPaths });
      } else {
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
  if (body.msgtype !== 'text') return;

  const userid = body.from?.userid;
  const content = body.text?.content?.trim();
  if (!userid || !content) return;

  if (!isAuthorizedUser(userid)) {
    console.warn(`[${new Date().toISOString()}] 拒绝未授权用户: ${userid}`);
    try {
      await wsClient.replyStream(frame, generateReqId('stream'), '你没有权限使用此机器人。', true);
    } catch (e) {
      console.error('未授权提示发送失败:', e.message);
    }
    return;
  }

  // 去重检查：避免网络抖动导致重复处理
  const msgid = body.msgid || body.msg_id || `${userid}-${Date.now()}`;
  if (isDuplicate(msgid)) {
    console.log(`[${new Date().toISOString()}] 忽略重复消息 ${msgid}`);
    return;
  }

  console.log(`[${new Date().toISOString()}] 收到消息 from ${userid}: ${content}`);

  // /clear 命令：清空用户会话
  if (content === '/clear') {
    userSessions.delete(userid);
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
    // 非致命错误；部分 SDK 版本可能对流式分片支持不是很好
  }

  try {
    const { sessionId, reply, mediaPaths } = await enqueueHermes(userid, content);
    if (sessionId) userSessions.set(userid, sessionId);

    // 先发送文字部分（如果有）
    if (reply) {
      await wsClient.replyStream(frame, generateReqId('stream'), reply, true);
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
  `[${new Date().toISOString()}] 安全配置: allowlist=${ALLOWED_USERIDS.size}, yolo=${HERMES_ENABLE_YOLO}, mediaBaseDir=${MEDIA_BASE_DIR}`
);
wsClient.connect();
