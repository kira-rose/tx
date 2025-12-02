# tx — Semantic Task Management

`tx` is an AI-powered task management system that automatically extracts semantic structure from natural language task descriptions. Instead of manually categorizing and tagging tasks, simply describe what you need to do and `tx` discovers the structure for you.

## Philosophy

Traditional task managers require you to fit your tasks into predefined categories, tags, and fields. `tx` flips this: **you write naturally, and the system discovers the structure**.

Over time, `tx` learns:
- What projects you work on
- How you describe priorities
- Common task patterns (meetings, bug fixes, deployments)
- How long different types of tasks take you

This emergent semantic model becomes increasingly powerful for querying, filtering, and organizing your work.

---

## Installation

```bash
npm install
npm run build
npm link
```

## Configuration

Configuration is stored at `~/.tx/config.json`:

```json
{
  "llm": {
    "provider": "bedrock",
    "model": "anthropic.claude-sonnet-4-20250514-v1:0",
    "region": "us-east-1"
  },
  "storage": {
    "type": "file",
    "path": "~/.tx/data"
  },
  "currentScope": "work"
}
```

### LLM Providers

| Provider | Required Fields |
|----------|-----------------|
| `bedrock` | `model`, `region` |
| `openai` | `model`, `apiKey` |
| `anthropic` | `model`, `apiKey` |

### Storage Backends

| Backend | Config |
|---------|--------|
| `file` | `{ "type": "file", "path": "~/.tx/data" }` |
| `sqlite` | `{ "type": "sqlite", "path": "~/.tx/tx.db" }` |
| `postgres` | `{ "type": "postgres", "connectionString": "postgres://..." }` |

## Storage Locations

- **Config:** `~/.tx/config.json`
- **Schema:** `~/.tx/data/schema.json`
- **Tasks:** `~/.tx/data/tasks/` (file backend)
- **Index:** `~/.tx/data/index.json`

---

## Task Status System

Tasks move through a lifecycle of statuses:

| Status | Icon | Description |
|--------|------|-------------|
| `backlog` | ○ (yellow) | New tasks start here — planned but not started |
| `active` | ● (green) | Currently working on |
| `completed` | ✓ (cyan) | Finished successfully |
| `canceled` | ✗ (red) | No longer needed |

### Status Commands

```bash
tx --list                    # Shows active + backlog tasks
tx --active                  # Only active tasks
tx --backlog                 # Only backlog tasks
tx --canceled                # Canceled tasks

tx --activate <id>           # Move to active (start working)
tx --backlog-task <id>       # Move back to backlog
tx --complete <id>           # Mark completed
tx --cancel <id> [--reason]  # Cancel with optional reason
```

### Workflow Example

```bash
tx "fix login bug in webapp"     # Created in backlog
tx --activate a1b2               # Start working on it
# ... do the work ...
tx --complete a1b2               # Done!
```

---

## Scopes (Namespaces)

Scopes are high-level domains that organize your work — like "work", "home", "personal". They act as **namespaces**: when a scope is active, all operations are filtered to that scope.

### Quick Start

```bash
# Create scopes
tx --scope-add work --desc "Work tasks" --icon 💼
tx --scope-add home --desc "Home & personal" --icon 🏠

# Set active scope (like `cd` for directories)
tx --use-scope work

# Now all commands operate within "work"
tx "fix login bug"        # Auto-assigned to work scope
tx --list                 # Only shows work tasks
tx --focus                # Only work priorities

# Switch contexts
tx --use-scope home
tx --list                 # Now shows home tasks

# Go global (see everything)
tx --unset-scope
tx --list                 # All tasks across all scopes
```

### Scope Commands

| Command | Description |
|---------|-------------|
| `tx --use-scope <scope>` | Set active scope |
| `tx --unset-scope` | Clear scope (global mode) |
| `tx --current-scope` | Show current scope |
| `tx --scopes` | List all scopes |
| `tx --scope <name>` | View tasks in a specific scope |
| `tx --scope-add <name> [opts]` | Create scope (`--desc`, `--icon`, `--parent`) |
| `tx --scope-assign <subject> <scope>` | Assign a subject/project to a scope |

### Subject-Scope Mapping

Projects (subjects) can be assigned to scopes:

```bash
tx --scope-assign webapp work
tx --scope-assign backend work
tx --scope-assign garden home
```

Now any task with `subject: webapp` automatically belongs to the "work" scope.

### Nested Scopes

Scopes can have parents for hierarchical organization:

```bash
tx --scope-add health --parent personal --icon 🏃
tx --scope-add learning --parent personal --icon 📚
```

---

## Adding Tasks

