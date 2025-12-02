import { useState } from "react";
import { trpc } from "./lib/trpc";
import { TaskList } from "./components/TaskList";
import { TaskInput } from "./components/TaskInput";
import { StatusFilter } from "./components/StatusFilter";
import { ScopeSelector } from "./components/ScopeSelector";
import { Stats } from "./components/Stats";
import { FilterPanel, FilterState } from "./components/FilterPanel";
import { SemanticExplorer } from "./components/SemanticExplorer";
import { NotesView } from "./components/NotesView";
import "./App.css";

type MainView = "tasks" | "notes" | "explorer";
type StatusFilterType = "active" | "backlog" | "all" | "completed" | "canceled";

export default function App() {
  const [mainView, setMainView] = useState<MainView>("tasks");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [currentScope, setCurrentScope] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterState>({
    smartView: "all",
    groupBy: "none",
    fieldFilters: [],
    searchQuery: "",
  });

  const activeFilterCount =
    (filters.smartView !== "all" ? 1 : 0) +
    (filters.groupBy !== "none" ? 1 : 0) +
    filters.fieldFilters.length +
    (filters.searchQuery ? 1 : 0);

  const healthQuery = trpc.system.health.useQuery(undefined, {
    refetchInterval: 30000,
  });

  const isConnected = healthQuery.data?.status === "ok";

  return (
    <div className="app">
      {/* Background effects */}
      <div className="bg-grid" />
      <div className="bg-glow" />

      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1 className="logo">
            <span className="logo-tx">tx</span>
            <span className="logo-dot">.</span>
          </h1>
          <div className={`connection-status ${isConnected ? "connected" : "disconnected"}`}>
            <span className="status-dot" />
            {isConnected ? "Connected" : "Offline"}
          </div>
        </div>

        {/* Main Navigation */}
        <nav className="main-nav">
          <button
            className={`nav-btn ${mainView === "tasks" ? "active" : ""}`}
            onClick={() => setMainView("tasks")}
            title="Tasks"
          >
            <span className="nav-icon">☰</span>
            <span className="nav-label">Tasks</span>
          </button>
          <button
            className={`nav-btn ${mainView === "notes" ? "active" : ""}`}
            onClick={() => setMainView("notes")}
            title="Notes"
          >
            <span className="nav-icon">✎</span>
            <span className="nav-label">Notes</span>
          </button>
          <button
            className={`nav-btn ${mainView === "explorer" ? "active" : ""}`}
            onClick={() => setMainView("explorer")}
            title="Explorer"
          >
            <span className="nav-icon">◈</span>
            <span className="nav-label">Explorer</span>
          </button>
        </nav>

        <div className="header-right">
          <ScopeSelector currentScope={currentScope} onScopeChange={setCurrentScope} />
        </div>
      </header>

      {/* Main content */}
      <main className="main">
        {mainView === "tasks" && (
          <>
            {/* Task input with filter toggle */}
            <section className="input-section">
              <TaskInput scope={currentScope} />
              <button
                className={`filter-toggle-btn ${showFilters ? "active" : ""}`}
                onClick={() => setShowFilters(!showFilters)}
                title="Toggle filters"
              >
                <span className="filter-icon">⚙</span>
                {activeFilterCount > 0 && (
                  <span className="filter-badge">{activeFilterCount}</span>
                )}
              </button>
            </section>

            {/* Filter Panel */}
            <section className={`filter-section ${showFilters ? "expanded" : "collapsed"}`}>
              <FilterPanel filters={filters} onFiltersChange={setFilters} />
            </section>

            {/* Status filters and stats */}
            <div className="controls">
              <StatusFilter value={statusFilter} onChange={setStatusFilter} />
              <Stats />
            </div>

            {/* Task list */}
            <section className="tasks-section">
              <TaskList statusFilter={statusFilter} scope={currentScope} filters={filters} />
            </section>
          </>
        )}

        {mainView === "notes" && (
          <section className="notes-section">
            <NotesView />
          </section>
        )}

        {mainView === "explorer" && (
          <section className="explorer-section">
            <SemanticExplorer />
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="footer">
        <span className="footer-text">Semantic task management</span>
        <kbd className="kbd">⌘K</kbd>
      </footer>
    </div>
  );
}
