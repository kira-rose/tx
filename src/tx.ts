#!/usr/bin/env node

import { ChatBedrockConverse } from "@langchain/aws";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { homedir } from "os";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { createInterface } from "readline";

// ============================================================================
// TYPES
// ============================================================================

interface BedrockConfig {
  model?: string;
  region?: string;
}

interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LocalConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface Config {
  provider: "bedrock" | "openai" | "local";
  bedrock?: BedrockConfig;
  openai?: OpenAIConfig;
  local?: LocalConfig;
}

interface SemanticField {
  name: string;
  value: string | string[] | number | boolean | null;
  confidence?: number;
  normalized?: string; // Canonical form
}

interface CompletionInfo {
  completedAt: string;
  duration?: number; // minutes
  notes?: string;
  actualEffort?: string;
}

interface Task {
  id: string;
  raw: string;
  created: string;
  updated: string;
  completed: boolean;
  completionInfo?: CompletionInfo;
  fields: Record<string, SemanticField>;
  // Relationships
  blocks?: string[]; // Task IDs this blocks
  blockedBy?: string[]; // Task IDs blocking this
  parent?: string; // Parent task ID
  subtasks?: string[]; // Subtask IDs
  // Recurrence
  recurrence?: {
    pattern: string; // daily, weekly, monthly, yearly
    interval?: number; // every N days/weeks/etc
    dayOfWeek?: string; // monday, tuesday, etc
    dayOfMonth?: number; // 1-31
    nextDue?: string; // ISO date
  };
  // Template
  templateId?: string; // If created from a template
}

interface TaskIndex {
  tasks: string[];
  structures: Record<string, StructureInfo>;
  aliases: Record<string, string[]>; // canonical -> [variants]
  templates: Record<string, TaskTemplate>;
  stats: TaskStats;
}

interface StructureInfo {
  name: string;
  occurrences: number;
  examples: string[];
  type: "string" | "date" | "datetime" | "number" | "boolean" | "array" | "duration" | "unknown";
}

interface TaskTemplate {
  id: string;
  name: string;
  pattern: string; // regex or description
  defaultFields: Record<string, SemanticField>;
  occurrences: number;
}

interface TaskStats {
  totalCreated: number;
  totalCompleted: number;
  averageDuration: Record<string, number>; // task_type -> avg minutes
  completionsByDay: Record<string, number>; // ISO date -> count
  completionsByProject: Record<string, number>;
}

// JSON Schema for semantic fields
interface FieldDefinition {
  type: "string" | "date" | "datetime" | "number" | "boolean" | "array" | "duration";
  description: string;
  examples?: string[];
  aliases?: string[]; // Alternative names that map to this field
  enum?: string[]; // Allowed values for string types
  category?: "core" | "relationship" | "recurrence" | "custom";
}

interface TaskSchema {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  version: number;
  lastUpdated: string;
  fields: Record<string, FieldDefinition>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONFIG_DIR = join(homedir(), ".cx");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const TASKS_DIR = join(CONFIG_DIR, "tasks");
const INDEX_PATH = join(TASKS_DIR, "index.json");
const SCHEMA_PATH = join(TASKS_DIR, "schema.json");
const ARCHIVE_DIR = join(TASKS_DIR, "archive");

const DEFAULT_SCHEMA: TaskSchema = {
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
    subject: {
      type: "string",
      description: "The project, system, or area this task relates to",
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

const DEFAULT_CONFIG: Config = {
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

// ============================================================================
// UTILITIES
// ============================================================================

function ensureDirectories() {
  for (const dir of [CONFIG_DIR, TASKS_DIR, ARCHIVE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function loadConfig(): Config {
  ensureDirectories();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`\x1b[33mCreated default config at ${CONFIG_PATH}\x1b[0m`);
    return DEFAULT_CONFIG;
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Config;
  } catch {
    console.error(`\x1b[31mError reading config\x1b[0m`);
    process.exit(1);
  }
}

function createModel(config: Config): BaseChatModel {
  switch (config.provider) {
    case "bedrock":
      return new ChatBedrockConverse({
        model: config.bedrock?.model || "anthropic.claude-3-5-sonnet-20241022-v2:0",
        region: config.bedrock?.region || "us-east-1",
      });
    case "openai":
      if (!config.openai) throw new Error("OpenAI config not found");
      return new ChatOpenAI({
        modelName: config.openai.model,
        openAIApiKey: config.openai.apiKey,
        configuration: { baseURL: config.openai.baseUrl },
      });
    case "local":
      if (!config.local) throw new Error("Local config not found");
      return new ChatOpenAI({
        modelName: config.local.model,
        openAIApiKey: config.local.apiKey || "not-needed",
        configuration: { baseURL: config.local.baseUrl },
      });
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// DATE UTILITIES
// ============================================================================

function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

function getDayOfWeek(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
}

function parseRelativeDate(text: string): string | null {
  const today = new Date();
  const lower = text.toLowerCase();

  if (lower === "today") {
    return getToday();
  }
  if (lower === "tomorrow") {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  }
  if (lower === "yesterday") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  }

  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIndex = days.indexOf(lower);
  if (dayIndex !== -1) {
    const currentDay = today.getDay();
    let daysUntil = dayIndex - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + daysUntil);
    return d.toISOString().split("T")[0];
  }

  // Check for "next week", "in N days", etc.
  const inDaysMatch = lower.match(/in (\d+) days?/);
  if (inDaysMatch) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1]));
    return d.toISOString().split("T")[0];
  }

  const nextWeekMatch = lower.match(/next week/);
  if (nextWeekMatch) {
    const d = new Date(today);
    d.setDate(d.getDate() + 7);
    return d.toISOString().split("T")[0];
  }

  return null;
}

function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  const lower = timeStr.toLowerCase().trim();
  
  // Match patterns like "2pm", "2:30pm", "14:00", "2:30 pm"
  const match12h = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match12h) {
    let hours = parseInt(match12h[1]);
    const minutes = parseInt(match12h[2] || "0");
    const ampm = match12h[3];
    
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    
    return { hours, minutes };
  }
  
  // Match 24-hour format like "14:00", "09:30"
  const match24h = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (match24h) {
    return { hours: parseInt(match24h[1]), minutes: parseInt(match24h[2]) };
  }
  
  return null;
}

function normalizeDeadline(value: string): string {
  // Already valid ISO date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  
  // Already valid ISO datetime (YYYY-MM-DDTHH:MM)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  
  const lower = value.toLowerCase().trim();
  const today = getToday();
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  })();
  
  // Patterns like "2pm today", "today at 2pm", "today 2pm"
  const todayTimeMatch = lower.match(/(?:today\s*(?:at\s*)?|(?:at\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*today)/);
  if (lower.includes("today")) {
    const timeMatch = lower.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/);
    if (timeMatch) {
      const time = parseTime(timeMatch[1]);
      if (time) {
        const hours = time.hours.toString().padStart(2, "0");
        const mins = time.minutes.toString().padStart(2, "0");
        return `${today}T${hours}:${mins}`;
      }
    }
    return today;
  }
  
  // Patterns like "2pm tomorrow", "tomorrow at 2pm"
  if (lower.includes("tomorrow")) {
    const timeMatch = lower.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/);
    if (timeMatch) {
      const time = parseTime(timeMatch[1]);
      if (time) {
        const hours = time.hours.toString().padStart(2, "0");
        const mins = time.minutes.toString().padStart(2, "0");
        return `${tomorrow}T${hours}:${mins}`;
      }
    }
    return tomorrow;
  }
  
  // Just a time like "2pm", "14:00" - assume today
  const timeOnly = parseTime(value);
  if (timeOnly) {
    const hours = timeOnly.hours.toString().padStart(2, "0");
    const mins = timeOnly.minutes.toString().padStart(2, "0");
    return `${today}T${hours}:${mins}`;
  }
  
  // Try parseRelativeDate for things like "tuesday", "next week"
  const relDate = parseRelativeDate(value);
  if (relDate) {
    return relDate;
  }
  
  // Return as-is if we can't parse it (will show as invalid)
  return value;
}

