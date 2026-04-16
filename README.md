# WeCom Bot → Hermes Bridge

A lightweight Node.js bridge that connects a **WeCom Smart Bot (智能机器人）** directly to the local **Hermes Agent CLI**. Every WeChat user gets full access to Hermes' local toolset: terminal, file operations, browser automation, skills, cron, etc.

> 🚨 **Why this exists:** OpenClaw's built-in bridge often routes to cloud LLMs with no tool access. This bridge spawns the local `hermes` binary so your team can actually run commands, edit files, and browse the web through WeChat messages.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Deployment (PM2)](#deployment-pm2)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- 💬 **Full Hermes tool access** via WeCom text messages
- 🔐 **Per-user session memory** — multi-turn conversations just work
- ⚡ **Typing / buffering indicator** so users know the agent is thinking
- 🛠️ **ANSI & box-drawing cleanup** — Hermes' TUI output is stripped before sending
- 🔄 **Auto-reconnect** WebSocket with configurable retry limits
- 📅 **Session TTL** — stale sessions are automatically purged

---

## Architecture

```
WeCom User Message
        ↓
@wecom/aibot-node-sdk (WebSocket)
        ↓
Node.js bridge (this repo)
        ↓
spawn("hermes", ["chat", "-q", query, "--yolo"])
        ↓
Hermes Agent (local CLI with full tools)
        ↓
stdout → strip ANSI/borders → reply back through WS
```

---

## Prerequisites

- **Node.js** ≥ 18
- **Hermes CLI** installed and on your `PATH`
- A **WeCom Smart Bot** (智能机器人) with its `Bot ID` and `Secret`
  - Get these from: 企业微信管理后台 → 应用管理 → 智能机器人 → 点击你的 Bot → 查看 `BotId` 和 `Secret`

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/MoringstarsH/wecom-Bot-hermes.git
cd wecom-Bot-hermes

# 2. Install dependencies (the SDK is vendored under ./vendor)
npm install

# 3. Create your environment file
cp .env.example .env
# Edit .env and fill in WECOM_BOT_ID and WECOM_BOT_SECRET
```

---

## Configuration

Edit `.env`:

```ini
WECOM_BOT_ID=aib4Efhltb5TZYmg44lvGp5_JZK-daYSIwB
WECOM_BOT_SECRET=your_secret_here

# Optional:
HERMES_TIMEOUT_MS=300000      # Max time to wait for Hermes reply
SESSION_TTL_MS=86400000       # How long to keep a user's session in memory
```

---

## Running

### Dev / foreground

```bash
npm start
```

You should see:

```
[2026-04-16T12:00:00.000Z] Connecting to WeCom Bot aib4Ef...
[2026-04-16T12:00:01.000Z] WeCom authenticated
```

### Production (PM2)

```bash
# Create log directory first
mkdir -p logs

# Start with PM2
npm run pm2:start

# View logs
pm2 logs wecom-bot-hermes

# Restart / stop
npm run pm2:restart
npm run pm2:stop
```

You can also register PM2 as a startup service:

```bash
pm2 startup
pm2 save
```

---

## Commands

Users can send these special commands in WeCom:

| Command | Description |
|---------|-------------|
| `/clear` | Drop the current Hermes session and start fresh |
| `/help`  | Show available commands |

Everything else is routed straight to Hermes.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Authentication failed: 40058` | Double-check `WECOM_BOT_ID` and `WECOM_BOT_SECRET`. Regenerate the Secret in WeCom admin if unsure. |
| `errcode=40008 invalid message type` | Make sure you are using a **Smart Bot (智能机器人)** and not a legacy group robot. |
| Hermes reply looks garbled | The bridge already strips ANSI + box-drawing characters. If it still looks wrong, open an issue with a raw stdout sample. |
| Context lost between messages | Verify that `--resume {sessionId}` is being used. The session store is in-memory, so restarting the bridge process clears all sessions. Users can type `/clear` to recover. |
| Hermes times out on long tasks | Increase `HERMES_TIMEOUT_MS` in `.env`. Complex browser or build tasks may need 10+ minutes. |

---

## License

MIT
