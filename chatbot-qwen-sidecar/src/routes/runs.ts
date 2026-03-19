import type { FastifyInstance } from "fastify";

import type { AgentRuntime } from "../services/agent-runtime.js";
import type {
  ApprovalRequest,
  CancelRunRequest,
  SelectionRequest,
  SendMessageRequest,
  TextInputRequest,
} from "../types.js";

export function registerRunRoutes(app: FastifyInstance, runtime: AgentRuntime): void {
  app.post<{ Body: SendMessageRequest }>("/runs/message", async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const message = request.body?.message?.trim();
    if (!sessionId || !message) {
      reply.code(400);
      return { error: "session_id 与 message 不能为空" };
    }
    return runtime.sendMessage(request.body);
  });

  app.post<{ Body: ApprovalRequest }>("/runs/approval", async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const requestId = request.body?.request_id?.trim();
    const decision = request.body?.decision?.trim();
    if (!sessionId || !requestId || !decision) {
      reply.code(400);
      return { error: "session_id、request_id 与 decision 不能为空" };
    }
    return runtime.respondApproval(request.body);
  });

  app.post<{ Body: SelectionRequest }>("/runs/selection", async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const requestId = request.body?.request_id?.trim();
    const optionId = request.body?.option_id?.trim();
    if (!sessionId || !requestId || !optionId) {
      reply.code(400);
      return { error: "session_id、request_id 与 option_id 不能为空" };
    }
    return runtime.respondSelection(request.body);
  });

  app.post<{ Body: TextInputRequest }>("/runs/input", async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const requestId = request.body?.request_id?.trim();
    if (!sessionId || !requestId) {
      reply.code(400);
      return { error: "session_id 与 request_id 不能为空" };
    }
    return runtime.respondTextInput(request.body);
  });

  app.post<{ Body: CancelRunRequest }>("/runs/cancel", async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id 不能为空" };
    }
    return runtime.cancelRun(request.body);
  });
}
