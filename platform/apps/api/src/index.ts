import "dotenv/config";
import { createServer } from "node:http";

import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { loadEcsLogMetadata, logEvent } from "./logger.js";
import { createUpstreamRequester } from "./services/upstream.js";
import { attachOrchestratorWebSocketProxy } from "./ws/orchestrator-proxy.js";

const config = loadApiConfig();
const app = createApp(config);
const server = createServer(app);
const launcherRequest = createUpstreamRequester(config.launcherBaseUrl, config.launcherRequestTimeoutMs);

void loadEcsLogMetadata().catch((error) => {
  logEvent({
    event: "ecs_metadata_load_failed",
    level: "warn",
    error: error instanceof Error ? error.message : String(error),
  });
});

attachOrchestratorWebSocketProxy(server, config, launcherRequest);

server.listen(config.port, config.host, () => {
  logEvent({
    event: "server_started",
    port: config.port,
    host: config.host,
  });
});
