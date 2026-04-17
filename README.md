# 企业微信机器人 → Hermes 本地桥接

轻量级 Node.js 桥接服务，将**企业微信智能机器人**直接连接到本地 **Hermes Agent CLI**。让企业微信里的每位用户都能通过文字消息，使用 Hermes 的完整本地工具能力：终端命令、文件操作、浏览器自动化、技能调用、定时任务等。

> 🚨 **为什么要做这个：** OpenClaw 自带的桥接通常会把消息路由到云端大模型，而那些模型没有本地工具权限。这个桥接直接调用本地 `hermes` 二进制文件，真正让你的团队能在微信里跑命令、改文件、浏览网页。

---

## 目录

- [功能特性](#功能特性)
- [架构](#架构)
- [前置要求](#前置要求)
- [安装](#安装)
- [配置](#配置)
- [运行](#运行)
- [生产部署（PM2）](#生产部署pm2)
- [使用命令](#使用命令)
- [常见问题](#常见问题)
- [开源协议](#开源协议)

---

## 功能特性

- 💬 **完整 Hermes 工具能力**：通过企微文字消息调用本地 Agent 的全部工具
- 🛡️ **调用方白名单鉴权**：仅允许 `ALLOWED_USERIDS` 中的用户触发 Hermes
- 🔐 **用户级会话记忆**：每个用户独立会话，多轮对话上下文自动保持
- ⚡ **输入中/缓冲提示**：用户发送消息后，机器人会先提示“Hermes 正在思考...”
- 🛠️ **自动清理 TUI 输出**：Hermes 的 ANSI 颜色、边框字符、装饰符号在发回微信前自动剥离
- 🧱 **媒体路径与大小限制**：仅允许发送 `MEDIA_BASE_DIR` 下、白名单后缀且大小受限的图片文件
- 🔄 **断线自动重连**：WebSocket 掉线后自动恢复，可配置重试次数
- 📅 **会话自动过期**：内存中的用户会话支持 TTL，过期自动清理

---

## 架构

```
企业微信用户消息
        ↓
@wecom/aibot-node-sdk（WebSocket 长连接）
        ↓
Node.js 桥接服务（本项目）
        ↓
spawn("hermes", ["chat", "-q", "用户问题"])
        ↓
本地 Hermes Agent（拥有完整本地工具权限）
        ↓
stdout → 剥离 ANSI/边框字符 → 通过 WS 回发给用户
```

---

## 前置要求

- **Node.js** ≥ 18
- **Hermes CLI** 已安装，并且能在命令行里直接执行 `hermes`
- 一个 **企业微信智能机器人**，获取到 `BotId` 和 `Secret`
  - 获取路径：企业微信管理后台 → 应用管理 → 智能机器人 → 点击进入你的机器人 → 查看 `BotId` 和 `Secret`

---

## 安装

```bash
# 1. 克隆仓库
git clone https://github.com/MoringstarsH/wecom-Bot-hermes.git
cd wecom-Bot-hermes

# 2. 安装依赖（SDK 已内置在 vendor 目录，无需额外下载）
npm install

# 3. 复制环境变量模板
cp .env.example .env
# 编辑 .env，至少填入 WECOM_BOT_ID、WECOM_BOT_SECRET、ALLOWED_USERIDS
```

---

## 配置

编辑 `.env` 文件：

```ini
WECOM_BOT_ID=your_bot_id_here
WECOM_BOT_SECRET=your_bot_secret_here

# 必填配置：
ALLOWED_USERIDS=zhangsan,lisi # 允许调用机器人的企业微信用户 ID（逗号分隔）

# 可选配置：
SESSION_TTL_MS=86400000        # 用户会话在内存中的保留时间（毫秒）
HERMES_ENABLE_YOLO=false       # 是否给 Hermes 附加 --yolo（默认 false）
MEDIA_BASE_DIR=./media         # 允许发送媒体文件的根目录
MAX_MEDIA_FILE_SIZE_BYTES=10485760 # 媒体文件最大大小（默认 10MB）
```

---

## 运行

### 开发/前台运行

```bash
npm start
```

正常运行时你会看到：

```
[2026-04-16T12:00:00.000Z] 正在连接企业微信机器人 ...
[2026-04-16T12:00:01.000Z] 企业微信认证成功
```

### 生产环境（PM2）

```bash
# 先创建日志目录
mkdir -p logs

# 用 PM2 启动
npm run pm2:start

# 查看日志
pm2 logs wecom-bot-hermes

# 重启 / 停止
npm run pm2:restart
npm run pm2:stop
```

也可以把 PM2 注册为开机启动服务：

```bash
pm2 startup
pm2 save
```

---

## 使用命令

用户在企业微信里可以发送以下特殊命令：

| 命令 | 说明 |
|------|------|
| `/clear` | 清空当前用户的 Hermes 会话，重新开始 |
| `/help`  | 显示可用命令说明 |

其他所有文字都会直接路由给 Hermes Agent 处理。

如果用户不在 `ALLOWED_USERIDS` 白名单中，机器人会拒绝执行请求并返回“你没有权限使用此机器人”。

---

## 常见问题

| 现象 | 解决办法 |
|------|---------|
| `Authentication failed: 40058` | 仔细检查 `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET` 是否填对。如果不确定，去企业微信后台重新生成 Secret。 |
| `errcode=40008 invalid message type` | 请确认你使用的是**智能机器人**，而不是旧版的群机器人。 |
| Hermes 回复看起来是乱码/ASCII 艺术 | 桥接脚本已经做了 ANSI 和边框字符清理。如果仍然有问题，请带上一段原始 stdout 来提 issue。 |
| 多轮对话上下文丢失 | 检查是否使用了 `--resume {sessionId}`。会话目前保存在内存中，重启桥接服务会清空所有会话，用户可以发送 `/clear` 恢复。 |
| Hermes 执行复杂任务超时 | 桥接层采用双层超时机制：5分钟时会推送「任务仍在执行」状态，15分钟时会强制中断并告知用户。若任务在5~15分钟内完成，结果会自动推送到企微。 |

---

## 开源协议

MIT
