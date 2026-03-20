# Qwen Sidecar 使用文档

## 项目简介

Qwen Sidecar 是一个基于 Qwen Code SDK 的 AI 助手服务，提供 HTTP 和 WebSocket 接口，支持对话、工具调用、权限控制等功能。本项目已从 Claude Code SDK 成功迁移到 Qwen Code SDK。

## 功能特性

### ✅ 支持的功能
- 基本对话功能
- 工具调用功能
- 权限控制（`canUseTool` 回调）
- 流式响应
- 多轮对话
- MCP 服务器集成
- 会话管理
- 实时状态监控
- SDK 会话历史查询（`/sessions/sdk/list`、`/sessions/sdk/messages`）

### ❌ 不支持的功能（相比 Claude SDK）
- 工具进度消息（`tool_progress`）
- 认证状态消息（`auth_status`）
- 工具使用摘要（`tool_use_summary`）
- 速率限制事件（`rate_limit_event`）

## 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- TypeScript >= 5.0.0

## 下载和安装

### 1. 克隆项目

```bash
git clone <repository-url>
cd chatbot-qwen-sidecar
```

### 2. 安装依赖

```bash
npm install
```

### 3. 编译项目

```bash
npm run build
```

## 配置说明

### 环境变量配置

创建 `.env` 文件并配置以下环境变量：

```bash
# Qwen API 配置
QWEN_API_KEY=your_api_key_here
QWEN_BASE_URL=https://idealab.alibaba-inc.com/api/openai/v1
QWEN_MODEL=qwen3-coder-plus
QWEN_AUTH_TYPE=openai

# OpenAI 兼容认证配置（Qwen SDK 需要）
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://idealab.alibaba-inc.com/api/openai/v1

# Sidecar 配置
HOST=0.0.0.0
PORT=8099
LOG_LEVEL=info

# 工作目录配置
QWEN_WORKSPACE_DIR=/home/admin/workspace
QWEN_DEFAULT_PROJECT=chatbot-go

# 其他配置
QWEN_QUERY_MAX_TURNS=60
QWEN_INCLUDE_PARTIAL_MESSAGES=false
QWEN_PROMPT_SUGGESTIONS=false
QWEN_AGENT_PROGRESS_SUMMARIES=true
QWEN_ASK_USER_PREVIEW_FORMAT=markdown
QWEN_SNAPSHOT_WAIT_MS=8000
QWEN_PANEL_OUTPUT_LIMIT=2800
QWEN_PANEL_STATUS_LIMIT=400
QWEN_RECENT_EVENTS_LIMIT=20
```

### 配置说明

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `QWEN_API_KEY` | Qwen API 密钥 | 必填 |
| `QWEN_BASE_URL` | Qwen API 基础 URL | 必填 |
| `QWEN_MODEL` | 使用的模型名称 | `qwen3-coder-plus` |
| `QWEN_AUTH_TYPE` | 认证类型 | `openai` |
| `OPENAI_API_KEY` | OpenAI 兼容 API 密钥 | 必填 |
| `OPENAI_BASE_URL` | OpenAI 兼容基础 URL | 必填 |
| `HOST` | 服务监听地址 | `0.0.0.0` |
| `PORT` | 服务监听端口 | `8099` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `QWEN_WORKSPACE_DIR` | 工作目录 | `/home/admin/workspace` |
| `QWEN_DEFAULT_PROJECT` | 默认项目 ID | `chatbot-go` |

## 启动服务

### 开发模式

```bash
npm start
```

### 生产模式

```bash
npm run build
npm start
```

服务启动后，会监听在 `http://0.0.0.0:8099`

## API 接口说明

### 1. 健康检查

**接口**: `GET /health`

**响应**:
```json
{
  "ok": true
}
```

### 2. 创建/确保会话

**接口**: `POST /sessions/ensure`

**请求体**:
```json
{
  "user_id": "test_user",
  "session_id": "test_session_123",
  "sdk_session_id": "optional_sdk_session_id",
  "project_id": "chatbot-go"
}
```

