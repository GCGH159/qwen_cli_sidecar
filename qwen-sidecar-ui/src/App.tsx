import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

// API 基础 URL - 优先使用环境变量，否则自动使用当前页面的 hostname
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || `${window.location.protocol}//${window.location.hostname}:8099`

// 轮询间隔（毫秒）
const POLL_INTERVAL = 1000

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

interface SdkSessionSummary {
  session_id: string
  cwd: string
  start_time: string
  prompt: string
  git_branch?: string
  message_count: number
}

interface SdkSessionMessage {
  uuid: string
  type: "user" | "assistant" | "tool_result" | "system"
  timestamp: string
  text: string
  role?: string
}

interface SdkSessionDetail {
  session_id: string
  project_hash: string
  start_time: string
  last_updated: string
  messages: SdkSessionMessage[]
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

function App() {
  const [activeTab, setActiveTab] = useState<'sessions' | 'runs'>('sessions')

  // 会话管理状态
  const [userId, setUserId] = useState('test_user')
  const [sessionId, setSessionId] = useState('')
  const [projectId, setProjectId] = useState('chatbot-go')
  const [workspaceDir, setWorkspaceDir] = useState('/home/admin/com')
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [sessionList, setSessionList] = useState<any[]>([])

  // SDK 会话历史状态
  const [sdkSessionList, setSdkSessionList] = useState<SdkSessionSummary[]>([])
  const [selectedSdkSession, setSelectedSdkSession] = useState<string>('')
  const [sdkSessionDetail, setSdkSessionDetail] = useState<SdkSessionDetail | null>(null)
  const [sdkLoading, setSdkLoading] = useState(false)
  const [sdkWorkspaceDir, setSdkWorkspaceDir] = useState('/home/admin/com/workspace 10')
  const [sdkSessionIdInput, setSdkSessionIdInput] = useState('')

  // 选择 SDK 会话
  const selectSdkSession = (sessionId: string) => {
    setSelectedSdkSession(sessionId)
    getSdkSessionMessages(sessionId)
  }

  // 消息发送状态
  const [message, setMessage] = useState('')
  const [chatHistory, setChatHistory] = useState<Array<{role: string, content: string}>>([])

  // 加载和错误状态
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 轮询相关
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentSessionRef = useRef<Session | null>(null)

  // 同步 currentSession 到 ref
  useEffect(() => {
    currentSessionRef.current = currentSession
  }, [currentSession])

  // 获取会话快照
  const fetchSnapshot = useCallback(async () => {
    const session = currentSessionRef.current
    if (!session) return

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.session_id
        })
      })

      if (response.ok) {
        const data: Session = await response.json()
        setCurrentSession(data)

        // 如果有输出更新，更新聊天历史
        if (data.output && data.output.trim()) {
          setChatHistory(prev => {
            const lastMsg = prev[prev.length - 1]
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content !== data.output) {
              return [...prev.slice(0, -1), { role: 'assistant', content: data.output }]
            } else if (!lastMsg || lastMsg.role !== 'assistant') {
              return [...prev, { role: 'assistant', content: data.output }]
            }
            return prev
          })
        }

        // 如果有 pending_request，停止 loading 显示审批界面
        if (data.pending_request) {
          setLoading(false)
        }

        // 如果状态变为 idle，停止轮询
        if (data.status === 'idle') {
          setLoading(false)
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch snapshot:', err)
    }
  }, [])

  // 开始轮询
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }
    pollIntervalRef.current = setInterval(fetchSnapshot, POLL_INTERVAL)
    // 立即获取一次
    fetchSnapshot()
  }, [fetchSnapshot])

  // 停止轮询
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  // 组件卸载时停止轮询
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

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
        body: JSON.stringify({ project_id: projectId })
      })

      const data = await response.json()
      if (response.ok) {
        setSessionList(data.items || [])
      } else {
        setError(data.error || '获取会话列表失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // 列出 SDK 会话历史
  const listSdkSessions = async () => {
    setSdkLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/sdk/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_dir: sdkWorkspaceDir, limit: 20 })
      })

      const data = await response.json()
      if (response.ok) {
        setSdkSessionList(data.items || [])
        setSdkSessionDetail(null)
      } else {
        setError(data.error || '获取 SDK 会话列表失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setSdkLoading(false)
    }
  }

  // 获取 SDK 会话消息详情
  const getSdkSessionMessages = async (sessionId: string) => {
    if (!sessionId) {
      setError('请选择一个会话')
      return
    }

    setSdkLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/sdk/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_dir: sdkWorkspaceDir,
          session_id: sessionId
        })
      })

      const data = await response.json()
      if (response.ok) {
        setSdkSessionDetail(data.data || null)
      } else {
        setError(data.error || '获取 SDK 会话消息失败')
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
    } finally {
      setSdkLoading(false)
    }
  }

  // 响应审批请求
  const respondApproval = async (decision: 'allow' | 'deny') => {
    if (!currentSession?.pending_request) {
      setError('没有待处理的审批请求')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/runs/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession.session_id,
          request_id: currentSession.pending_request.request_id,
          decision: decision
        })
      })

      const data = await response.json()
      if (!response.ok) {
        setError(data.error || '审批响应失败')
        setLoading(false)
      } else {
        // 继续轮询
        startPolling()
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
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
      } else {
        // 开始轮询获取状态更新
        startPolling()
      }
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
        // 停止轮询
        stopPolling()
        // 更新会话状态
        setCurrentSession({
          ...currentSession,
          status: data.status || 'idle',
          status_text: data.status_text || '已取消当前运行',
          output: data.output || ''
        })
        setChatHistory(prev => [...prev, {role: 'system', content: '运行已取消'}])
        setLoading(false)
      } else {
        setError(data.error || '取消运行失败')
        setLoading(false)
      }
    } catch (err) {
      setError('网络错误: ' + (err as Error).message)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">Qwen Sidecar 测试界面</h1>

        {/* 错误提示 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* 标签页 */}
        <div className="flex border-b border-gray-300 mb-6">
          <button
            onClick={() => setActiveTab('sessions')}
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === 'sessions'
                ? 'border-blue-500 text-blue-600 bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            会话管理
          </button>
          <button
            onClick={() => setActiveTab('runs')}
            className={`px-6 py-3 font-medium border-b-2 transition-colors ${
              activeTab === 'runs'
                ? 'border-blue-500 text-blue-600 bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            消息对话
          </button>
        </div>

        {activeTab === 'sessions' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ======== SDK 会话历史区块 ======== */}
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="bg-teal-600 text-white px-6 py-4">
                <h2 className="text-lg font-semibold">SDK 会话历史</h2>
                <p className="text-teal-100 text-sm mt-1">
                  持久化的历史会话 (~/.qwen/projects/.../chats/)
                </p>
              </div>
              <div className="p-4">
                {/* 查询输入 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">工作目录</label>
                  <input
                    type="text"
                    value={sdkWorkspaceDir}
                    onChange={(e) => setSdkWorkspaceDir(e.target.value)}
                    placeholder="/home/admin/com/workspace 10"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">会话 ID（可直接查询详情）</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={sdkSessionIdInput}
                      onChange={(e) => setSdkSessionIdInput(e.target.value)}
                      placeholder="输入会话ID"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                    />
                    <button
                      onClick={() => getSdkSessionMessages(sdkSessionIdInput)}
                      disabled={sdkLoading || !sdkSessionIdInput.trim()}
                      className="bg-purple-500 text-white px-4 py-2 rounded-md hover:bg-purple-600 disabled:bg-gray-400"
                    >
                      查询详情
                    </button>
                  </div>
                </div>
                <button
                  onClick={listSdkSessions}
                  disabled={sdkLoading || !sdkWorkspaceDir.trim()}
                  className="w-full bg-teal-500 text-white py-2 rounded-md hover:bg-teal-600 disabled:bg-gray-400 mb-4"
                >
                  {sdkLoading ? '查询中...' : '列出会话历史'}
                </button>

                {/* 会话列表 */}
                {sdkSessionList.length > 0 && (
                  <div className="border-t pt-4">
                    <h3 className="text-sm font-medium text-gray-700 mb-2">历史会话 ({sdkSessionList.length})</h3>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {sdkSessionList.map((session) => (
                        <div
                          key={session.session_id}
                          onClick={() => selectSdkSession(session.session_id)}
                          className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                            selectedSdkSession === session.session_id
                              ? 'border-teal-500 bg-teal-50'
                              : 'border-gray-200 hover:border-teal-300'
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-xs text-gray-500 truncate">{session.session_id}</div>
                              <div className="text-sm truncate mt-1">{session.prompt || '(无提示)'}</div>
                            </div>
                            <div className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                              {session.message_count} 条消息
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 消息详情 */}
                {sdkSessionDetail && (
                  <div className="border-t pt-4 mt-4">
                    <h3 className="text-sm font-medium text-gray-700 mb-2">
                      消息记录 ({sdkSessionDetail.messages.length} 条)
                    </h3>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {sdkSessionDetail.messages.map((msg, index) => (
                        <div key={index} className={`p-2 rounded text-sm ${
                          msg.type === 'user' ? 'bg-blue-50' :
                          msg.type === 'assistant' ? 'bg-gray-50' : 'bg-yellow-50'
                        }`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-xs font-medium ${
                              msg.type === 'user' ? 'text-blue-600' :
                              msg.type === 'assistant' ? 'text-gray-600' : 'text-yellow-600'
                            }`}>
                              {msg.type === 'user' ? '用户' : msg.type === 'assistant' ? '助手' : msg.type}
                            </span>
                            <span className="text-xs text-gray-400">
                              {new Date(msg.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="text-gray-700 whitespace-pre-wrap line-clamp-3">
                            {msg.text || '(无内容)'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ======== Sidecar 活跃会话区块 ======== */}
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="bg-blue-600 text-white px-6 py-4">
                <h2 className="text-lg font-semibold">Sidecar 活跃会话</h2>
                <p className="text-blue-100 text-sm mt-1">
                  内存中的实时会话，用于对话
                </p>
              </div>
              <div className="p-4">
                {/* 创建会话表单 */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">用户ID</label>
                    <input
                      type="text"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">会话ID</label>
                    <input
                      type="text"
                      value={sessionId}
                      onChange={(e) => setSessionId(e.target.value)}
                      placeholder="输入新会话ID"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">项目ID</label>
                    <input
                      type="text"
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">工作目录</label>
                    <input
                      type="text"
                      value={workspaceDir}
                      onChange={(e) => setWorkspaceDir(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="flex gap-2 mb-4">
                  <button
                    onClick={ensureSession}
                    disabled={loading}
                    className="flex-1 bg-blue-500 text-white py-2 rounded-md hover:bg-blue-600 disabled:bg-gray-400"
                  >
                    创建会话
                  </button>
                  <button
                    onClick={listSessions}
                    disabled={loading}
                    className="flex-1 bg-green-500 text-white py-2 rounded-md hover:bg-green-600 disabled:bg-gray-400"
                  >
                    列出活跃会话
                  </button>
                </div>

                {/* 当前会话信息 */}
                {currentSession && (
                  <div className="bg-blue-50 rounded-lg p-3 mb-4">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-gray-500">会话:</span> <span className="font-mono text-xs">{currentSession.session_id}</span></div>
                      <div><span className="text-gray-500">状态:</span> <span className={currentSession.status === 'running' ? 'text-green-600 font-medium' : ''}>{currentSession.status}</span></div>
                    </div>
                    {currentSession.status_text && (
                      <div className="text-sm text-gray-600 mt-1">💬 {currentSession.status_text}</div>
                    )}
                  </div>
                )}

                {/* 活跃会话列表 */}
                {sessionList.length > 0 && (
                  <div className="border-t pt-4">
                    <h3 className="text-sm font-medium text-gray-700 mb-2">活跃会话 ({sessionList.length})</h3>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {sessionList.map((session, index) => (
                        <div key={index} className="flex justify-between items-center p-2 bg-gray-50 rounded">
                          <span className="font-mono text-sm">{session.session_id}</span>
                          <span className="text-sm text-gray-500">{session.summary}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'runs' && (
          <div className="max-w-3xl mx-auto">
            {/* 聊天界面 */}
            <div className="bg-white rounded-lg shadow">
              <div className="border-b px-6 py-4">
                <h2 className="text-lg font-semibold">消息对话</h2>
                {currentSession && (
                  <p className="text-sm text-gray-500">
                    会话: {currentSession.session_id} | 状态: {currentSession.status}
                  </p>
                )}
              </div>

              {/* 聊天历史 */}
              <div className="h-96 overflow-y-auto p-4 bg-gray-50">
                {chatHistory.length === 0 ? (
                  <div className="text-gray-400 text-center py-12">
                    请先在「会话管理」中创建会话，然后开始对话
                  </div>
                ) : (
                  chatHistory.map((msg, index) => (
                    <div key={index} className={`mb-3 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                      <div className={`inline-block max-w-[85%] p-3 rounded-lg ${
                        msg.role === 'user'
                          ? 'bg-blue-500 text-white'
                          : msg.role === 'system'
                          ? 'bg-gray-300 text-gray-700'
                          : 'bg-white border text-gray-800'
                      }`}>
                        <div className="text-xs opacity-75 mb-1">
                          {msg.role === 'user' ? '用户' : msg.role === 'system' ? '系统' : '助手'}
                        </div>
                        <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* 审批请求 */}
              {currentSession?.pending_request && (
                <div className="bg-yellow-50 border-t border-yellow-200 p-4">
                  <div className="font-medium text-yellow-800 mb-2">⚠️ 需要审批</div>
                  <div className="text-sm text-yellow-700 mb-3">
                    {currentSession.pending_request.prompt || '正在请求执行工具操作'}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => respondApproval('allow')}
                      disabled={loading}
                      className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 disabled:bg-gray-400"
                    >
                      允许
                    </button>
                    <button
                      onClick={() => respondApproval('deny')}
                      disabled={loading}
                      className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 disabled:bg-gray-400"
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              )}

              {/* 输入框 */}
              <div className="border-t p-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && !loading && sendMessage()}
                    placeholder="输入消息..."
                    disabled={!currentSession || loading}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                  <button
                    onClick={cancelRun}
                    disabled={!currentSession || !loading}
                    className="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 disabled:bg-gray-400"
                  >
                    取消
                  </button>
                  <button
                    onClick={sendMessage}
                    disabled={!currentSession || loading || !message.trim()}
                    className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:bg-gray-400"
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App