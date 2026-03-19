import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";

import type { SidecarConfig } from "./config.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { AgentRuntime } from "./services/agent-runtime.js";
import { SessionStore } from "./services/session-store.js";

export function createApp(config: SidecarConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  const store = new SessionStore(config.recentEventsLimit);
  const runtime = new AgentRuntime(config, store, app.log);

  // 注册 CORS 插件
  void app.register(cors, {
    origin: true, // 允许所有来源
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    enforceApiKey(config, request, reply);
  });

  void app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  registerSessionRoutes(app, runtime);
  registerRunRoutes(app, runtime);

  app.get(
    "/ws/sessions/:session_id",
    { websocket: true },
    (socket, request) => {
      const sessionId = readStringParam(request.params, "session_id");
      const sidecarSessionId = readOptionalStringParam(request.query, "sidecar_session_id");
      if (!sessionId) {
        socket.close(1008, "session_id required");
        return;
      }
      try {
        const { initialEvent, unsubscribe } = runtime.subscribeSession(sessionId, sidecarSessionId, (event) => {
          if (socket.readyState !== socket.OPEN) {
            return;
          }
          socket.send(JSON.stringify(event));
        });
        socket.send(JSON.stringify(initialEvent));
        socket.on("close", () => {
          unsubscribe();
        });
        socket.on("error", () => {
          unsubscribe();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "session stream unavailable";
        socket.close(1011, message.slice(0, 120));
      }
    },
  );

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
