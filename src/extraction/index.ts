// ============================================================================
// SEMANTIC EXTRACTION MODULE
// ============================================================================
// Shared module for extracting semantic structure from natural language tasks.

import { ChatBedrockConverse } from "@langchain/aws";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import {
  Task,
  TaskIndex,
  TaskSchema,
  SemanticField,
  FieldDefinition,
  LLMConfig,
  NoteIndex,
  EntityInfo,
} from "../types/index.js";

// ============================================================================
// LLM MODEL CREATION
// ============================================================================

export function createModel(llmConfig: LLMConfig): BaseChatModel {
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

  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIndex = daysOfWeek.indexOf(lower);
  if (dayIndex !== -1) {
    const todayIndex = today.getDay();
    let daysUntil = dayIndex - todayIndex;
    if (daysUntil <= 0) daysUntil += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + daysUntil);
    return d.toISOString().split("T")[0];
  }

  return null;
}

function normalizeDeadline(value: string): string {
  if (!value) return value;
  
  // If already ISO format, return as-is
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value)) {
    return value;
  }

  // Try to parse relative dates
  const parsed = parseRelativeDate(value);
  if (parsed) return parsed;

  // Try to parse common formats
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split("T")[0];
  }

  return value;
}

// ============================================================================
// SCHEMA UTILITIES
// ============================================================================

function resolveFieldName(schema: TaskSchema, name: string): string {
  const lower = name.toLowerCase();
  
  // Check exact match first
  if (schema.fields[lower]) return lower;

  // Check aliases
  for (const [fieldName, def] of Object.entries(schema.fields)) {
    if (def.aliases?.some((a) => a.toLowerCase() === lower)) {
      return fieldName;
    }
  }

  return lower;
}

function formatSchemaForPrompt(schema: TaskSchema): string {
  const byCategory: Record<string, string[]> = {
    core: [],
    relationship: [],
    recurrence: [],
    custom: [],
  };

  for (const [name, def] of Object.entries(schema.fields)) {
    const aliasInfo = def.aliases?.length ? ` (aka: ${def.aliases.join(", ")})` : "";
    const allowedInfo = def.enum?.length ? `\n    Allowed: ${def.enum.join(" | ")}` : "";
    const examplesInfo = def.examples?.length ? `\n    Examples: ${def.examples.join(", ")}` : "";

    const line = `  ${name}  ${def.type}${aliasInfo}\n    ${def.description || ""}${allowedInfo}${examplesInfo}`;
    const category = def.category || "custom";
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(line);
  }

  let result = "";
  if (byCategory.core.length) result += "CORE FIELDS:\n" + byCategory.core.join("\n\n") + "\n\n";
  if (byCategory.relationship.length) result += "RELATIONSHIP FIELDS:\n" + byCategory.relationship.join("\n\n") + "\n\n";
  if (byCategory.recurrence.length) result += "RECURRENCE FIELDS:\n" + byCategory.recurrence.join("\n\n") + "\n\n";
  if (byCategory.custom.length) result += "CUSTOM FIELDS:\n" + byCategory.custom.join("\n\n");

  return result;
}

// ============================================================================
// EXTRACTION TYPES
// ============================================================================

export interface ExtractedTask {
  raw: string;
  fields: Record<string, SemanticField>;
  summary: string;
  recurrence?: Task["recurrence"];
  templateId?: string;
  seq?: number;
  dependsOn?: number;
}

export interface NewFieldProposal {
  name: string;
  type: string;
  description?: string;
}

export interface ExtractionResult {
  tasks: ExtractedTask[];
  newFields?: NewFieldProposal[];
}

// ============================================================================
// EXTRACTION PROMPT
// ============================================================================