function getWeekRange(): { start: string; end: string } {
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

function getDatePart(datetime: string): string {
  // Extract YYYY-MM-DD from either "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
  return datetime.split("T")[0];
}

function isOverdue(deadline: string): boolean {
  const deadlineDate = getDatePart(deadline);
  const today = getToday();
  
  // If deadline is today but has a time component, check if that time has passed
  if (deadlineDate === today && deadline.includes("T")) {
    return new Date(deadline) < new Date();
  }
  
  return deadlineDate < today;
}

function isToday(deadline: string): boolean {
  return getDatePart(deadline) === getToday();
}

function isThisWeek(deadline: string): boolean {
  const { start, end } = getWeekRange();
  const deadlineDate = getDatePart(deadline);
  return deadlineDate >= start && deadlineDate <= end;
}

// ============================================================================
// INDEX & TASK STORAGE
// ============================================================================

function loadIndex(): TaskIndex {
  ensureDirectories();

  const defaultIndex: TaskIndex = {
    tasks: [],
    structures: {},
    aliases: {},
    templates: {},
    stats: {
      totalCreated: 0,
      totalCompleted: 0,
      averageDuration: {},
      completionsByDay: {},
      completionsByProject: {},
    },
  };

  if (!existsSync(INDEX_PATH)) {
    return defaultIndex;
  }

  try {
    const loaded = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
    // Merge with defaults to handle migration from older versions
    return {
      tasks: loaded.tasks || [],
      structures: loaded.structures || {},
      aliases: loaded.aliases || {},
      templates: loaded.templates || {},
      stats: {
        totalCreated: loaded.stats?.totalCreated || loaded.tasks?.length || 0,
        totalCompleted: loaded.stats?.totalCompleted || 0,
        averageDuration: loaded.stats?.averageDuration || {},
        completionsByDay: loaded.stats?.completionsByDay || {},
        completionsByProject: loaded.stats?.completionsByProject || {},
      },
    };
  } catch {
    return defaultIndex;
  }
}

function saveIndex(index: TaskIndex) {
  ensureDirectories();
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function loadSchema(): TaskSchema {
  ensureDirectories();
  if (!existsSync(SCHEMA_PATH)) {
    // Create default schema
    const schema = { ...DEFAULT_SCHEMA, lastUpdated: new Date().toISOString() };
    writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2));
    return schema;
  }
  try {
    const loaded = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as TaskSchema;
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

function saveSchema(schema: TaskSchema) {
  ensureDirectories();
  schema.lastUpdated = new Date().toISOString();
  writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2));
}

function addFieldToSchema(
  schema: TaskSchema,
  fieldName: string,
  definition: Partial<FieldDefinition>
): boolean {
  // Normalize field name
  const normalizedName = fieldName.toLowerCase().replace(/\s+/g, "_");

  // Check if field already exists or is an alias
  if (schema.fields[normalizedName]) {
    return false; // Already exists
  }

  // Check if it's an alias of an existing field
  for (const [existingName, existingDef] of Object.entries(schema.fields)) {
    if (existingDef.aliases?.includes(normalizedName)) {
      return false; // Is an alias
    }
  }

  // Add new field
  schema.fields[normalizedName] = {
    type: definition.type || "string",
    description: definition.description || `Auto-discovered field: ${normalizedName}`,
    examples: definition.examples || [],
    category: "custom",
  };

  schema.version++;
  return true;
}

function resolveFieldName(schema: TaskSchema, fieldName: string): string {
  const normalized = fieldName.toLowerCase().replace(/\s+/g, "_");

  // Direct match
  if (schema.fields[normalized]) {
    return normalized;
  }

  // Check aliases
  for (const [canonicalName, def] of Object.entries(schema.fields)) {
    if (def.aliases?.includes(normalized)) {
      return canonicalName;
    }
  }

  // No match - return as-is (will be added as new field)
  return normalized;
}

function loadTask(id: string): Task | null {
  const taskPath = join(TASKS_DIR, `${id}.json`);
  if (!existsSync(taskPath)) {
    // Check archive
    const archivePath = join(ARCHIVE_DIR, `${id}.json`);
    if (existsSync(archivePath)) {
      return JSON.parse(readFileSync(archivePath, "utf-8")) as Task;
    }
    return null;
  }
  try {
    return JSON.parse(readFileSync(taskPath, "utf-8")) as Task;
  } catch {
    return null;
  }
}

