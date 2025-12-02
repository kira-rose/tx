// ============================================================================
// tRPC SETUP
// ============================================================================
// Base tRPC configuration for the server.

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { IStorage } from "../storage/index.js";
import { TxConfig } from "../types/index.js";

// ---- Context ----

export interface TRPCContext {
  storage: IStorage;
  config: TxConfig;
}

// ---- tRPC Instance ----

const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
    };
  },
});

// ---- Exports ----

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

// ---- Zod Schemas for Validation ----

export const SemanticFieldSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()]),
  confidence: z.number().optional(),
  normalized: z.string().optional(),
});

export const TaskFilterSchema = z.object({
  field: z.string(),
  op: z.enum(["eq", "contains", "gt", "lt", "exists", "not_exists", "startswith"]),
  value: z.string(),
});

export const TaskQuerySchema = z.object({
  filters: z.array(TaskFilterSchema).optional(),
  groupBy: z.string().optional(),
  sort: z.string().optional(),
  includeCompleted: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export const CreateTaskInputSchema = z.object({
  raw: z.string().min(1, "Task description is required"),
  blocks: z.string().optional(),
});

export const CompleteTaskInputSchema = z.object({
  taskId: z.string().min(1),
  duration: z.number().optional(),
  notes: z.string().optional(),
});

export const UpdateTaskInputSchema = z.object({
  taskId: z.string().min(1),
  fields: z.record(SemanticFieldSchema).optional(),
  blocks: z.array(z.string()).optional(),
  blockedBy: z.array(z.string()).optional(),
});

export const FieldDefinitionSchema = z.object({
  type: z.enum(["string", "date", "datetime", "number", "boolean", "array", "duration"]),
  description: z.string(),
  examples: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  enum: z.array(z.string()).optional(),
  category: z.enum(["core", "relationship", "recurrence", "custom"]).optional(),
});

