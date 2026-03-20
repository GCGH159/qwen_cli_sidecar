import type { FastifyInstance } from "fastify";

import type { AgentRuntime } from "../services/agent-runtime.js";
import type {
  EnsureSessionRequest,
  GetSessionMessagesRequest,
  GetSessionSnapshotRequest,
  SdkListSessionsRequest,
  GetSdkSessionMessagesRequest,
  ListSessionsRequest,
  ResolveSessionRequest,
} from "../types.js";

// 公共 schema 定义
const sidecarResponseSchema = {
  type: "object",
  properties: {
    session_id: { type: "string", description: "Sidecar 会话 ID" },
    sdk_session_id: { type: "string", description: "SDK 会话 ID" },
    project_id: { type: "string", description: "项目 ID" },
    run_id: { type: "string", description: "当前运行 ID" },
    status: { type: "string", enum: ["inactive", "idle", "running", "awaiting_approval", "awaiting_selection", "awaiting_text_input", "error"], description: "会话状态" },
    status_text: { type: "string", description: "状态文本" },
    output: { type: "string", description: "当前输出内容" },
    thinking: { type: "string", description: "思考过程" },
    error: { type: "string", description: "错误信息" },
    pending_request: {
      type: "object",
      nullable: true,
      properties: {
        kind: { type: "string", enum: ["approval", "selection", "text_input"] },
        request_id: { type: "string" },
        prompt: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
            },
          },
        },
      },
    },
    recent_events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          text: { type: "string" },
          created_at: { type: "number" },
        },
      },
    },
    event_version: { type: "number", description: "事件版本号，用于轮询判断是否有更新" },
    updated_at: { type: "number", description: "更新时间戳" },
  },
};

const errorResponseSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export function registerSessionRoutes(app: FastifyInstance, runtime: AgentRuntime): void {
  app.get("/projects", {
    schema: {
      description: "获取所有项目列表",
      tags: ["projects"],
      response: {
        200: {
          type: "object",
          properties: {
            default_project_id: { type: "string", description: "默认项目 ID" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "项目 ID" },
                  label: { type: "string", description: "项目名称" },
                  workspace_dir: { type: "string", description: "工作目录" },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return runtime.listProjects();
  });

  app.post<{ Body: EnsureSessionRequest }>("/sessions/ensure", {
    schema: {
      description: "确保会话存在，如果不存在则创建新会话。可选择绑定 SDK 会话 ID 以恢复历史会话。",
      tags: ["sessions"],
      body: {
        type: "object",
        required: ["user_id", "session_id"],
        properties: {
          user_id: { type: "string", description: "用户 ID" },
          session_id: { type: "string", description: "Sidecar 会话 ID" },
          sdk_session_id: { type: "string", description: "SDK 会话 ID（可选，用于绑定历史会话）" },
          project_id: { type: "string", description: "项目 ID（可选，默认使用默认项目）" },
          workspace_dir: { type: "string", description: "工作目录（可选）" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const userId = request.body?.user_id?.trim();
    const sessionId = request.body?.session_id?.trim();
    if (!userId || !sessionId) {
      reply.code(400);
      return { error: "user_id 与 session_id 不能为空" };
    }
    return runtime.ensureSession(
      userId,
      sessionId,
      request.body?.sdk_session_id,
      request.body?.project_id,
      request.body?.workspace_dir,
    );
  });

  app.post<{ Body: ResolveSessionRequest }>("/sessions/resolve", {
    schema: {
      description: "通过 SDK 会话 ID 获取或创建 sidecar 会话。用于从 SDK 会话历史列表点击进入时，能够找到或创建对应的 sidecar 会话。",
      tags: ["sessions"],
      body: {
        type: "object",
        required: ["sdk_session_id"],
        properties: {
          sdk_session_id: { type: "string", description: "SDK 会话 ID" },
          project_id: { type: "string", description: "项目 ID（可选）" },
          workspace_dir: { type: "string", description: "工作目录（可选）" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sdkSessionId = request.body?.sdk_session_id?.trim();
    if (!sdkSessionId) {
      reply.code(400);
      return { error: "sdk_session_id 不能为空" };
    }
    return runtime.resolveSession(
      sdkSessionId,
      request.body?.project_id,
      request.body?.workspace_dir,
    );
  });

  app.post<{ Body: ListSessionsRequest }>("/sessions/list", {
    schema: {
      description: "获取 Sidecar 维护的会话列表（当前内存中的活跃会话）",
      tags: ["sessions"],
      body: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "项目 ID（可选）" },
          limit: { type: "number", description: "返回数量限制" },
          offset: { type: "number", description: "偏移量" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  session_id: { type: "string" },
                  project_id: { type: "string" },
                  summary: { type: "string" },
                  last_modified: { type: "number" },
                  created_at: { type: "number" },
                  cwd: { type: "string" },
                },
              },
            },
            limit: { type: "number" },
            offset: { type: "number" },
            has_more: { type: "boolean" },
          },
        },
      },
    },
  }, async (request) => {
    return runtime.listSessions(request.body ?? {});
  });

  app.post<{ Body: SdkListSessionsRequest }>("/sessions/sdk/list", {
    schema: {
      description: "获取 SDK 维护的会话历史列表（存储在 ~/.qwen/projects/{projectHash}/chats/）",
      tags: ["sessions"],
      body: {
        type: "object",
        required: ["workspace_dir"],
        properties: {
          workspace_dir: { type: "string", description: "工作目录" },
          limit: { type: "number", description: "返回数量限制" },
          cursor: { type: "number", description: "游标，用于分页" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            workspace_dir: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  session_id: { type: "string" },
                  cwd: { type: "string" },
                  start_time: { type: "string" },
                  prompt: { type: "string" },
                  message_count: { type: "number" },
                },
              },
            },
            limit: { type: "number" },
            has_more: { type: "boolean" },
            next_cursor: { type: "number", nullable: true },
          },
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const workspaceDir = request.body?.workspace_dir?.trim();
    if (!workspaceDir) {
      reply.code(400);
      return { error: "workspace_dir 不能为空" };
    }
    return runtime.listSdkSessions(request.body);
  });

  app.post<{ Body: GetSessionMessagesRequest }>("/sessions/messages", {
    schema: {
      description: "获取 Sidecar 会话的消息列表（已废弃，返回空列表）",
      tags: ["sessions"],
      deprecated: true,
      body: {
        type: "object",
        required: ["sdk_session_id"],
        properties: {
          sdk_session_id: { type: "string", description: "SDK 会话 ID" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            sdk_session_id: { type: "string" },
            items: { type: "array", items: {} },
            limit: { type: "number" },
            offset: { type: "number" },
            has_more: { type: "boolean" },
          },
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.body?.sdk_session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "sdk_session_id 不能为空" };
    }
    return runtime.getSessionMessages(request.body);
  });

  app.post<{ Body: GetSdkSessionMessagesRequest }>("/sessions/sdk/messages", {
    schema: {
      description: "获取 SDK 会话的消息详情",
      tags: ["sessions"],
      body: {
        type: "object",
        required: ["workspace_dir", "session_id"],
        properties: {
          workspace_dir: { type: "string", description: "工作目录" },
          session_id: { type: "string", description: "SDK 会话 ID" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            session_id: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["user", "assistant"] },
                  kind: { type: "string", enum: ["message", "tool_use", "tool_result"] },
                  uuid: { type: "string" },
                  session_id: { type: "string" },
                  text: { type: "string" },
                },
              },
            },
            error: { type: "string", nullable: true },
          },
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const workspaceDir = request.body?.workspace_dir?.trim();
    if (!workspaceDir) {
      reply.code(400);
      return { error: "workspace_dir 不能为空" };
    }
    const sessionId = request.body?.session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id 不能为空" };
    }
    return runtime.getSdkSessionMessages(request.body);
  });

  app.post<{ Body: GetSessionSnapshotRequest }>("/sessions/snapshot", {
    schema: {
      description: "获取会话快照，包含当前状态、输出、思考过程等。用于轮询获取实时状态。",
      tags: ["sessions"],
      body: {
        type: "object",
        required: ["session_id"],
        properties: {
          session_id: { type: "string", description: "会话 ID" },
          wait_for_version: { type: "number", description: "等待的版本号（可选，用于长轮询）" },
          timeout_ms: { type: "number", description: "超时时间（毫秒）" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    request.log.level = "debug";
    const sessionId = request.body?.session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id 不能为空" };
    }
    return runtime.getSessionSnapshot(request.body);
  });
}