function saveTask(task: Task) {
  ensureDirectories();
  writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function archiveTask(task: Task) {
  ensureDirectories();
  writeFileSync(join(ARCHIVE_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
  // Remove from active
  const activePath = join(TASKS_DIR, `${task.id}.json`);
  if (existsSync(activePath)) {
    unlinkSync(activePath);
  }
}

function deleteTaskFile(taskId: string) {
  const taskPath = join(TASKS_DIR, `${taskId}.json`);
  if (existsSync(taskPath)) {
    unlinkSync(taskPath);
  }
}

function loadAllTasks(includeCompleted = false): Task[] {
  const index = loadIndex();
  const tasks: Task[] = [];
  for (const id of index.tasks) {
    const task = loadTask(id);
    if (task && (includeCompleted || !task.completed)) {
      tasks.push(task);
    }
  }
  return tasks;
}

function findTaskByPrefix(prefix: string): Task | null {
  const index = loadIndex();
  const matches = index.tasks.filter((id) => id.startsWith(prefix));
  if (matches.length === 1) {
    return loadTask(matches[0]);
  }
  return null;
}

// ============================================================================
// SEMANTIC EXTRACTION
// ============================================================================

function formatSchemaForPrompt(schema: TaskSchema): string {
  const byCategory: Record<string, string[]> = {
    core: [],
    relationship: [],
    recurrence: [],
    custom: [],
  };

  for (const [name, def] of Object.entries(schema.fields)) {
    const category = def.category || "custom";
    const aliasStr = def.aliases?.length ? ` (aliases: ${def.aliases.join(", ")})` : "";
    const enumStr = def.enum?.length ? ` [${def.enum.join("|")}]` : "";
    const exampleStr = def.examples?.length ? ` e.g. ${def.examples.slice(0, 2).join(", ")}` : "";
    byCategory[category].push(`- ${name} (${def.type})${aliasStr}${enumStr}: ${def.description}${exampleStr}`);
  }

  let result = "";
  if (byCategory.core.length) {
    result += "\nCORE FIELDS:\n" + byCategory.core.join("\n");
  }
  if (byCategory.relationship.length) {
    result += "\n\nRELATIONSHIP FIELDS:\n" + byCategory.relationship.join("\n");
  }
  if (byCategory.recurrence.length) {
    result += "\n\nRECURRENCE FIELDS:\n" + byCategory.recurrence.join("\n");
  }
  if (byCategory.custom.length) {
    result += "\n\nCUSTOM FIELDS (learned from previous tasks):\n" + byCategory.custom.join("\n");
  }

  return result;
}

function getExtractionPrompt(schema: TaskSchema, index: TaskIndex): string {
  const today = getToday();
  const dayOfWeek = getDayOfWeek();

  const schemaFields = formatSchemaForPrompt(schema);

  const templateHints = Object.keys(index.templates).length > 0
    ? `\n\nKNOWN TASK PATTERNS:\n${Object.values(index.templates)
        .slice(0, 5)
        .map((t) => `- ${t.name}: ${t.pattern}`)
        .join("\n")}`
    : "";

  return `You are a semantic extraction engine for task management. Your job is to extract structured fields from natural language task descriptions.

TODAY: ${dayOfWeek}, ${today}

SCHEMA - USE THESE FIELD NAMES:
${schemaFields}
${templateHints}

INSTRUCTIONS:
1. Detect if the input contains MULTIPLE distinct tasks (separated by commas, "and", newlines, or listed)
2. Detect SEQUENTIAL relationships: "and then", "then", "after that", "before", "first...then", "once...then"
3. Extract values for fields defined in the schema above
4. Use the EXACT field names from the schema (prefer canonical names over aliases)
5. For deadlines - MUST use strict ISO 8601 format:
   - Date only: YYYY-MM-DD (e.g., "tuesday" → "${parseRelativeDate("tuesday") || "2025-12-10"}")
   - Date + time: YYYY-MM-DDTHH:MM in 24-hour format (e.g., "2pm today" → "${today}T14:00", "3:30pm tomorrow" → next day + "T15:30")
   - NEVER return strings like "today", "2pm today", "tomorrow" - ALWAYS convert to actual ISO dates
   - "today" = ${today}, "tomorrow" = tomorrow's ISO date
   - Use 24-hour time: 2pm = 14:00, 9am = 09:00, 3:30pm = 15:30
6. Normalize names to snake_case (e.g., "John Smith" → "john_smith")
7. If you identify a meaningful field NOT in the schema, include it with a suggested type

RESPOND WITH ONLY VALID JSON:

For a SINGLE task:
{
  "tasks": [{
    "raw": "original text for this task",
    "fields": {
      "fieldName": { "name": "fieldName", "value": "extracted value", "normalized": "canonical_form" }
    },
    "summary": "Brief one-line summary",
    "recurrence": { "pattern": "weekly", "dayOfWeek": "monday" }
  }],
  "newFields": []
}

For MULTIPLE tasks with SEQUENCE (e.g., "do X and then Y"):
{
  "tasks": [
    { "raw": "first task", "fields": {...}, "summary": "...", "seq": 0 },
    { "raw": "second task", "fields": {...}, "summary": "...", "seq": 1, "dependsOn": 0 }
  ],
  "newFields": []
}

For MULTIPLE PARALLEL tasks (e.g., "do X, Y, and Z"):
{
  "tasks": [
    { "raw": "task X", "fields": {...}, "summary": "..." },
    { "raw": "task Y", "fields": {...}, "summary": "..." },
    { "raw": "task Z", "fields": {...}, "summary": "..." }
  ],
  "newFields": []
}

IMPORTANT:
- ALWAYS return a "tasks" array, even for a single task
- Each task needs its own "raw", "fields", and "summary"
- Use "seq" (sequence number) and "dependsOn" (index of prerequisite task) for sequential tasks
- "and then", "then", "after" indicate the next task depends on the previous one
- Shared context (like a deadline) should be copied to each relevant task
- Only include "newFields" if you discover semantic information that doesn't fit existing schema fields
- New fields should be genuinely useful categories, not one-off values
- Use existing schema fields whenever possible`;
}

interface NewFieldProposal {
  name: string;
  type: string;
  description: string;
}

interface ExtractedTask {
  raw: string;
  fields: Record<string, SemanticField>;
  summary: string;
  recurrence?: Task["recurrence"];
  templateId?: string;
  seq?: number;
  dependsOn?: number; // Index of task this depends on
}

interface ExtractionResult {
  tasks: ExtractedTask[];
  newFields?: NewFieldProposal[];
}

async function extractSemantics(
  raw: string,
  config: Config,
  schema: TaskSchema,
  index: TaskIndex
): Promise<ExtractionResult> {
  const model = createModel(config);

  const response = await model.invoke([
    new SystemMessage(getExtractionPrompt(schema, index)),
    new HumanMessage(raw),
  ]);

  const content = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { 
      tasks: [{ raw, fields: { action: { name: "action", value: raw } }, summary: raw }] 
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Helper to normalize field values (especially deadlines)
    function normalizeFieldValue(fieldName: string, field: SemanticField): SemanticField {
      if (fieldName === "deadline" && typeof field.value === "string") {
        return { ...field, value: normalizeDeadline(field.value as string) };
      }
      return field;
    }

    // Handle new multi-task format
    if (parsed.tasks && Array.isArray(parsed.tasks)) {
      const tasks: ExtractedTask[] = parsed.tasks.map((t: any, idx: number) => {
        const normalizedFields: Record<string, SemanticField> = {};
        for (const [key, value] of Object.entries(t.fields || {})) {
          const canonicalName = resolveFieldName(schema, key);
          normalizedFields[canonicalName] = normalizeFieldValue(canonicalName, value as SemanticField);
        }

        return {
          raw: t.raw || raw,
          fields: Object.keys(normalizedFields).length > 0
            ? normalizedFields
            : { action: { name: "action", value: t.raw || raw } },
          summary: t.summary || t.raw || raw,
          recurrence: t.recurrence,
          templateId: t.suggestedTemplate,
          seq: t.seq ?? idx,
          dependsOn: t.dependsOn,
        };
      });

      return {
        tasks,
        newFields: parsed.newFields,
      };
    }

    // Fallback: handle old single-task format for backwards compatibility
    const normalizedFields: Record<string, SemanticField> = {};
    for (const [key, value] of Object.entries(parsed.fields || {})) {
      const canonicalName = resolveFieldName(schema, key);
      normalizedFields[canonicalName] = normalizeFieldValue(canonicalName, value as SemanticField);
    }

    return {
      tasks: [{
        raw,
        fields: Object.keys(normalizedFields).length > 0
          ? normalizedFields
          : { action: { name: "action", value: raw } },
        summary: parsed.summary || raw,
        recurrence: parsed.recurrence,
        templateId: parsed.suggestedTemplate,
      }],
      newFields: parsed.newFields,
    };
  } catch {
    return { 
      tasks: [{ raw, fields: { action: { name: "action", value: raw } }, summary: raw }] 
    };
  }
}

// ============================================================================
// NATURAL LANGUAGE QUERIES
// ============================================================================

async function naturalLanguageQuery(
  query: string,
  config: Config,
  index: TaskIndex
): Promise<{ filters: Array<{ field: string; op: string; value: string }>; groupBy?: string; sort?: string }> {
  const model = createModel(config);

  const structureList = Object.entries(index.structures)
    .map(([k, v]) => `${k} (${v.type}): ${v.examples.slice(0, 3).join(", ")}`)
    .join("\n");

  const systemPrompt = `You are a query parser for a task management system. Convert natural language queries into structured filters.

Available fields in this system:
${structureList}

Special filters:
- deadline comparisons: today, tomorrow, this_week, overdue, next_week
- completed: true/false
- has_field: check if a field exists

RESPOND WITH ONLY VALID JSON:
{
  "filters": [
    { "field": "fieldname", "op": "eq|contains|gt|lt|exists", "value": "value" }
  ],
  "groupBy": "field to group by (optional)",
  "sort": "field to sort by (optional)"
}

Examples:
- "urgent tasks" → { "filters": [{ "field": "priority", "op": "eq", "value": "urgent" }] }
- "what's due today" → { "filters": [{ "field": "deadline", "op": "eq", "value": "today" }] }
- "supersonic tasks" → { "filters": [{ "field": "subject", "op": "eq", "value": "supersonic" }] }
- "tasks by project" → { "filters": [], "groupBy": "project" }
- "overdue" → { "filters": [{ "field": "deadline", "op": "lt", "value": "today" }] }`;

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(query),
  ]);

  const content = typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { filters: [] };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { filters: [] };
  }
}