### Basic Usage

```bash
tx <natural language task description>
```

### Examples

```bash
tx update insurance definitions in supersonic before tuesday
tx call john about the quarterly review tomorrow - urgent
tx fix the login bug in webapp today
tx review PR for authentication feature
tx prepare slides for monday standup
tx buy groceries on the way home
```

### Multiple Tasks at Once

```bash
tx buy groceries, call mom, and pick up dry cleaning
tx email john about the meeting, review the PR, deploy to staging
tx 1. write tests 2. update docs 3. submit PR
```

### What Gets Extracted

| Field | Description | Examples |
|-------|-------------|----------|
| `scope` | High-level domain | "work", "home", "personal" |
| `action` | Core verb/action | "update", "fix", "call", "review" |
| `subject` / `project` | Project or area | "supersonic", "webapp" |
| `deadline` | When it's due | "2025-12-03", "tomorrow at 3pm" |
| `priority` | Inferred urgency | "urgent", "high", "normal", "low" |
| `people` | People mentioned | "john", "sarah" |
| `context` | GTD-style contexts | "@computer", "@phone", "@errands" |
| `effort` | Estimated effort | "quick", "1hour", "half-day" |
| `energy` | Required energy level | "high", "medium", "low" |
| `task_type` | Type of task | "bug fix", "meeting", "deployment" |

### Adding Dependencies

```bash
tx deploy webapp to production --blocks e965
```

---

## Viewing Tasks

### List All Tasks

```bash
tx --list                # Active + backlog (filtered by scope if set)
```

### Smart Views

```bash
tx --today          # Due today
tx --week           # Due this week  
tx --overdue        # Past deadline
tx --blocked        # Tasks waiting on dependencies
tx --focus          # AI-prioritized (considers urgency, deadlines, blocking)
```

### Group By Field

```bash
tx --by project     # Group by project
tx --by context     # Group by context (@computer, @phone, etc.)
tx --by priority    # Group by priority level
tx --by scope       # Group by scope
```

### Structured Queries

```bash
tx --query subject --eq supersonic
tx --query priority --eq urgent
tx --query context --eq @computer
```

### Natural Language Queries

```bash
tx --q "what do I need to do for supersonic"
tx --q "urgent tasks this week"
tx --q "anything involving john"
```

---

## Completing Tasks

```bash
tx --complete <task-id>
tx --complete e965      # Use any unique prefix
```

### Completion Tracking

When completing a task, `tx` prompts for:

1. **Duration** — How long did it take? (e.g., `30min`, `2h`, `skip`)
2. **Notes** — Any notes? (or `skip`)

### Recurring Tasks

```bash
tx check email every morning
# When completed → creates new task for tomorrow
```

---

## Schema

The schema defines all valid semantic fields.

### View Schema

```bash
tx --schema            # Human-readable
tx --schema --json     # JSON Schema output
```

### Add Custom Fields

```bash
tx --schema-add location string "Physical location for the task"
tx --schema-add sprint number "Sprint number for agile planning"
```

---

## tRPC Server

`tx` can run as a server, exposing a type-safe tRPC API for integration with other tools and agents.

### Start Server

```bash
tx --serve                    # Default port 3847
tx --serve --port 8080        # Custom port
```

### API Endpoints

The server exposes these routers:

#### `task.*`
- `task.list` — List tasks with filtering
- `task.get` — Get task by ID
- `task.create` — Create task from natural language
- `task.createWithFields` — Create with explicit fields
- `task.complete` — Mark task completed
- `task.activate` — Set status to active
- `task.backlog` — Set status to backlog
- `task.cancel` — Cancel with reason
- `task.delete` — Delete task

#### `scope.*`
- `scope.list` — List all scopes
- `scope.get` — Get scope by ID
- `scope.tasks` — Get tasks in scope
- `scope.create` — Create new scope
- `scope.update` — Update scope
- `scope.delete` — Delete scope
- `scope.assignSubject` — Assign subject to scope
- `scope.unassignSubject` — Remove subject from scope

#### `schema.*`
- `schema.get` — Get full schema
- `schema.addField` — Add custom field

#### `index.*`
- `index.stats` — Get statistics
- `index.structures` — Get field usage
- `index.aliases` — Get name variations

### Client Usage

```typescript
import { createTxClient } from "tx/client";

const client = createTxClient("http://localhost:3847");

// Create a task
const task = await client.task.create.mutate({
  raw: "fix login bug in webapp by friday"
});

// List tasks in a scope
const tasks = await client.scope.tasks.query({
  id: "work",
  includeChildScopes: true
});

// Change task status
await client.task.activate.mutate({ taskId: task.id });
await client.task.complete.mutate({ taskId: task.id });
```

