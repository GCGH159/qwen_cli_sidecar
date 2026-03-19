import type { FastifyInstance } from "fastify";

import type { AgentRuntime } from "../services/agent-runtime.js";
import type {
  EnsureSessionRequest,
  GetSessionMessagesRequest,
  GetSessionSnapshotRequest,
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

  app.post<{ Body: ListSessionsRequest }>("/sessions/list", async (request) => {
    return runtime.listSessions(request.body ?? {});
  });

  app.post<{ Body: GetSessionMessagesRequest }>("/sessions/messages", async (request, reply) => {
    const sessionId = request.body?.sdk_session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "sdk_session_id 不能为空" };
    }
    return runtime.getSessionMessages(request.body);
  });

  app.post<{ Body: GetSessionSnapshotRequest }>("/sessions/snapshot", async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id 不能为空" };
    }
    return runtime.getSessionSnapshot(request.body);
  });
}
