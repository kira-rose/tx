// ============================================================================
// SQLITE STORAGE IMPLEMENTATION
// ============================================================================
// SQLite-based storage for local single-user deployments.
// Provides better query performance than file storage while remaining portable.

import { BaseStorage } from "./interface.js";
import {
  Task,
  TaskIndex,
  TaskSchema,
  TaskStatus,
  TaskQuery,
  TaskQueryResult,
  SQLiteStorageConfig,
  DEFAULT_SCHEMA,
  DEFAULT_INDEX,
  Note,
  NoteIndex,
  DEFAULT_NOTE_INDEX,
} from "../types/index.js";

// Note: This implementation uses better-sqlite3 for synchronous operations.
// The async wrapper allows for future migration to async drivers if needed.

interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SQLiteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export class SQLiteStorage extends BaseStorage {
  private db: SQLiteDatabase | null = null;
  private dbPath: string;

  constructor(config: SQLiteStorageConfig) {
    super(config);
    this.dbPath = config.path;
  }

  async initialize(): Promise<void> {
    // Dynamic import to avoid bundling issues
    const Database = (await import("better-sqlite3")).default;
    this.db = new Database(this.dbPath) as unknown as SQLiteDatabase;
    
    // Create tables
    this.db.exec(`
      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        raw TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        completion_info TEXT,
        fields TEXT NOT NULL,
        blocks TEXT,
        blocked_by TEXT,
        parent TEXT,
        subtasks TEXT,
        recurrence TEXT,
        template_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );

      -- Index on common query fields
      CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
      CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created);

      -- Task index (metadata about all tasks)
      CREATE TABLE IF NOT EXISTS task_index (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );

      -- Schema table
      CREATE TABLE IF NOT EXISTS schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );

      -- Extracted fields for efficient querying
      CREATE TABLE IF NOT EXISTS task_fields (
        task_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        field_value TEXT,
        normalized_value TEXT,
        PRIMARY KEY (task_id, field_name),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_fields_name ON task_fields(field_name);
      CREATE INDEX IF NOT EXISTS idx_task_fields_value ON task_fields(field_value);

      -- Notes table
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        raw TEXT NOT NULL,
        title TEXT,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        fields TEXT NOT NULL,
        tags TEXT NOT NULL,
        related_tasks TEXT,
        related_notes TEXT,
        source TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created);

      -- Note index
      CREATE TABLE IF NOT EXISTS note_index (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
    `);

    // Initialize index if not exists
    const indexExists = this.db.prepare("SELECT 1 FROM task_index WHERE id = 1").get();
    if (!indexExists) {
      this.db.prepare("INSERT INTO task_index (id, data) VALUES (1, ?)").run(
        JSON.stringify(DEFAULT_INDEX)
      );
    }

    // Initialize schema if not exists
    const schemaExists = this.db.prepare("SELECT 1 FROM schema WHERE id = 1").get();
    if (!schemaExists) {
      this.db.prepare("INSERT INTO schema (id, data) VALUES (1, ?)").run(
        JSON.stringify({ ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() })
      );
    }

    // Initialize note index if not exists
    const noteIndexExists = this.db.prepare("SELECT 1 FROM note_index WHERE id = 1").get();
    if (!noteIndexExists) {
      this.db.prepare("INSERT INTO note_index (id, data) VALUES (1, ?)").run(
        JSON.stringify(DEFAULT_NOTE_INDEX)
      );
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async isReady(): Promise<boolean> {
    return this.db !== null;
  }

  // ---- Task Operations ----

  async saveTask(task: Task): Promise<void> {
    this.ensureDb();
    
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, raw, created, updated, completed, completion_info,
        fields, blocks, blocked_by, parent, subtasks, recurrence, template_id, archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      task.id,
      task.raw,
      task.created,
      task.updated,
      task.completed ? 1 : 0,
      task.completionInfo ? JSON.stringify(task.completionInfo) : null,
      JSON.stringify(task.fields),
      task.blocks ? JSON.stringify(task.blocks) : null,
      task.blockedBy ? JSON.stringify(task.blockedBy) : null,
      task.parent || null,
      task.subtasks ? JSON.stringify(task.subtasks) : null,
      task.recurrence ? JSON.stringify(task.recurrence) : null,
      task.templateId || null,
      0 // not archived
    );

    // Update task_fields for efficient querying
    this.db!.prepare("DELETE FROM task_fields WHERE task_id = ?").run(task.id);
    
    const fieldStmt = this.db!.prepare(`
      INSERT INTO task_fields (task_id, field_name, field_value, normalized_value)
      VALUES (?, ?, ?, ?)
    `);
    
    for (const [name, field] of Object.entries(task.fields)) {
      const value = Array.isArray(field.value) 
        ? field.value.join(",") 
        : String(field.value ?? "");
      fieldStmt.run(task.id, name, value, field.normalized || value);
    }
  }

  async loadTask(id: string): Promise<Task | null> {
    this.ensureDb();
    
    const row = this.db!.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) return null;
    
    return this.rowToTask(row);
  }

  async findTaskByPrefix(prefix: string): Promise<Task | null> {
    this.ensureDb();
    
    const rows = this.db!.prepare(
      "SELECT * FROM tasks WHERE id LIKE ? AND archived = 0"
    ).all(`${prefix}%`) as TaskRow[];
    
    if (rows.length === 1) {
      return this.rowToTask(rows[0]);
    }
    
    return null;
  }

  async deleteTask(id: string): Promise<boolean> {
    this.ensureDb();
    
    const result = this.db!.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    
    if (result.changes > 0) {
      // Also remove from index
      const index = await this.loadIndex();
      index.tasks = index.tasks.filter((tid) => tid !== id);
      await this.saveIndex(index);
      return true;
    }
    
    return false;
  }

  async archiveTask(task: Task): Promise<void> {
    this.ensureDb();
    
    // Mark as archived in the database
    this.db!.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(task.id);
  }

  async loadAllTasks(includeCompleted = false): Promise<Task[]> {
    this.ensureDb();
    
    const sql = includeCompleted
      ? "SELECT * FROM tasks WHERE archived = 0"
      : "SELECT * FROM tasks WHERE archived = 0 AND completed = 0";
    
    const rows = this.db!.prepare(sql).all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  async getAllTaskIds(): Promise<string[]> {
    this.ensureDb();
    
    const rows = this.db!.prepare(
      "SELECT id FROM tasks WHERE archived = 0"
    ).all() as { id: string }[];
    
    return rows.map((row) => row.id);
  }

  // ---- Optimized Query Implementation ----

  async queryTasks(query: TaskQuery): Promise<TaskQueryResult> {
    this.ensureDb();
    
    let sql = "SELECT DISTINCT t.* FROM tasks t";
    const params: unknown[] = [];
    const joins: string[] = [];
    const conditions: string[] = ["t.archived = 0"];
    
    if (!query.includeCompleted) {
      conditions.push("t.completed = 0");
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
            conditions.push(`substr(${alias}.field_value, 1, 10) = ?`);
            params.push(today);
          } else if (filter.value === "this_week") {
            const { start, end } = this.getWeekRange();
            conditions.push(`substr(${alias}.field_value, 1, 10) BETWEEN ? AND ?`);
            params.push(start, end);
          } else if (filter.op === "lt" && filter.value === "today") {
            const today = new Date().toISOString().split("T")[0];
            conditions.push(`substr(${alias}.field_value, 1, 10) < ?`);
            params.push(today);
          } else {
            conditions.push(`${alias}.field_value = ?`);
            params.push(filter.value);
          }
          continue;
        }
        
        // Special handling for completed
        if (filter.field === "completed") {
          conditions.push(`t.completed = ?`);
          params.push(filter.value === "true" ? 1 : 0);
          continue;
        }
        
        // Regular field filters
        joins.push(`LEFT JOIN task_fields ${alias} ON t.id = ${alias}.task_id AND ${alias}.field_name = ?`);
        params.push(filter.field);
        
        switch (filter.op) {
          case "eq":
            conditions.push(`LOWER(${alias}.normalized_value) = LOWER(?)`);
            params.push(filter.value);
            break;
          case "contains":
            conditions.push(`LOWER(${alias}.normalized_value) LIKE LOWER(?)`);
            params.push(`%${filter.value}%`);
            break;
          case "startswith":
            conditions.push(`LOWER(${alias}.normalized_value) LIKE LOWER(?)`);
            params.push(`${filter.value}%`);
            break;
          case "gt":
            conditions.push(`${alias}.normalized_value > ?`);
            params.push(filter.value);
            break;
          case "lt":
            conditions.push(`${alias}.normalized_value < ?`);
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
      sql += ` ORDER BY (SELECT normalized_value FROM task_fields WHERE task_id = t.id AND field_name = ?)`;
      params.push(query.sort);
    } else {
      sql += " ORDER BY t.created DESC";
    }
    
    // Get total count
    const countSql = `SELECT COUNT(DISTINCT t.id) as count FROM tasks t ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    const countRow = this.db!.prepare(countSql).get(...params) as { count: number };
    const total = countRow.count;
    
    // Pagination
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    if (query.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(query.offset);
    }
    
    const rows = this.db!.prepare(sql).all(...params) as TaskRow[];
    const tasks = rows.map((row) => this.rowToTask(row));
    
    // Apply grouping if requested
    let grouped: Record<string, Task[]> | undefined;
    if (query.groupBy) {
      grouped = this.applyGrouping(tasks, query.groupBy);
    }
    
    return { tasks, total, grouped };
  }

  // ---- Index Operations ----

  async loadIndex(): Promise<TaskIndex> {
    this.ensureDb();
    
    const row = this.db!.prepare("SELECT data FROM task_index WHERE id = 1").get() as { data: string } | undefined;
    if (!row) {
      return { ...DEFAULT_INDEX };
    }
    
    try {
      const loaded = JSON.parse(row.data);
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
    } catch {
      return { ...DEFAULT_INDEX };
    }
  }

  async saveIndex(index: TaskIndex): Promise<void> {
    this.ensureDb();
    
    this.db!.prepare("UPDATE task_index SET data = ? WHERE id = 1").run(
      JSON.stringify(index)
    );
  }

  // ---- Schema Operations ----

  async loadSchema(): Promise<TaskSchema> {
    this.ensureDb();
    
    const row = this.db!.prepare("SELECT data FROM schema WHERE id = 1").get() as { data: string } | undefined;
    if (!row) {
      return { ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() };
    }
    
    try {
      const loaded = JSON.parse(row.data) as TaskSchema;
      // Merge with defaults
      for (const [key, def] of Object.entries(DEFAULT_SCHEMA.fields)) {
        if (!loaded.fields[key]) {
          loaded.fields[key] = def;
        }
      }
      return loaded;
    } catch {
      return { ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() };
    }
  }

  async saveSchema(schema: TaskSchema): Promise<void> {
    this.ensureDb();
    
    schema.lastUpdated = new Date().toISOString();
    this.db!.prepare("UPDATE schema SET data = ? WHERE id = 1").run(
      JSON.stringify(schema)
    );
  }

  // ---- Private Helpers ----

  private ensureDb(): void {
    if (!this.db) {
      throw new Error("SQLite database not initialized. Call initialize() first.");
    }
  }

  private rowToTask(row: TaskRow): Task {
    const completed = row.completed === 1;
    // Infer status from completed if not stored
    let status: TaskStatus = "backlog";
    if (completed) {
      status = "completed";
    }
    // Check if there's a status field stored
    const fields = JSON.parse(row.fields);
    
    return {
      id: row.id,
      raw: row.raw,
      created: row.created,
      updated: row.updated,
      status,
      completed,
      completionInfo: row.completion_info ? JSON.parse(row.completion_info) : undefined,
      fields,
      blocks: row.blocks ? JSON.parse(row.blocks) : undefined,
      blockedBy: row.blocked_by ? JSON.parse(row.blocked_by) : undefined,
      parent: row.parent || undefined,
      subtasks: row.subtasks ? JSON.parse(row.subtasks) : undefined,
      recurrence: row.recurrence ? JSON.parse(row.recurrence) : undefined,
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

  // ---- Note Operations ----

  async saveNote(note: Note): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO notes (
        id, raw, title, created, updated, fields, tags,
        related_tasks, related_notes, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      note.id,
      note.raw,
      note.title || null,
      note.created,
      note.updated,
      JSON.stringify(note.fields),
      JSON.stringify(note.tags),
      note.relatedTasks ? JSON.stringify(note.relatedTasks) : null,
      note.relatedNotes ? JSON.stringify(note.relatedNotes) : null,
      note.source || null
    );
  }

  async loadNote(id: string): Promise<Note | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
    if (!row) return null;

    return this.noteFromRow(row);
  }

  async deleteNote(id: string): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    if (result.changes > 0) {
      // Update index
      const index = await this.loadNoteIndex();
      index.notes = index.notes.filter((nid) => nid !== id);
      await this.saveNoteIndex(index);
      return true;
    }
    return false;
  }

  async loadAllNotes(): Promise<Note[]> {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db.prepare("SELECT * FROM notes ORDER BY created DESC").all() as NoteRow[];
    return rows.map((row) => this.noteFromRow(row));
  }

  async loadNoteIndex(): Promise<NoteIndex> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare("SELECT data FROM note_index WHERE id = 1").get() as { data: string } | undefined;
    if (!row) return { ...DEFAULT_NOTE_INDEX };

    try {
      return JSON.parse(row.data);
    } catch {
      return { ...DEFAULT_NOTE_INDEX };
    }
  }

  async saveNoteIndex(index: NoteIndex): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    this.db.prepare("UPDATE note_index SET data = ? WHERE id = 1").run(JSON.stringify(index));
  }

  async getAllNoteIds(): Promise<string[]> {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db.prepare("SELECT id FROM notes").all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  private noteFromRow(row: NoteRow): Note {
    return {
      id: row.id,
      raw: row.raw,
      title: row.title || undefined,
      created: row.created,
      updated: row.updated,
      fields: JSON.parse(row.fields),
      tags: JSON.parse(row.tags),
      relatedTasks: row.related_tasks ? JSON.parse(row.related_tasks) : undefined,
      relatedNotes: row.related_notes ? JSON.parse(row.related_notes) : undefined,
      source: row.source || undefined,
    };
  }
}

// Type for database rows
interface TaskRow {
  id: string;
  raw: string;
  created: string;
  updated: string;
  completed: number;
  completion_info: string | null;
  fields: string;
  blocks: string | null;
  blocked_by: string | null;
  parent: string | null;
  subtasks: string | null;
  recurrence: string | null;
  template_id: string | null;
  archived: number;
}

interface NoteRow {
  id: string;
  raw: string;
  title: string | null;
  created: string;
  updated: string;
  fields: string;
  tags: string;
  related_tasks: string | null;
  related_notes: string | null;
  source: string | null;
}

