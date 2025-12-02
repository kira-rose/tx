// ============================================================================
// STORAGE INTERFACE CONTRACT
// ============================================================================
// This interface defines the contract that all storage backends must implement.
// It provides a clean abstraction layer between the application logic and
// the underlying persistence mechanism (file, SQLite, PostgreSQL).

import {
  Task,
  TaskIndex,
  TaskSchema,
  TaskQuery,
  TaskQueryResult,
  TaskStatus,
  StorageConfig,
} from "../types/index.js";

/**
 * Storage interface that all backends must implement.
 * This enables swapping between file-based, SQLite, and PostgreSQL storage
 * without changing any application logic.
 */
export interface IStorage {
  // ---- Lifecycle ----
  
  /**
   * Initialize the storage backend (create directories, tables, etc.)
   */
  initialize(): Promise<void>;
  
  /**
   * Close any open connections and clean up resources
   */
  close(): Promise<void>;
  
  /**
   * Check if the storage is properly initialized and connected
   */
  isReady(): Promise<boolean>;

  // ---- Task Operations ----
  
  /**
   * Save a task (create or update)
   */
  saveTask(task: Task): Promise<void>;
  
  /**
   * Load a task by its full ID
   * @returns The task or null if not found
   */
  loadTask(id: string): Promise<Task | null>;
  
  /**
   * Find a task by ID prefix (like Docker's short IDs)
   * @returns The task if exactly one match found, null otherwise
   */
  findTaskByPrefix(prefix: string): Promise<Task | null>;
  
  /**
   * Delete a task permanently
   * @returns true if the task was deleted, false if not found
   */
  deleteTask(id: string): Promise<boolean>;
  
  /**
   * Archive a completed task (move to archive storage)
   */
  archiveTask(task: Task): Promise<void>;
  
  /**
   * Load all tasks, optionally including completed ones
   */
  loadAllTasks(includeCompleted?: boolean): Promise<Task[]>;
  
  /**
   * Query tasks with filters, sorting, and pagination
   */
  queryTasks(query: TaskQuery): Promise<TaskQueryResult>;

  // ---- Index Operations ----
  
  /**
   * Load the task index
   */
  loadIndex(): Promise<TaskIndex>;
  
  /**
   * Save the task index
   */
  saveIndex(index: TaskIndex): Promise<void>;
  
  /**
   * Add a task ID to the index
   */
  addTaskToIndex(taskId: string): Promise<void>;
  
  /**
   * Remove a task ID from the index
   */
  removeTaskFromIndex(taskId: string): Promise<void>;

  // ---- Schema Operations ----
  
  /**
   * Load the semantic schema
   */
  loadSchema(): Promise<TaskSchema>;
  
  /**
   * Save the semantic schema
   */
  saveSchema(schema: TaskSchema): Promise<void>;

  // ---- Bulk Operations ----
  
  /**
   * Get all task IDs in the index
   */
  getAllTaskIds(): Promise<string[]>;
  
  /**
   * Get count of tasks matching a query
   */
  countTasks(query?: TaskQuery): Promise<number>;
  
  /**
   * Export all data (for backup/migration)
   */
  exportAll(): Promise<{
    tasks: Task[];
    index: TaskIndex;
    schema: TaskSchema;
  }>;
  
  /**
   * Import data (for restore/migration)
   */
  importAll(data: {
    tasks: Task[];
    index: TaskIndex;
    schema: TaskSchema;
  }): Promise<void>;
}

/**
 * Factory function type for creating storage instances
 */
export type StorageFactory = (config: StorageConfig) => IStorage;

/**
 * Abstract base class with common utility methods
 * Storage implementations can extend this for shared functionality
 */
