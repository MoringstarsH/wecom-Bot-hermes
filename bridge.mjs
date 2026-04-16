import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
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
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS || 300_000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);

if (!BOT_ID || !BOT_SECRET) {
  console.error('缺少环境变量 WECOM_BOT_ID 或 WECOM_BOT_SECRET');
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

function extractHermesReply(raw) {
  const clean = stripFormatting(raw);

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
    return { sessionId, reply };
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
    if (fallback) return { sessionId, reply: fallback };
  }

  // fallback 2：如果连 "Resume this session with:" 都没有，直接取清理后末尾内容
  const tail = clean.trim();
  if (tail) {
    return { sessionId, reply: tail.slice(-2000) };
  }

  return { sessionId: null, reply: null };
}

// ====== 从回复中提取 MEDIA: 图片路径 ======
function extractMediaPaths(text) {
  const mediaPaths = [];
  const cleaned = text.replace(/MEDIA:([^\s\n]+)/g, (match, p1) => {
    if (existsSync(p1)) mediaPaths.push(p1);
    return '';
  });
  // 清理因移除 MEDIA 产生的多余空行
  const finalText = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { text: finalText, mediaPaths };
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

// ====== 调用本地 Hermes CLI ======
function callHermes(userid, query) {
  return new Promise((resolve, reject) => {
    const sessionId = userSessions.get(userid);
    const args = sessionId
      ? ['--resume', sessionId, 'chat', '-q', query, '--yolo']
      : ['chat', '-q', query, '--yolo'];

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
      reject(new Error(`Hermes 响应超时，等待了 ${HERMES_TIMEOUT_MS} 毫秒`));
    }, HERMES_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const { sessionId: sid, reply } = extractHermesReply(stdout);

      if (reply) {
        resolve({ sessionId: sid, reply });
      } else {
        const tail = stdout.slice(-800).trim();
        reject(new Error(`无法解析 Hermes 回复，退出码: ${code}。末尾原始输出:\n${tail}`));
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
      // 如果上传失败，回退为文字提示
      await ws.replyStream(frame, generateReqId('stream'), `[图片发送失败: ${path}]`, true);
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
    const { sessionId, reply } = await enqueueHermes(userid, content);
    if (sessionId) userSessions.set(userid, sessionId);

    const { text, mediaPaths } = extractMediaPaths(reply);

    // 先发送文字部分（如果有）
    if (text) {
      await wsClient.replyStream(frame, generateReqId('stream'), text, true);
    }

    // 再发送图片（如果有）
    if (mediaPaths.length > 0) {
      await sendMediaReplies(wsClient, frame, mediaPaths);
    }
  } catch (err) {
    console.error('Hermes 调用错误:', err.message);
    try {
      await wsClient.replyStream(
        frame,
        generateReqId('stream'),
        `出错了: ${err.message}\n\n小贴士: 发送 "/clear" 可以重置会话。`,
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
wsClient.connect();
