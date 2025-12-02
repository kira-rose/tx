// ============================================================================
// tRPC ROUTER - Task Management API
// ============================================================================
// Defines all procedures for task management that can be called by agents.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";

import {
  router,
  publicProcedure,
  TaskQuerySchema,
  CreateTaskInputSchema,
  CompleteTaskInputSchema,
  UpdateTaskInputSchema,
  FieldDefinitionSchema,
} from "./trpc.js";

import {
  Task,
  TaskIndex,
  TaskSchema,
  Scope,
  SemanticField,
  FieldDefinition,
} from "../types/index.js";

import { extractSemantics, addFieldToSchema } from "../extraction/index.js";

// ============================================================================
// TASK ROUTER
// ============================================================================

export const taskRouter = router({
  // ---- Query Operations ----

  /**
   * List all tasks with optional filtering
   */
  list: publicProcedure
    .input(TaskQuerySchema.extend({
      status: z.array(z.enum(["active", "backlog", "completed", "canceled"])).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const result = await ctx.storage.queryTasks(input || {});
      return result;
    }),

  /**
   * Get a single task by ID or prefix
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      // Try exact match first
      let task = await ctx.storage.loadTask(input.id);
      
      // Try prefix match
      if (!task) {
        task = await ctx.storage.findTaskByPrefix(input.id);
      }
      
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.id}`,
        });
      }
      
      return task;
    }),

  /**
   * Get tasks due today
   */
  today: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.queryTasks({
      filters: [{ field: "deadline", op: "eq", value: "today" }],
    });
  }),

  /**
   * Get tasks due this week
   */
  week: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.queryTasks({
      filters: [{ field: "deadline", op: "eq", value: "this_week" }],
    });
  }),

  /**
   * Get overdue tasks
   */
  overdue: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.queryTasks({
      filters: [{ field: "deadline", op: "lt", value: "today" }],
    });
  }),

  /**
   * Get blocked tasks
   */
  blocked: publicProcedure.query(async ({ ctx }) => {
    const allTasks = await ctx.storage.loadAllTasks();
    const blocked = allTasks.filter((t) => t.blockedBy?.length);
    return { tasks: blocked, total: blocked.length };
  }),

  /**
   * Get active tasks
   */
  active: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.queryTasks({ status: ["active"] });
  }),

  /**
   * Get backlog tasks
   */
  backlog: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.queryTasks({ status: ["backlog"] });
  }),

  /**
   * Get canceled tasks
   */
  canceled: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.queryTasks({ status: ["canceled"] });
  }),

  /**
   * Get count of tasks
   */
  count: publicProcedure
    .input(TaskQuerySchema.optional())
    .query(async ({ ctx, input }) => {
      return ctx.storage.countTasks(input);
    }),

  // ---- Mutation Operations ----

  /**
   * Create a new task (raw text, will be processed by semantic extraction)
   */
  create: publicProcedure
    .input(CreateTaskInputSchema)
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const schema = await ctx.storage.loadSchema();
      
      // Perform semantic extraction using LLM
      const { tasks: extractedTasks, newFields } = await extractSemantics(
        input.raw,
        schema,
        index,
        ctx.config.llm
      );

      // Handle new schema fields
      if (newFields && newFields.length > 0) {
        let schemaUpdated = false;
        for (const proposal of newFields) {
          const added = addFieldToSchema(schema, proposal.name, {
            type: proposal.type as FieldDefinition["type"],
            description: proposal.description,
          });
          if (added) schemaUpdated = true;
        }
        if (schemaUpdated) {
          await ctx.storage.saveSchema(schema);
        }
      }

      // Create tasks from extracted data
      const createdTasks: Task[] = [];
      const taskIdMap: Record<number, string> = {};

      for (const extracted of extractedTasks) {
        const task: Task = {
          id: randomUUID(),
          raw: extracted.raw,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          status: "backlog",
          completed: false,
          fields: {
            ...extracted.fields,
            summary: extracted.fields.summary || { name: "summary", value: extracted.summary },
          },
          recurrence: extracted.recurrence,
          templateId: extracted.templateId,
        };

        // Track for dependency resolution
        if (extracted.seq !== undefined) {
          taskIdMap[extracted.seq] = task.id;
        }

        // Handle blocking relationship from input
        if (input.blocks && createdTasks.length === 0) {
          const blockedTask = await ctx.storage.findTaskByPrefix(input.blocks);
          if (blockedTask) {
            task.blocks = [blockedTask.id];
            blockedTask.blockedBy = blockedTask.blockedBy || [];
            blockedTask.blockedBy.push(task.id);
            await ctx.storage.saveTask(blockedTask);
          }
        }

        await ctx.storage.saveTask(task);
        createdTasks.push(task);

        // Update index
        index.tasks.push(task.id);
        index.stats.totalCreated++;
        if (index.stats.byStatus) {
          index.stats.byStatus.backlog++;
        }
      }

      // Handle sequential dependencies between created tasks
      for (let i = 0; i < extractedTasks.length; i++) {
        const extracted = extractedTasks[i];
        if (extracted.dependsOn !== undefined && taskIdMap[extracted.dependsOn]) {
          const task = createdTasks[i];
          const dependsOnId = taskIdMap[extracted.dependsOn];
          
          task.blockedBy = task.blockedBy || [];
          task.blockedBy.push(dependsOnId);
          
          const prerequisite = createdTasks.find(t => t.id === dependsOnId);
          if (prerequisite) {
            prerequisite.blocks = prerequisite.blocks || [];
            prerequisite.blocks.push(task.id);
            await ctx.storage.saveTask(prerequisite);
          }
          
          await ctx.storage.saveTask(task);
        }
      }

      await ctx.storage.saveIndex(index);

      // Return first task (or all if multiple)
      return createdTasks.length === 1 ? createdTasks[0] : createdTasks[0];
    }),

  /**
   * Create a task with pre-extracted semantic fields
   * (Use this when the client has already done semantic extraction)
   */
  createWithFields: publicProcedure
    .input(z.object({
      raw: z.string(),
      fields: z.record(z.object({
        name: z.string(),
        value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()]),
        confidence: z.number().optional(),
        normalized: z.string().optional(),
      })),
      blocks: z.string().optional(),
      recurrence: z.object({
        pattern: z.string(),
        interval: z.number().optional(),
        dayOfWeek: z.string().optional(),
        dayOfMonth: z.number().optional(),
        nextDue: z.string().optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      
      const task: Task = {
        id: randomUUID(),
        raw: input.raw,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        status: "backlog",
        completed: false,
        fields: input.fields as Record<string, SemanticField>,
        recurrence: input.recurrence,
      };

      // Handle blocking relationship
      if (input.blocks) {
        const blockedTask = await ctx.storage.findTaskByPrefix(input.blocks);
        if (blockedTask) {
          task.blocks = [blockedTask.id];
          blockedTask.blockedBy = blockedTask.blockedBy || [];
          blockedTask.blockedBy.push(task.id);
          await ctx.storage.saveTask(blockedTask);
        }
      }

      await ctx.storage.saveTask(task);
      
      // Update index
      index.tasks.push(task.id);
      index.stats.totalCreated++;
      await ctx.storage.saveIndex(index);

      return task;
    }),

  /**
   * Update an existing task
   */
  update: publicProcedure
    .input(UpdateTaskInputSchema)
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.storage.findTaskByPrefix(input.taskId);
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.taskId}`,
        });
      }

      // Update fields
      if (input.fields) {
        task.fields = { ...task.fields, ...input.fields };
      }
      if (input.blocks !== undefined) {
        task.blocks = input.blocks;
      }
      if (input.blockedBy !== undefined) {
        task.blockedBy = input.blockedBy;
      }

      task.updated = new Date().toISOString();
      await ctx.storage.saveTask(task);

      return task;
    }),

  /**
   * Complete a task
   */
  complete: publicProcedure
    .input(CompleteTaskInputSchema)
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.storage.findTaskByPrefix(input.taskId);
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.taskId}`,
        });
      }

      task.completed = true;
      task.updated = new Date().toISOString();
      task.completionInfo = {
        completedAt: new Date().toISOString(),
        duration: input.duration,
        notes: input.notes,
      };

      // Update stats
      const index = await ctx.storage.loadIndex();
      index.stats.totalCompleted++;

      const today = new Date().toISOString().split("T")[0];
      index.stats.completionsByDay[today] = (index.stats.completionsByDay[today] || 0) + 1;

      const project = String(task.fields.project?.value || task.fields.subject?.value || "unknown");
      index.stats.completionsByProject[project] = (index.stats.completionsByProject[project] || 0) + 1;

      if (input.duration && task.fields.task_type) {
        const taskType = String(task.fields.task_type.value);
        const current = index.stats.averageDuration[taskType] || input.duration;
        index.stats.averageDuration[taskType] = Math.round((current + input.duration) / 2);
      }

      // Handle recurrence
      let nextTask: Task | null = null;
      if (task.recurrence) {
        nextTask = { ...task };
        nextTask.id = randomUUID();
        nextTask.completed = false;
        nextTask.completionInfo = undefined;
        nextTask.created = new Date().toISOString();
        nextTask.updated = new Date().toISOString();

        const currentDeadline = task.fields.deadline?.value as string;
        if (currentDeadline) {
          const nextDate = new Date(currentDeadline);
          switch (task.recurrence.pattern) {
            case "daily":
              nextDate.setDate(nextDate.getDate() + (task.recurrence.interval || 1));
              break;
            case "weekly":
              nextDate.setDate(nextDate.getDate() + 7 * (task.recurrence.interval || 1));
              break;
            case "monthly":
              nextDate.setMonth(nextDate.getMonth() + (task.recurrence.interval || 1));
              break;
            case "yearly":
              nextDate.setFullYear(nextDate.getFullYear() + (task.recurrence.interval || 1));
              break;
          }
          nextTask.fields.deadline = {
            name: "deadline",
            value: nextDate.toISOString().split("T")[0],
          };
        }

        await ctx.storage.saveTask(nextTask);
        index.tasks.push(nextTask.id);
      }

      await ctx.storage.saveTask(task);
      await ctx.storage.archiveTask(task);
      await ctx.storage.saveIndex(index);

      return { completed: task, next: nextTask };
    }),

  /**
   * Delete a task permanently
   */
  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.storage.findTaskByPrefix(input.id);
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.id}`,
        });
      }

      const index = await ctx.storage.loadIndex();
      index.tasks = index.tasks.filter((id) => id !== task.id);

      // Update blocking relationships
      for (const id of index.tasks) {
        const t = await ctx.storage.loadTask(id);
        if (t && t.blockedBy?.includes(task.id)) {
          t.blockedBy = t.blockedBy.filter((bid) => bid !== task.id);
          await ctx.storage.saveTask(t);
        }
      }

      if (task.blocks) {
        for (const blockedId of task.blocks) {
          const blocked = await ctx.storage.loadTask(blockedId);
          if (blocked && blocked.blockedBy) {
            blocked.blockedBy = blocked.blockedBy.filter((bid) => bid !== task.id);
            await ctx.storage.saveTask(blocked);
          }
        }
      }

      await ctx.storage.deleteTask(task.id);
      await ctx.storage.saveIndex(index);

      return { deleted: task };
    }),

  /**
   * Activate a task (move from backlog to active)
   */
  activate: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.storage.findTaskByPrefix(input.taskId);
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.taskId}`,
        });
      }

      const oldStatus = task.status;
      task.status = "active";
      task.completed = false;
      task.updated = new Date().toISOString();

      const index = await ctx.storage.loadIndex();
      if (index.stats.byStatus) {
        if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
          index.stats.byStatus[oldStatus]--;
        }
        index.stats.byStatus.active++;
      }

      await ctx.storage.saveTask(task);
      await ctx.storage.saveIndex(index);

      return task;
    }),

  /**
   * Move a task to backlog
   */
  toBacklog: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.storage.findTaskByPrefix(input.taskId);
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.taskId}`,
        });
      }

      const oldStatus = task.status;
      task.status = "backlog";
      task.completed = false;
      task.updated = new Date().toISOString();

      const index = await ctx.storage.loadIndex();
      if (index.stats.byStatus) {
        if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
          index.stats.byStatus[oldStatus]--;
        }
        index.stats.byStatus.backlog++;
      }

      await ctx.storage.saveTask(task);
      await ctx.storage.saveIndex(index);

      return task;
    }),

  /**
   * Cancel a task
   */
  cancel: publicProcedure
    .input(z.object({ 
      taskId: z.string(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const task = await ctx.storage.findTaskByPrefix(input.taskId);
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Task not found: ${input.taskId}`,
        });
      }

      const oldStatus = task.status;
      task.status = "canceled";
      task.completed = false;
      task.updated = new Date().toISOString();
      task.canceledInfo = {
        canceledAt: new Date().toISOString(),
        reason: input.reason,
      };

      const index = await ctx.storage.loadIndex();
      if (index.stats.byStatus) {
        if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
          index.stats.byStatus[oldStatus]--;
        }
        index.stats.byStatus.canceled++;
      }
      index.stats.totalCanceled = (index.stats.totalCanceled || 0) + 1;

      await ctx.storage.saveTask(task);
      await ctx.storage.archiveTask(task);
      await ctx.storage.saveIndex(index);

      return task;
    }),
});

