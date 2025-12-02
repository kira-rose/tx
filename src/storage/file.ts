// ============================================================================
// FILE-BASED STORAGE IMPLEMENTATION
// ============================================================================
// This is the original storage mechanism, now conforming to the IStorage interface.
// Tasks are stored as individual JSON files in a directory structure.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";

import { BaseStorage } from "./interface.js";
import {
  Task,
  TaskIndex,
  TaskSchema,
  FileStorageConfig,
  DEFAULT_SCHEMA,
  DEFAULT_INDEX,
} from "../types/index.js";

export class FileStorage extends BaseStorage {
  private basePath: string;
  private tasksDir: string;
  private archiveDir: string;
  private indexPath: string;
  private schemaPath: string;
  private initialized: boolean = false;

  constructor(config: FileStorageConfig) {
    super(config);
    this.basePath = config.basePath;
    this.tasksDir = join(this.basePath, "tasks");
    this.archiveDir = join(this.tasksDir, "archive");
    this.indexPath = join(this.tasksDir, "index.json");
    this.schemaPath = join(this.tasksDir, "schema.json");
  }

  async initialize(): Promise<void> {
    // Create directories if they don't exist
    for (const dir of [this.basePath, this.tasksDir, this.archiveDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    // No-op for file storage
    this.initialized = false;
  }

  async isReady(): Promise<boolean> {
    return this.initialized && existsSync(this.basePath);
  }

  // ---- Task Operations ----

  async saveTask(task: Task): Promise<void> {
    await this.ensureInitialized();
    const taskPath = join(this.tasksDir, `${task.id}.json`);
    writeFileSync(taskPath, JSON.stringify(task, null, 2));
  }

  async loadTask(id: string): Promise<Task | null> {
    await this.ensureInitialized();
    
    // Check active tasks
    const taskPath = join(this.tasksDir, `${id}.json`);
    if (existsSync(taskPath)) {
      try {
        const task = JSON.parse(readFileSync(taskPath, "utf-8")) as Task;
        return this.migrateTask(task);
      } catch {
        return null;
      }
    }
    
    // Check archive
    const archivePath = join(this.archiveDir, `${id}.json`);
    if (existsSync(archivePath)) {
      try {
        const task = JSON.parse(readFileSync(archivePath, "utf-8")) as Task;
        return this.migrateTask(task);
      } catch {
        return null;
      }
    }
    
    return null;
  }

  /**
   * Migrate old tasks that don't have a status field
   */
  private migrateTask(task: Task): Task {
    if (!task.status) {
      // Infer status from completed field
      if (task.completed) {
        task.status = "completed";
      } else {
        // Default new tasks to backlog - user can activate them
        task.status = "backlog";
      }
    }
    // Keep completed in sync with status
    task.completed = task.status === "completed";
    return task;
  }

  async deleteTask(id: string): Promise<boolean> {
    await this.ensureInitialized();
    
    const taskPath = join(this.tasksDir, `${id}.json`);
    if (existsSync(taskPath)) {
      unlinkSync(taskPath);
      await this.removeTaskFromIndex(id);
      return true;
    }
    
    return false;
  }

  async archiveTask(task: Task): Promise<void> {
    await this.ensureInitialized();
    
    // Write to archive
    const archivePath = join(this.archiveDir, `${task.id}.json`);
    writeFileSync(archivePath, JSON.stringify(task, null, 2));
    
    // Remove from active tasks
    const activePath = join(this.tasksDir, `${task.id}.json`);
    if (existsSync(activePath)) {
      unlinkSync(activePath);
    }
  }

  async loadAllTasks(includeCompleted = false): Promise<Task[]> {
    await this.ensureInitialized();
    
    const index = await this.loadIndex();
    const tasks: Task[] = [];
    
    for (const id of index.tasks) {
      const task = await this.loadTask(id);
      if (task) {
        // Legacy support: includeCompleted now means include all statuses
        if (includeCompleted || (task.status !== "completed" && task.status !== "canceled")) {
          tasks.push(task);
        }
      }
    }
    
    return tasks;
  }

  async getAllTaskIds(): Promise<string[]> {
    await this.ensureInitialized();
    const index = await this.loadIndex();
    return index.tasks;
  }

  // ---- Index Operations ----

  async loadIndex(): Promise<TaskIndex> {
    await this.ensureInitialized();
    
    if (!existsSync(this.indexPath)) {
      return { ...DEFAULT_INDEX };
    }
    
    try {
      const loaded = JSON.parse(readFileSync(this.indexPath, "utf-8"));
      // Merge with defaults to handle migration from older versions
      return {
        tasks: loaded.tasks || [],
        structures: loaded.structures || {},
        aliases: loaded.aliases || {},
        templates: loaded.templates || {},
        stats: {
          totalCreated: loaded.stats?.totalCreated || loaded.tasks?.length || 0,
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
    await this.ensureInitialized();
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }

  // ---- Schema Operations ----

  async loadSchema(): Promise<TaskSchema> {
    await this.ensureInitialized();
    
    if (!existsSync(this.schemaPath)) {
      // Create default schema
      const schema = { ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() };
      writeFileSync(this.schemaPath, JSON.stringify(schema, null, 2));
      return schema;
    }
    
    try {
      const loaded = JSON.parse(readFileSync(this.schemaPath, "utf-8")) as TaskSchema;
      // Merge with defaults to ensure all core fields exist
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
    await this.ensureInitialized();
    schema.lastUpdated = new Date().toISOString();
    writeFileSync(this.schemaPath, JSON.stringify(schema, null, 2));
  }

  // ---- Private Helpers ----

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

