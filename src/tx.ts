#!/usr/bin/env node

// ============================================================================
// TX - SEMANTIC TASK MANAGEMENT CLI
// ============================================================================
// Refactored to use the new storage interface and config system.

import { ChatBedrockConverse } from "@langchain/aws";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createInterface } from "readline";
import { randomUUID } from "crypto";

// Import server
import { startServerCLI } from "./server/index.js";

// Import types
import {
  Task,
  TaskIndex,
  TaskSchema,
  TaskStatus,
  Scope,
  SemanticField,
  FieldDefinition,
  LLMConfig,
  TxConfig,
  DEFAULT_SCHEMA,
} from "./types/index.js";

// Import storage and config
import { IStorage, createStorage, getStorageTypeName } from "./storage/index.js";
import { loadConfig, saveConfig, getDataDir, describeConfig, getCurrentScope, setCurrentScope } from "./config/index.js";

// ============================================================================
// GLOBAL STATE
// ============================================================================

let storage: IStorage;
let config: TxConfig;

// ============================================================================
// UTILITIES
// ============================================================================

function createModel(llmConfig: LLMConfig): BaseChatModel {
  switch (llmConfig.provider) {
    case "bedrock":
      return new ChatBedrockConverse({
        model: llmConfig.bedrock?.model || "anthropic.claude-3-5-sonnet-20241022-v2:0",
        region: llmConfig.bedrock?.region || "us-east-1",
      });
    case "openai":
      if (!llmConfig.openai) throw new Error("OpenAI config not found");
      return new ChatOpenAI({
        modelName: llmConfig.openai.model,
        openAIApiKey: llmConfig.openai.apiKey,
        configuration: { baseURL: llmConfig.openai.baseUrl },
      });
    case "local":
      if (!llmConfig.local) throw new Error("Local config not found");
      return new ChatOpenAI({
        modelName: llmConfig.local.model,
        openAIApiKey: llmConfig.local.apiKey || "not-needed",
        configuration: { baseURL: llmConfig.local.baseUrl },
      });
    default:
      throw new Error(`Unknown provider: ${llmConfig.provider}`);
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
  
  const match12h = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match12h) {
    let hours = parseInt(match12h[1]);
    const minutes = parseInt(match12h[2] || "0");
    const ampm = match12h[3];
    
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    
    return { hours, minutes };
  }
  
  const match24h = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (match24h) {
    return { hours: parseInt(match24h[1]), minutes: parseInt(match24h[2]) };
  }
  
  return null;
}

function normalizeDeadline(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  
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
  
  const timeOnly = parseTime(value);
  if (timeOnly) {
    const hours = timeOnly.hours.toString().padStart(2, "0");
    const mins = timeOnly.minutes.toString().padStart(2, "0");
    return `${today}T${hours}:${mins}`;
  }
  
  const relDate = parseRelativeDate(value);
  if (relDate) {
    return relDate;
  }
  
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
  return datetime.split("T")[0];
}

