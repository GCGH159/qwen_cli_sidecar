import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";

import type { SidecarConfig } from "./config.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { AgentRuntime } from "./services/agent-runtime.js";
import { SessionStore } from "./services/session-store.js";

export function createApp(config: SidecarConfig): FastifyInstance {
  const app = Fastify({ 
    logger: { level: config.logLevel },
    ajv: {
      customOptions: {
        removeAdditional: "all",
        coerceTypes: true,
        useDefaults: true,
      },
    },
  });
  const store = new SessionStore(config.recentEventsLimit);
  const runtime = new AgentRuntime(config, store, app.log);

  // 注册 CORS 插件
  void app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });

  // 注册 Swagger 插件
  void app.register(swagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "Qwen Sidecar API",
        description: "Qwen Code Sidecar 服务 API 文档",
        version: "0.1.0",
      },
      servers: [
        {
          url: `http://localhost:${config.port}`,
          description: "本地开发服务器",
        },
      ],
      tags: [
        { name: "projects", description: "项目相关接口" },
        { name: "sessions", description: "会话管理接口" },
        { name: "runs", description: "运行控制接口" },
        { name: "websocket", description: "WebSocket 实时通信" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "API Key 认证",
          },
        },
      },
    },
  });

  // 注册 Swagger UI
  void app.register(swaggerUI, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    staticCSP: true,
  });

  void app.register(websocket);

  // 在封装插件内注册路由，确保 swagger 能收集 schema
  void app.register(async (instance) => {
    instance.get("/health", {
      schema: {
        description: "健康检查接口",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
          },
        },
      },
    }, async () => ({ ok: true }));

    registerSessionRoutes(instance, runtime);
    registerRunRoutes(instance, runtime);

    instance.get(
      "/ws/sessions/:session_id",
      { websocket: true },
      (socket, request) => {
        const sessionId = readStringParam(request.params, "session_id");
        const sidecarSessionId = readOptionalStringParam(request.query, "sidecar_session_id");
        if (!sessionId) {
          socket.socket.close(1008, "session_id required");
          return;
        }
        try {
          const { initialEvent, unsubscribe } = runtime.subscribeSession(sessionId, sidecarSessionId, (event) => {
            if (socket.socket.readyState !== 1) {
              return;
            }
            socket.socket.send(JSON.stringify(event));
          });
          socket.socket.send(JSON.stringify(initialEvent));
          socket.on("close", () => {
            unsubscribe();
          });
          socket.on("error", () => {
            unsubscribe();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "session stream unavailable";
          socket.socket.close(1011, message.slice(0, 120));
        }
      },
    );
  });

  app.addHook("onRequest", async (request, reply) => {
    enforceApiKey(config, request, reply);
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : "sidecar internal error";
    reply.code(typeof statusCode === "number" && statusCode >= 400 ? statusCode : 500).send({
      error: message || "sidecar internal error",
    });
  });

  return app;
}

function enforceApiKey(config: SidecarConfig, request: FastifyRequest, reply: FastifyReply): void {
  if (!config.sidecarApiKey) {
    return;
  }
  const authHeader = request.headers.authorization?.trim() || "";
  const expected = `Bearer ${config.sidecarApiKey}`;
  if (authHeader === expected) {
    return;
  }
  reply.code(401).send({ error: "unauthorized" });
}

function readStringParam(input: unknown, key: string): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalStringParam(input: unknown, key: string): string | undefined {
  const value = readStringParam(input, key);
  return value || undefined;
}
