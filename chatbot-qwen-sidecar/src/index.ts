import "dotenv/config";

import type { FastifyInstance } from "fastify";

import { Cfg } from "./config.js";
import { createApp } from "./app.js";

async function shutdown(app: FastifyInstance, signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "Qwen sidecar is shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error, signal }, "Qwen sidecar failed to shut down cleanly");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = Cfg;
  const app = createApp(config);
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdown(app, signal);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      {
        qwenBaseUrl: config.qwenBaseUrl,
        httpProxy: config.httpProxy || undefined,
        httpsProxy: config.httpsProxy || undefined,
        noProxy: config.noProxy || undefined,
        logLevel: config.logLevel,
      },
      "Qwen sidecar upstream config loaded",
    );
    app.log.info(`Qwen sidecar listening on http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void main();