---

## Semantic Discovery

### View Discovered Structures

```bash
tx --structures
```

### View Aliases

```bash
tx --aliases
```

### Merge Aliases

```bash
tx --merge john "John Smith"
```

### View Templates

```bash
tx --templates
```

---

## Dependencies & Relationships

```bash
tx deploy webapp --blocks e965     # Create blocking dependency
tx --blocked                        # View blocked tasks
tx --graph                          # Dependency graph
```

---

## Review & Statistics

```bash
tx --review    # Daily review (overdue, today, blocked, urgent)
tx --stats     # Completion statistics
```

---

## Export

```bash
tx --export json       # Full JSON export
tx --export markdown   # Markdown checklist
tx --export ical       # iCal for calendar apps
```

---

## Command Reference

### Adding Tasks

| Command | Description |
|---------|-------------|
| `tx <task>` | Add a task |
| `tx <task> --blocks <id>` | Add task that blocks another |

### Status & Management

| Command | Description |
|---------|-------------|
| `tx --activate <id>` | Start working on task |
| `tx --backlog-task <id>` | Return to backlog |
| `tx --complete <id>` | Complete task |
| `tx --cancel <id> [--reason]` | Cancel task |
| `tx --delete <id>` | Delete permanently |

### Views

| Command | Description |
|---------|-------------|
| `tx --list` | Active + backlog tasks |
| `tx --active` | Currently active tasks |
| `tx --backlog` | Backlog tasks |
| `tx --canceled` | Canceled tasks |
| `tx --today` | Due today |
| `tx --week` | Due this week |
| `tx --overdue` | Past deadline |
| `tx --blocked` | Waiting on dependencies |
| `tx --focus` | AI-prioritized top 5 |

### Scopes

| Command | Description |
|---------|-------------|
| `tx --use-scope <scope>` | Set active scope |
| `tx --unset-scope` | Global mode |
| `tx --current-scope` | Show current scope |
| `tx --scopes` | List all scopes |
| `tx --scope <name>` | View scope tasks |
| `tx --scope-add <name> [opts]` | Create scope |
| `tx --scope-assign <subj> <scope>` | Assign subject |

### Filtering & Grouping

| Command | Description |
|---------|-------------|
| `tx --by <field>` | Group by field |
| `tx --query <field> --eq <value>` | Filter by field |
| `tx --q "<natural language>"` | Natural language query |

### Schema

| Command | Description |
|---------|-------------|
| `tx --schema` | View schema |
| `tx --schema --json` | JSON output |
| `tx --schema-add <name> <type> <desc>` | Add field |

### Semantics

| Command | Description |
|---------|-------------|
| `tx --structures` | Field usage stats |
| `tx --aliases` | Name variations |
| `tx --merge <canonical> <variant>` | Merge aliases |
| `tx --templates` | Task patterns |

### Server

| Command | Description |
|---------|-------------|
| `tx --serve` | Start tRPC server (port 3847) |
| `tx --serve --port <n>` | Custom port |
| `tx --config` | Show configuration |

### Export

| Command | Description |
|---------|-------------|
| `tx --export json` | JSON export |
| `tx --export markdown` | Markdown checklist |
| `tx --export ical` | iCal format |

---

## Tips

### Use Scopes for Context Switching

```bash
# Morning: work mode
tx --use-scope work
tx --focus

# Evening: personal mode
tx --use-scope home
tx --list

# Weekly review: see everything
tx --unset-scope
tx --stats
```

### Leverage Status Workflow

1. **Backlog** — capture everything, don't worry about starting
2. **Active** — limit active tasks to focus (recommended: 1-3)
3. **Complete** — track duration for better estimates
4. **Cancel** — close with reason for retrospectives

### Use Consistent Language

The more consistently you describe tasks, the better the semantic model becomes:
- "fix X bug in Y" → extracts task_type: bug fix, project: Y
- "call X about Y" → extracts task_type: communication, person: X

### Check Focus Daily

```bash
tx --focus
```

Intelligently ranks tasks by urgency, deadlines, priorities, and blocking relationships.

---

## Packages

`tx` exports several packages for integration:

```typescript
import { Task, TaskIndex, Scope } from "tx/types";
import { IStorage, createStorage } from "tx/storage";
import { loadConfig, setCurrentScope } from "tx/config";
```

---

## Future Ideas

- **Import from email** — scan inbox for action items
- **Calendar sync** — two-way sync with calendar
- **Team mode** — shared semantic models
- **Mobile companion** — quick capture app
- **Voice input** — add tasks by speaking
