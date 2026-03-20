import type { FastifyInstance } from "fastify";

import type { AgentRuntime } from "../services/agent-runtime.js";
import type {
  ApprovalRequest,
  CancelRunRequest,
  SelectionRequest,
  SendMessageRequest,
  TextInputRequest,
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
    event_version: { type: "number", description: "事件版本号" },
    updated_at: { type: "number", description: "更新时间戳" },
  },
};

const errorResponseSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export function registerRunRoutes(app: FastifyInstance, runtime: AgentRuntime): void {
  app.post<{ Body: SendMessageRequest }>("/runs/message", {
    schema: {
      description: "向会话发送消息，触发 Agent 执行任务",
      tags: ["runs"],
      body: {
        type: "object",
        required: ["session_id", "message"],
        properties: {
          session_id: { type: "string", description: "会话 ID" },
          message: { type: "string", description: "用户消息内容" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const message = request.body?.message?.trim();
    if (!sessionId || !message) {
      reply.code(400);
      return { error: "session_id 与 message 不能为空" };
    }
    return runtime.sendMessage(request.body);
  });

  app.post<{ Body: ApprovalRequest }>("/runs/approval", {
    schema: {
      description: "响应工具调用审批请求，允许或拒绝工具执行",
      tags: ["runs"],
      body: {
        type: "object",
        required: ["session_id", "request_id", "decision"],
        properties: {
          session_id: { type: "string", description: "会话 ID" },
          request_id: { type: "string", description: "审批请求 ID" },
          decision: { type: "string", enum: ["allow", "deny"], description: "审批决定" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const requestId = request.body?.request_id?.trim();
    const decision = request.body?.decision?.trim();
    if (!sessionId || !requestId || !decision) {
      reply.code(400);
      return { error: "session_id、request_id 与 decision 不能为空" };
    }
    return runtime.respondApproval(request.body);
  });

  app.post<{ Body: SelectionRequest }>("/runs/selection", {
    schema: {
      description: "响应选项选择请求，用户从多个选项中选择一个",
      tags: ["runs"],
      body: {
        type: "object",
        required: ["session_id", "request_id", "option_id"],
        properties: {
          session_id: { type: "string", description: "会话 ID" },
          request_id: { type: "string", description: "选择请求 ID" },
          option_id: { type: "string", description: "选中的选项 ID" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const requestId = request.body?.request_id?.trim();
    const optionId = request.body?.option_id?.trim();
    if (!sessionId || !requestId || !optionId) {
      reply.code(400);
      return { error: "session_id、request_id 与 option_id 不能为空" };
    }
    return runtime.respondSelection(request.body);
  });

  app.post<{ Body: TextInputRequest }>("/runs/input", {
    schema: {
      description: "响应文本输入请求，提供用户输入的文本",
      tags: ["runs"],
      body: {
        type: "object",
        required: ["session_id", "request_id"],
        properties: {
          session_id: { type: "string", description: "会话 ID" },
          request_id: { type: "string", description: "输入请求 ID" },
          text: { type: "string", description: "用户输入的文本" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    const requestId = request.body?.request_id?.trim();
    if (!sessionId || !requestId) {
      reply.code(400);
      return { error: "session_id 与 request_id 不能为空" };
    }
    return runtime.respondTextInput(request.body);
  });

  app.post<{ Body: CancelRunRequest }>("/runs/cancel", {
    schema: {
      description: "取消当前正在运行的任务",
      tags: ["runs"],
      body: {
        type: "object",
        required: ["session_id"],
        properties: {
          session_id: { type: "string", description: "会话 ID" },
        },
      },
      response: {
        200: sidecarResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.body?.session_id?.trim();
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id 不能为空" };
    }
    return runtime.cancelRun(request.body);
  });
}
