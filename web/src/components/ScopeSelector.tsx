import { useState } from "react";
import { trpc } from "../lib/trpc";
import "./ScopeSelector.css";

interface ScopeSelectorProps {
  currentScope: string | null;
  onScopeChange: (scope: string | null) => void;
}

export function ScopeSelector({ currentScope, onScopeChange }: ScopeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const scopesQuery = trpc.scope.list.useQuery();
  const scopes = scopesQuery.data || [];

  const selectedScope = scopes.find((s) => s.id === currentScope);

  return (
    <div className="scope-selector">
      <button
        className={`scope-trigger ${currentScope ? "has-scope" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {selectedScope ? (
          <>
            <span className="scope-icon">{selectedScope.icon || "◉"}</span>
            <span className="scope-name">{selectedScope.name}</span>
          </>
        ) : (
          <>
            <span className="scope-icon">◎</span>
            <span className="scope-name">All Scopes</span>
          </>
        )}
        <span className="chevron">{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <>
          <div className="scope-backdrop" onClick={() => setIsOpen(false)} />
          <div className="scope-dropdown animate-fade-in">
            <button
              className={`scope-option ${!currentScope ? "selected" : ""}`}
              onClick={() => {
                onScopeChange(null);
                setIsOpen(false);
              }}
            >
              <span className="scope-option-icon">◎</span>
              <span className="scope-option-name">All Scopes</span>
              {!currentScope && <span className="check">✓</span>}
            </button>

            {scopes.length > 0 && <div className="scope-divider" />}

            {scopes.map((scope) => (
              <button
                key={scope.id}
                className={`scope-option ${currentScope === scope.id ? "selected" : ""}`}
                onClick={() => {
                  onScopeChange(scope.id);
                  setIsOpen(false);
                }}
              >
                <span className="scope-option-icon">{scope.icon || "◉"}</span>
                <div className="scope-option-content">
                  <span className="scope-option-name">{scope.name}</span>
                  {scope.description && (
                    <span className="scope-option-desc">{scope.description}</span>
                  )}
                </div>
                {currentScope === scope.id && <span className="check">✓</span>}
              </button>
            ))}

            {scopes.length === 0 && (
              <div className="scope-empty">
                No scopes defined.
                <br />
                <code>tx --scope-add work</code>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

