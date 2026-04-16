import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ───────────────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────────────
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
  console.error('Missing WECOM_BOT_ID or WECOM_BOT_SECRET');
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────
// ANSI / Box-drawing strip helpers
// ───────────────────────────────────────────────────────────────
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

  // Extract session id
  const sessionMatch = clean.match(/Resume this session with:\s+hermes --resume\s+(\S+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;

  // Extract the actual assistant reply between the Hermes header and the footer
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
  }

  return { sessionId, reply };
}

// ───────────────────────────────────────────────────────────────
// Session store (in-memory with TTL)
// ───────────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────────
// Hermes invocation
// ───────────────────────────────────────────────────────────────
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
      reject(new Error(`Hermes timeout after ${HERMES_TIMEOUT_MS}ms`));
    }, HERMES_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const { sessionId: sid, reply } = extractHermesReply(stdout);

      if (reply) {
        resolve({ sessionId: sid, reply });
      } else {
        const tail = stdout.slice(-800).trim();
        reject(new Error(`Failed to parse Hermes reply. Exit code: ${code}. Raw tail:\n${tail}`));
      }
    });
  });
}

// ───────────────────────────────────────────────────────────────
// WeCom WS client
// ───────────────────────────────────────────────────────────────
const wsClient = new WSClient({
  botId: BOT_ID,
  secret: BOT_SECRET,
  heartbeatInterval: 30_000,
  maxReconnectAttempts: 20,
  maxAuthFailureAttempts: 5,
});

wsClient.on('authenticated', () => {
  console.log(`[${new Date().toISOString()}] WeCom authenticated`);
});

wsClient.on('message', async (frame) => {
  const body = frame.body;
  if (body.msgtype !== 'text') return;

  const userid = body.from?.userid;
  const content = body.text?.content?.trim();
  if (!userid || !content) return;

  console.log(`[${new Date().toISOString()}] Message from ${userid}: ${content}`);

  // /clear command
  if (content === '/clear') {
    userSessions.delete(userid);
    try {
      await wsClient.replyStream(frame, generateReqId('stream'), 'Session cleared. Start fresh!', true);
    } catch (e) {
      console.error('Reply error:', e.message);
    }
    return;
  }

  // /help command
  if (content === '/help') {
    const helpText = [
      'Available commands:',
      '/clear – start a new Hermes session',
      '/help  – show this message',
      '',
      'Any other text is sent directly to Hermes Agent with full tool access.',
    ].join('\n');
    try {
      await wsClient.replyStream(frame, generateReqId('stream'), helpText, true);
    } catch (e) {
      console.error('Reply error:', e.message);
    }
    return;
  }

  // Typing / buffering indicator
  try {
    await wsClient.replyStream(frame, generateReqId('stream'), ' Hermes is thinking... ', false);
  } catch (e) {
    // Non-fatal; some SDK versions may not support mid-stream chunks well
  }

  try {
    const { sessionId, reply } = await callHermes(userid, content);
    if (sessionId) userSessions.set(userid, sessionId);

    // Send final reply
    await wsClient.replyStream(frame, generateReqId('stream'), reply, true);
  } catch (err) {
    console.error('Hermes error:', err.message);
    try {
      await wsClient.replyStream(
        frame,
        generateReqId('stream'),
        `Error: ${err.message}\n\nTip: try "/clear" to reset your session.`,
        true
      );
    } catch (e) {
      console.error('Failed to send error reply:', e.message);
    }
  }
});

wsClient.on('error', (err) => {
  console.error('WSClient error:', err.message);
});

wsClient.on('close', () => {
  console.log(`[${new Date().toISOString()}] WS connection closed`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  try {
    wsClient.disconnect && wsClient.disconnect();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[${new Date().toISOString()}] Connecting to WeCom Bot ${BOT_ID}...`);
wsClient.connect();
