// ============================================================================
// SERVER ENTRY POINT
// ============================================================================
// HTTP server exposing the tRPC API.

import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import * as ws from "ws";
import http from "http";

import { appRouter, AppRouter } from "./router.js";
import { TRPCContext } from "./trpc.js";
import { IStorage, createStorage } from "../storage/index.js";
import { TxConfig } from "../types/index.js";
import { loadConfig } from "../config/index.js";

export { appRouter, AppRouter } from "./router.js";
export { TRPCContext } from "./trpc.js";

// ============================================================================
// SERVER OPTIONS
// ============================================================================

export interface ServerOptions {
  port?: number;
  host?: string;
  enableWebSocket?: boolean;
  config?: TxConfig;
}

const DEFAULT_OPTIONS: Required<ServerOptions> = {
  port: 3847,
  host: "0.0.0.0",
  enableWebSocket: true,
  config: undefined as unknown as TxConfig,
};

// ============================================================================
// CREATE SERVER
// ============================================================================

export interface TxServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number;
  getStorage(): IStorage;
}

export async function createServer(options: ServerOptions = {}): Promise<TxServer> {
  const config = options.config || loadConfig();
  const opts = {
    port: options.port ?? DEFAULT_OPTIONS.port,
    host: options.host ?? DEFAULT_OPTIONS.host,
    enableWebSocket: options.enableWebSocket ?? DEFAULT_OPTIONS.enableWebSocket,
    config,
  };
  
  // Create storage
  const storage = createStorage(config.storage);
  await storage.initialize();

  // Create context
  const createContext = (): TRPCContext => ({
    storage,
    config,
  });

  // Create HTTP server
  const httpServer = createHTTPServer({
    router: appRouter,
    createContext,
    responseMeta() {
      return {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      };
    },
  });

  // WebSocket server for subscriptions (future use)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wss: any = null;
  let wssHandler: ReturnType<typeof applyWSSHandler> | null = null;

  if (opts.enableWebSocket) {
    wss = new ws.WebSocketServer({ server: httpServer.server as http.Server });
    wssHandler = applyWSSHandler({
      wss,
      router: appRouter,
      createContext,
    });
  }

  return {
    async start() {
      return new Promise((resolve) => {
        httpServer.listen(opts.port);
        console.log(`\x1b[32m✓ TX Server running at http://${opts.host}:${opts.port}\x1b[0m`);
        if (opts.enableWebSocket) {
          console.log(`\x1b[32m✓ WebSocket enabled at ws://${opts.host}:${opts.port}\x1b[0m`);
        }
        console.log(`\x1b[90m  Storage: ${config.storage.type}\x1b[0m`);
        console.log(`\x1b[90m  LLM: ${config.llm.provider}\x1b[0m`);
        resolve();
      });
    },

    async stop() {
      if (wssHandler) {
        wssHandler.broadcastReconnectNotification();
      }
      if (wss) {
        wss.close();
      }
      httpServer.server.close();
      await storage.close();
      console.log(`\x1b[33mServer stopped\x1b[0m`);
    },

    getPort() {
      return opts.port;
    },

    getStorage() {
      return storage;
    },
  };
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

export async function startServerCLI(port?: number) {
  const server = await createServer({ port });
  
  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\x1b[33mShutting down...\x1b[0m");
    await server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });

  await server.start();
}