// ============================================================================
// SCHEMA ROUTER
// ============================================================================

export const schemaRouter = router({
  /**
   * Get the current schema
   */
  get: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.loadSchema();
  }),

  /**
   * Add a field to the schema
   */
  addField: publicProcedure
    .input(z.object({
      name: z.string().min(1),
      definition: FieldDefinitionSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const schema = await ctx.storage.loadSchema();
      const normalizedName = input.name.toLowerCase().replace(/\s+/g, "_");

      if (schema.fields[normalizedName]) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Field "${normalizedName}" already exists`,
        });
      }

      schema.fields[normalizedName] = {
        ...input.definition,
        category: input.definition.category || "custom",
      };
      schema.version++;

      await ctx.storage.saveSchema(schema);
      return schema;
    }),

  /**
   * Update a field in the schema
   */
  updateField: publicProcedure
    .input(z.object({
      name: z.string(),
      definition: FieldDefinitionSchema.partial(),
    }))
    .mutation(async ({ ctx, input }) => {
      const schema = await ctx.storage.loadSchema();
      
      if (!schema.fields[input.name]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Field "${input.name}" not found`,
        });
      }

      schema.fields[input.name] = {
        ...schema.fields[input.name],
        ...input.definition,
      };
      schema.version++;

      await ctx.storage.saveSchema(schema);
      return schema;
    }),
});