function getExtractionPrompt(schema: TaskSchema, index: TaskIndex): string {
  const today = getToday();
  const dayOfWeek = getDayOfWeek();

  const schemaFields = formatSchemaForPrompt(schema);

  const templateHints = Object.keys(index.templates || {}).length > 0
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

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

export async function extractSemantics(
  raw: string,
  schema: TaskSchema,
  index: TaskIndex,
  llmConfig: LLMConfig
): Promise<ExtractionResult> {
  const model = createModel(llmConfig);

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
      tasks: [{ raw, fields: { action: { name: "action", value: raw } }, summary: raw }],
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

    // Handle legacy single-task format
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
      tasks: [{ raw, fields: { action: { name: "action", value: raw } }, summary: raw }],
    };
  }
}

// ============================================================================
// SCHEMA UPDATE HELPER
// ============================================================================

export function addFieldToSchema(
  schema: TaskSchema,
  name: string,
  definition: Partial<FieldDefinition>
): boolean {
  const normalizedName = name.toLowerCase().replace(/\s+/g, "_");

  if (schema.fields[normalizedName]) {
    return false; // Already exists
  }

  schema.fields[normalizedName] = {
    type: definition.type || "string",
    description: definition.description || `Custom field: ${normalizedName}`,
    examples: definition.examples,
    enum: definition.enum,
    aliases: definition.aliases,
    category: "custom",
  };

  schema.version++;
  return true;
}

// ============================================================================
// NOTE EXTRACTION
// ============================================================================

interface NoteExtractionResult {
  title?: string;
  tags: string[];
  fields: Record<string, SemanticField>;
  entities: EntityInfo[];
  relatedTaskIds: string[];
}

function getNoteExtractionPrompt(
  noteContent: string,
  existingTags: string[],
  existingEntities: Record<string, EntityInfo>,
  taskIndex: TaskIndex
): string {
  const existingTagsList = existingTags.length > 0
    ? `\nExisting tags in the system: ${existingTags.join(", ")}`
    : "";

  const entityNames = Object.keys(existingEntities);
  const existingEntitiesList = entityNames.length > 0
    ? `\nKnown entities: ${entityNames.slice(0, 50).join(", ")}`
    : "";

  // Get project/subject names from task index for relationship matching
  const knownProjects = taskIndex.structures["subject"]?.examples || [];

  return `Analyze this note and extract semantic information.

Today's date: ${getToday()}
${existingTagsList}
${existingEntitiesList}
${knownProjects.length > 0 ? `Known projects/subjects: ${knownProjects.join(", ")}` : ""}

NOTE CONTENT:
"""
${noteContent}
"""

Extract the following:
1. A brief title (if one isn't obvious, create a concise summary)
2. Tags - relevant categories, topics, or labels. Prefer using existing tags when appropriate.
3. Entities - people, projects, concepts, locations, or organizations mentioned
4. Semantic fields - key information structured as fields
5. Related projects/subjects - any mentioned that might link to existing tasks

Respond in this exact JSON format:
{
  "title": "Brief title or summary",
  "tags": ["tag1", "tag2"],
  "fields": {
    "topic": { "name": "topic", "value": "main topic" },
    "people": { "name": "people", "value": ["person1", "person2"] },
    "context": { "name": "context", "value": "relevant context" }
  },
  "entities": [
    { "name": "EntityName", "type": "person|project|concept|location|organization|other" }
  ],
  "relatedProjects": ["project1", "project2"]
}

Notes:
- Tags should be lowercase, use underscores for multi-word tags
- Entity types must be one of: person, project, concept, location, organization, other
- Fields can include: topic, people, context, source, date_mentioned, key_points, action_items
- Only include fields that are clearly present in the note`;
}

