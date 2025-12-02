// ============================================================================
// POSTGRESQL STORAGE IMPLEMENTATION
// ============================================================================
// PostgreSQL-based storage for server deployments and multi-user scenarios.
// Provides full ACID compliance and concurrent access support.

import { BaseStorage } from "./interface.js";
import {
  Task,
  TaskIndex,
  TaskSchema,
  TaskStatus,
  TaskQuery,
  TaskQueryResult,
  PostgresStorageConfig,
  DEFAULT_SCHEMA,
  DEFAULT_INDEX,
} from "../types/index.js";

// Type definitions for pg module
interface PoolClient {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  release(): void;
}

interface Pool {
  connect(): Promise<PoolClient>;
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  end(): Promise<void>;
}

export class PostgresStorage extends BaseStorage {
  private pool: Pool | null = null;
  private pgConfig: PostgresStorageConfig;

  constructor(config: PostgresStorageConfig) {
    super(config);
    this.pgConfig = config;
  }

  async initialize(): Promise<void> {
    // Dynamic import to avoid bundling issues
    const { Pool } = await import("pg");
    
    this.pool = new Pool({
      host: this.pgConfig.host,
      port: this.pgConfig.port,
      database: this.pgConfig.database,
      user: this.pgConfig.user,
      password: this.pgConfig.password,
      ssl: this.pgConfig.ssl ? { rejectUnauthorized: false } : false,
    }) as unknown as Pool;

    // Create tables
    await this.pool.query(`
      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        raw TEXT NOT NULL,
        created TIMESTAMPTZ NOT NULL,
        updated TIMESTAMPTZ NOT NULL,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        completion_info JSONB,
        fields JSONB NOT NULL,
        blocks UUID[],
        blocked_by UUID[],
        parent UUID,
        subtasks UUID[],
        recurrence JSONB,
        template_id TEXT,
        archived BOOLEAN NOT NULL DEFAULT FALSE
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
      CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created);
      
      -- GIN index for JSONB fields queries
      CREATE INDEX IF NOT EXISTS idx_tasks_fields ON tasks USING GIN(fields);

      -- Task index (metadata)
      CREATE TABLE IF NOT EXISTS task_index (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL
      );

      -- Schema table
      CREATE TABLE IF NOT EXISTS schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL
      );

      -- Extracted fields for efficient querying
      CREATE TABLE IF NOT EXISTS task_fields (
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        field_value TEXT,
        normalized_value TEXT,
        PRIMARY KEY (task_id, field_name)
      );

      CREATE INDEX IF NOT EXISTS idx_task_fields_name ON task_fields(field_name);
      CREATE INDEX IF NOT EXISTS idx_task_fields_value ON task_fields(field_value);
      CREATE INDEX IF NOT EXISTS idx_task_fields_normalized ON task_fields(normalized_value);
    `);

    // Initialize index if not exists
    const indexResult = await this.pool.query("SELECT 1 FROM task_index WHERE id = 1");
    if (indexResult.rows.length === 0) {
      await this.pool.query(
        "INSERT INTO task_index (id, data) VALUES (1, $1)",
        [JSON.stringify(DEFAULT_INDEX)]
      );
    }

    // Initialize schema if not exists
    const schemaResult = await this.pool.query("SELECT 1 FROM schema WHERE id = 1");
    if (schemaResult.rows.length === 0) {
      await this.pool.query(
        "INSERT INTO schema (id, data) VALUES (1, $1)",
        [JSON.stringify({ ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() })]
      );
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async isReady(): Promise<boolean> {
    if (!this.pool) return false;
    
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  // ---- Task Operations ----

  async saveTask(task: Task): Promise<void> {
    this.ensurePool();
    
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      
      await client.query(`
        INSERT INTO tasks (
          id, raw, created, updated, completed, completion_info,
          fields, blocks, blocked_by, parent, subtasks, recurrence, template_id, archived
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          raw = EXCLUDED.raw,
          updated = EXCLUDED.updated,
          completed = EXCLUDED.completed,
          completion_info = EXCLUDED.completion_info,
          fields = EXCLUDED.fields,
          blocks = EXCLUDED.blocks,
          blocked_by = EXCLUDED.blocked_by,
          parent = EXCLUDED.parent,
          subtasks = EXCLUDED.subtasks,
          recurrence = EXCLUDED.recurrence,
          template_id = EXCLUDED.template_id,
          archived = EXCLUDED.archived
      `, [
        task.id,
        task.raw,
        task.created,
        task.updated,
        task.completed,
        task.completionInfo ? JSON.stringify(task.completionInfo) : null,
        JSON.stringify(task.fields),
        task.blocks || null,
        task.blockedBy || null,
        task.parent || null,
        task.subtasks || null,
        task.recurrence ? JSON.stringify(task.recurrence) : null,
        task.templateId || null,
        false
      ]);

      // Update task_fields
      await client.query("DELETE FROM task_fields WHERE task_id = $1", [task.id]);
      
      for (const [name, field] of Object.entries(task.fields)) {
        const value = Array.isArray(field.value)
          ? field.value.join(",")
          : String(field.value ?? "");
        
        await client.query(
          "INSERT INTO task_fields (task_id, field_name, field_value, normalized_value) VALUES ($1, $2, $3, $4)",
          [task.id, name, value, field.normalized || value]
        );
      }
      
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadTask(id: string): Promise<Task | null> {
    this.ensurePool();
    
    const result = await this.pool!.query<TaskRow>(
      "SELECT * FROM tasks WHERE id = $1",
      [id]
    );
    
    if (result.rows.length === 0) return null;
    return this.rowToTask(result.rows[0]);
  }

  async findTaskByPrefix(prefix: string): Promise<Task | null> {
    this.ensurePool();
    
    const result = await this.pool!.query<TaskRow>(
      "SELECT * FROM tasks WHERE id::text LIKE $1 AND archived = FALSE",
      [`${prefix}%`]
    );
    
    if (result.rows.length === 1) {
      return this.rowToTask(result.rows[0]);
    }
    
    return null;
  }

  async deleteTask(id: string): Promise<boolean> {
    this.ensurePool();
    
    const result = await this.pool!.query(
      "DELETE FROM tasks WHERE id = $1",
      [id]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      // Also remove from index
      const index = await this.loadIndex();
      index.tasks = index.tasks.filter((tid) => tid !== id);
      await this.saveIndex(index);
      return true;
    }
    
    return false;
  }

  async archiveTask(task: Task): Promise<void> {
    this.ensurePool();
    
    await this.pool!.query(
      "UPDATE tasks SET archived = TRUE WHERE id = $1",
      [task.id]
    );
  }

  async loadAllTasks(includeCompleted = false): Promise<Task[]> {
    this.ensurePool();
    
    const sql = includeCompleted
      ? "SELECT * FROM tasks WHERE archived = FALSE ORDER BY created DESC"
      : "SELECT * FROM tasks WHERE archived = FALSE AND completed = FALSE ORDER BY created DESC";
    
    const result = await this.pool!.query<TaskRow>(sql);
    return result.rows.map((row) => this.rowToTask(row));
  }

  async getAllTaskIds(): Promise<string[]> {
    this.ensurePool();
    
    const result = await this.pool!.query<{ id: string }>(
      "SELECT id FROM tasks WHERE archived = FALSE"
    );
    
    return result.rows.map((row) => row.id);
  }

  // ---- Optimized Query Implementation ----

  async queryTasks(query: TaskQuery): Promise<TaskQueryResult> {
    this.ensurePool();
    
    let sql = "SELECT DISTINCT t.* FROM tasks t";
    const params: unknown[] = [];
    let paramIndex = 1;
    const joins: string[] = [];
    const conditions: string[] = ["t.archived = FALSE"];
    
    if (!query.includeCompleted) {
      conditions.push("t.completed = FALSE");
    }
    
    // Build query from filters
    if (query.filters?.length) {
      for (let i = 0; i < query.filters.length; i++) {
        const filter = query.filters[i];
        const alias = `f${i}`;
        
        // Special handling for deadline
        if (filter.field === "deadline") {
          joins.push(`LEFT JOIN task_fields ${alias} ON t.id = ${alias}.task_id AND ${alias}.field_name = 'deadline'`);
          
          if (filter.value === "today") {
            const today = new Date().toISOString().split("T")[0];
            conditions.push(`LEFT(${alias}.field_value, 10) = $${paramIndex++}`);
            params.push(today);
          } else if (filter.value === "this_week") {
            const { start, end } = this.getWeekRange();
            conditions.push(`LEFT(${alias}.field_value, 10) BETWEEN $${paramIndex++} AND $${paramIndex++}`);
            params.push(start, end);
          } else if (filter.op === "lt" && filter.value === "today") {
            const today = new Date().toISOString().split("T")[0];
            conditions.push(`LEFT(${alias}.field_value, 10) < $${paramIndex++}`);
            params.push(today);
          } else {
            conditions.push(`${alias}.field_value = $${paramIndex++}`);
            params.push(filter.value);
          }
          continue;
        }
        
        // Special handling for completed
        if (filter.field === "completed") {
          conditions.push(`t.completed = $${paramIndex++}`);
          params.push(filter.value === "true");
          continue;
        }
        
        // Regular field filters
        joins.push(`LEFT JOIN task_fields ${alias} ON t.id = ${alias}.task_id AND ${alias}.field_name = $${paramIndex++}`);
        params.push(filter.field);
        
        switch (filter.op) {
          case "eq":
            conditions.push(`LOWER(${alias}.normalized_value) = LOWER($${paramIndex++})`);
            params.push(filter.value);
            break;
          case "contains":
            conditions.push(`LOWER(${alias}.normalized_value) LIKE LOWER($${paramIndex++})`);
            params.push(`%${filter.value}%`);
            break;
          case "startswith":
            conditions.push(`LOWER(${alias}.normalized_value) LIKE LOWER($${paramIndex++})`);
            params.push(`${filter.value}%`);
            break;
          case "gt":
            conditions.push(`${alias}.normalized_value > $${paramIndex++}`);
            params.push(filter.value);
            break;
          case "lt":
            conditions.push(`${alias}.normalized_value < $${paramIndex++}`);
            params.push(filter.value);
            break;
          case "exists":
            conditions.push(`${alias}.field_value IS NOT NULL`);
            break;
          case "not_exists":
            conditions.push(`${alias}.field_value IS NULL`);
            break;
        }
      }
    }
    
    // Build full SQL
    if (joins.length) {
      sql += " " + joins.join(" ");
    }
    
    sql += " WHERE " + conditions.join(" AND ");
    
    // Sorting
    if (query.sort) {
      sql += ` ORDER BY (SELECT normalized_value FROM task_fields WHERE task_id = t.id AND field_name = $${paramIndex++})`;
      params.push(query.sort);
    } else {
      sql += " ORDER BY t.created DESC";
    }
    
    // Get total count (save params count before adding pagination)
    const countParams = [...params];
    const countSql = `SELECT COUNT(DISTINCT t.id) as count FROM tasks t ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    const countResult = await this.pool!.query<{ count: string }>(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);
    
    // Pagination
    if (query.limit !== undefined) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }
    if (query.offset !== undefined) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(query.offset);
    }
    
    const result = await this.pool!.query<TaskRow>(sql, params);
    const tasks = result.rows.map((row) => this.rowToTask(row));
    
    // Apply grouping if requested
    let grouped: Record<string, Task[]> | undefined;
    if (query.groupBy) {
      grouped = this.applyGrouping(tasks, query.groupBy);
    }
    
    return { tasks, total, grouped };
  }

  // ---- Index Operations ----

  async loadIndex(): Promise<TaskIndex> {
    this.ensurePool();
    
    const result = await this.pool!.query<{ data: TaskIndex }>(
      "SELECT data FROM task_index WHERE id = 1"
    );
    
    if (result.rows.length === 0) {
      return { ...DEFAULT_INDEX };
    }
    
    const loaded = result.rows[0].data;
    return {
      tasks: loaded.tasks || [],
      structures: loaded.structures || {},
      aliases: loaded.aliases || {},
      templates: loaded.templates || {},
      stats: {
        totalCreated: loaded.stats?.totalCreated || 0,
        totalCompleted: loaded.stats?.totalCompleted || 0,
        totalCanceled: loaded.stats?.totalCanceled || 0,
        averageDuration: loaded.stats?.averageDuration || {},
        completionsByDay: loaded.stats?.completionsByDay || {},
        completionsByProject: loaded.stats?.completionsByProject || {},
        byStatus: loaded.stats?.byStatus || {
          active: 0,
          backlog: 0,
          completed: loaded.stats?.totalCompleted || 0,
          canceled: 0,
        },
      },
      scopes: loaded.scopes || {},
      subjectScopes: loaded.subjectScopes || {},
    };
  }

  async saveIndex(index: TaskIndex): Promise<void> {
    this.ensurePool();
    
    await this.pool!.query(
      "UPDATE task_index SET data = $1 WHERE id = 1",
      [JSON.stringify(index)]
    );
  }

  // ---- Schema Operations ----

  async loadSchema(): Promise<TaskSchema> {
    this.ensurePool();
    
    const result = await this.pool!.query<{ data: TaskSchema }>(
      "SELECT data FROM schema WHERE id = 1"
    );
    
    if (result.rows.length === 0) {
      return { ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() };
    }
    
    const loaded = result.rows[0].data;
    // Merge with defaults
    for (const [key, def] of Object.entries(DEFAULT_SCHEMA.fields)) {
      if (!loaded.fields[key]) {
        loaded.fields[key] = def;
      }
    }
    return loaded;
  }

  async saveSchema(schema: TaskSchema): Promise<void> {
    this.ensurePool();
    
    schema.lastUpdated = new Date().toISOString();
    await this.pool!.query(
      "UPDATE schema SET data = $1 WHERE id = 1",
      [JSON.stringify(schema)]
    );
  }

  // ---- Private Helpers ----

  private ensurePool(): void {
    if (!this.pool) {
      throw new Error("PostgreSQL pool not initialized. Call initialize() first.");
    }
  }

  private rowToTask(row: TaskRow): Task {
    // Infer status from completed if not stored
    let status: TaskStatus = "backlog";
    if (row.completed) {
      status = "completed";
    }
    
    return {
      id: row.id,
      raw: row.raw,
      created: row.created instanceof Date ? row.created.toISOString() : row.created,
      updated: row.updated instanceof Date ? row.updated.toISOString() : row.updated,
      status,
      completed: row.completed,
      completionInfo: row.completion_info || undefined,
      fields: row.fields,
      blocks: row.blocks || undefined,
      blockedBy: row.blocked_by || undefined,
      parent: row.parent || undefined,
      subtasks: row.subtasks || undefined,
      recurrence: row.recurrence || undefined,
      templateId: row.template_id || undefined,
    };
  }

  private getWeekRange(): { start: string; end: string } {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const start = new Date(today);
    start.setDate(today.getDate() - dayOfWeek);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
    };
  }
}

// Type for database rows
interface TaskRow {
  id: string;
  raw: string;
  created: string | Date;
  updated: string | Date;
  completed: boolean;
  completion_info: Task["completionInfo"] | null;
  fields: Record<string, Task["fields"][string]>;
  blocks: string[] | null;
  blocked_by: string[] | null;
  parent: string | null;
  subtasks: string[] | null;
  recurrence: Task["recurrence"] | null;
  template_id: string | null;
  archived: boolean;
}