// ============================================================================
// INDEX ROUTER
// ============================================================================

export const indexRouter = router({
  /**
   * Get the full index (structures, aliases, templates, stats)
   */
  get: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.loadIndex();
  }),

  /**
   * Get statistics only
   */
  stats: publicProcedure.query(async ({ ctx }) => {
    const index = await ctx.storage.loadIndex();
    return index.stats;
  }),

  /**
   * Get discovered structures
   */
  structures: publicProcedure.query(async ({ ctx }) => {
    const index = await ctx.storage.loadIndex();
    return index.structures;
  }),

  /**
   * Get known aliases
   */
  aliases: publicProcedure.query(async ({ ctx }) => {
    const index = await ctx.storage.loadIndex();
    return index.aliases;
  }),

  /**
   * Merge aliases
   */
  mergeAliases: publicProcedure
    .input(z.object({
      canonical: z.string(),
      variant: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();

      if (!index.aliases[input.canonical]) {
        index.aliases[input.canonical] = [];
      }
      if (!index.aliases[input.canonical].includes(input.variant)) {
        index.aliases[input.canonical].push(input.variant);
      }

      await ctx.storage.saveIndex(index);
      return index.aliases;
    }),

  /**
   * Get templates
   */
  templates: publicProcedure.query(async ({ ctx }) => {
    const index = await ctx.storage.loadIndex();
    return index.templates;
  }),
});

