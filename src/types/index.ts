// ============================================================================
// CORE TYPES - Shared across CLI, Server, and Storage
// ============================================================================

// ---- Task Status Types ----

export type TaskStatus = "active" | "backlog" | "completed" | "canceled";

// ---- Scope Types ----

/**
 * A Scope represents a high-level domain or life area.
 * Subjects/projects are categorized within scopes.
 * Examples: "work", "home", "personal", "health"
 */
export interface Scope {
  id: string;
  name: string;
  description?: string;
  color?: string; // For UI display
  icon?: string; // Emoji or icon name
  created: string;
  updated: string;
  // Subjects that belong to this scope
  subjects: string[];
  // Optional parent scope for nested hierarchies
  parent?: string;
}

// ---- Semantic Field Types ----

export interface SemanticField {
  name: string;
  value: string | string[] | number | boolean | null;
  confidence?: number;
  normalized?: string; // Canonical form
}

// ---- Task Types ----

export interface CompletionInfo {
  completedAt: string;
  duration?: number; // minutes
  notes?: string;
  actualEffort?: string;
}

export interface TaskRecurrence {
  pattern: string; // daily, weekly, monthly, yearly
  interval?: number; // every N days/weeks/etc
  dayOfWeek?: string; // monday, tuesday, etc
  dayOfMonth?: number; // 1-31
  nextDue?: string; // ISO date
}

export interface Task {
  id: string;
  raw: string;
  created: string;
  updated: string;
  status: TaskStatus;
  // Legacy field for backwards compatibility - derived from status
  completed: boolean;
  completionInfo?: CompletionInfo;
  canceledInfo?: {
    canceledAt: string;
    reason?: string;
  };
  fields: Record<string, SemanticField>;
  // Relationships
  blocks?: string[]; // Task IDs this blocks
  blockedBy?: string[]; // Task IDs blocking this
  parent?: string; // Parent task ID
  subtasks?: string[]; // Subtask IDs
  // Recurrence
  recurrence?: TaskRecurrence;
  // Template
  templateId?: string; // If created from a template
}

// ---- Index Types ----

export interface StructureInfo {
  name: string;
  occurrences: number;
  examples: string[];
  type: "string" | "date" | "datetime" | "number" | "boolean" | "array" | "duration" | "unknown";
}

export interface TaskTemplate {
  id: string;
  name: string;
  pattern: string; // regex or description
  defaultFields: Record<string, SemanticField>;
  occurrences: number;
}

export interface TaskStats {
  totalCreated: number;
  totalCompleted: number;
  totalCanceled: number;
  averageDuration: Record<string, number>; // task_type -> avg minutes
  completionsByDay: Record<string, number>; // ISO date -> count
  completionsByProject: Record<string, number>;
  byStatus: Record<TaskStatus, number>; // count by status
}

export interface TaskIndex {
  tasks: string[];
  structures: Record<string, StructureInfo>;
  aliases: Record<string, string[]>; // canonical -> [variants]
  templates: Record<string, TaskTemplate>;
  stats: TaskStats;
  // Scope management
  scopes: Record<string, Scope>;
  // Subject to scope mapping (subject_name -> scope_id)
  subjectScopes: Record<string, string>;
}

// ---- Schema Types ----

export type FieldType = "string" | "date" | "datetime" | "number" | "boolean" | "array" | "duration";
export type FieldCategory = "core" | "relationship" | "recurrence" | "custom";

export interface FieldDefinition {
  type: FieldType;
  description: string;
  examples?: string[];
  aliases?: string[]; // Alternative names that map to this field
  enum?: string[]; // Allowed values for string types
  category?: FieldCategory;
}

export interface TaskSchema {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  version: number;
  lastUpdated: string;
  fields: Record<string, FieldDefinition>;
}

// ---- LLM Provider Config Types ----

export interface BedrockConfig {
  model?: string;
  region?: string;
}

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LocalConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type LLMProvider = "bedrock" | "openai" | "local";

export interface LLMConfig {
  provider: LLMProvider;
  bedrock?: BedrockConfig;
  openai?: OpenAIConfig;
  local?: LocalConfig;
}

// ---- Storage Config Types ----

export type StorageBackend = "file" | "sqlite" | "postgres";

export interface FileStorageConfig {
  type: "file";
  basePath: string; // Directory for task files
}

export interface SQLiteStorageConfig {
  type: "sqlite";
  path: string; // Path to SQLite database file
}

export interface PostgresStorageConfig {
  type: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export type StorageConfig = FileStorageConfig | SQLiteStorageConfig | PostgresStorageConfig;

// ---- Main Config Type ----

export interface TxConfig {
  // LLM configuration for semantic extraction
  llm: LLMConfig;
  // Storage backend configuration
  storage: StorageConfig;
  // Current active scope (namespace) - tasks are created in this scope
  currentScope?: string;
}

// ---- Default Configurations ----

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  provider: "bedrock",
  bedrock: {
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    region: "us-east-1",
  },
  openai: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "your-api-key-here",
    model: "anthropic/claude-3.5-sonnet",
  },
  local: {
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
  },
};

export const DEFAULT_FILE_STORAGE_CONFIG: FileStorageConfig = {
  type: "file",
  basePath: "", // Will be set to ~/.tx/data at runtime
};

export const DEFAULT_TX_CONFIG: TxConfig = {
  llm: DEFAULT_LLM_CONFIG,
  storage: DEFAULT_FILE_STORAGE_CONFIG,
};