// ============================================================================
// STRUCTURE & ALIAS MANAGEMENT
// ============================================================================

function updateStructures(index: TaskIndex, fields: Record<string, SemanticField> | null | undefined) {
  if (!fields) return;
  for (const [key, field] of Object.entries(fields)) {
    if (!index.structures[key]) {
      index.structures[key] = {
        name: key,
        occurrences: 0,
        examples: [],
        type: "unknown",
      };
    }

    const struct = index.structures[key];
    struct.occurrences++;

    const value = field.value;
    if (typeof value === "string") {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        struct.type = "datetime";
      } else if (/^\d{4}-\d{2}-\d{2}/.test(value) || /today|tomorrow|monday|tuesday|wednesday|thursday|friday/i.test(value)) {
        struct.type = "date";
      } else if (/^\d+\s*(min|hour|day|h|m)/.test(value)) {
        struct.type = "duration";
      } else {
        struct.type = "string";
      }
    } else if (typeof value === "number") {
      struct.type = "number";
    } else if (typeof value === "boolean") {
      struct.type = "boolean";
    } else if (Array.isArray(value)) {
      struct.type = "array";
    }

    const valueStr = JSON.stringify(field.value);
    if (!struct.examples.includes(valueStr) && struct.examples.length < 5) {
      struct.examples.push(valueStr);
    }

    // Track aliases
    if (field.normalized && field.normalized !== field.value) {
      const canonical = field.normalized as string;
      const variant = String(field.value);
      if (!index.aliases[canonical]) {
        index.aliases[canonical] = [];
      }
      if (!index.aliases[canonical].includes(variant)) {
        index.aliases[canonical].push(variant);
      }
    }
  }
}

function updateTemplates(index: TaskIndex, task: Task, templateId?: string) {
  if (!templateId) return;
  if (!task.fields) return;

  if (!index.templates[templateId]) {
    index.templates[templateId] = {
      id: templateId,
      name: templateId,
      pattern: task.raw,
      defaultFields: { ...task.fields },
      occurrences: 0,
    };
  }

  index.templates[templateId].occurrences++;
}

// ============================================================================
// TASK OPERATIONS
// ============================================================================

async function addTasks(raw: string, config: Config, options: { blocks?: string } = {}): Promise<{ tasks: Task[]; schemaUpdated: boolean }> {
  const index = loadIndex();
  const schema = loadSchema();

  console.log(`\x1b[90m⏳ Extracting semantic structure...\x1b[0m`);

  const { tasks: extractedTasks, newFields } = await extractSemantics(raw, config, schema, index);

  // Handle new field proposals - add to schema
  let schemaUpdated = false;
  if (newFields && newFields.length > 0) {
    for (const proposal of newFields) {
      const added = addFieldToSchema(schema, proposal.name, {
        type: proposal.type as FieldDefinition["type"],
        description: proposal.description,
      });
      if (added) {
        schemaUpdated = true;
        console.log(`\x1b[35m  + Schema: added field "${proposal.name}" (${proposal.type})\x1b[0m`);
      }
    }
    if (schemaUpdated) {
      saveSchema(schema);
    }
  }

  const createdTasks: Task[] = [];

  // First pass: create all tasks
  for (const extracted of extractedTasks) {
    // Add summary to fields
    extracted.fields.summary = { name: "summary", value: extracted.summary };

    const task: Task = {
      id: randomUUID(),
      raw: extracted.raw,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      completed: false,
      fields: extracted.fields,
      recurrence: extracted.recurrence,
      templateId: extracted.templateId,
    };

    // Handle blocking relationship from --blocks flag (only for first task if multiple)
    if (options.blocks && createdTasks.length === 0) {
      const blockedTask = findTaskByPrefix(options.blocks);
      if (blockedTask) {
        task.blocks = [blockedTask.id];
        blockedTask.blockedBy = blockedTask.blockedBy || [];
        blockedTask.blockedBy.push(task.id);
        saveTask(blockedTask);
      }
    }

    updateStructures(index, extracted.fields);
    updateTemplates(index, task, extracted.templateId);

    index.tasks.push(task.id);
    index.stats.totalCreated++;

    createdTasks.push(task);
  }

  // Second pass: set up dependencies between tasks based on "dependsOn"
  for (let i = 0; i < extractedTasks.length; i++) {
    const extracted = extractedTasks[i];
    if (extracted.dependsOn !== undefined && extracted.dependsOn >= 0 && extracted.dependsOn < createdTasks.length) {
      const dependentTask = createdTasks[i];
      const prerequisiteTask = createdTasks[extracted.dependsOn];

      // prerequisiteTask blocks dependentTask
      prerequisiteTask.blocks = prerequisiteTask.blocks || [];
      if (!prerequisiteTask.blocks.includes(dependentTask.id)) {
        prerequisiteTask.blocks.push(dependentTask.id);
      }

      // dependentTask is blocked by prerequisiteTask
      dependentTask.blockedBy = dependentTask.blockedBy || [];
      if (!dependentTask.blockedBy.includes(prerequisiteTask.id)) {
        dependentTask.blockedBy.push(prerequisiteTask.id);
      }
    }
  }

  // Save all tasks
  for (const task of createdTasks) {
    saveTask(task);
  }

  saveIndex(index);

  return { tasks: createdTasks, schemaUpdated };
}

function deleteTask(taskId: string): Task | null {
  const task = findTaskByPrefix(taskId);
  if (!task) return null;

  const index = loadIndex();

  // Remove from index
  index.tasks = index.tasks.filter((id) => id !== task.id);

  // Update any tasks that were blocked by this one
  for (const id of index.tasks) {
    const t = loadTask(id);
    if (t && t.blockedBy?.includes(task.id)) {
      t.blockedBy = t.blockedBy.filter((bid) => bid !== task.id);
      saveTask(t);
    }
  }

  // Update any tasks this was blocking
  if (task.blocks) {
    for (const blockedId of task.blocks) {
      const blocked = loadTask(blockedId);
      if (blocked && blocked.blockedBy) {
        blocked.blockedBy = blocked.blockedBy.filter((bid) => bid !== task.id);
        saveTask(blocked);
      }
    }
  }

  // Delete the task file
  deleteTaskFile(task.id);

  saveIndex(index);

  return task;
}

async function completeTask(taskId: string, config: Config): Promise<Task | null> {
  const task = findTaskByPrefix(taskId);
  if (!task) return null;

  // Ask for completion details
  const durationStr = await prompt(`\x1b[33mHow long did this take? (e.g., 30min, 2h, skip):\x1b[0m `);
  const notes = await prompt(`\x1b[33mAny notes? (or skip):\x1b[0m `);

  let duration: number | undefined;
  if (durationStr && durationStr !== "skip") {
    const match = durationStr.match(/(\d+)\s*(m|min|h|hour)?/i);
    if (match) {
      duration = parseInt(match[1]);
      if (match[2]?.toLowerCase().startsWith("h")) {
        duration *= 60;
      }
    }
  }

  task.completed = true;
  task.updated = new Date().toISOString();
  task.completionInfo = {
    completedAt: new Date().toISOString(),
    duration,
    notes: notes !== "skip" ? notes : undefined,
  };

  // Update stats
  const index = loadIndex();
  index.stats.totalCompleted++;

  const today = getToday();
  index.stats.completionsByDay[today] = (index.stats.completionsByDay[today] || 0) + 1;

  const project = String(task.fields.project?.value || task.fields.subject?.value || "unknown");
  index.stats.completionsByProject[project] = (index.stats.completionsByProject[project] || 0) + 1;

  // Update average duration for task type
  if (duration && task.fields.task_type) {
    const taskType = String(task.fields.task_type.value);
    const current = index.stats.averageDuration[taskType] || duration;
    index.stats.averageDuration[taskType] = Math.round((current + duration) / 2);
  }

  // Handle recurrence
  if (task.recurrence) {
    // Create next occurrence
    const nextTask = { ...task };
    nextTask.id = randomUUID();
    nextTask.completed = false;
    nextTask.completionInfo = undefined;
    nextTask.created = new Date().toISOString();
    nextTask.updated = new Date().toISOString();

    // Calculate next due date
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

    saveTask(nextTask);
    index.tasks.push(nextTask.id);
    console.log(`\x1b[36m↻ Created next occurrence: ${nextTask.id.slice(0, 8)}\x1b[0m`);
  }

  saveTask(task);
  archiveTask(task);

  // Remove from active tasks but keep in index for history
  saveIndex(index);

  return task;
}

