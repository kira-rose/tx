import { useMemo } from "react";
import { trpc } from "../lib/trpc";
import { TaskItem } from "./TaskItem";
import { FilterState, SmartView } from "./FilterPanel";
import "./TaskList.css";

// Local Task type that accepts server responses
type Task = {
  id: string;
  raw: string;
  status: "active" | "backlog" | "completed" | "canceled";
  completed: boolean;
  updated: string;
  fields: Record<string, { name: string; value: unknown }>;
  created: string;
  blocks?: string[];
  blockedBy?: string[];
};

interface TaskListProps {
  statusFilter: "active" | "backlog" | "all" | "completed" | "canceled";
  scope: string | null;
  filters: FilterState;
}

export function TaskList({ statusFilter, scope, filters }: TaskListProps) {
  const statusArray =
    statusFilter === "all" ? ["active", "backlog"] : [statusFilter];

  const tasksQuery = trpc.task.list.useQuery({
    status: statusArray as ("active" | "backlog" | "completed" | "canceled")[],
  });

  const utils = trpc.useUtils();

  // Mutations
  const activateMutation = trpc.task.activate.useMutation({
    onSuccess: () => utils.task.list.invalidate(),
  });
  const backlogMutation = trpc.task.toBacklog.useMutation({
    onSuccess: () => utils.task.list.invalidate(),
  });
  const completeMutation = trpc.task.complete.useMutation({
    onSuccess: () => utils.task.list.invalidate(),
  });
  const cancelMutation = trpc.task.cancel.useMutation({
    onSuccess: () => utils.task.list.invalidate(),
  });
  const deleteMutation = trpc.task.delete.useMutation({
    onSuccess: () => utils.task.list.invalidate(),
  });

  // Filter and process tasks
  const processedTasks = useMemo(() => {
    let tasks = (tasksQuery.data?.tasks || []) as Task[];

    // Filter by scope
    if (scope) {
      tasks = tasks.filter((task) => {
        const taskScope = task.fields?.scope?.value;
        const subject = task.fields?.subject?.value || task.fields?.project?.value;
        return (
          taskScope === scope ||
          (subject && String(subject).toLowerCase().includes(scope.toLowerCase()))
        );
      });
    }

    // Apply smart view filters
    tasks = applySmartView(tasks, filters.smartView);

    // Apply field filters
    for (const filter of filters.fieldFilters) {
      tasks = tasks.filter((task) => {
        const fieldValue = task.fields?.[filter.field]?.value;
        if (fieldValue === undefined) return false;
        return String(fieldValue).toLowerCase().includes(filter.value.toLowerCase());
      });
    }

    // Apply search query
    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      tasks = tasks.filter(
        (task) =>
          task.raw.toLowerCase().includes(query) ||
          Object.values(task.fields || {}).some((f) =>
            String(f.value).toLowerCase().includes(query)
          )
      );
    }

    return tasks;
  }, [tasksQuery.data, scope, filters]);

  // Group tasks
  const groupedTasks = useMemo(() => {
    if (filters.groupBy === "none") {
      return { ungrouped: processedTasks };
    }

    const groups: Record<string, Task[]> = {};

    for (const task of processedTasks) {
      let groupValue = "Other";

      if (filters.groupBy === "deadline") {
        const deadline = task.fields?.deadline?.value as string;
        if (!deadline) {
          groupValue = "No deadline";
        } else {
          groupValue = getDeadlineGroup(deadline);
        }
      } else {
        const fieldValue = task.fields?.[filters.groupBy]?.value;
        if (fieldValue) {
          groupValue = String(fieldValue);
        }
      }

      if (!groups[groupValue]) groups[groupValue] = [];
      groups[groupValue].push(task);
    }

    return groups;
  }, [processedTasks, filters.groupBy]);

  if (tasksQuery.isLoading) {
    return (
      <div className="task-list-loading">
        <div className="spinner" />
        <span>Loading tasks...</span>
      </div>
    );
  }

  if (tasksQuery.isError) {
    return (
      <div className="task-list-error">
        <span className="error-icon">⚠</span>
        <span>Failed to load tasks</span>
        <button className="retry-btn" onClick={() => tasksQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (processedTasks.length === 0) {
    return (
      <div className="task-list-empty">
        <div className="empty-icon">✦</div>
        <h3>No tasks</h3>
        <p>
          {filters.smartView !== "all" || filters.fieldFilters.length > 0
            ? "No tasks match the current filters"
            : statusFilter === "all"
            ? "Add a task above to get started"
            : `No ${statusFilter} tasks`}
        </p>
      </div>
    );
  }

  const handleStatusChange = (taskId: string, newStatus: string) => {
    switch (newStatus) {
      case "active":
        activateMutation.mutate({ taskId });
        break;
      case "backlog":
        backlogMutation.mutate({ taskId });
        break;
      case "completed":
        completeMutation.mutate({ taskId });
        break;
      case "canceled":
        cancelMutation.mutate({ taskId });
        break;
    }
  };

  const handleDelete = (taskId: string) => {
    if (confirm("Delete this task permanently?")) {
      deleteMutation.mutate({ id: taskId });
    }
  };

  // Build task ID lookup for dependency display
  const taskMap = new Map(processedTasks.map((t) => [t.id, t]));

  return (
    <div className="task-list">
      {filters.groupBy === "none" ? (
        // Ungrouped: show by status
        <>
          {statusFilter === "all" && (
            <>
              {renderStatusGroup(
                "active",
                processedTasks.filter((t) => t.status === "active"),
                taskMap,
                handleStatusChange,
                handleDelete
              )}
              {renderStatusGroup(
                "backlog",
                processedTasks.filter((t) => t.status === "backlog"),
                taskMap,
                handleStatusChange,
                handleDelete
              )}
            </>
          )}
          {statusFilter !== "all" && (
            <div className="task-group">
              <div className="group-tasks">
                {processedTasks.map((task, i) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    taskMap={taskMap}
                    onStatusChange={handleStatusChange}
                    onDelete={handleDelete}
                    style={{ animationDelay: `${i * 50}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        // Grouped view
        Object.entries(groupedTasks).map(([group, tasks], gi) => (
          <div key={group} className="task-group animate-fade-in" style={{ animationDelay: `${gi * 100}ms` }}>
            <h3 className="group-header grouped">
              <span className="group-label">{filters.groupBy}:</span>
              <span className="group-value">{group}</span>
              <span className="group-count">{tasks.length}</span>
            </h3>
            <div className="group-tasks">
              {tasks.map((task, i) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  taskMap={taskMap}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                  style={{ animationDelay: `${(gi * tasks.length + i) * 30}ms` }}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function renderStatusGroup(
  status: string,
  tasks: Task[],
  taskMap: Map<string, Task>,
  onStatusChange: (id: string, status: string) => void,
  onDelete: (id: string) => void
) {
  if (tasks.length === 0) return null;

  const icons: Record<string, string> = {
    active: "●",
    backlog: "○",
    completed: "✓",
    canceled: "✗",
  };

  return (
    <div className="task-group animate-fade-in">
      <h3 className="group-header">
        <span className={`group-icon ${status}`}>{icons[status]}</span>
        {status.charAt(0).toUpperCase() + status.slice(1)}
        <span className="group-count">{tasks.length}</span>
      </h3>
      <div className="group-tasks">
        {tasks.map((task, i) => (
          <TaskItem
            key={task.id}
            task={task}
            taskMap={taskMap}
            onStatusChange={onStatusChange}
            onDelete={onDelete}
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function applySmartView(tasks: Task[], view: SmartView): Task[] {
  const today = new Date().toISOString().split("T")[0];
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split("T")[0];

  switch (view) {
    case "today":
      return tasks.filter((t) => {
        const deadline = t.fields?.deadline?.value as string;
        return deadline && deadline.split("T")[0] === today;
      });

    case "week":
      return tasks.filter((t) => {
        const deadline = t.fields?.deadline?.value as string;
        if (!deadline) return false;
        const date = deadline.split("T")[0];
        return date >= today && date <= weekEndStr;
      });

    case "overdue":
      return tasks.filter((t) => {
        const deadline = t.fields?.deadline?.value as string;
        if (!deadline) return false;
        const date = deadline.split("T")[0];
        if (date < today) return true;
        if (date === today && deadline.includes("T")) {
          return new Date(deadline) < new Date();
        }
        return false;
      });

    case "blocked":
      return tasks.filter((t) => t.blockedBy && t.blockedBy.length > 0);

    case "focus":
      // Score and sort by priority
      const scored = tasks.map((task) => {
        let score = 0;

        const priority = String(task.fields?.priority?.value || "normal").toLowerCase();
        if (priority === "urgent") score += 100;
        else if (priority === "high") score += 50;

        const deadline = task.fields?.deadline?.value as string;
        if (deadline) {
          const date = deadline.split("T")[0];
          if (date < today) score += 200;
          else if (date === today) score += 100;
          else if (date <= weekEndStr) score += 30;
        }

        if (task.blocks?.length) score += 40 * task.blocks.length;
        if (task.blockedBy?.length) score -= 50;

        return { task, score };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 5).map((s) => s.task);

    default:
      return tasks;
  }
}

function getDeadlineGroup(deadline: string): string {
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split("T")[0];

  const date = deadline.split("T")[0];

  if (date < today) return "Overdue";
  if (date === today) return "Today";
  if (date === tomorrowStr) return "Tomorrow";
  if (date <= weekEndStr) return "This Week";
  return "Later";
}