export abstract class BaseStorage implements IStorage {
  protected config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
  }

  // Abstract methods that must be implemented
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract isReady(): Promise<boolean>;
  abstract saveTask(task: Task): Promise<void>;
  abstract loadTask(id: string): Promise<Task | null>;
  abstract deleteTask(id: string): Promise<boolean>;
  abstract archiveTask(task: Task): Promise<void>;
  abstract loadAllTasks(includeCompleted?: boolean): Promise<Task[]>;
  abstract loadIndex(): Promise<TaskIndex>;
  abstract saveIndex(index: TaskIndex): Promise<void>;
  abstract loadSchema(): Promise<TaskSchema>;
  abstract saveSchema(schema: TaskSchema): Promise<void>;
  abstract getAllTaskIds(): Promise<string[]>;

  /**
   * Default implementation of findTaskByPrefix using getAllTaskIds
   * Can be overridden for more efficient implementations
   */
  async findTaskByPrefix(prefix: string): Promise<Task | null> {
    const allIds = await this.getAllTaskIds();
    const matches = allIds.filter((id) => id.startsWith(prefix));
    
    if (matches.length === 1) {
      return this.loadTask(matches[0]);
    }
    
    return null;
  }

  /**
   * Default implementation of addTaskToIndex
   */
  async addTaskToIndex(taskId: string): Promise<void> {
    const index = await this.loadIndex();
    if (!index.tasks.includes(taskId)) {
      index.tasks.push(taskId);
      await this.saveIndex(index);
    }
  }

  /**
   * Default implementation of removeTaskFromIndex
   */
  async removeTaskFromIndex(taskId: string): Promise<void> {
    const index = await this.loadIndex();
    index.tasks = index.tasks.filter((id) => id !== taskId);
    await this.saveIndex(index);
  }

  /**
   * Default implementation of queryTasks with in-memory filtering
   * Can be overridden for database-native query execution
   */
  async queryTasks(query: TaskQuery): Promise<TaskQueryResult> {
    // Determine which statuses to include
    let statusFilter: TaskStatus[];
    if (query.status) {
      statusFilter = query.status;
    } else if (query.includeCompleted) {
      // Legacy support
      statusFilter = ["active", "backlog", "completed", "canceled"];
    } else {
      // Default: active and backlog only
      statusFilter = ["active", "backlog"];
    }

    let tasks = await this.loadAllTasks(true); // Load all, we'll filter by status
    
    // Apply status filter
    tasks = tasks.filter((t) => statusFilter.includes(t.status));
    
    // Apply filters
    if (query.filters?.length) {
      tasks = this.applyFilters(tasks, query.filters);
    }
    
    // Apply sorting
    if (query.sort) {
      tasks = this.applySorting(tasks, query.sort);
    }
    
    const total = tasks.length;
    
    // Apply pagination
    if (query.offset !== undefined) {
      tasks = tasks.slice(query.offset);
    }
    if (query.limit !== undefined) {
      tasks = tasks.slice(0, query.limit);
    }
    
    // Apply grouping
    let grouped: Record<string, Task[]> | undefined;
    if (query.groupBy) {
      grouped = this.applyGrouping(tasks, query.groupBy);
    }
    
    return { tasks, total, grouped };
  }

  /**
   * Default implementation of countTasks
   */
  async countTasks(query?: TaskQuery): Promise<number> {
    if (!query) {
      const ids = await this.getAllTaskIds();
      return ids.length;
    }
    
    const result = await this.queryTasks({ ...query, limit: undefined, offset: undefined });
    return result.total;
  }

  /**
   * Default implementation of exportAll
   */
  async exportAll(): Promise<{
    tasks: Task[];
    index: TaskIndex;
    schema: TaskSchema;
  }> {
    const [tasks, index, schema] = await Promise.all([
      this.loadAllTasks(true),
      this.loadIndex(),
      this.loadSchema(),
    ]);
    
    return { tasks, index, schema };
  }

  /**
   * Default implementation of importAll
   */
  async importAll(data: {
    tasks: Task[];
    index: TaskIndex;
    schema: TaskSchema;
  }): Promise<void> {
    // Save schema first
    await this.saveSchema(data.schema);
    
    // Save all tasks
    for (const task of data.tasks) {
      await this.saveTask(task);
    }
    
    // Save index
    await this.saveIndex(data.index);
  }

  // ---- Protected Helper Methods ----

  protected applyFilters(tasks: Task[], filters: TaskQuery["filters"]): Task[] {
    if (!filters) return tasks;
    
    return tasks.filter((task) => {
      return filters.every((filter) => {
        // Special handling for deadline comparisons
        if (filter.field === "deadline") {
          const deadline = task.fields.deadline?.value as string;
          if (!deadline) return false;
          
          const today = new Date().toISOString().split("T")[0];
          
          if (filter.value === "today") {
            const deadlineDate = deadline.split("T")[0];
            return filter.op === "eq" ? deadlineDate === today : false;
          }
          if (filter.value === "this_week") {
            return this.isThisWeek(deadline);
          }
          if (filter.op === "lt" && filter.value === "today") {
            return this.isOverdue(deadline);
          }
        }
        
        // Special handling for completed
        if (filter.field === "completed") {
          return task.completed === (filter.value === "true");
        }
        
        const field = task.fields[filter.field];
        if (!field) return filter.op === "not_exists";
        if (filter.op === "exists") return true;
        
        const fieldValue = String(field.normalized || field.value).toLowerCase();
        const queryValue = filter.value.toLowerCase();
        
        switch (filter.op) {
          case "eq":
            return fieldValue === queryValue;
          case "contains":
            return fieldValue.includes(queryValue);
          case "startswith":
            return fieldValue.startsWith(queryValue);
          case "gt":
            return fieldValue > queryValue;
          case "lt":
            return fieldValue < queryValue;
          default:
            return fieldValue === queryValue;
        }
      });
    });
  }

  protected applySorting(tasks: Task[], sortField: string): Task[] {
    return [...tasks].sort((a, b) => {
      const aVal = String(a.fields[sortField]?.value || "");
      const bVal = String(b.fields[sortField]?.value || "");
      return aVal.localeCompare(bVal);
    });
  }

  protected applyGrouping(tasks: Task[], groupBy: string): Record<string, Task[]> {
    const groups: Record<string, Task[]> = {};
    
    for (const task of tasks) {
      const value = String(task.fields[groupBy]?.value || "ungrouped");
      if (!groups[value]) {
        groups[value] = [];
      }
      groups[value].push(task);
    }
    
    return groups;
  }

  protected isOverdue(deadline: string): boolean {
    const deadlineDate = deadline.split("T")[0];
    const today = new Date().toISOString().split("T")[0];
    
    if (deadlineDate === today && deadline.includes("T")) {
      return new Date(deadline) < new Date();
    }
    
    return deadlineDate < today;
  }

  protected isThisWeek(deadline: string): boolean {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const start = new Date(today);
    start.setDate(today.getDate() - dayOfWeek);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    
    const deadlineDate = deadline.split("T")[0];
    const startStr = start.toISOString().split("T")[0];
    const endStr = end.toISOString().split("T")[0];
    
    return deadlineDate >= startStr && deadlineDate <= endStr;
  }
}