// ============================================================================
// DISPLAY UTILITIES
// ============================================================================

function formatFieldValue(value: SemanticField["value"]): string {
  if (value === null) return "\x1b[90mnull\x1b[0m";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString();
}

function formatDeadline(deadline: string): string {
  // Check if it has a time component
  if (deadline.includes("T")) {
    const [datePart, timePart] = deadline.split("T");
    const date = new Date(deadline);
    if (isNaN(date.getTime())) {
      // Fallback: try just the date part
      const dateOnly = new Date(datePart + "T00:00:00");
      if (isNaN(dateOnly.getTime())) return deadline; // Return as-is if unparseable
      const [hours, minutes] = timePart.split(":");
      const hour = parseInt(hours) || 0;
      const ampm = hour >= 12 ? "pm" : "am";
      const hour12 = hour % 12 || 12;
      const timeStr = `${hour12}:${minutes || "00"}${ampm}`;
      return `${dateOnly.toLocaleDateString()} ${timeStr}`;
    }
    const dateStr = date.toLocaleDateString();
    // Format time as 12-hour with am/pm
    const [hours, minutes] = timePart.split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "pm" : "am";
    const hour12 = hour % 12 || 12;
    const timeStr = `${hour12}:${minutes}${ampm}`;
    return `${dateStr} ${timeStr}`;
  }
  const date = new Date(deadline + "T00:00:00");
  if (isNaN(date.getTime())) return deadline; // Return as-is if unparseable
  return date.toLocaleDateString();
}

function displayTask(task: Task, options: { verbose?: boolean; showRelations?: boolean } = {}) {
  const shortId = task.id.slice(0, 8);
  const status = task.completed ? "\x1b[32m✓\x1b[0m" : "\x1b[33m○\x1b[0m";

  // Check for overdue/today
  const deadline = task.fields.deadline?.value as string;
  let deadlineIndicator = "";
  if (deadline && !task.completed) {
    if (isOverdue(deadline)) {
      deadlineIndicator = " \x1b[31m⚠ OVERDUE\x1b[0m";
    } else if (isToday(deadline)) {
      // Show time if available
      const timeStr = deadline.includes("T") ? ` @ ${deadline.split("T")[1]}` : "";
      deadlineIndicator = ` \x1b[33m📅 TODAY${timeStr}\x1b[0m`;
    }
  }

  // Check if blocked
  const blockedIndicator = task.blockedBy?.length ? " \x1b[90m🔒 blocked\x1b[0m" : "";

  const summary = task.fields.summary?.value || task.fields.action?.value || task.raw;
  console.log(`${status} \x1b[1m${shortId}\x1b[0m  ${summary}${deadlineIndicator}${blockedIndicator}`);

  if (options.verbose) {
    console.log(`  \x1b[90mRaw: ${task.raw}\x1b[0m`);
    console.log(`  \x1b[90mCreated: ${formatDate(task.created)}\x1b[0m`);
    if (task.recurrence) {
      console.log(`  \x1b[35m↻ Recurs: ${task.recurrence.pattern}${task.recurrence.dayOfWeek ? ` on ${task.recurrence.dayOfWeek}` : ""}\x1b[0m`);
    }
  }

  // Show key fields
  const keyFields = ["subject", "project", "deadline", "priority", "people", "context", "effort", "energy"];
  const shownFields: string[] = [];

  for (const key of keyFields) {
    if (task.fields[key]) {
      let color = "\x1b[36m";
      let displayValue = formatFieldValue(task.fields[key].value);
      
      if (key === "priority") {
        const val = String(task.fields[key].value).toLowerCase();
        color = val === "urgent" ? "\x1b[31m" : val === "high" ? "\x1b[33m" : "\x1b[36m";
      } else if (key === "deadline") {
        displayValue = formatDeadline(String(task.fields[key].value));
      }
      
      shownFields.push(`${key}: ${color}${displayValue}\x1b[0m`);
    }
  }

  // Show other fields
  for (const [key, field] of Object.entries(task.fields)) {
    if (!keyFields.includes(key) && key !== "action" && key !== "summary") {
      shownFields.push(`${key}: \x1b[36m${formatFieldValue(field.value)}\x1b[0m`);
    }
  }

  if (shownFields.length > 0) {
    console.log(`  ${shownFields.join("  ")}`);
  }

  if (options.showRelations) {
    if (task.blocks?.length) {
      console.log(`  \x1b[90mBlocks: ${task.blocks.map((id) => id.slice(0, 8)).join(", ")}\x1b[0m`);
    }
    if (task.blockedBy?.length) {
      console.log(`  \x1b[90mBlocked by: ${task.blockedBy.map((id) => id.slice(0, 8)).join(", ")}\x1b[0m`);
    }
  }

  console.log();
}

// ============================================================================
// LIST & FILTER OPERATIONS
// ============================================================================

interface ListOptions {
  filter?: Array<{ field: string; op: string; value: string }>;
  groupBy?: string;
  sort?: string;
  showCompleted?: boolean;
  verbose?: boolean;
}

