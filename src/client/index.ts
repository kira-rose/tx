// ============================================================================
// TX CLIENT
// ============================================================================
// Client for connecting to the TX server from other applications/agents.

import { createTRPCProxyClient, httpBatchLink, createWSClient, wsLink, splitLink } from "@trpc/client";
import type { AppRouter } from "../server/router.js";

// Re-export types for consumers
export type { AppRouter } from "../server/router.js";
export * from "../types/index.js";

// ============================================================================
// CLIENT OPTIONS
// ============================================================================

export interface TxClientOptions {
  /** Server URL (default: http://localhost:3847) */
  url?: string;
  /** Enable WebSocket for subscriptions (default: false) */
  enableWebSocket?: boolean;
  /** Custom headers to send with requests */
  headers?: Record<string, string>;
}

// ============================================================================
// CREATE CLIENT
// ============================================================================

/**
 * Create a typed tRPC client for the TX server.
 * 
 * @example
 * ```typescript
 * import { createTxClient } from "tx/client";
 * 
 * const client = createTxClient({ url: "http://localhost:3847" });
 * 
 * // List tasks
 * const { tasks } = await client.task.list.query();
 * 
 * // Create a task
 * const task = await client.task.create.mutate({ raw: "Buy groceries tomorrow" });
 * 
 * // Complete a task
 * await client.task.complete.mutate({ taskId: task.id });
 * ```
 */
export function createTxClient(options: TxClientOptions = {}) {
  const url = options.url || "http://localhost:3847";
  const wsUrl = url.replace(/^http/, "ws");

  // HTTP-only client (simpler, no WebSocket)
  if (!options.enableWebSocket) {
    return createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url,
          headers: options.headers,
        }),
      ],
    });
  }

  // Client with WebSocket support for subscriptions
  const wsClient = createWSClient({
    url: wsUrl,
  });

  return createTRPCProxyClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({
          url,
          headers: options.headers,
        }),
      }),
    ],
  });
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Quick helper to check if the server is running
 */
export async function checkServerHealth(url = "http://localhost:3847"): Promise<boolean> {
  try {
    const client = createTxClient({ url });
    const health = await client.system.health.query();
    return health.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Get server info
 */
export async function getServerInfo(url = "http://localhost:3847") {
  const client = createTxClient({ url });
  return client.system.info.query();
}