**响应**:
```json
{
  "session_id": "test_session_123",
  "sdk_session_id": "abc123-def456-ghi789",
  "project_id": "chatbot-go",
  "status": "idle",
  "status_text": "Qwen 模式已开启",
  "output": "",
  "pending_request": null,
  "recent_events": [
    {
      "type": "session.created",
      "text": "Qwen 模式已开启",
      "created_at": 1234567890
    }
  ],
  "event_version": 1,
  "updated_at": 1234567890
}
```

### 3. 列出会话

**接口**: `POST /sessions/list`

**请求体**:
```json
{
  "project_id": "chatbot-go",
  "limit": 20,
  "offset": 0
}
```

**响应**:
```json
{
  "project_id": "chatbot-go",
  "items": [],
  "limit": 20,
  "offset": 0,
  "has_more": false
}
```

### 4. 获取会话消息

**接口**: `POST /sessions/messages`

**请求体**:
```json
{
  "sdk_session_id": "abc123-def456-ghi789"
}
```

**响应**:
```json
{
  "messages": []
}
```

### 5. 获取会话快照

**接口**: `POST /sessions/snapshot`

**请求体**:
```json
{
  "session_id": "test_session_123"
}
```

**响应**:
```json
{
  "session_id": "test_session_123",
  "sdk_session_id": "abc123-def456-ghi789",
  "project_id": "chatbot-go",
  "status": "idle",
  "status_text": "Qwen 已完成当前请求",
  "output": "助手回复内容",
  "pending_request": null,
  "recent_events": [],
  "event_version": 7,
  "updated_at": 1234567890
}
```

### 6. 发送消息

**接口**: `POST /runs/message`

**请求体**:
```json
{
  "session_id": "test_session_123",
  "message": "你好，请介绍一下你自己"
}
```

**响应**:
```json
{
  "run_id": "run-uuid",
  "status": "running"
}
```

### 7. 处理审批请求

**接口**: `POST /runs/approval`

**请求体**:
```json
{
  "session_id": "test_session_123",
  "request_id": "request-uuid",
  "decision": "allow"
}
```

**响应**: 返回会话快照

### 8. 处理选择请求

**接口**: `POST /runs/selection`

**请求体**:
```json
{
  "session_id": "test_session_123",
  "request_id": "request-uuid",
  "option_id": "option-1"
}
```

**响应**: 返回会话快照

### 9. 处理文本输入请求

**接口**: `POST /runs/input`

**请求体**:
```json
{
  "session_id": "test_session_123",
  "request_id": "request-uuid",
  "text": "用户输入的文本"
}
```

**响应**: 返回会话快照

### 10. 取消运行

**接口**: `POST /runs/cancel`

**请求体**:
```json
{
  "session_id": "test_session_123",
  "run_id": "run-uuid"
}
```

**响应**: 返回会话快照

### 11. WebSocket 实时更新

**接口**: `WS /ws/sessions/:session_id`

**查询参数**:
- `sidecar_session_id`: 可选的 sidecar 会话 ID

**消息格式**:
```json
{
  "type": "event_type",
  "text": "事件描述",
  "created_at": 1234567890
}
```

## 测试对话接口

### 方法一：使用 curl 命令

#### 1. 创建会话

```bash
curl -X POST http://localhost:8099/sessions/ensure \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test_user",
    "session_id": "test_session_001",
    "project_id": "chatbot-go"
  }'
```

#### 2. 发送消息

```bash
curl -X POST http://localhost:8099/runs/message \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test_session_001",
    "message": "你好，请用一句话介绍你自己"
  }'
```

#### 3. 获取响应

```bash
curl -X POST http://localhost:8099/sessions/snapshot \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test_session_001"
  }'
```

### 方法二：使用前端测试界面

项目包含一个完整的前端测试界面，提供可视化的 API 测试功能。

#### 启动前端界面