// ---- Default Schema ----

export const DEFAULT_SCHEMA: TaskSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "tx-task-schema",
  title: "Task Semantic Schema",
  description: "Defines the semantic fields that can be extracted from task descriptions",
  version: 1,
  lastUpdated: new Date().toISOString(),
  fields: {
    // Core fields
    action: {
      type: "string",
      description: "The core verb/action to be performed",
      examples: ["update", "fix", "call", "review", "deploy", "write"],
      category: "core",
    },
    summary: {
      type: "string",
      description: "A brief one-line summary of the task",
      category: "core",
    },
    scope: {
      type: "string",
      description: "High-level domain or life area (e.g., work, home, personal). Scopes contain subjects.",
      examples: ["work", "home", "personal", "health", "finance"],
      category: "core",
    },
    subject: {
      type: "string",
      description: "The project, system, or area this task relates to (within a scope)",
      aliases: ["project"],
      examples: ["webapp", "backend", "documentation"],
      category: "core",
    },
    deadline: {
      type: "datetime",
      description: "When the task is due. Use YYYY-MM-DD for date-only, or YYYY-MM-DDTHH:MM for date+time",
      examples: ["2025-12-03", "2025-12-03T14:00", "2025-01-15T09:30"],
      category: "core",
    },
    priority: {
      type: "string",
      description: "Task urgency level",
      enum: ["urgent", "high", "normal", "low"],
      category: "core",
    },
    people: {
      type: "array",
      description: "People mentioned or involved in the task",
      examples: ["john_smith", "sarah"],
      category: "core",
    },
    context: {
      type: "string",
      description: "GTD-style context indicating where/how the task can be done",
      enum: ["@computer", "@phone", "@errands", "@home", "@work", "@anywhere"],
      category: "core",
    },
    tags: {
      type: "array",
      description: "Categories or labels for the task",
      category: "core",
    },
    effort: {
      type: "duration",
      description: "Estimated time/effort required",
      enum: ["quick", "30min", "1hour", "2hours", "half-day", "full-day", "multi-day"],
      category: "core",
    },
    energy: {
      type: "string",
      description: "Mental energy level required",
      enum: ["high", "medium", "low"],
      aliases: ["focus"],
      category: "core",
    },
    task_type: {
      type: "string",
      description: "Category of task",
      examples: ["bug_fix", "feature", "meeting", "communication", "review", "deployment", "research"],
      category: "core",
    },
    // Relationship fields
    blocks: {
      type: "array",
      description: "Task IDs that this task blocks",
      category: "relationship",
    },
    related_to: {
      type: "array",
      description: "Related projects, tasks, or concepts",
      category: "relationship",
    },
    depends_on: {
      type: "array",
      description: "Prerequisites or dependencies",
      category: "relationship",
    },
    // Recurrence fields
    recurrence_pattern: {
      type: "string",
      description: "How often the task repeats",
      enum: ["daily", "weekly", "monthly", "yearly"],
      category: "recurrence",
    },
    recurrence_day: {
      type: "string",
      description: "Specific day for recurrence",
      examples: ["monday", "1st", "15th", "last"],
      category: "recurrence",
    },
  },
};

// ---- Default Index ----

export const DEFAULT_INDEX: TaskIndex = {
  tasks: [],
  structures: {},
  aliases: {},
  templates: {},
  stats: {
    totalCreated: 0,
    totalCompleted: 0,
    totalCanceled: 0,
    averageDuration: {},
    completionsByDay: {},
    completionsByProject: {},
    byStatus: {
      active: 0,
      backlog: 0,
      completed: 0,
      canceled: 0,
    },
  },
  scopes: {},
  subjectScopes: {},
};

// ---- Query Types (for tRPC interface later) ----

export interface TaskFilter {
  field: string;
  op: "eq" | "contains" | "gt" | "lt" | "exists" | "not_exists" | "startswith";
  value: string;
}

export interface TaskQuery {
  filters?: TaskFilter[];
  groupBy?: string;
  sort?: string;
  /** @deprecated Use status filter instead */
  includeCompleted?: boolean;
  /** Filter by status (default: ["active", "backlog"]) */
  status?: TaskStatus[];
  limit?: number;
  offset?: number;
}

export interface TaskQueryResult {
  tasks: Task[];
  total: number;
  grouped?: Record<string, Task[]>;
}

// ---- API Types (for server interface) ----

export interface CreateTaskInput {
  raw: string;
  blocks?: string; // Task ID this blocks
}

export interface CreateTaskResult {
  tasks: Task[];
  schemaUpdated: boolean;
}

export interface CompleteTaskInput {
  taskId: string;
  duration?: number; // minutes
  notes?: string;
}

export interface CancelTaskInput {
  taskId: string;
  reason?: string;
}

export interface ActivateTaskInput {
  taskId: string;
}

export interface BacklogTaskInput {
  taskId: string;
}

// ---- Scope API Types ----

export interface CreateScopeInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parent?: string; // Parent scope ID for nesting
}

export interface UpdateScopeInput {
  id: string;
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  parent?: string;
}

export interface AssignSubjectToScopeInput {
  subject: string;
  scopeId: string;
}

export interface UpdateTaskInput {
  taskId: string;
  fields?: Record<string, SemanticField>;
  blocks?: string[];
  blockedBy?: string[];
}

