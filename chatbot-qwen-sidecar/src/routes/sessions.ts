import type { FastifyInstance } from "fastify";

import type { AgentRuntime } from "../services/agent-runtime.js";
import type {
  EnsureSessionRequest,
  GetSessionMessagesRequest,
  GetSessionSnapshotRequest,
  SdkListSessionsRequest,
  GetSdkSessionMessagesRequest,
  ListSessionsRequest,
} from "../types.js";

export function registerSessionRoutes(app: FastifyInstance, runtime: AgentRuntime): void {
  app.get("/projects", async () => {
    return runtime.listProjects();
  });

  app.post<{ Body: EnsureSessionRequest }>("/sessions/ensure", async (request, reply) => {
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

  // Sidecar 维护的会话列表（当前内存中的活跃会话）
  app.post<{ Body: ListSessionsRequest }>("/sessions/list", async (request) => {
    return runtime.listSessions(request.body ?? {});
  });

  // SDK 维护的会话历史列表（存储在 ~/.qwen/projects/{projectHash}/chats/）
  app.post<{ Body: SdkListSessionsRequest }>("/sessions/sdk/list", async (request, reply) => {
    const workspaceDir = request.body?.workspace_dir?.trim();
    if (!workspaceDir) {
      reply.code(400);
      return { error: "workspace_dir 不能为空" };
    }
    return runtime.listSdkSessions(request.body);
  });

  // Sidecar 会话的消息列表（已废弃，返回空列表）
  app.post<{ Body: GetSessionMessagesRequest }>("/sessions/messages", async (request, reply) => {
    const sessionId = request.body?.sdk_session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "sdk_session_id 不能为空" };
    }
    return runtime.getSessionMessages(request.body);
  });

  // SDK 会话的消息详情
  app.post<{ Body: GetSdkSessionMessagesRequest }>("/sessions/sdk/messages", async (request, reply) => {
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

  app.post<{ Body: GetSessionSnapshotRequest }>(
    "/sessions/snapshot",
    async (request, reply) => {
      // 禁用此路由的请求日志
      request.log.level = "debug";
      const sessionId = request.body?.session_id?.trim();
      if (!sessionId) {
        reply.code(400);
        return { error: "session_id 不能为空" };
      }
      return runtime.getSessionSnapshot(request.body);
    },
  );
}