```bash
# 进入前端目录
cd qwen-sidecar-ui

# 安装依赖（首次运行）
npm install

# 启动开发服务器
npm run dev -- --host 0.0.0.0 --port 3000
```

#### 访问测试界面

打开浏览器访问：`http://localhost:3000`

#### 功能说明

1. **会话管理标签页**
   - 创建新会话
   - 查看会话详细信息
   - 列出所有会话
   - 获取会话消息历史
   - 获取会话实时快照

2. **消息对话标签页**
   - 实时聊天界面
   - 发送消息给 Qwen
   - 查看助手响应
   - 多轮对话支持

### 方法三：使用编程语言

#### JavaScript/Node.js 示例

```javascript
const axios = require('axios');

const API_BASE_URL = 'http://localhost:8099';

async function testConversation() {
  try {
    // 1. 创建会话
    const sessionResponse = await axios.post(`${API_BASE_URL}/sessions/ensure`, {
      user_id: 'test_user',
      session_id: 'test_session_js',
      project_id: 'chatbot-go'
    });
    
    console.log('会话创建成功:', sessionResponse.data);
    
    // 2. 发送消息
    const messageResponse = await axios.post(`${API_BASE_URL}/runs/message`, {
      session_id: 'test_session_js',
      message: '你好，请介绍一下你自己'
    });
    
    console.log('消息发送成功:', messageResponse.data);
    
    // 3. 等待响应
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 4. 获取响应
    const snapshotResponse = await axios.post(`${API_BASE_URL}/sessions/snapshot`, {
      session_id: 'test_session_js'
    });
    
    console.log('助手回复:', snapshotResponse.data.output);
    
  } catch (error) {
    console.error('测试失败:', error.response?.data || error.message);
  }
}

testConversation();
```

#### Python 示例

```python
import requests
import time

API_BASE_URL = 'http://localhost:8099'

def test_conversation():
    try:
        # 1. 创建会话
        session_response = requests.post(
            f'{API_BASE_URL}/sessions/ensure',
            json={
                'user_id': 'test_user',
                'session_id': 'test_session_python',
                'project_id': 'chatbot-go'
            }
        )
        
        print('会话创建成功:', session_response.json())
        
        # 2. 发送消息
        message_response = requests.post(
            f'{API_BASE_URL}/runs/message',
            json={
                'session_id': 'test_session_python',
                'message': '你好，请介绍一下你自己'
            }
        )
        
        print('消息发送成功:', message_response.json())
        
        # 3. 等待响应
        time.sleep(3)
        
        # 4. 获取响应
        snapshot_response = requests.post(
            f'{API_BASE_URL}/sessions/snapshot',
            json={
                'session_id': 'test_session_python'
            }
        )
        
        print('助手回复:', snapshot_response.json()['output'])
        
    except Exception as error:
        print('测试失败:', str(error))

if __name__ == '__main__':
    test_conversation()
```

## 常见问题

### 1. 模型不存在错误

**问题**: API 返回"模型不存在"错误

**解决方案**:
- 检查 `.env` 文件中的 `QWEN_MODEL` 配置
- 确认 API 密钥有使用该模型的权限
- 联系 API 提供商确认模型可用性

### 2. 认证失败

**问题**: API 返回认证失败错误

**解决方案**:
- 检查 `QWEN_API_KEY` 和 `OPENAI_API_KEY` 是否正确
- 确认 API 密钥未过期
- 检查 `QWEN_AUTH_TYPE` 配置是否正确

### 3. CORS 错误

**问题**: 浏览器访问 API 时出现 CORS 错误

**解决方案**:
- 确认后端服务已启动并支持 CORS
- 检查 `src/app.ts` 中的 CORS 配置
- 使用正确的 API 访问地址

### 4. 连接超时

**问题**: API 请求超时

**解决方案**:
- 检查网络连接
- 确认 API 服务地址正确
- 增加 `QWEN_SNAPSHOT_WAIT_MS` 配置值

## 技术支持

如有问题，请联系技术支持团队或查看项目文档。

## 许可证

[项目许可证信息]
