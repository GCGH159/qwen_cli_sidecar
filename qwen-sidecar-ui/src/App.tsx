import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

// API 基础 URL - 使用预览环境可访问的 URL
const API_BASE_URL = 'https://cdfc69-sandbox-session964b5fd695b74b6da5-8099.agent-preview.alibaba-inc.com'

// WebSocket 基础 URL
const WS_BASE_URL = API_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://')

// 类型定义
interface Session {
  session_id: string
  sdk_session_id: string
  project_id: string
  status: string
  status_text: string
  output: string
  pending_request: any
  recent_events: any[]
  event_version: number
  updated_at: number
}

interface EnsureSessionRequest {
  user_id: string
  session_id: string
  sdk_session_id?: string
  project_id?: string
  workspace_dir?: string
}

interface SendMessageRequest {
  session_id: string
  message: string
}

interface CancelRunRequest {
  session_id: string
  sidecar_session_id?: string
  run_id?: string
}

interface LiveSessionEvent {
  type: 'session.snapshot' | 'session.updated'
  session: Session
}

function App() {
  const [activeTab, setActiveTab] = useState<'sessions' | 'runs'>('sessions')

  // 会话管理状态
  const [userId, setUserId] = useState('test_user')
  const [sessionId, setSessionId] = useState('')
  const [projectId, setProjectId] = useState('chatbot-go')
  const [workspaceDir, setWorkspaceDir] = useState('/home/admin/com')
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [sessionList, setSessionList] = useState<any[]>([])
  const [sessionMessages, setSessionMessages] = useState<any[]>([])

  // 消息发送状态
  const [message, setMessage] = useState('')
  const [chatHistory, setChatHistory] = useState<Array<{role: string, content: string}>>([])

  // 加载和错误状态
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // WebSocket 相关
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // WebSocket 连接管理
  const connectWebSocket = useCallback((session: Session) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }

    const wsUrl = `${WS_BASE_URL}/ws/sessions/${session.session_id}?sidecar_session_id=${session.sdk_session_id}`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      console.log('WebSocket connected')
      setError('')
    }

    ws.onmessage = (event) => {
      try {
        const data: LiveSessionEvent = JSON.parse(event.data)
        if (data.session) {
          setCurrentSession(data.session)
          // 如果有输出更新，更新聊天历史
          if (data.session.output && data.session.output.trim()) {
            setChatHistory(prev => {
              const lastMsg = prev[prev.length - 1]
              if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content !== data.session.output) {
                // 更新最后一条助手消息
                return [...prev.slice(0, -1), { role: 'assistant', content: data.session.output }]
              } else if (!lastMsg || lastMsg.role !== 'assistant') {
                // 添加新的助手消息
                return [...prev, { role: 'assistant', content: data.session.output }]
              }
              return prev
            })
          }
          // 如果状态变为 idle，说明运行结束
          if (data.session.status === 'idle' && loading) {
            setLoading(false)
          }
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err)
      }
    }

    ws.onerror = () => {
      console.error('WebSocket error')
    }

    ws.onclose = (event) => {
      console.log('WebSocket closed', event.code, event.reason)
      // 如果非正常关闭，尝试重连
      if (event.code !== 1000 && event.code !== 1008 && currentSession) {
        reconnectTimeoutRef.current = setTimeout(() => {
          if (currentSession) {
            connectWebSocket(currentSession)
          }
        }, 3000)
      }
    }

    wsRef.current = ws
  }, [loading, currentSession])

  // 断开 WebSocket
  const disconnectWebSocket = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected')
      wsRef.current = null
    }
  }, [])

  // 组件卸载时断开 WebSocket
  useEffect(() => {
    return () => {
      disconnectWebSocket()
    }
  }, [disconnectWebSocket])

  // 确保会话
  const ensureSession = async () => {
    if (!userId || !sessionId) {
      setError('用户ID和会话ID不能为空')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/ensure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          session_id: sessionId,
          project_id: projectId,
          workspace_dir: workspaceDir || undefined
        } as EnsureSessionRequest)
      })

      const data = await response.json()
      if (response.ok) {
        setCurrentSession(data)
        setChatHistory([{role: 'system', content: data.status_text}])
        // 连接 WebSocket
        connectWebSocket(data)
      } else {
        setError(data.error || '创建会话失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 列出会话
  const listSessions = async () => {
    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })

      const data = await response.json()
      if (response.ok) {
        setSessionList(data.sessions || [])
      } else {
        setError(data.error || '获取会话列表失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 获取会话消息
  const getSessionMessages = async () => {
    if (!currentSession) {
      setError('请先创建会话')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdk_session_id: currentSession.sdk_session_id
        })
      })

      const data = await response.json()
      if (response.ok) {
        setSessionMessages(data.messages || [])
      } else {
        setError(data.error || '获取会话消息失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 获取会话快照
  const getSessionSnapshot = async () => {
    if (!currentSession) {
      setError('请先创建会话')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession.session_id
        })
      })

      const data = await response.json()
      if (response.ok) {
        setCurrentSession(data)
        if (data.output) {
          setChatHistory(prev => [...prev, {role: 'assistant', content: data.output}])
        }
      } else {
        setError(data.error || '获取会话快照失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 发送消息
  const sendMessage = async () => {
    if (!currentSession || !message.trim()) {
      setError('请先创建会话并输入消息')
      return
    }

    setLoading(true)
    setError('')

    // 添加用户消息到历史
    setChatHistory(prev => [...prev, {role: 'user', content: message}])
    const userMessage = message
    setMessage('')

    try {
      const response = await fetch(`${API_BASE_URL}/runs/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession.session_id,
          message: userMessage
        } as SendMessageRequest)
      })

      const data = await response.json()
      if (!response.ok) {
        setError(data.error || '发送消息失败')
        setChatHistory(prev => [...prev.slice(0, -1)]) // 移除刚才添加的用户消息
        setLoading(false)
      }
      // 后续状态更新通过 WebSocket 接收
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
      setChatHistory(prev => [...prev.slice(0, -1)]) // 移除刚才添加的用户消息
      setLoading(false)
    }
  }

  // 取消运行
  const cancelRun = async () => {
    if (!currentSession) {
      setError('请先创建会话')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/runs/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession.session_id
        } as CancelRunRequest)
      })

      const data = await response.json()
      if (response.ok) {
        // 更新会话状态
        setCurrentSession({
          ...currentSession,
          status: data.status || 'idle',
          status_text: data.status_text || '已取消当前运行',
          output: data.output || ''
        })
        setChatHistory(prev => [...prev, {role: 'system', content: '运行已取消'}])
      } else {
        setError(data.error || '取消运行失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Qwen Sidecar API 测试界面</h1>

        {/* 错误提示 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        {/* WebSocket 连接状态 */}
        <div className="mb-4 text-sm">
          <span className={`inline-block w-2 h-2 rounded-full mr-2 ${wsRef.current?.readyState === WebSocket.OPEN ? 'bg-green-500' : 'bg-gray-400'}`}></span>
          <span className="text-gray-600">
            WebSocket: {wsRef.current?.readyState === WebSocket.OPEN ? '已连接' : '未连接'}
          </span>
        </div>

        {/* 标签页 */}
        <div className="flex border-b border-gray-200 mb-6">
          <button
            onClick={() => setActiveTab('sessions')}
            className={`px-6 py-3 font-medium ${
              activeTab === 'sessions'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            会话管理
          </button>
          <button
            onClick={() => setActiveTab('runs')}
            className={`px-6 py-3 font-medium ${
              activeTab === 'runs'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            消息对话
          </button>
        </div>

        {activeTab === 'sessions' && (
          <div className="space-y-6">
            {/* 创建会话 */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold mb-4">创建/确保会话</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">用户ID</label>
                  <input
                    type="text"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">会话ID</label>
                  <input
                    type="text"
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                    placeholder="输入新会话ID"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">项目ID</label>
                  <input
                    type="text"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">工作目录</label>
                  <input
                    type="text"
                    value={workspaceDir}
                    onChange={(e) => setWorkspaceDir(e.target.value)}
                    placeholder="例如: /home/admin/com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <button
                onClick={ensureSession}
                disabled={loading}
                className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 disabled:bg-gray-400"
              >
                {loading ? '处理中...' : '创建会话'}
              </button>
            </div>

            {/* 当前会话信息 */}
            {currentSession && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-4">当前会话信息</h2>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="font-medium">会话ID:</span> {currentSession.session_id}</div>
                  <div><span className="font-medium">SDK会话ID:</span> {currentSession.sdk_session_id}</div>
                  <div><span className="font-medium">项目ID:</span> {currentSession.project_id}</div>
                  <div><span className="font-medium">状态:</span> {currentSession.status}</div>
                  <div><span className="font-medium">状态文本:</span> {currentSession.status_text}</div>
                  <div><span className="font-medium">更新时间:</span> {new Date(currentSession.updated_at * 1000).toLocaleString()}</div>
                </div>
                {currentSession.output && (
                  <div className="mt-4">
                    <span className="font-medium">输出:</span>
                    <pre className="mt-2 bg-gray-50 p-3 rounded text-sm overflow-auto max-h-40">
                      {currentSession.output}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* 会话操作按钮 */}
            <div className="flex gap-4">
              <button
                onClick={listSessions}
                disabled={loading}
                className="bg-green-500 text-white px-4 py-2 rounded-md hover:bg-green-600 disabled:bg-gray-400"
              >
                列出所有会话
              </button>
              <button
                onClick={getSessionMessages}
                disabled={loading || !currentSession}
                className="bg-purple-500 text-white px-4 py-2 rounded-md hover:bg-purple-600 disabled:bg-gray-400"
              >
                获取会话消息
              </button>
              <button
                onClick={getSessionSnapshot}
                disabled={loading || !currentSession}
                className="bg-orange-500 text-white px-4 py-2 rounded-md hover:bg-orange-600 disabled:bg-gray-400"
              >
                获取会话快照
              </button>
            </div>

            {/* 会话列表 */}
            {sessionList.length > 0 && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-4">会话列表 ({sessionList.length})</h2>
                <div className="space-y-2">
                  {sessionList.map((session, index) => (
                    <div key={index} className="border-b border-gray-200 pb-2">
                      <div className="font-medium">{session.session_id}</div>
                      <div className="text-sm text-gray-500">
                        项目: {session.project_id} | 状态: {session.status}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 会话消息 */}
            {sessionMessages.length > 0 && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-4">会话消息 ({sessionMessages.length})</h2>
                <div className="space-y-2">
                  {sessionMessages.map((msg, index) => (
                    <div key={index} className="border-b border-gray-200 pb-2">
                      <div className="font-medium">{msg.role}</div>
                      <div className="text-sm text-gray-700">{JSON.stringify(msg.content)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'runs' && (
          <div className="space-y-6">
            {/* 聊天界面 */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold mb-4">消息对话</h2>

              {/* 聊天历史 */}
              <div className="border border-gray-200 rounded-md p-4 mb-4 h-96 overflow-y-auto bg-gray-50">
                {chatHistory.length === 0 ? (
                  <div className="text-gray-500 text-center py-8">
                    请先创建会话，然后开始对话
                  </div>
                ) : (
                  chatHistory.map((msg, index) => (
                    <div key={index} className={`mb-4 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                      <div className={`inline-block max-w-[80%] p-3 rounded-lg ${
                        msg.role === 'user'
                          ? 'bg-blue-500 text-white'
                          : msg.role === 'system'
                          ? 'bg-gray-300 text-gray-700'
                          : 'bg-white border border-gray-200 text-gray-800'
                      }`}>
                        <div className="text-xs font-medium mb-1 opacity-75">
                          {msg.role === 'user' ? '用户' : msg.role === 'system' ? '系统' : '助手'}
                        </div>
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* 消息输入 */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && !loading && sendMessage()}
                  placeholder="输入消息..."
                  disabled={!currentSession || loading}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                />
                <button
                  onClick={cancelRun}
                  disabled={!currentSession || !loading}
                  className="bg-red-500 text-white px-6 py-2 rounded-md hover:bg-red-600 disabled:bg-gray-400"
                >
                  取消
                </button>
                <button
                  onClick={sendMessage}
                  disabled={!currentSession || loading || !message.trim()}
                  className="bg-blue-500 text-white px-6 py-2 rounded-md hover:bg-blue-600 disabled:bg-gray-400"
                >
                  {loading ? '发送中...' : '发送'}
                </button>
              </div>
            </div>

            {/* 当前会话状态 */}
            {currentSession && (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-4">当前会话状态</h2>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="font-medium">会话ID:</span> {currentSession.session_id}</div>
                  <div><span className="font-medium">状态:</span> {currentSession.status}</div>
                  <div><span className="font-medium">状态文本:</span> {currentSession.status_text}</div>
                  <div><span className="font-medium">更新时间:</span> {new Date(currentSession.updated_at * 1000).toLocaleString()}</div>
                </div>
                {currentSession.recent_events && currentSession.recent_events.length > 0 && (
                  <div className="mt-4">
                    <span className="font-medium">最近事件:</span>
                    <div className="mt-2 space-y-1">
                      {currentSession.recent_events.slice(-5).map((event, index) => (
                        <div key={index} className="text-sm bg-gray-50 p-2 rounded">
                          <span className="font-medium">{event.type}</span>: {event.text}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