function isOverdue(deadline: string): boolean {
  const deadlineDate = getDatePart(deadline);
  const today = getToday();
  
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
// SCHEMA OPERATIONS
// ============================================================================

function addFieldToSchema(
  schema: TaskSchema,
  fieldName: string,
  definition: Partial<FieldDefinition>
): boolean {
  const normalizedName = fieldName.toLowerCase().replace(/\s+/g, "_");

  if (schema.fields[normalizedName]) {
    return false;
  }

  for (const [, existingDef] of Object.entries(schema.fields)) {
    if (existingDef.aliases?.includes(normalizedName)) {
      return false;
    }
  }

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

  if (schema.fields[normalized]) {
    return normalized;
  }

  for (const [canonicalName, def] of Object.entries(schema.fields)) {
    if (def.aliases?.includes(normalized)) {
      return canonicalName;
    }
  }

  return normalized;
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
  dependsOn?: number;
}

interface ExtractionResult {
  tasks: ExtractedTask[];
  newFields?: NewFieldProposal[];
}

async function extractSemantics(
  raw: string,
  schema: TaskSchema,
  index: TaskIndex
): Promise<ExtractionResult> {
  const model = createModel(config.llm);

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

    function normalizeFieldValue(fieldName: string, field: SemanticField): SemanticField {
      if (fieldName === "deadline" && typeof field.value === "string") {
        return { ...field, value: normalizeDeadline(field.value as string) };
      }
      return field;
    }

    if (parsed.tasks && Array.isArray(parsed.tasks)) {
      const tasks: ExtractedTask[] = parsed.tasks.map((t: Record<string, unknown>, idx: number) => {
        const normalizedFields: Record<string, SemanticField> = {};
        const fields = t.fields as Record<string, SemanticField> | undefined;
        for (const [key, value] of Object.entries(fields || {})) {
          const canonicalName = resolveFieldName(schema, key);
          normalizedFields[canonicalName] = normalizeFieldValue(canonicalName, value as SemanticField);
        }

        return {
          raw: (t.raw as string) || raw,
          fields: Object.keys(normalizedFields).length > 0
            ? normalizedFields
            : { action: { name: "action", value: (t.raw as string) || raw } },
          summary: (t.summary as string) || (t.raw as string) || raw,
          recurrence: t.recurrence as Task["recurrence"],
          templateId: t.suggestedTemplate as string | undefined,
          seq: (t.seq as number) ?? idx,
          dependsOn: t.dependsOn as number | undefined,
        };
      });

      return {
        tasks,
        newFields: parsed.newFields as NewFieldProposal[],
      };
    }

    const normalizedFields: Record<string, SemanticField> = {};
    const fields = parsed.fields as Record<string, SemanticField> | undefined;
    for (const [key, value] of Object.entries(fields || {})) {
      const canonicalName = resolveFieldName(schema, key);
      normalizedFields[canonicalName] = normalizeFieldValue(canonicalName, value as SemanticField);
    }

    return {
      tasks: [{
        raw,
        fields: Object.keys(normalizedFields).length > 0
          ? normalizedFields
          : { action: { name: "action", value: raw } },
        summary: (parsed.summary as string) || raw,
        recurrence: parsed.recurrence as Task["recurrence"],
        templateId: parsed.suggestedTemplate as string | undefined,
      }],
      newFields: parsed.newFields as NewFieldProposal[],
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
  index: TaskIndex
): Promise<{ filters: Array<{ field: string; op: string; value: string }>; groupBy?: string; sort?: string }> {
  const model = createModel(config.llm);

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
// TASK OPERATIONS
// ============================================================================

async function addTasks(raw: string, options: { blocks?: string } = {}): Promise<{ tasks: Task[]; schemaUpdated: boolean }> {
  const index = await storage.loadIndex();
  const schema = await storage.loadSchema();

  console.log(`\x1b[90m⏳ Extracting semantic structure...\x1b[0m`);

  const { tasks: extractedTasks, newFields } = await extractSemantics(raw, schema, index);

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
      await storage.saveSchema(schema);
    }
  }

  const createdTasks: Task[] = [];

  for (const extracted of extractedTasks) {
    extracted.fields.summary = { name: "summary", value: extracted.summary };

    // Auto-assign current scope if set and not already specified
    const currentScope = getCurrentScope(config);
    if (currentScope && !extracted.fields.scope) {
      extracted.fields.scope = { name: "scope", value: currentScope };
    }

    // Auto-assign subject to scope if we have both
    if (currentScope && extracted.fields.subject) {
      const subject = String(extracted.fields.subject.value).toLowerCase().replace(/\s+/g, "_");
      if (!index.subjectScopes[subject]) {
        index.subjectScopes[subject] = currentScope;
        if (index.scopes[currentScope]) {
          if (!index.scopes[currentScope].subjects.includes(subject)) {
            index.scopes[currentScope].subjects.push(subject);
          }
        }
      }
    }

    const task: Task = {
      id: randomUUID(),
      raw: extracted.raw,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      status: "backlog", // New tasks start in backlog
      completed: false,
      fields: extracted.fields,
      recurrence: extracted.recurrence,
      templateId: extracted.templateId,
    };

    if (options.blocks && createdTasks.length === 0) {
      const blockedTask = await storage.findTaskByPrefix(options.blocks);
      if (blockedTask) {
        task.blocks = [blockedTask.id];
        blockedTask.blockedBy = blockedTask.blockedBy || [];
        blockedTask.blockedBy.push(task.id);
        await storage.saveTask(blockedTask);
      }
    }

    updateStructures(index, extracted.fields);
    updateTemplates(index, task, extracted.templateId);

    index.tasks.push(task.id);
    index.stats.totalCreated++;
    if (index.stats.byStatus) {
      index.stats.byStatus.backlog++;
    }

    createdTasks.push(task);
  }

  for (let i = 0; i < extractedTasks.length; i++) {
    const extracted = extractedTasks[i];
    if (extracted.dependsOn !== undefined && extracted.dependsOn >= 0 && extracted.dependsOn < createdTasks.length) {
      const dependentTask = createdTasks[i];
      const prerequisiteTask = createdTasks[extracted.dependsOn];

      prerequisiteTask.blocks = prerequisiteTask.blocks || [];
      if (!prerequisiteTask.blocks.includes(dependentTask.id)) {
        prerequisiteTask.blocks.push(dependentTask.id);
      }

      dependentTask.blockedBy = dependentTask.blockedBy || [];
      if (!dependentTask.blockedBy.includes(prerequisiteTask.id)) {
        dependentTask.blockedBy.push(prerequisiteTask.id);
      }
    }
  }

  for (const task of createdTasks) {
    await storage.saveTask(task);
  }

  await storage.saveIndex(index);

  return { tasks: createdTasks, schemaUpdated };
}

async function deleteTask(taskId: string): Promise<Task | null> {
  const task = await storage.findTaskByPrefix(taskId);
  if (!task) return null;

  const index = await storage.loadIndex();
  index.tasks = index.tasks.filter((id) => id !== task.id);

  for (const id of index.tasks) {
    const t = await storage.loadTask(id);
    if (t && t.blockedBy?.includes(task.id)) {
      t.blockedBy = t.blockedBy.filter((bid) => bid !== task.id);
      await storage.saveTask(t);
    }
  }

  if (task.blocks) {
    for (const blockedId of task.blocks) {
      const blocked = await storage.loadTask(blockedId);
      if (blocked && blocked.blockedBy) {
        blocked.blockedBy = blocked.blockedBy.filter((bid) => bid !== task.id);
        await storage.saveTask(blocked);
      }
    }
  }

  await storage.deleteTask(task.id);
  await storage.saveIndex(index);

  return task;
}

async function completeTask(taskId: string): Promise<Task | null> {
  const task = await storage.findTaskByPrefix(taskId);
  if (!task) return null;

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

  const oldStatus = task.status;
  task.status = "completed";
  task.completed = true;
  task.updated = new Date().toISOString();
  task.completionInfo = {
    completedAt: new Date().toISOString(),
    duration,
    notes: notes !== "skip" ? notes : undefined,
  };

  // Update status counts
  const index = await storage.loadIndex();
  if (index.stats.byStatus) {
    if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
      index.stats.byStatus[oldStatus]--;
    }
    index.stats.byStatus.completed++;
  }
  index.stats.totalCompleted++;

  const today = getToday();
  index.stats.completionsByDay[today] = (index.stats.completionsByDay[today] || 0) + 1;

  const project = String(task.fields.project?.value || task.fields.subject?.value || "unknown");
  index.stats.completionsByProject[project] = (index.stats.completionsByProject[project] || 0) + 1;

  if (duration && task.fields.task_type) {
    const taskType = String(task.fields.task_type.value);
    const current = index.stats.averageDuration[taskType] || duration;
    index.stats.averageDuration[taskType] = Math.round((current + duration) / 2);
  }

  if (task.recurrence) {
    const nextTask = { ...task };
    nextTask.id = randomUUID();
    nextTask.status = "backlog"; // Recurring tasks start in backlog
    nextTask.completed = false;
    nextTask.completionInfo = undefined;
    nextTask.created = new Date().toISOString();
    nextTask.updated = new Date().toISOString();
    if (index.stats.byStatus) {
      index.stats.byStatus.backlog++;
    }

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

    await storage.saveTask(nextTask);
    index.tasks.push(nextTask.id);
    console.log(`\x1b[36m↻ Created next occurrence: ${nextTask.id.slice(0, 8)}\x1b[0m`);
  }

  await storage.saveTask(task);
  await storage.archiveTask(task);
  await storage.saveIndex(index);

  return task;
}

