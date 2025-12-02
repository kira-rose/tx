import { useState } from "react";
import { trpc } from "../lib/trpc";
import "./FilterPanel.css";

export type SmartView = "all" | "today" | "week" | "overdue" | "blocked" | "focus";
export type GroupBy = "none" | "subject" | "priority" | "context" | "task_type" | "deadline";

export interface FilterState {
  smartView: SmartView;
  groupBy: GroupBy;
  fieldFilters: Array<{ field: string; value: string }>;
  searchQuery: string;
}

interface FilterPanelProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
}

export function FilterPanel({ filters, onFiltersChange }: FilterPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [newFilterField, setNewFilterField] = useState("");
  const [newFilterValue, setNewFilterValue] = useState("");

  const indexQuery = trpc.index.get.useQuery();
  const structures = indexQuery.data?.structures || {};

  const smartViews: { id: SmartView; label: string; icon: string }[] = [
    { id: "all", label: "All", icon: "◐" },
    { id: "today", label: "Today", icon: "📅" },
    { id: "week", label: "Week", icon: "📆" },
    { id: "overdue", label: "Late", icon: "⚠" },
    { id: "blocked", label: "Blocked", icon: "🔒" },
    { id: "focus", label: "Focus", icon: "🎯" },
  ];

  const groupByOptions: { id: GroupBy; label: string }[] = [
    { id: "none", label: "No grouping" },
    { id: "subject", label: "By Project" },
    { id: "priority", label: "By Priority" },
    { id: "context", label: "By Context" },
    { id: "task_type", label: "By Type" },
    { id: "deadline", label: "By Deadline" },
  ];

  const availableFields = Object.keys(structures).filter(
    (f) => !filters.fieldFilters.some((ff) => ff.field === f)
  );

  const addFieldFilter = () => {
    if (newFilterField && newFilterValue) {
      onFiltersChange({
        ...filters,
        fieldFilters: [...filters.fieldFilters, { field: newFilterField, value: newFilterValue }],
      });
      setNewFilterField("");
      setNewFilterValue("");
    }
  };

  const removeFieldFilter = (index: number) => {
    onFiltersChange({
      ...filters,
      fieldFilters: filters.fieldFilters.filter((_, i) => i !== index),
    });
  };

  const clearFilters = () => {
    onFiltersChange({
      smartView: "all",
      groupBy: "none",
      fieldFilters: [],
      searchQuery: "",
    });
  };

  const hasActiveFilters =
    filters.smartView !== "all" ||
    filters.groupBy !== "none" ||
    filters.fieldFilters.length > 0 ||
    filters.searchQuery !== "";

  return (
    <div className="filter-panel">
      {/* Smart Views */}
      <div className="smart-views">
        {smartViews.map((view) => (
          <button
            key={view.id}
            className={`smart-view-btn ${filters.smartView === view.id ? "active" : ""}`}
            onClick={() => onFiltersChange({ ...filters, smartView: view.id })}
            title={view.label}
            aria-label={view.label}
          >
            <span className="view-icon">{view.icon}</span>
            <span className="view-label">{view.label}</span>
          </button>
        ))}
      </div>

      {/* Search & Controls */}
      <div className="filter-controls">
        <div className="search-wrapper">
          <span className="search-icon">⌕</span>
          <input
            type="text"
            className="search-input"
            placeholder="Search tasks..."
            value={filters.searchQuery}
            onChange={(e) => onFiltersChange({ ...filters, searchQuery: e.target.value })}
          />
          {filters.searchQuery && (
            <button
              className="clear-search"
              onClick={() => onFiltersChange({ ...filters, searchQuery: "" })}
            >
              ✕
            </button>
          )}
        </div>

        <div className="group-by-select">
          <select
            value={filters.groupBy}
            onChange={(e) => onFiltersChange({ ...filters, groupBy: e.target.value as GroupBy })}
          >
            {groupByOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <button
          className={`advanced-toggle ${showAdvanced ? "active" : ""}`}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <span>+ Filter</span>
          {filters.fieldFilters.length > 0 && (
            <span className="filter-count">{filters.fieldFilters.length}</span>
          )}
        </button>

        {hasActiveFilters && (
          <button className="clear-all-btn" onClick={clearFilters}>
            Clear
          </button>
        )}
      </div>

      {/* Advanced Filters */}
      {showAdvanced && (
        <div className="advanced-filters animate-fade-in">
          <div className="add-filter-row">
            <select
              value={newFilterField}
              onChange={(e) => setNewFilterField(e.target.value)}
              className="filter-field-select"
            >
              <option value="">Field...</option>
              {availableFields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Value..."
              value={newFilterValue}
              onChange={(e) => setNewFilterValue(e.target.value)}
              className="filter-value-input"
              onKeyDown={(e) => e.key === "Enter" && addFieldFilter()}
            />
            <button
              className="add-filter-btn"
              onClick={addFieldFilter}
              disabled={!newFilterField || !newFilterValue}
            >
              +
            </button>
          </div>

          {filters.fieldFilters.length > 0 && (
            <div className="active-filters">
              {filters.fieldFilters.map((filter, i) => (
                <div key={i} className="filter-chip">
                  <span className="chip-field">{filter.field}</span>
                  <span className="chip-eq">=</span>
                  <span className="chip-value">{filter.value}</span>
                  <button className="chip-remove" onClick={() => removeFieldFilter(i)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