export async function extractNoteSemantics(
  noteContent: string,
  llmConfig: LLMConfig,
  noteIndex: NoteIndex,
  taskIndex: TaskIndex
): Promise<NoteExtractionResult> {
  const model = createModel(llmConfig);

  // Gather existing tags and entities
  const existingTags = Object.keys(noteIndex.tagStats);
  const existingEntities = noteIndex.entities;

  const prompt = getNoteExtractionPrompt(
    noteContent,
    existingTags,
    existingEntities,
    taskIndex
  );

  try {
    const response = await model.invoke([
      new SystemMessage(
        "You are a semantic analyzer for a note-taking system. " +
        "Extract structured information from notes to enable powerful tagging, " +
        "searching, and relationship discovery. Be concise and accurate."
      ),
      new HumanMessage(prompt),
    ]);

    const content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackNoteResult(noteContent);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Process entities
    const entities: EntityInfo[] = (parsed.entities || []).map((e: { name: string; type: string }) => ({
      name: e.name,
      type: e.type as EntityInfo["type"],
      occurrences: 1,
      relatedTaskIds: [],
      relatedNoteIds: [],
    }));

    // Related task IDs based on project/subject matches
    // For now return empty - actual linking happens at a higher level
    const relatedTaskIds: string[] = [];

    return {
      title: parsed.title,
      tags: (parsed.tags || []).map((t: string) => t.toLowerCase().replace(/\s+/g, "_")),
      fields: parsed.fields || {},
      entities,
      relatedTaskIds,
    };
  } catch (error) {
    console.error("Note extraction failed:", error);
    return createFallbackNoteResult(noteContent);
  }
}

function createFallbackNoteResult(noteContent: string): NoteExtractionResult {
  // Create a basic title from the first line or first 50 chars
  const firstLine = noteContent.split("\n")[0].trim();
  const title = firstLine.length > 50 
    ? firstLine.substring(0, 47) + "..." 
    : firstLine;

  // Extract basic tags from hashtags if present
  const hashtagMatches = noteContent.match(/#(\w+)/g) || [];
  const tags = hashtagMatches.map(t => t.substring(1).toLowerCase());

  return {
    title,
    tags,
    fields: {},
    entities: [],
    relatedTaskIds: [],
  };
}

// Update note index with new tags and entities
export function updateNoteIndex(
  index: NoteIndex,
  noteId: string,
  extractionResult: NoteExtractionResult
): void {
  // Add note ID to index
  if (!index.notes.includes(noteId)) {
    index.notes.push(noteId);
    index.stats.totalCreated++;
  }

  // Update tag stats
  for (const tag of extractionResult.tags) {
    index.tagStats[tag] = (index.tagStats[tag] || 0) + 1;
    index.stats.byTag[tag] = (index.stats.byTag[tag] || 0) + 1;
  }

  // Update entities
  for (const entity of extractionResult.entities) {
    if (index.entities[entity.name]) {
      index.entities[entity.name].occurrences++;
      if (!index.entities[entity.name].relatedNoteIds.includes(noteId)) {
        index.entities[entity.name].relatedNoteIds.push(noteId);
      }
    } else {
      index.entities[entity.name] = {
        ...entity,
        relatedNoteIds: [noteId],
      };
    }
  }
}

// Remove a note's contributions from the index (for updates/deletes)
export function removeNoteFromIndex(
  index: NoteIndex,
  noteId: string,
  oldTags: string[],
  oldEntities: string[] // Entity names that were in the old note
): void {
  // Decrement tag stats
  for (const tag of oldTags) {
    if (index.tagStats[tag]) {
      index.tagStats[tag]--;
      if (index.tagStats[tag] <= 0) {
        delete index.tagStats[tag];
      }
    }
    if (index.stats.byTag[tag]) {
      index.stats.byTag[tag]--;
      if (index.stats.byTag[tag] <= 0) {
        delete index.stats.byTag[tag];
      }
    }
  }

  // Update entity references
  for (const entityName of oldEntities) {
    if (index.entities[entityName]) {
      index.entities[entityName].occurrences--;
      index.entities[entityName].relatedNoteIds = 
        index.entities[entityName].relatedNoteIds.filter(id => id !== noteId);
      
      // Remove entity if no more references
      if (index.entities[entityName].occurrences <= 0) {
        delete index.entities[entityName];
      }
    }
  }
}

