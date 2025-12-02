import { useState, CSSProperties } from "react";
import "./TaskItem.css";

interface Task {
  id: string;
  raw: string;
  status: string;
  fields: Record<string, { name: string; value: unknown; confidence?: number }>;
  created: string;
  updated?: string;
  blocks?: string[];
  blockedBy?: string[];
  recurrence?: {
    pattern: string;
    interval?: number;
  };
}

interface TaskItemProps {
  task: Task;
  taskMap?: Map<string, Task>;
  onStatusChange: (taskId: string, newStatus: string) => void;
  onDelete: (taskId: string) => void;
  style?: CSSProperties;
}

export function TaskItem({ task, taskMap, onStatusChange, onDelete, style }: TaskItemProps) {
  const [showActions, setShowActions] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const status = task.status || "backlog";
  const priority = task.fields?.priority?.value as string;
  const deadline = task.fields?.deadline?.value as string;
  const subject = (task.fields?.subject?.value || task.fields?.project?.value) as string;
  const isBlocked = task.blockedBy && task.blockedBy.length > 0;

  const statusIcon = {
    active: "●",
    backlog: "○",
    completed: "✓",
    canceled: "✗",
  }[status] || "○";

  const getDatePart = (datetime: string): string => {
    return datetime.split("T")[0];
  };

  const isOverdue = (deadlineStr: string): boolean => {
    const today = new Date().toISOString().split("T")[0];
    const deadlineDate = getDatePart(deadlineStr);
    
    // If same day but has time component, check the time
    if (deadlineDate === today && deadlineStr.includes("T")) {
      return new Date(deadlineStr) < new Date();
    }
    
    return deadlineDate < today;
  };

  const isToday = (deadlineStr: string): boolean => {
    const today = new Date().toISOString().split("T")[0];
    return getDatePart(deadlineStr) === today;
  };

  const isTomorrow = (deadlineStr: string): boolean => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];
    return getDatePart(deadlineStr) === tomorrowStr;
  };

  const formatDeadline = (dateStr: string) => {
    const date = new Date(dateStr);
    const hasTime = dateStr.includes("T");
    const timeStr = hasTime ? ` @ ${dateStr.split("T")[1]}` : "";
    
    if (isToday(dateStr)) return `Today${timeStr}`;
    if (isTomorrow(dateStr)) return `Tomorrow${timeStr}`;

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + timeStr;
  };

  const formatFieldValue = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
  };

  const overdueTask = deadline && isOverdue(deadline) && status !== "completed" && status !== "canceled";
  const todayTask = deadline && isToday(deadline) && status !== "completed" && status !== "canceled";


  const fieldCount = Object.keys(task.fields || {}).length;

  return (
    <div
      className={`task-item animate-slide-in ${status} ${isBlocked ? "blocked" : ""} ${expanded ? "expanded" : ""}`}
      style={style}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="task-item-main">
        <div className="task-item-top">
          <button
            className={`task-status-btn ${status}`}
            onClick={(e) => {
              e.stopPropagation();
              if (status === "backlog") onStatusChange(task.id, "active");
              else if (status === "active") onStatusChange(task.id, "completed");
            }}
            title={status === "backlog" ? "Start task" : status === "active" ? "Complete task" : status}
          >
            {statusIcon}
          </button>

          <div className="task-content" onClick={() => setExpanded(!expanded)}>
            <div className="task-main">
              <span className="task-text">{task.raw}</span>
              {overdueTask && <span className="task-badge overdue">⚠ OVERDUE</span>}
              {todayTask && !overdueTask && <span className="task-badge today">📅 TODAY</span>}
              {isBlocked && <span className="task-badge blocked">🔒</span>}
              {task.recurrence && <span className="task-badge recurrence">↻</span>}
            </div>

          <div className="task-meta">
            {subject && (
              <span className="task-tag subject">
                <span className="tag-icon">📁</span>
                {subject}
              </span>
            )}
            {deadline && (
              <span className={`task-tag deadline ${overdueTask ? "overdue" : todayTask ? "today" : ""}`}>
                <span className="tag-icon">📅</span>
                {formatDeadline(deadline)}
              </span>
            )}
            {priority && priority !== "normal" && (
              <span className={`task-tag priority ${priority}`}>
                {priority}
              </span>
            )}
            {fieldCount > 0 && (
              <button 
                className="task-expand-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
                title={expanded ? "Hide details" : "Show semantic fields"}
              >
                <span className="expand-icon">{expanded ? "▼" : "▶"}</span>
                <span className="field-count">{fieldCount} fields</span>
              </button>
            )}
            {/* Mobile actions toggle - inline with meta */}
            <button 
              className={`mobile-actions-pill ${mobileActionsOpen ? "open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setMobileActionsOpen(!mobileActionsOpen);
              }}
              title="Actions"
            >
              ⋯
            </button>
          </div>
          </div>

          <span className="task-id">{task.id.slice(0, 6)}</span>
        </div>

        {/* Desktop actions - shown on hover */}
        <div className={`task-actions desktop-actions ${showActions ? "visible" : ""}`}>
          {status === "active" && (
            <button
              className="action-btn"
              onClick={() => onStatusChange(task.id, "backlog")}
              title="Move to backlog"
            >
              ⏸
            </button>
          )}
          {status === "backlog" && (
            <button
              className="action-btn"
              onClick={() => onStatusChange(task.id, "active")}
              title="Start task"
            >
              ▶
            </button>
          )}
          {(status === "active" || status === "backlog") && (
            <>
              <button
                className="action-btn complete"
                onClick={() => onStatusChange(task.id, "completed")}
                title="Complete"
              >
                ✓
              </button>
              <button
                className="action-btn cancel"
                onClick={() => onStatusChange(task.id, "canceled")}
                title="Cancel"
              >
                ✗
              </button>
            </>
          )}
          <button
            className="action-btn delete"
            onClick={() => onDelete(task.id)}
            title="Delete"
          >
            🗑
          </button>
        </div>

        {/* Mobile actions - shown when toggle is open */}
        {mobileActionsOpen && (
          <div className="mobile-actions-row">
            {status === "active" && (
              <button
                className="action-btn"
                onClick={() => onStatusChange(task.id, "backlog")}
                title="Move to backlog"
              >
                ⏸
              </button>
            )}
            {status === "backlog" && (
              <button
                className="action-btn"
                onClick={() => onStatusChange(task.id, "active")}
                title="Start task"
              >
                ▶
              </button>
            )}
            {(status === "active" || status === "backlog") && (
              <>
                <button
                  className="action-btn complete"
                  onClick={() => onStatusChange(task.id, "completed")}
                  title="Complete"
                >
                  ✓
                </button>
                <button
                  className="action-btn cancel"
                  onClick={() => onStatusChange(task.id, "canceled")}
                  title="Cancel"
                >
                  ✗
                </button>
              </>
            )}
            <button
              className="action-btn delete"
              onClick={() => onDelete(task.id)}
              title="Delete"
            >
              🗑
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="task-details animate-fade-in">
          <div className="details-header">
            <h4>Semantic Structure</h4>
            <span className="details-id">ID: {task.id.slice(0, 8)}</span>
          </div>
          
          <div className="details-grid">
            {Object.entries(task.fields || {}).map(([key, field]) => (
              <div key={key} className="field-item">
                <span className="field-name">{key}</span>
                <span className="field-value">{formatFieldValue(field.value)}</span>
                {field.confidence !== undefined && (
                  <span className="field-confidence" title="Confidence">
                    {Math.round(field.confidence * 100)}%
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Dependency Graph */}
          {((task.blocks && task.blocks.length > 0) || (task.blockedBy && task.blockedBy.length > 0)) && (
            <div className="dependency-section">
              <h5 className="dependency-title">Dependencies</h5>
              <div className="dependency-graph">
                {task.blockedBy && task.blockedBy.length > 0 && (
                  <div className="dependency-chain">
                    <div className="dep-label blocked-by">Blocked by:</div>
                    <div className="dep-items">
                      {task.blockedBy.map((id) => {
                        const blockerTask = taskMap?.get(id);
                        return (
                          <div key={id} className="dep-task blocker">
                            <span className="dep-icon">⬆</span>
                            <span className="dep-id">{id.slice(0, 6)}</span>
                            {blockerTask && (
                              <span className="dep-summary">
                                {String(blockerTask.fields?.summary?.value || blockerTask.raw).slice(0, 30)}
                                {String(blockerTask.fields?.summary?.value || blockerTask.raw).length > 30 ? "..." : ""}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="dep-current">
                  <span className="dep-current-icon">◆</span>
                  <span className="dep-current-label">This task</span>
                </div>
                {task.blocks && task.blocks.length > 0 && (
                  <div className="dependency-chain">
                    <div className="dep-label blocks">Blocks:</div>
                    <div className="dep-items">
                      {task.blocks.map((id) => {
                        const blockedTask = taskMap?.get(id);
                        return (
                          <div key={id} className="dep-task blocked">
                            <span className="dep-icon">⬇</span>
                            <span className="dep-id">{id.slice(0, 6)}</span>
                            {blockedTask && (
                              <span className="dep-summary">
                                {String(blockedTask.fields?.summary?.value || blockedTask.raw).slice(0, 30)}
                                {String(blockedTask.fields?.summary?.value || blockedTask.raw).length > 30 ? "..." : ""}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="details-footer">
            <div className="detail-info">
              <span className="info-label">Created</span>
              <span className="info-value">
                {new Date(task.created).toLocaleString()}
              </span>
            </div>
            {task.updated && task.updated !== task.created && (
              <div className="detail-info">
                <span className="info-label">Updated</span>
                <span className="info-value">
                  {new Date(task.updated).toLocaleString()}
                </span>
              </div>
            )}
            {task.recurrence && (
              <div className="detail-info">
                <span className="info-label">Recurrence</span>
                <span className="info-value">
                  {task.recurrence.pattern}
                  {task.recurrence.interval && task.recurrence.interval > 1 
                    ? ` (every ${task.recurrence.interval})` 
                    : ""}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
