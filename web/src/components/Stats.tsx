import { trpc } from "../lib/trpc";
import "./Stats.css";

export function Stats() {
  const statsQuery = trpc.index.stats.useQuery();
  const stats = statsQuery.data;

  if (!stats) {
    return null;
  }

  const byStatus = stats.byStatus || {
    active: 0,
    backlog: 0,
    completed: 0,
    canceled: 0,
  };

  const total = byStatus.active + byStatus.backlog;
  const completionRate =
    stats.totalCreated > 0
      ? Math.round((stats.totalCompleted / stats.totalCreated) * 100)
      : 0;

  return (
    <div className="stats">
      <div className="stat-item">
        <span className="stat-value">{total}</span>
        <span className="stat-label">open</span>
      </div>
      <div className="stat-divider" />
      <div className="stat-item">
        <span className="stat-value completed">{stats.totalCompleted}</span>
        <span className="stat-label">done</span>
      </div>
      <div className="stat-divider" />
      <div className="stat-item">
        <span className="stat-value">{completionRate}%</span>
        <span className="stat-label">rate</span>
      </div>
    </div>
  );
}

