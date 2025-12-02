import "./StatusFilter.css";

type StatusValue = "active" | "backlog" | "all" | "completed" | "canceled";

interface StatusFilterProps {
  value: StatusValue;
  onChange: (value: StatusValue) => void;
}

const filters: { value: StatusValue; label: string; icon: string }[] = [
  { value: "all", label: "All", icon: "◐" },
  { value: "active", label: "Active", icon: "●" },
  { value: "backlog", label: "Backlog", icon: "○" },
  { value: "completed", label: "Done", icon: "✓" },
  { value: "canceled", label: "Canceled", icon: "✗" },
];

export function StatusFilter({ value, onChange }: StatusFilterProps) {
  return (
    <div className="status-filter">
      {filters.map((filter) => (
        <button
          key={filter.value}
          className={`filter-btn ${filter.value} ${value === filter.value ? "active" : ""}`}
          onClick={() => onChange(filter.value)}
          title={filter.label}
          aria-label={filter.label}
        >
          <span className="filter-icon">{filter.icon}</span>
          <span className="filter-label">{filter.label}</span>
        </button>
      ))}
    </div>
  );
}

