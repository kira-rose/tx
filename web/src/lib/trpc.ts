import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import type { AppRouter } from "../../../src/server/router";

export const trpc = createTRPCReact<AppRouter>();

// Get API URL from environment variable (set during build) or default to localhost
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3847";

export function createTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: API_URL,
      }),
    ],
  });
}

// Re-export types
export type { AppRouter };