async function activateTask(taskId: string): Promise<Task | null> {
  const task = await storage.findTaskByPrefix(taskId);
  if (!task) return null;

  const oldStatus = task.status;
  task.status = "active";
  task.completed = false;
  task.updated = new Date().toISOString();

  const index = await storage.loadIndex();
  if (index.stats.byStatus) {
    if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
      index.stats.byStatus[oldStatus]--;
    }
    index.stats.byStatus.active++;
  }

  await storage.saveTask(task);
  await storage.saveIndex(index);

  return task;
}

async function backlogTask(taskId: string): Promise<Task | null> {
  const task = await storage.findTaskByPrefix(taskId);
  if (!task) return null;

  const oldStatus = task.status;
  task.status = "backlog";
  task.completed = false;
  task.updated = new Date().toISOString();

  const index = await storage.loadIndex();
  if (index.stats.byStatus) {
    if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
      index.stats.byStatus[oldStatus]--;
    }
    index.stats.byStatus.backlog++;
  }

  await storage.saveTask(task);
  await storage.saveIndex(index);

  return task;
}

async function cancelTask(taskId: string, reason?: string): Promise<Task | null> {
  const task = await storage.findTaskByPrefix(taskId);
  if (!task) return null;

  const oldStatus = task.status;
  task.status = "canceled";
  task.completed = false;
  task.updated = new Date().toISOString();
  task.canceledInfo = {
    canceledAt: new Date().toISOString(),
    reason,
  };

  const index = await storage.loadIndex();
  if (index.stats.byStatus) {
    if (oldStatus && index.stats.byStatus[oldStatus] > 0) {
      index.stats.byStatus[oldStatus]--;
    }
    index.stats.byStatus.canceled++;
  }
  index.stats.totalCanceled = (index.stats.totalCanceled || 0) + 1;

  await storage.saveTask(task);
  await storage.archiveTask(task);
  await storage.saveIndex(index);

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
  if (deadline.includes("T")) {
    const [datePart, timePart] = deadline.split("T");
    const date = new Date(deadline);
    if (isNaN(date.getTime())) {
      const dateOnly = new Date(datePart + "T00:00:00");
      if (isNaN(dateOnly.getTime())) return deadline;
      const [hours, minutes] = timePart.split(":");
      const hour = parseInt(hours) || 0;
      const ampm = hour >= 12 ? "pm" : "am";
      const hour12 = hour % 12 || 12;
      const timeStr = `${hour12}:${minutes || "00"}${ampm}`;
      return `${dateOnly.toLocaleDateString()} ${timeStr}`;
    }
    const dateStr = date.toLocaleDateString();
    const [hours, minutes] = timePart.split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "pm" : "am";
    const hour12 = hour % 12 || 12;
    const timeStr = `${hour12}:${minutes}${ampm}`;
    return `${dateStr} ${timeStr}`;
  }
  const date = new Date(deadline + "T00:00:00");
  if (isNaN(date.getTime())) return deadline;
  return date.toLocaleDateString();
}

function getStatusIcon(status: TaskStatus): string {
  switch (status) {
    case "active":
      return "\x1b[36m▶\x1b[0m"; // Cyan play
    case "backlog":
      return "\x1b[33m○\x1b[0m"; // Yellow circle
    case "completed":
      return "\x1b[32m✓\x1b[0m"; // Green check
    case "canceled":
      return "\x1b[90m✗\x1b[0m"; // Gray X
    default:
      return "\x1b[33m○\x1b[0m";
  }
}

