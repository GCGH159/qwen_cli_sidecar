# Qwen CLI Sidecar

基于 Qwen Code SDK 的 AI 助手服务，提供 HTTP 接口和 Web UI，支持会话管理、实时状态监控和中断功能。

## 项目结构

```
qwen_cli_sidecar/
├── chatbot-qwen-sidecar/    # 后端服务
│   ├── src/
│   │   ├── routes/          # API 路由
│   │   │   ├── runs.ts       # 运行相关接口（发送消息、取消等）
│   │   │   └── sessions.ts   # 会话管理接口
│   │   ├── services/
│   │   │   ├── agent-runtime.ts   # 核心运行时
│   │   │   ├── request-mapper.ts   # 请求映射
│   │   │   └── session-store.ts    # 会话存储（文件持久化）
│   │   ├── app.ts           # Fastify 应用
│   │   ├── config.ts        # 配置管理
│   │   ├── index.ts         # 入口文件
│   │   └── types.ts         # 类型定义
│   └── package.json
│
├── qwen-sidecar-ui/         # 前端界面
│   ├── src/
│   │   ├── App.tsx          # 主应用组件
│   │   ├── main.tsx         # 入口文件
│   │   └── ...
│   └── package.json
│
└── .gitignore
```

## 功能特性

### 后端服务 (chatbot-qwen-sidecar)

- **会话管理** — 创建/切换会话，文件持久化到 `~/.qwen/sidecar-sessions/`
- **消息通信** — 支持多轮对话和工具调用
- **权限控制** — 通过 `canUseTool` 回调自定义工具授权
- **实时监控** — WebSocket 订阅会话状态变化
- **会话中断** — 支持取消正在运行的会话
- **MCP 集成** — 支持 MCP 服务器连接

### 前端界面 (qwen-sidecar-ui)

- **会话管理** — 创建、查看会话状态
- **实时对话** — 发送消息并接收 AI 回复
- **中断功能** — 可随时取消正在运行的请求
- **状态显示** — 实时展示会话状态和最近事件

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 后端服务

```bash
cd chatbot-qwen-sidecar
npm install
npm run build
npm start
```

服务启动后监听在 `http://0.0.0.0:8099`

### 前端界面

```bash
cd qwen-sidecar-ui
npm install
npm run dev
```

前端界面运行在 `http://localhost:5173`

### 环境变量配置

在后端目录创建 `.env` 文件：

```bash
# Qwen API 配置
QWEN_API_KEY=your_api_key_here
QWEN_BASE_URL=https://api.example.com/v1
QWEN_MODEL=qwen3-coder-plus

# OpenAI 兼容认证配置
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.example.com/v1

# Sidecar 配置
HOST=0.0.0.0
PORT=8099
LOG_LEVEL=info

# 工作目录配置
QWEN_WORKSPACE_DIR=/path/to/workspace
QWEN_DEFAULT_PROJECT=default-project
```

## API 概览

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/projects` | GET | 获取项目列表 |
| `/sessions/ensure` | POST | 创建/确保会话 |
| `/sessions/list` | POST | 列出会话 |
| `/sessions/messages` | POST | 获取会话消息 |
| `/sessions/snapshot` | POST | 获取会话快照 |
| `/runs/message` | POST | 发送消息 |
| `/runs/approval` | POST | 响应批准请求 |
| `/runs/selection` | POST | 响应选择请求 |
| `/runs/input` | POST | 响应文本输入 |
| `/runs/cancel` | POST | 取消运行 |

## 获取会话快照

**接口**: `POST /sessions/snapshot`

**请求体**:
```json
{
  "session_id": "test_session_123",
  "sidecar_session_id": "optional_sidecar_session_id"
}
```

**响应**:
```json
{
  "session_id": "test_session_123",
  "sdk_session_id": "abc123-def456-ghi789",
  "project_id": "chatbot-go",
  "run_id": "run-uuid-if-running",
  "status": "idle | running | awaiting_approval | awaiting_selection | awaiting_text_input | error",
  "status_text": "当前状态的描述文本",
  "output": "AI 的输出内容",
  "pending_request": {
    "kind": "approval | selection | text_input",
    "request_id": "uuid",
    "prompt": "用户需要确认的提示文本",
    "options": [
      { "id": "option_1", "label": "选项1" },
      { "id": "option_2", "label": "选项2" }
    ]
  },
  "recent_events": [
    {
      "type": "run.started | run.resumed | run.canceled | tool_use | ...",
      "text": "事件描述",
      "created_at": 1234567890
    }
  ],
  "event_version": 1,
  "updated_at": 1234567890
}
```

### 状态说明

| 状态 | 说明 |
|------|------|
| `idle` | 会话空闲，无运行中的任务 |
| `running` | Qwen 正在处理请求 |
| `awaiting_approval` | 等待用户批准工具调用 |
| `awaiting_selection` | 等待用户选择选项 |
| `awaiting_text_input` | 等待用户输入文本 |
| `error` | 发生错误 |

### 前端实时更新说明

前端采用轮询方式获取会话状态，每秒调用一次 `/sessions/snapshot` 接口查询最新状态。后端也支持 WebSocket 实时推送，可通过 `/ws/sessions/:session_id` 连接实现实时更新。

## 会话持久化

会话数据存储在 `~/.qwen/sidecar-sessions/` 目录下，每个会话保存为一个 JSON 文件。服务重启后会自动加载历史会话。

## License

Apache-2.0