// ============================================================================
// SYSTEM ROUTER
// ============================================================================

export const systemRouter = router({
  /**
   * Health check
   */
  health: publicProcedure.query(async ({ ctx }) => {
    const ready = await ctx.storage.isReady();
    return {
      status: ready ? "ok" : "error",
      timestamp: new Date().toISOString(),
      storage: ctx.config.storage.type,
    };
  }),

  /**
   * Get server info
   */
  info: publicProcedure.query(async ({ ctx }) => {
    const index = await ctx.storage.loadIndex();
    return {
      version: "2.0.0",
      storage: ctx.config.storage.type,
      llmProvider: ctx.config.llm.provider,
      taskCount: index.tasks.length,
      schemaVersion: (await ctx.storage.loadSchema()).version,
    };
  }),

  /**
   * Export all data
   */
  export: publicProcedure.query(async ({ ctx }) => {
    return ctx.storage.exportAll();
  }),

  /**
   * Import data
   */
  import: publicProcedure
    .input(z.object({
      tasks: z.array(z.any()),
      index: z.any(),
      schema: z.any(),
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.storage.importAll({
        tasks: input.tasks as Task[],
        index: input.index as TaskIndex,
        schema: input.schema as TaskSchema,
      });
      return { success: true };
    }),
});

// ============================================================================
// APP ROUTER
// ============================================================================

// ============================================================================
// SCOPE ROUTER
// ============================================================================

export const scopeRouter = router({
  /**
   * List all scopes
   */
  list: publicProcedure.query(async ({ ctx }) => {
    const index = await ctx.storage.loadIndex();
    return Object.values(index.scopes);
  }),

  /**
   * Get a scope by ID
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const scope = index.scopes[input.id];
      if (!scope) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Scope not found: ${input.id}`,
        });
      }
      return scope;
    }),

  /**
   * Get tasks within a scope
   */
  tasks: publicProcedure
    .input(z.object({ 
      id: z.string(),
      includeChildScopes: z.boolean().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const scope = index.scopes[input.id];
      if (!scope) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Scope not found: ${input.id}`,
        });
      }

      // Get subjects in scope (and optionally child scopes)
      const scopeIds = [input.id];
      if (input.includeChildScopes) {
        for (const s of Object.values(index.scopes)) {
          if (s.parent === input.id) {
            scopeIds.push(s.id);
          }
        }
      }

      const subjectsInScope = new Set<string>();
      for (const sid of scopeIds) {
        const s = index.scopes[sid];
        if (s) {
          for (const subject of s.subjects) {
            subjectsInScope.add(subject);
          }
        }
      }

      const allTasks = await ctx.storage.loadAllTasks();
      const tasksInScope = allTasks.filter(task => {
        const subject = task.fields.subject?.value || task.fields.project?.value;
        if (!subject) return false;
        const normalizedSubject = String(subject).toLowerCase().replace(/\s+/g, "_");
        return subjectsInScope.has(normalizedSubject);
      });

      return { tasks: tasksInScope, total: tasksInScope.length };
    }),

  /**
   * Create a new scope
   */
  create: publicProcedure
    .input(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
      parent: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const id = input.name.toLowerCase().replace(/\s+/g, "_");

      if (index.scopes[id]) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Scope "${input.name}" already exists`,
        });
      }

      if (input.parent && !index.scopes[input.parent]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Parent scope not found: ${input.parent}`,
        });
      }

      const scope: Scope = {
        id,
        name: input.name,
        description: input.description,
        color: input.color,
        icon: input.icon,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        subjects: [],
        parent: input.parent,
      };

      index.scopes[id] = scope;
      await ctx.storage.saveIndex(index);

      return scope;
    }),

  /**
   * Update a scope
   */
  update: publicProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
      parent: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const scope = index.scopes[input.id];

      if (!scope) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Scope not found: ${input.id}`,
        });
      }

      if (input.name !== undefined) scope.name = input.name;
      if (input.description !== undefined) scope.description = input.description;
      if (input.color !== undefined) scope.color = input.color;
      if (input.icon !== undefined) scope.icon = input.icon;
      if (input.parent !== undefined) scope.parent = input.parent || undefined;
      scope.updated = new Date().toISOString();

      await ctx.storage.saveIndex(index);
      return scope;
    }),

  /**
   * Delete a scope
   */
  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();

      if (!index.scopes[input.id]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Scope not found: ${input.id}`,
        });
      }

      // Remove subject associations
      for (const [subject, scopeId] of Object.entries(index.subjectScopes)) {
        if (scopeId === input.id) {
          delete index.subjectScopes[subject];
        }
      }

      // Remove child scope parent references
      for (const scope of Object.values(index.scopes)) {
        if (scope.parent === input.id) {
          scope.parent = undefined;
        }
      }

      delete index.scopes[input.id];
      await ctx.storage.saveIndex(index);

      return { deleted: input.id };
    }),

  /**
   * Assign a subject to a scope
   */
  assignSubject: publicProcedure
    .input(z.object({
      subject: z.string(),
      scopeId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const normalizedSubject = input.subject.toLowerCase().replace(/\s+/g, "_");

      if (!index.scopes[input.scopeId]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Scope not found: ${input.scopeId}`,
        });
      }

      // Remove from old scope
      const oldScopeId = index.subjectScopes[normalizedSubject];
      if (oldScopeId && index.scopes[oldScopeId]) {
        index.scopes[oldScopeId].subjects = index.scopes[oldScopeId].subjects.filter(
          s => s !== normalizedSubject
        );
      }

      // Add to new scope
      index.subjectScopes[normalizedSubject] = input.scopeId;
      if (!index.scopes[input.scopeId].subjects.includes(normalizedSubject)) {
        index.scopes[input.scopeId].subjects.push(normalizedSubject);
      }
      index.scopes[input.scopeId].updated = new Date().toISOString();

      await ctx.storage.saveIndex(index);

      return { subject: normalizedSubject, scopeId: input.scopeId };
    }),

  /**
   * Unassign a subject from its scope
   */
  unassignSubject: publicProcedure
    .input(z.object({ subject: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const index = await ctx.storage.loadIndex();
      const normalizedSubject = input.subject.toLowerCase().replace(/\s+/g, "_");

      const scopeId = index.subjectScopes[normalizedSubject];
      if (scopeId && index.scopes[scopeId]) {
        index.scopes[scopeId].subjects = index.scopes[scopeId].subjects.filter(
          s => s !== normalizedSubject
        );
      }

      delete index.subjectScopes[normalizedSubject];
      await ctx.storage.saveIndex(index);

      return { subject: normalizedSubject };
    }),
});

export const appRouter = router({
  task: taskRouter,
  schema: schemaRouter,
  index: indexRouter,
  scope: scopeRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;