function displayTask(task: Task, options: { verbose?: boolean; showRelations?: boolean } = {}) {
  const shortId = task.id.slice(0, 8);
  const statusIcon = getStatusIcon(task.status || (task.completed ? "completed" : "backlog"));

  const deadline = task.fields.deadline?.value as string;
  let deadlineIndicator = "";
  if (deadline && task.status !== "completed" && task.status !== "canceled") {
    if (isOverdue(deadline)) {
      deadlineIndicator = " \x1b[31m⚠ OVERDUE\x1b[0m";
    } else if (isToday(deadline)) {
      const timeStr = deadline.includes("T") ? ` @ ${deadline.split("T")[1]}` : "";
      deadlineIndicator = ` \x1b[33m📅 TODAY${timeStr}\x1b[0m`;
    }
  }

  const blockedIndicator = task.blockedBy?.length ? " \x1b[90m🔒 blocked\x1b[0m" : "";
  const statusLabel = task.status === "active" ? " \x1b[36m[active]\x1b[0m" : "";

  const summary = task.fields.summary?.value || task.fields.action?.value || task.raw;
  console.log(`${statusIcon} \x1b[1m${shortId}\x1b[0m  ${summary}${statusLabel}${deadlineIndicator}${blockedIndicator}`);

  if (options.verbose) {
    console.log(`  \x1b[90mRaw: ${task.raw}\x1b[0m`);
    console.log(`  \x1b[90mCreated: ${formatDate(task.created)}\x1b[0m`);
    if (task.recurrence) {
      console.log(`  \x1b[35m↻ Recurs: ${task.recurrence.pattern}${task.recurrence.dayOfWeek ? ` on ${task.recurrence.dayOfWeek}` : ""}\x1b[0m`);
    }
  }

  const keyFields = ["scope", "subject", "project", "deadline", "priority", "people", "context", "effort", "energy"];
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
// SCOPE FILTERING
// ============================================================================

/**
 * Filter tasks by the current scope setting
 */
async function filterByCurrentScope(tasks: Task[]): Promise<Task[]> {
  const currentScope = getCurrentScope(config);
  if (!currentScope) return tasks; // No scope = show all
  
  const index = await storage.loadIndex();
  const scope = index.scopes[currentScope];
  if (!scope) return tasks; // Invalid scope = show all
  
  // Get all subjects in this scope
  const subjectsInScope = new Set(scope.subjects);
  
  return tasks.filter(task => {
    // Check if task has the scope field directly
    const taskScope = task.fields.scope?.value;
    if (taskScope && String(taskScope).toLowerCase() === currentScope.toLowerCase()) {
      return true;
    }
    
    // Check if task's subject is in the scope
    const subject = task.fields.subject?.value || task.fields.project?.value;
    if (subject) {
      const normalizedSubject = String(subject).toLowerCase().replace(/\s+/g, "_");
      if (subjectsInScope.has(normalizedSubject)) {
        return true;
      }
    }
    
    return false;
  });
}

/**
 * Get scope indicator for display
 */
function getScopeIndicator(): string {
  const currentScope = getCurrentScope(config);
  if (!currentScope) return "";
  return `\x1b[35m[${currentScope}]\x1b[0m `;
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

async function listTasks(options: ListOptions = {}) {
  let tasks = await storage.loadAllTasks(options.showCompleted);

  // Filter by current scope unless viewing all
  tasks = await filterByCurrentScope(tasks);

  if (tasks.length === 0) {
    const scopeIndicator = getScopeIndicator();
    console.log(`\x1b[33m${scopeIndicator}No tasks found.\x1b[0m`);
    return;
  }

  if (options.filter?.length) {
    tasks = filterTasks(tasks, options.filter);
  }

  if (options.sort) {
    tasks.sort((a, b) => {
      const aVal = String(a.fields[options.sort!]?.value || "");
      const bVal = String(b.fields[options.sort!]?.value || "");
      return aVal.localeCompare(bVal);
    });
  } else {
    tasks.sort((a, b) => {
      const aDeadline = a.fields.deadline?.value as string || "9999-99-99";
      const bDeadline = b.fields.deadline?.value as string || "9999-99-99";
      if (aDeadline !== bDeadline) return aDeadline.localeCompare(bDeadline);
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    });
  }

  const filterLabel = options.filter?.length ? " filtered" : "";
  const scopeIndicator = getScopeIndicator();
  console.log(`\n\x1b[36m┌─ ${scopeIndicator}Tasks (${tasks.length}${filterLabel}) ─────────────────────────────────┐\x1b[0m\n`);

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
// VIEWS
// ============================================================================

async function viewToday() {
  await listTasks({
    filter: [{ field: "deadline", op: "eq", value: "today" }],
  });
}

async function viewWeek() {
  await listTasks({
    filter: [{ field: "deadline", op: "eq", value: "this_week" }],
    sort: "deadline",
  });
}

async function viewOverdue() {
  await listTasks({
    filter: [{ field: "deadline", op: "lt", value: "today" }],
  });
}

async function viewBlocked() {
  let tasks = (await storage.loadAllTasks()).filter((t) => t.blockedBy?.length);
  tasks = await filterByCurrentScope(tasks);
  
  const scopeIndicator = getScopeIndicator();
  if (tasks.length === 0) {
    console.log(`\x1b[33m${scopeIndicator}No blocked tasks.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ ${scopeIndicator}Blocked Tasks (${tasks.length}) ─────────────────────────────┐\x1b[0m\n`);
  for (const task of tasks) {
    displayTask(task, { showRelations: true });
  }
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function viewActive() {
  const result = await storage.queryTasks({ status: ["active"] });
  let tasks = await filterByCurrentScope(result.tasks);
  
  const scopeIndicator = getScopeIndicator();
  if (tasks.length === 0) {
    console.log(`\x1b[33m${scopeIndicator}No active tasks. Use 'tx --activate <id>' to activate a task.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ ${scopeIndicator}Active Tasks (${tasks.length}) ─────────────────────────────┐\x1b[0m\n`);
  for (const task of tasks) {
    displayTask(task, { showRelations: true });
  }
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function viewBacklog() {
  const result = await storage.queryTasks({ status: ["backlog"] });
  let tasks = await filterByCurrentScope(result.tasks);
  
  const scopeIndicator = getScopeIndicator();
  if (tasks.length === 0) {
    console.log(`\x1b[33m${scopeIndicator}Backlog is empty.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ ${scopeIndicator}Backlog (${tasks.length}) ─────────────────────────────────┐\x1b[0m\n`);
  for (const task of tasks) {
    displayTask(task);
  }
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function viewCanceled() {
  const result = await storage.queryTasks({ status: ["canceled"] });
  if (result.tasks.length === 0) {
    console.log(`\x1b[33mNo canceled tasks.\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m┌─ Canceled Tasks (${result.tasks.length}) ────────────────────────────┐\x1b[0m\n`);
  for (const task of result.tasks) {
    displayTask(task);
    if (task.canceledInfo?.reason) {
      console.log(`  \x1b[90mReason: ${task.canceledInfo.reason}\x1b[0m\n`);
    }
  }
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function viewFocus() {
  let tasks = await storage.loadAllTasks();
  tasks = await filterByCurrentScope(tasks);

  const scored = tasks.map((task) => {
    let score = 0;

    const priority = String(task.fields.priority?.value || "normal").toLowerCase();
    if (priority === "urgent") score += 100;
    else if (priority === "high") score += 50;

    const deadline = task.fields.deadline?.value as string;
    if (deadline) {
      if (isOverdue(deadline)) score += 200;
      else if (isToday(deadline)) score += 100;
      else if (isThisWeek(deadline)) score += 30;
    }

    if (task.blocks?.length) score += 40 * task.blocks.length;
    if (task.blockedBy?.length) score -= 50;

    return { task, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const scopeIndicator = getScopeIndicator();
  console.log(`\n\x1b[36m┌─ 🎯 ${scopeIndicator}Focus: Top Tasks ─────────────────────────────┐\x1b[0m\n`);

  if (top.length === 0) {
    console.log(`  \x1b[33mNo tasks to focus on!\x1b[0m\n`);
  } else {
    for (const { task } of top) {
      displayTask(task);
    }
  }

  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

// ============================================================================
// STRUCTURES & ALIASES
// ============================================================================

async function showStructures() {
  const index = await storage.loadIndex();

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

async function showSchema(outputJson = false) {
  const schema = await storage.loadSchema();

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
  console.log(`\n\x1b[90mConfig: ${getDataDir()}\x1b[0m\n`);
}

async function addSchemaField(name: string, type: string, description: string) {
  const schema = await storage.loadSchema();

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
    await storage.saveSchema(schema);
    console.log(`\x1b[32m✓ Added field "${name}" (${type}) to schema\x1b[0m`);
    return true;
  } else {
    console.log(`\x1b[33mField "${name}" already exists in schema\x1b[0m`);
    return false;
  }
}

async function showAliases() {
  const index = await storage.loadIndex();

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

async function mergeAliases(canonical: string, variant: string) {
  const index = await storage.loadIndex();

  if (!index.aliases[canonical]) {
    index.aliases[canonical] = [];
  }
  if (!index.aliases[canonical].includes(variant)) {
    index.aliases[canonical].push(variant);
  }

  await storage.saveIndex(index);
  console.log(`\x1b[32m✓ Merged: "${variant}" → "${canonical}"\x1b[0m`);
}

// ============================================================================
// TEMPLATES
// ============================================================================

// ============================================================================
// SCOPE MANAGEMENT
// ============================================================================

async function createScope(name: string, options: { description?: string; icon?: string; color?: string; parent?: string } = {}): Promise<Scope> {
  const index = await storage.loadIndex();
  
  // Generate ID from name
  const id = name.toLowerCase().replace(/\s+/g, "_");
  
  if (index.scopes[id]) {
    throw new Error(`Scope "${name}" already exists`);
  }
  
  const scope: Scope = {
    id,
    name,
    description: options.description,
    icon: options.icon,
    color: options.color,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    subjects: [],
    parent: options.parent,
  };
  
  index.scopes[id] = scope;
  await storage.saveIndex(index);
  
  return scope;
}

async function assignSubjectToScope(subject: string, scopeId: string): Promise<void> {
  const index = await storage.loadIndex();
  
  const normalizedSubject = subject.toLowerCase().replace(/\s+/g, "_");
  
  if (!index.scopes[scopeId]) {
    throw new Error(`Scope "${scopeId}" not found`);
  }
  
  // Remove from old scope if assigned
  const oldScopeId = index.subjectScopes[normalizedSubject];
  if (oldScopeId && index.scopes[oldScopeId]) {
    index.scopes[oldScopeId].subjects = index.scopes[oldScopeId].subjects.filter(s => s !== normalizedSubject);
  }
  
  // Add to new scope
  index.subjectScopes[normalizedSubject] = scopeId;
  if (!index.scopes[scopeId].subjects.includes(normalizedSubject)) {
    index.scopes[scopeId].subjects.push(normalizedSubject);
  }
  index.scopes[scopeId].updated = new Date().toISOString();
  
  await storage.saveIndex(index);
}

async function showScopes() {
  const index = await storage.loadIndex();
  
  const scopes = Object.values(index.scopes);
  if (scopes.length === 0) {
    console.log(`\x1b[33mNo scopes defined. Create one with: tx --scope-add <name>\x1b[0m`);
    return;
  }
  
  console.log(`\n\x1b[36m┌─ Scopes ───────────────────────────────────────────┐\x1b[0m\n`);
  
  // Build tree structure
  const rootScopes = scopes.filter(s => !s.parent);
  const childScopes = scopes.filter(s => s.parent);
  
  function displayScope(scope: Scope, indent = "") {
    const icon = scope.icon ? `${scope.icon} ` : "";
    const subjectCount = scope.subjects.length;
    const subjectsLabel = subjectCount > 0 ? ` \x1b[90m(${subjectCount} subject${subjectCount !== 1 ? 's' : ''})\x1b[0m` : "";
    
    console.log(`${indent}${icon}\x1b[1m${scope.name}\x1b[0m${subjectsLabel}`);
    
    if (scope.description) {
      console.log(`${indent}  \x1b[90m${scope.description}\x1b[0m`);
    }
    
    if (scope.subjects.length > 0) {
      console.log(`${indent}  \x1b[90mSubjects: ${scope.subjects.join(", ")}\x1b[0m`);
    }
    
    // Show children
    const children = childScopes.filter(s => s.parent === scope.id);
    for (const child of children) {
      displayScope(child, indent + "  ");
    }
    
    console.log();
  }
  
  for (const scope of rootScopes) {
    displayScope(scope);
  }
  
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function viewScope(scopeId: string) {
  const index = await storage.loadIndex();
  
  const scope = index.scopes[scopeId] || Object.values(index.scopes).find(s => s.name.toLowerCase() === scopeId.toLowerCase());
  
  if (!scope) {
    console.error(`\x1b[31mScope not found: ${scopeId}\x1b[0m`);
    console.log(`\x1b[33mAvailable scopes: ${Object.keys(index.scopes).join(", ") || "none"}\x1b[0m`);
    return;
  }
  
  // Get all subjects in this scope (and child scopes)
  const scopeIds = [scope.id];
  // Add child scope IDs
  for (const s of Object.values(index.scopes)) {
    if (s.parent === scope.id) {
      scopeIds.push(s.id);
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
  
  // Filter tasks by subjects in scope
  const allTasks = await storage.loadAllTasks();
  const tasksInScope = allTasks.filter(task => {
    const subject = task.fields.subject?.value || task.fields.project?.value;
    if (!subject) return false;
    const normalizedSubject = String(subject).toLowerCase().replace(/\s+/g, "_");
    return subjectsInScope.has(normalizedSubject);
  });
  
  const icon = scope.icon ? `${scope.icon} ` : "";
  console.log(`\n\x1b[36m┌─ ${icon}${scope.name} (${tasksInScope.length} tasks) ─────────────────────────────┐\x1b[0m\n`);
  
  if (scope.description) {
    console.log(`  \x1b[90m${scope.description}\x1b[0m\n`);
  }
  
  if (tasksInScope.length === 0) {
    console.log(`  \x1b[33mNo tasks in this scope.\x1b[0m`);
    if (scope.subjects.length === 0) {
      console.log(`  \x1b[90mAssign subjects with: tx --scope-assign <subject> ${scope.id}\x1b[0m`);
    }
  } else {
    // Group by subject
    const bySubject: Record<string, Task[]> = {};
    for (const task of tasksInScope) {
      const subject = String(task.fields.subject?.value || task.fields.project?.value || "other");
      if (!bySubject[subject]) {
        bySubject[subject] = [];
      }
      bySubject[subject].push(task);
    }
    
    for (const [subject, tasks] of Object.entries(bySubject)) {
      console.log(`\x1b[35m━━ ${subject} (${tasks.length}) ━━\x1b[0m\n`);
      for (const task of tasks) {
        displayTask(task);
      }
    }
  }
  
  console.log(`\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
}

async function showTemplates() {
  const index = await storage.loadIndex();

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

async function showStats() {
  const index = await storage.loadIndex();

  console.log(`\n\x1b[36m┌─ Task Statistics ──────────────────────────────────┐\x1b[0m\n`);

  console.log(`  \x1b[1mOverall\x1b[0m`);
  console.log(`  Created: ${index.stats.totalCreated}  Completed: ${index.stats.totalCompleted}`);

  const completionRate = index.stats.totalCreated > 0
    ? Math.round((index.stats.totalCompleted / index.stats.totalCreated) * 100)
    : 0;
  console.log(`  Completion rate: ${completionRate}%\n`);

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

async function interactiveReview() {
  const tasks = await storage.loadAllTasks();

  console.log(`\n\x1b[36m┌─ Daily Review ─────────────────────────────────────┐\x1b[0m\n`);

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

  const blocked = tasks.filter((t) => t.blockedBy?.length);
  if (blocked.length > 0) {
    console.log(`\x1b[90m🔒 Blocked (${blocked.length})\x1b[0m\n`);
  }

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
  console.log(`\x1b[90mTotal open tasks: ${tasks.length}\x1b[0m`);
}

// ============================================================================
// EXPORT
// ============================================================================

async function exportTasks(format: string) {
  const tasks = await storage.loadAllTasks(true);

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

async function showGraph() {
  const tasks = await storage.loadAllTasks();

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
        const blocked = await storage.loadTask(blockedId);
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

function showHelp() {
  console.log(`
\x1b[36m┌─────────────────────────────────────────┐
│  \x1b[1mtx\x1b[0m\x1b[36m - Semantic Task Management          │
└─────────────────────────────────────────┘\x1b[0m

\x1b[33mAdd Tasks:\x1b[0m
  tx <natural language task>
  tx <task> --blocks <task-id>      Add with dependency

\x1b[33mViews:\x1b[0m
  tx --list                         All open tasks (active + backlog)
  tx --active                       Currently active tasks
  tx --backlog                      Tasks in backlog
  tx --canceled                     Canceled tasks
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
  tx --activate <id>                Start working on a task
  tx --backlog-task <id>            Move task back to backlog
  tx --complete <id>                Complete task (tracks duration)
  tx --cancel <id> [--reason <r>]   Cancel a task
  tx --delete <id>                  Delete task permanently
  tx --graph                        Show dependency graph

\x1b[33mSchema:\x1b[0m
  tx --schema                       View the semantic schema
  tx --schema --json                Output schema as JSON
  tx --schema-add <name> <type> <desc>  Add a field to schema

\x1b[33mScopes:\x1b[0m
  tx --use-scope <scope>            Set active scope (namespace)
  tx --unset-scope                  Clear scope (global mode)
  tx --current-scope                Show current scope
  tx --scopes                       List all scopes
  tx --scope <name>                 View tasks in a scope
  tx --scope-add <name> [opts]      Create scope (--desc, --icon, --parent)
  tx --scope-assign <subject> <scope>  Assign subject to scope

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

\x1b[33mServer:\x1b[0m
  tx --serve                        Start tRPC server (default port: 3847)
  tx --serve --port <port>          Start on custom port

\x1b[33mConfig:\x1b[0m
  tx --config                       Show configuration
  Provider: \x1b[1m${config.llm.provider}\x1b[0m
  Storage: ${getStorageTypeName(config.storage)}
`);
}

async function showConfig() {
  console.log(`\n\x1b[36m┌─ TX Configuration ─────────────────────────────────┐\x1b[0m\n`);
  console.log(describeConfig(config));
  console.log(`\n\x1b[36m└────────────────────────────────────────────────────┘\x1b[0m\n`);
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

  const simpleCommands: Record<string, string> = {
    "--list": "list",
    "--active": "active",
    "--backlog": "backlog-view",
    "--canceled": "canceled",
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
    "--config": "config",
    "--serve": "serve",
    "--scopes": "scopes",
    "--current-scope": "current-scope",
    "--unset-scope": "unset-scope",
  };

  if (simpleCommands[args[0]]) {
    result.command = simpleCommands[args[0]];
    // Parse --port for serve command
    if (args[0] === "--serve" && args[1] === "--port" && args[2]) {
      result.params.port = args[2];
    }
    return result;
  }

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

  if (args[0] === "--activate") {
    result.command = "activate";
    result.params.id = args[1] || "";
    return result;
  }

  if (args[0] === "--backlog-task") {
    result.command = "backlog-task";
    result.params.id = args[1] || "";
    return result;
  }

  if (args[0] === "--cancel") {
    result.command = "cancel";
    result.params.id = args[1] || "";
    // Check for --reason flag
    const reasonIdx = args.indexOf("--reason");
    if (reasonIdx !== -1 && args[reasonIdx + 1]) {
      result.params.reason = args.slice(reasonIdx + 1).join(" ");
    }
    return result;
  }

  if (args[0] === "--scope") {
    result.command = "scope-view";
    result.params.scopeId = args[1] || "";
    return result;
  }

  if (args[0] === "--scope-add") {
    result.command = "scope-add";
    result.params.name = args[1] || "";
    // Parse optional flags
    const descIdx = args.indexOf("--desc");
    if (descIdx !== -1 && args[descIdx + 1]) {
      result.params.description = args[descIdx + 1];
    }
    const iconIdx = args.indexOf("--icon");
    if (iconIdx !== -1 && args[iconIdx + 1]) {
      result.params.icon = args[iconIdx + 1];
    }
    const parentIdx = args.indexOf("--parent");
    if (parentIdx !== -1 && args[parentIdx + 1]) {
      result.params.parent = args[parentIdx + 1];
    }
    return result;
  }

  if (args[0] === "--scope-assign") {
    result.command = "scope-assign";
    result.params.subject = args[1] || "";
    result.params.scopeId = args[2] || "";
    return result;
  }

  if (args[0] === "--use-scope") {
    result.command = "use-scope";
    result.params.scopeId = args[1] || "";
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

  result.command = "add";

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
  // Load configuration
  config = loadConfig();
  
  // Create storage instance
  storage = createStorage(config.storage);
  await storage.initialize();

  const args = process.argv.slice(2);
  const { command, params, flags } = parseArgs(args);

  try {
    switch (command) {
      case "help":
        showHelp();
        break;

      case "add":
        const { tasks: createdTasks, schemaUpdated } = await addTasks(params.raw, { blocks: params.blocks });
        const taskWord = createdTasks.length === 1 ? "Task" : "Tasks";
        console.log(`\n\x1b[32m✓ ${createdTasks.length} ${taskWord} added\x1b[0m${schemaUpdated ? " \x1b[35m(schema updated)\x1b[0m" : ""}\n`);
        for (const task of createdTasks) {
          displayTask(task, { verbose: createdTasks.length === 1 });
        }
        break;

      case "list":
        await listTasks();
        break;

      case "today":
        await viewToday();
        break;

      case "week":
        await viewWeek();
        break;

      case "overdue":
        await viewOverdue();
        break;

      case "blocked":
        await viewBlocked();
        break;

      case "active":
        await viewActive();
        break;

      case "backlog-view":
        await viewBacklog();
        break;

      case "canceled":
        await viewCanceled();
        break;

      case "focus":
        await viewFocus();
        break;

      case "by":
        await listTasks({ groupBy: params.field });
        break;

      case "query":
        if (!params.field || !params.value) {
          console.error(`\x1b[31mUsage: tx --query <field> --eq <value>\x1b[0m`);
          process.exit(1);
        }
        await listTasks({
          filter: [{ field: params.field, op: params.op || "eq", value: params.value }],
        });
        break;

      case "nlquery":
        if (!params.query) {
          console.error(`\x1b[31mUsage: tx --q "<natural language query>"\x1b[0m`);
          process.exit(1);
        }
        console.log(`\x1b[90m⏳ Parsing query...\x1b[0m`);
        const index = await storage.loadIndex();
        const parsed = await naturalLanguageQuery(params.query, index);
        await listTasks({ filter: parsed.filters, groupBy: parsed.groupBy, sort: parsed.sort });
        break;

      case "complete":
        if (!params.id) {
          console.error(`\x1b[31mUsage: tx --complete <task-id>\x1b[0m`);
          process.exit(1);
        }
        const completed = await completeTask(params.id);
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
        const deleted = await deleteTask(params.id);
        if (deleted) {
          console.log(`\x1b[32m✓ Task deleted: ${deleted.id.slice(0, 8)}\x1b[0m`);
        } else {
          console.error(`\x1b[31mTask not found: ${params.id}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "activate":
        if (!params.id) {
          console.error(`\x1b[31mUsage: tx --activate <task-id>\x1b[0m`);
          process.exit(1);
        }
        const activated = await activateTask(params.id);
        if (activated) {
          console.log(`\x1b[36m▶ Task activated: ${activated.id.slice(0, 8)}\x1b[0m`);
          displayTask(activated);
        } else {
          console.error(`\x1b[31mTask not found: ${params.id}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "backlog-task":
        if (!params.id) {
          console.error(`\x1b[31mUsage: tx --backlog-task <task-id>\x1b[0m`);
          process.exit(1);
        }
        const backlogged = await backlogTask(params.id);
        if (backlogged) {
          console.log(`\x1b[33m○ Task moved to backlog: ${backlogged.id.slice(0, 8)}\x1b[0m`);
        } else {
          console.error(`\x1b[31mTask not found: ${params.id}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "cancel":
        if (!params.id) {
          console.error(`\x1b[31mUsage: tx --cancel <task-id> [--reason <reason>]\x1b[0m`);
          process.exit(1);
        }
        const canceled = await cancelTask(params.id, params.reason);
        if (canceled) {
          console.log(`\x1b[90m✗ Task canceled: ${canceled.id.slice(0, 8)}\x1b[0m`);
        } else {
          console.error(`\x1b[31mTask not found: ${params.id}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "schema":
        await showSchema(flags.has("json"));
        break;

      case "schema-add":
        if (!params.name || !params.type) {
          console.error(`\x1b[31mUsage: tx --schema-add <name> <type> <description>\x1b[0m`);
          console.log(`\x1b[33mTypes: string, date, number, boolean, array, duration\x1b[0m`);
          process.exit(1);
        }
        await addSchemaField(params.name, params.type, params.description || `Field: ${params.name}`);
        break;

      case "structures":
        await showStructures();
        break;

      case "aliases":
        await showAliases();
        break;

      case "merge":
        if (!params.canonical || !params.variant) {
          console.error(`\x1b[31mUsage: tx --merge <canonical> <variant>\x1b[0m`);
          process.exit(1);
        }
        await mergeAliases(params.canonical, params.variant);
        break;

      case "templates":
        await showTemplates();
        break;

      case "scopes":
        await showScopes();
        break;

      case "scope-view":
        if (!params.scopeId) {
          console.error(`\x1b[31mUsage: tx --scope <scope-name>\x1b[0m`);
          process.exit(1);
        }
        await viewScope(params.scopeId);
        break;

      case "scope-add":
        if (!params.name) {
          console.error(`\x1b[31mUsage: tx --scope-add <name> [--desc <description>] [--icon <emoji>] [--parent <scope-id>]\x1b[0m`);
          process.exit(1);
        }
        try {
          const newScope = await createScope(params.name, {
            description: params.description,
            icon: params.icon,
            parent: params.parent,
          });
          console.log(`\x1b[32m✓ Created scope: ${newScope.icon || ""}${newScope.name}\x1b[0m`);
        } catch (error) {
          console.error(`\x1b[31m${(error as Error).message}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "scope-assign":
        if (!params.subject || !params.scopeId) {
          console.error(`\x1b[31mUsage: tx --scope-assign <subject> <scope-id>\x1b[0m`);
          process.exit(1);
        }
        try {
          await assignSubjectToScope(params.subject, params.scopeId);
          console.log(`\x1b[32m✓ Assigned "${params.subject}" to scope "${params.scopeId}"\x1b[0m`);
        } catch (error) {
          console.error(`\x1b[31m${(error as Error).message}\x1b[0m`);
          process.exit(1);
        }
        break;

      case "use-scope":
        if (!params.scopeId) {
          console.error(`\x1b[31mUsage: tx --use-scope <scope-id>\x1b[0m`);
          process.exit(1);
        }
        {
          const index = await storage.loadIndex();
          if (!index.scopes[params.scopeId]) {
            console.error(`\x1b[31mScope not found: ${params.scopeId}\x1b[0m`);
            console.log(`\x1b[33mAvailable scopes: ${Object.keys(index.scopes).join(", ") || "none"}\x1b[0m`);
            process.exit(1);
          }
          config = setCurrentScope(config, params.scopeId);
          const scope = index.scopes[params.scopeId];
          console.log(`\x1b[32m✓ Now using scope: ${scope.icon || ""}${scope.name}\x1b[0m`);
          console.log(`\x1b[90m  All new tasks will be created in this scope.\x1b[0m`);
        }
        break;

      case "unset-scope":
        config = setCurrentScope(config, null);
        console.log(`\x1b[32m✓ Scope unset. Operating in global mode.\x1b[0m`);
        break;

      case "current-scope":
        {
          const currentScope = getCurrentScope(config);
          if (currentScope) {
            const index = await storage.loadIndex();
            const scope = index.scopes[currentScope];
            if (scope) {
              console.log(`\x1b[36mCurrent scope: ${scope.icon || ""}${scope.name}\x1b[0m`);
              if (scope.description) {
                console.log(`\x1b[90m  ${scope.description}\x1b[0m`);
              }
            } else {
              console.log(`\x1b[33mCurrent scope "${currentScope}" no longer exists.\x1b[0m`);
            }
          } else {
            console.log(`\x1b[33mNo scope set. Operating in global mode.\x1b[0m`);
            console.log(`\x1b[90m  Use 'tx --use-scope <scope>' to set a scope.\x1b[0m`);
          }
        }
        break;

      case "review":
        await interactiveReview();
        break;

      case "stats":
        await showStats();
        break;

      case "export":
        await exportTasks(params.format);
        break;

      case "graph":
        await showGraph();
        break;

      case "config":
        await showConfig();
        break;

      case "serve":
        const port = params.port ? parseInt(params.port, 10) : undefined;
        await startServerCLI(port);
        return; // Server runs until interrupted

      default:
        showHelp();
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n\x1b[31m✗ Error:\x1b[0m ${error.message}`);
    }
    process.exit(1);
  } finally {
    // Clean up storage
    await storage.close();
  }
}

main();