function filterTasks(tasks: Task[], filters: Array<{ field: string; op: string; value: string }>): Task[] {
  return tasks.filter((task) => {
    return filters.every((filter) => {
      // Special handling for deadline comparisons
      if (filter.field === "deadline") {
        const deadline = task.fields.deadline?.value as string;
        if (!deadline) return false;

        if (filter.value === "today") {
          return filter.op === "eq" ? isToday(deadline) : false;
        }
        if (filter.value === "this_week") {
          return isThisWeek(deadline);
        }
        if (filter.op === "lt" && filter.value === "today") {
          return isOverdue(deadline);
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

function groupTasks(tasks: Task[], groupBy: string): Record<string, Task[]> {
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

function listTasks(options: ListOptions = {}) {
  let tasks = loadAllTasks(options.showCompleted);

  if (tasks.length === 0) {
    console.log(`\x1b[33mNo tasks found.\x1b[0m`);
    return;
  }

  if (options.filter?.length) {
    tasks = filterTasks(tasks, options.filter);
  }

  // Sort
  if (options.sort) {
    tasks.sort((a, b) => {
      const aVal = String(a.fields[options.sort!]?.value || "");
      const bVal = String(b.fields[options.sort!]?.value || "");
      return aVal.localeCompare(bVal);
    });
  } else {
    // Default: sort by deadline, then created
    tasks.sort((a, b) => {
      const aDeadline = a.fields.deadline?.value as string || "9999-99-99";
      const bDeadline = b.fields.deadline?.value as string || "9999-99-99";
      if (aDeadline !== bDeadline) return aDeadline.localeCompare(bDeadline);
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    });
  }

  const filterLabel = options.filter?.length ? " filtered" : "";
  console.log(`\n\x1b[36m┌─ Tasks (${tasks.length}${filterLabel}) ─────────────────────────────────┐\x1b[0m\n`);

  if (options.groupBy) {
    const groups = groupTasks(tasks, options.groupBy);
    for (const [group, groupTasks] of Object.entries(groups)) {
      console.log(`\x1b[35m━━ ${options.groupBy}: ${group} (${groupTasks.length}) ━━\x1b[0m\n`);
      for (const task of groupTasks) {
        displayTask(task, { verbose: options.verbose });
      }
    }
  } else {
    for (const task of tasks) {
      displayTask(task, { verbose: options.verbose, showRelations: true });
    }
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

// ============================================================================
// VIEWS (MATERIALIZED QUERIES)
// ============================================================================

function viewToday() {
  listTasks({
    filter: [{ field: "deadline", op: "eq", value: "today" }],
  });
}

function viewWeek() {
  listTasks({
    filter: [{ field: "deadline", op: "eq", value: "this_week" }],
    sort: "deadline",
  });
}

function viewOverdue() {
  listTasks({
    filter: [{ field: "deadline", op: "lt", value: "today" }],
  });
}

function viewBlocked() {
  const tasks = loadAllTasks().filter((t) => t.blockedBy?.length);
  if (tasks.length === 0) {
    console.log(`\x1b[33mNo blocked tasks.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ Blocked Tasks (${tasks.length}) ─────────────────────────────┐\x1b[0m\n`);
  for (const task of tasks) {
    displayTask(task, { showRelations: true });
  }
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

function viewFocus() {
  const tasks = loadAllTasks();

  // Score tasks by urgency
  const scored = tasks.map((task) => {
    let score = 0;

    // Priority
    const priority = String(task.fields.priority?.value || "normal").toLowerCase();
    if (priority === "urgent") score += 100;
    else if (priority === "high") score += 50;

    // Deadline proximity
    const deadline = task.fields.deadline?.value as string;
    if (deadline) {
      if (isOverdue(deadline)) score += 200;
      else if (isToday(deadline)) score += 100;
      else if (isThisWeek(deadline)) score += 30;
    }

    // Blocking others
    if (task.blocks?.length) score += 40 * task.blocks.length;

    // Being blocked (negative - can't do it anyway)
    if (task.blockedBy?.length) score -= 50;

    return { task, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  console.log(`\n\x1b[36m┌─ 🎯 Focus: Top Tasks ─────────────────────────────┐\x1b[0m\n`);

  if (top.length === 0) {
    console.log(`  \x1b[33mNo tasks to focus on!\x1b[0m\n`);
  } else {
    for (const { task, score } of top) {
      displayTask(task);
    }
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

// ============================================================================
// STRUCTURES & ALIASES
// ============================================================================

function showStructures() {
  const index = loadIndex();

  if (Object.keys(index.structures).length === 0) {
    console.log(`\x1b[33mNo semantic structures discovered yet.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ Discovered Structures ────────────────────────────┐\x1b[0m\n`);

  const sorted = Object.values(index.structures).sort((a, b) => b.occurrences - a.occurrences);

  for (const struct of sorted) {
    const typeColor: Record<string, string> = {
      string: "\x1b[32m",
      date: "\x1b[35m",
      datetime: "\x1b[35m",
      number: "\x1b[33m",
      boolean: "\x1b[34m",
      array: "\x1b[36m",
      duration: "\x1b[33m",
      unknown: "\x1b[90m",
    };

    console.log(`  \x1b[1m${struct.name}\x1b[0m  ${typeColor[struct.type]}${struct.type}\x1b[0m  \x1b[90m(${struct.occurrences}x)\x1b[0m`);
    console.log(`  \x1b[90m${struct.examples.slice(0, 3).join(", ")}\x1b[0m\n`);
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

function showSchema(outputJson = false) {
  const schema = loadSchema();

  if (outputJson) {
    console.log(JSON.stringify(schema, null, 2));
    return;
  }

  console.log(`\n\x1b[36m┌─ Task Schema (v${schema.version}) ─────────────────────────────┐\x1b[0m`);
  console.log(`\x1b[90m  Last updated: ${new Date(schema.lastUpdated).toLocaleString()}\x1b[0m\n`);

  const byCategory: Record<string, Array<[string, FieldDefinition]>> = {
    core: [],
    relationship: [],
    recurrence: [],
    custom: [],
  };

  for (const [name, def] of Object.entries(schema.fields)) {
    const category = def.category || "custom";
    byCategory[category].push([name, def]);
  }

  const typeColor: Record<string, string> = {
    string: "\x1b[32m",
    date: "\x1b[35m",
    datetime: "\x1b[35m",
    number: "\x1b[33m",
    boolean: "\x1b[34m",
    array: "\x1b[36m",
    duration: "\x1b[33m",
  };

  const categoryLabels: Record<string, string> = {
    core: "Core Fields",
    relationship: "Relationship Fields",
    recurrence: "Recurrence Fields",
    custom: "Custom Fields (learned)",
  };

  for (const [category, fields] of Object.entries(byCategory)) {
    if (fields.length === 0) continue;

    console.log(`\x1b[35m━━ ${categoryLabels[category]} (${fields.length}) ━━\x1b[0m\n`);

    for (const [name, def] of fields) {
      const color = typeColor[def.type] || "\x1b[90m";
      const aliasStr = def.aliases?.length ? ` \x1b[90m(aka: ${def.aliases.join(", ")})\x1b[0m` : "";
      const enumStr = def.enum?.length ? `\n    \x1b[90mAllowed: ${def.enum.join(" | ")}\x1b[0m` : "";

      console.log(`  \x1b[1m${name}\x1b[0m  ${color}${def.type}\x1b[0m${aliasStr}`);
      console.log(`    ${def.description}${enumStr}`);
      if (def.examples?.length) {
        console.log(`    \x1b[90mExamples: ${def.examples.slice(0, 3).join(", ")}\x1b[0m`);
      }
      console.log();
    }
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m`);
  console.log(`\n\x1b[90mSchema file: ${SCHEMA_PATH}\x1b[0m\n`);
}

function addSchemaField(name: string, type: string, description: string) {
  const schema = loadSchema();

  const validTypes = ["string", "date", "datetime", "number", "boolean", "array", "duration"];
  if (!validTypes.includes(type)) {
    console.error(`\x1b[31mInvalid type: ${type}\x1b[0m`);
    console.log(`\x1b[33mValid types: ${validTypes.join(", ")}\x1b[0m`);
    return false;
  }

  const added = addFieldToSchema(schema, name, {
    type: type as FieldDefinition["type"],
    description,
  });

  if (added) {
    saveSchema(schema);
    console.log(`\x1b[32m✓ Added field "${name}" (${type}) to schema\x1b[0m`);
    return true;
  } else {
    console.log(`\x1b[33mField "${name}" already exists in schema\x1b[0m`);
    return false;
  }
}

function showAliases() {
  const index = loadIndex();

  if (Object.keys(index.aliases).length === 0) {
    console.log(`\x1b[33mNo aliases discovered yet.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ Known Aliases ────────────────────────────────────┐\x1b[0m\n`);

  for (const [canonical, variants] of Object.entries(index.aliases)) {
    console.log(`  \x1b[1m${canonical}\x1b[0m`);
    console.log(`  \x1b[90m= ${variants.join(", ")}\x1b[0m\n`);
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

function mergeAliases(canonical: string, variant: string) {
  const index = loadIndex();

  if (!index.aliases[canonical]) {
    index.aliases[canonical] = [];
  }
  if (!index.aliases[canonical].includes(variant)) {
    index.aliases[canonical].push(variant);
  }

  saveIndex(index);
  console.log(`\x1b[32m✓ Merged: "${variant}" → "${canonical}"\x1b[0m`);
}

// ============================================================================
// TEMPLATES
// ============================================================================

function showTemplates() {
  const index = loadIndex();

  if (Object.keys(index.templates).length === 0) {
    console.log(`\x1b[33mNo templates discovered yet.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ Task Templates ───────────────────────────────────┐\x1b[0m\n`);

  const sorted = Object.values(index.templates).sort((a, b) => b.occurrences - a.occurrences);

  for (const template of sorted) {
    console.log(`  \x1b[1m${template.name}\x1b[0m  \x1b[90m(${template.occurrences}x)\x1b[0m`);
    console.log(`  \x1b[90mPattern: ${template.pattern.slice(0, 60)}...\x1b[0m`);

    const fields = Object.keys(template.defaultFields).slice(0, 5);
    console.log(`  \x1b[90mFields: ${fields.join(", ")}\x1b[0m\n`);
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

// ============================================================================
// STATS & REVIEW
// ============================================================================

function showStats() {
  const index = loadIndex();
  const tasks = loadAllTasks(true);

  console.log(`\n\x1b[36m┌─ Task Statistics ──────────────────────────────────┐\x1b[0m\n`);

  console.log(`  \x1b[1mOverall\x1b[0m`);
  console.log(`  Created: ${index.stats.totalCreated}  Completed: ${index.stats.totalCompleted}`);

  const completionRate = index.stats.totalCreated > 0
    ? Math.round((index.stats.totalCompleted / index.stats.totalCreated) * 100)
    : 0;
  console.log(`  Completion rate: ${completionRate}%\n`);

  // By project
  if (Object.keys(index.stats.completionsByProject).length > 0) {
    console.log(`  \x1b[1mBy Project\x1b[0m`);
    const sorted = Object.entries(index.stats.completionsByProject)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    for (const [project, count] of sorted) {
      console.log(`  ${project}: ${count} completed`);
    }
    console.log();
  }

  // Average duration by type
  if (Object.keys(index.stats.averageDuration).length > 0) {
    console.log(`  \x1b[1mAverage Duration by Type\x1b[0m`);
    for (const [type, mins] of Object.entries(index.stats.averageDuration)) {
      const hours = Math.floor(mins / 60);
      const minutes = mins % 60;
      const formatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      console.log(`  ${type}: ${formatted}`);
    }
    console.log();
  }

  // Recent completions
  const recentDays = Object.entries(index.stats.completionsByDay)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7);
  if (recentDays.length > 0) {
    console.log(`  \x1b[1mRecent Activity\x1b[0m`);
    for (const [day, count] of recentDays) {
      console.log(`  ${day}: ${count} completed`);
    }
  }

  console.log(`\n\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function interactiveReview(config: Config) {
  const tasks = loadAllTasks();
  const today = getToday();

  console.log(`\n\x1b[36m┌─ Daily Review ─────────────────────────────────────┐\x1b[0m\n`);

  // Overdue tasks
  const overdue = tasks.filter((t) => {
    const deadline = t.fields.deadline?.value as string;
    return deadline && isOverdue(deadline);
  });

  if (overdue.length > 0) {
    console.log(`\x1b[31m⚠ Overdue Tasks (${overdue.length})\x1b[0m\n`);
    for (const task of overdue) {
      displayTask(task);
    }
  }

  // Today's tasks
  const todayTasks = tasks.filter((t) => {
    const deadline = t.fields.deadline?.value as string;
    return deadline && isToday(deadline);
  });

  if (todayTasks.length > 0) {
    console.log(`\x1b[33m📅 Due Today (${todayTasks.length})\x1b[0m\n`);
    for (const task of todayTasks) {
      displayTask(task);
    }
  }

  // Blocked tasks check
  const blocked = tasks.filter((t) => t.blockedBy?.length);
  if (blocked.length > 0) {
    console.log(`\x1b[90m🔒 Blocked (${blocked.length})\x1b[0m\n`);
  }

  // Top priority
  const urgent = tasks.filter((t) =>
    String(t.fields.priority?.value).toLowerCase() === "urgent"
  );
  if (urgent.length > 0) {
    console.log(`\x1b[31m🔥 Urgent (${urgent.length})\x1b[0m\n`);
    for (const task of urgent) {
      displayTask(task);
    }
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);

  // Summary
  console.log(`\x1b[90mTotal open tasks: ${tasks.length}\x1b[0m`);
}

// ============================================================================
// EXPORT
// ============================================================================

function exportTasks(format: string) {
  const tasks = loadAllTasks(true);

  switch (format) {
    case "json":
      console.log(JSON.stringify(tasks, null, 2));
      break;

    case "markdown":
      console.log("# Tasks\n");
      for (const task of tasks) {
        const status = task.completed ? "[x]" : "[ ]";
        const summary = task.fields.summary?.value || task.raw;
        console.log(`- ${status} ${summary}`);

        const deadline = task.fields.deadline?.value;
        const project = task.fields.project?.value || task.fields.subject?.value;
        if (deadline || project) {
          const meta = [deadline && `📅 ${deadline}`, project && `📁 ${project}`]
            .filter(Boolean)
            .join(" ");
          console.log(`  ${meta}`);
        }
      }
      break;

    case "ical":
      console.log("BEGIN:VCALENDAR");
      console.log("VERSION:2.0");
      console.log("PRODID:-//tx//Task Manager//EN");

      for (const task of tasks) {
        if (!task.completed && task.fields.deadline?.value) {
          const deadline = String(task.fields.deadline.value).replace(/-/g, "");
          const summary = String(task.fields.summary?.value || task.raw).replace(/,/g, "\\,");

          console.log("BEGIN:VTODO");
          console.log(`UID:${task.id}`);
          console.log(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`);
          console.log(`DUE:${deadline}`);
          console.log(`SUMMARY:${summary}`);
          console.log("END:VTODO");
        }
      }

      console.log("END:VCALENDAR");
      break;

    default:
      console.error(`\x1b[31mUnknown format: ${format}\x1b[0m`);
      console.log(`\x1b[33mSupported: json, markdown, ical\x1b[0m`);
  }
}

// ============================================================================
// DEPENDENCY GRAPH
// ============================================================================

function showGraph() {
  const tasks = loadAllTasks();

  const hasRelations = tasks.some((t) => t.blocks?.length || t.blockedBy?.length);

  if (!hasRelations) {
    console.log(`\x1b[33mNo task dependencies found.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ Dependency Graph ─────────────────────────────────┐\x1b[0m\n`);

  for (const task of tasks) {
    if (task.blocks?.length) {
      const summary = String(task.fields.summary?.value || task.id.slice(0, 8));
      console.log(`  \x1b[1m${task.id.slice(0, 8)}\x1b[0m ${summary}`);

      for (const blockedId of task.blocks) {
        const blocked = loadTask(blockedId);
        if (blocked) {
          const blockedSummary = String(blocked.fields.summary?.value || blockedId.slice(0, 8));
          console.log(`    └─▶ \x1b[90m${blockedId.slice(0, 8)}\x1b[0m ${blockedSummary}`);
        }
      }
      console.log();
    }
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

// ============================================================================
// HELP
// ============================================================================

function showHelp(config: Config) {
  console.log(`
\x1b[36m┌─────────────────────────────────────────┐
│  \x1b[1mtx\x1b[0m\x1b[36m - Semantic Task Management          │
└─────────────────────────────────────────┘\x1b[0m

\x1b[33mAdd Tasks:\x1b[0m
  tx <natural language task>
  tx <task> --blocks <task-id>      Add with dependency

\x1b[33mViews:\x1b[0m
  tx --list                         All open tasks
  tx --today                        Due today
  tx --week                         Due this week
  tx --overdue                      Past deadline
  tx --blocked                      Tasks waiting on others
  tx --focus                        AI-prioritized top tasks

\x1b[33mGrouping & Filtering:\x1b[0m
  tx --by <field>                   Group by field (project, context, etc)
  tx --query <field> --eq <value>   Filter by field
  tx --q "<natural language>"       Natural language query

\x1b[33mTask Management:\x1b[0m
  tx --complete <id>                Complete task (tracks duration)
  tx --delete <id>                  Delete task permanently
  tx --graph                        Show dependency graph

\x1b[33mSchema:\x1b[0m
  tx --schema                       View the semantic schema
  tx --schema --json                Output schema as JSON
  tx --schema-add <name> <type> <desc>  Add a field to schema

\x1b[33mSemantics:\x1b[0m
  tx --structures                   Discovered field usage stats
  tx --aliases                      Known name variations
  tx --merge <canonical> <variant>  Manually merge aliases
  tx --templates                    Discovered task patterns

\x1b[33mReview & Stats:\x1b[0m
  tx --review                       Interactive daily review
  tx --stats                        Completion statistics

\x1b[33mExport:\x1b[0m
  tx --export json|markdown|ical    Export tasks

\x1b[33mConfig:\x1b[0m
  Provider: \x1b[1m${config.provider}\x1b[0m
  Storage: ${TASKS_DIR}/
`);
}

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

interface ParsedArgs {
  command: string;
  params: Record<string, string>;
  flags: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "help", params: {}, flags: new Set() };

  if (args.length === 0) return result;

  // Simple commands
  const simpleCommands: Record<string, string> = {
    "--list": "list",
    "--today": "today",
    "--week": "week",
    "--overdue": "overdue",
    "--blocked": "blocked",
    "--focus": "focus",
    "--structures": "structures",
    "--aliases": "aliases",
    "--templates": "templates",
    "--review": "review",
    "--stats": "stats",
    "--graph": "graph",
  };

  if (simpleCommands[args[0]]) {
    result.command = simpleCommands[args[0]];
    return result;
  }

  // Schema commands
  if (args[0] === "--schema") {
    result.command = "schema";
    if (args[1] === "--json") {
      result.flags.add("json");
    }
    return result;
  }

  if (args[0] === "--schema-add") {
    result.command = "schema-add";
    result.params.name = args[1] || "";
    result.params.type = args[2] || "";
    result.params.description = args.slice(3).join(" ");
    return result;
  }

  // Commands with parameters
  if (args[0] === "--by" && args[1]) {
    result.command = "by";
    result.params.field = args[1];
    return result;
  }

  if (args[0] === "--query") {
    result.command = "query";
    let i = 1;
    while (i < args.length) {
      if (!args[i].startsWith("--")) {
        result.params.field = args[i];
        i++;
      } else if (args[i] === "--eq" && args[i + 1]) {
        result.params.op = "eq";
        result.params.value = args[i + 1];
        i += 2;
      } else if (args[i] === "--contains" && args[i + 1]) {
        result.params.op = "contains";
        result.params.value = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    }
    return result;
  }

  if (args[0] === "--q") {
    result.command = "nlquery";
    result.params.query = args.slice(1).join(" ");
    return result;
  }

  if (args[0] === "--complete") {
    result.command = "complete";
    result.params.id = args[1] || "";
    return result;
  }

  if (args[0] === "--delete") {
    result.command = "delete";
    result.params.id = args[1] || "";
    return result;
  }

  if (args[0] === "--export") {
    result.command = "export";
    result.params.format = args[1] || "json";
    return result;
  }

  if (args[0] === "--merge") {
    result.command = "merge";
    result.params.canonical = args[1] || "";
    result.params.variant = args[2] || "";
    return result;
  }

  // Default: add task
  result.command = "add";

  // Check for --blocks flag
  const blocksIdx = args.indexOf("--blocks");
  if (blocksIdx !== -1 && args[blocksIdx + 1]) {
    result.params.blocks = args[blocksIdx + 1];
    args = [...args.slice(0, blocksIdx), ...args.slice(blocksIdx + 2)];
  }

  result.params.raw = args.join(" ");
  return result;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const { command, params, flags } = parseArgs(args);

  try {
    switch (command) {
      case "help":
        showHelp(config);
        break;

      case "add":
        const { tasks: createdTasks, schemaUpdated } = await addTasks(params.raw, config, { blocks: params.blocks });
        const taskWord = createdTasks.length === 1 ? "Task" : "Tasks";
        console.log(`\n\x1b[32m✓ ${createdTasks.length} ${taskWord} added\x1b[0m${schemaUpdated ? " \x1b[35m(schema updated)\x1b[0m" : ""}\n`);
        for (const task of createdTasks) {
          displayTask(task, { verbose: createdTasks.length === 1 });
        }
        break;

      case "list":
        listTasks();
        break;

      case "today":
        viewToday();
        break;

      case "week":
        viewWeek();
        break;

      case "overdue":
        viewOverdue();
        break;

      case "blocked":
        viewBlocked();
        break;

      case "focus":
        viewFocus();
        break;

      case "by":
        listTasks({ groupBy: params.field });
        break;

      case "query":
        if (!params.field || !params.value) {
          console.error(`\x1b[31mUsage: tx --query <field> --eq <value>\x1b[0m`);
          process.exit(1);
        }
        listTasks({
          filter: [{ field: params.field, op: params.op || "eq", value: params.value }],
        });
        break;

      case "nlquery":
        if (!params.query) {
          console.error(`\x1b[31mUsage: tx --q "<natural language query>"\x1b[0m`);
          process.exit(1);
        }
        console.log(`\x1b[90m⏳ Parsing query...\x1b[0m`);
        const index = loadIndex();
        const parsed = await naturalLanguageQuery(params.query, config, index);
        listTasks({ filter: parsed.filters, groupBy: parsed.groupBy, sort: parsed.sort });
        break;

      case "complete":
        if (!params.id) {
          console.error(`\x1b[31mUsage: tx --complete <task-id>\x1b[0m`);
          process.exit(1);
        }
        const completed = await completeTask(params.id, config);
        if (completed) {
          console.log(`\x1b[32m✓ Task completed: ${completed.id.slice(0, 8)}\x1b[0m`);
        } else {
          console.error(`\x1b[31mTask not found: ${params.id}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "delete":
        if (!params.id) {
          console.error(`\x1b[31mUsage: tx --delete <task-id>\x1b[0m`);
          process.exit(1);
        }
        const deleted = deleteTask(params.id);
        if (deleted) {
          console.log(`\x1b[32m✓ Task deleted: ${deleted.id.slice(0, 8)}\x1b[0m`);
        } else {
          console.error(`\x1b[31mTask not found: ${params.id}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "schema":
        showSchema(flags.has("json"));
        break;

      case "schema-add":
        if (!params.name || !params.type) {
          console.error(`\x1b[31mUsage: tx --schema-add <name> <type> <description>\x1b[0m`);
          console.log(`\x1b[33mTypes: string, date, number, boolean, array, duration\x1b[0m`);
          process.exit(1);
        }
        addSchemaField(params.name, params.type, params.description || `Field: ${params.name}`);
        break;

      case "structures":
        showStructures();
        break;

      case "aliases":
        showAliases();
        break;

      case "merge":
        if (!params.canonical || !params.variant) {
          console.error(`\x1b[31mUsage: tx --merge <canonical> <variant>\x1b[0m`);
          process.exit(1);
        }
        mergeAliases(params.canonical, params.variant);
        break;

      case "templates":
        showTemplates();
        break;

      case "review":
        await interactiveReview(config);
        break;

      case "stats":
        showStats();
        break;

      case "export":
        exportTasks(params.format);
        break;

      case "graph":
        showGraph();
        break;

      default:
        showHelp(config);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n\x1b[31m✗ Error:\x1b[0m ${error.message}`);
    }
    process.exit(1);
  }
}

main();
