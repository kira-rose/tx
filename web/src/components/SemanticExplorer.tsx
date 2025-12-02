import { useState } from "react";
import { trpc } from "../lib/trpc";
import "./SemanticExplorer.css";

type ExplorerTab = "structures" | "aliases" | "templates" | "schema";

export function SemanticExplorer() {
  const [activeTab, setActiveTab] = useState<ExplorerTab>("structures");

  const indexQuery = trpc.index.get.useQuery();
  const schemaQuery = trpc.schema.get.useQuery();

  const index = indexQuery.data;
  const schema = schemaQuery.data;

  const tabs: { id: ExplorerTab; label: string; icon: string }[] = [
    { id: "structures", label: "Structures", icon: "◈" },
    { id: "aliases", label: "Aliases", icon: "≈" },
    { id: "templates", label: "Templates", icon: "❖" },
    { id: "schema", label: "Schema", icon: "⬡" },
  ];

  if (indexQuery.isLoading || schemaQuery.isLoading) {
    return (
      <div className="explorer-loading">
        <div className="spinner" />
        <span>Loading semantic data...</span>
      </div>
    );
  }

  return (
    <div className="semantic-explorer">
      <div className="explorer-header">
        <h2>Semantic Universe</h2>
        <p className="explorer-subtitle">Explore discovered patterns and structures</p>
      </div>

      <div className="explorer-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`explorer-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
            aria-label={tab.label}
          >
            <span className="tab-icon">{tab.icon}</span>
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="explorer-content">
        {activeTab === "structures" && <StructuresView structures={index?.structures || {}} />}
        {activeTab === "aliases" && <AliasesView aliases={index?.aliases || {}} />}
        {activeTab === "templates" && <TemplatesView templates={index?.templates || {}} />}
        {activeTab === "schema" && <SchemaView schema={schema} />}
      </div>
    </div>
  );
}

// Structures View
interface Structure {
  name: string;
  type: string;
  examples: string[];
  occurrences: number;
}

function StructuresView({ structures }: { structures: Record<string, Structure> }) {
  const entries = Object.entries(structures).sort((a, b) => b[1].occurrences - a[1].occurrences);

  if (entries.length === 0) {
    return (
      <div className="explorer-empty">
        <span className="empty-icon">◈</span>
        <h3>No structures discovered yet</h3>
        <p>Structures emerge as you add tasks with semantic fields</p>
      </div>
    );
  }

  return (
    <div className="structures-view">
      <div className="view-header">
        <h3>Discovered Structures</h3>
        <span className="count-badge">{entries.length} fields</span>
      </div>
      <div className="structures-grid">
        {entries.map(([name, struct]) => (
          <div key={name} className="structure-card">
            <div className="structure-header">
              <span className="structure-name">{name}</span>
              <span className="structure-type">{struct.type}</span>
            </div>
            <div className="structure-count">{struct.occurrences}× used</div>
            {struct.examples.length > 0 && (
              <div className="structure-examples">
                {struct.examples.slice(0, 5).map((ex, i) => (
                  <span key={i} className="example-tag">{String(ex)}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Aliases View
function AliasesView({ aliases }: { aliases: Record<string, string[]> }) {
  const entries = Object.entries(aliases);

  if (entries.length === 0) {
    return (
      <div className="explorer-empty">
        <span className="empty-icon">≈</span>
        <h3>No aliases discovered yet</h3>
        <p>Aliases are detected when similar names refer to the same entity</p>
      </div>
    );
  }

  return (
    <div className="aliases-view">
      <div className="view-header">
        <h3>Known Aliases</h3>
        <span className="count-badge">{entries.length} groups</span>
      </div>
      <div className="aliases-list">
        {entries.map(([canonical, variants]) => (
          <div key={canonical} className="alias-card">
            <div className="alias-canonical">{canonical}</div>
            <div className="alias-arrow">→</div>
            <div className="alias-variants">
              {variants.map((v, i) => (
                <span key={i} className="variant-tag">{v}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Templates View
interface Template {
  id: string;
  name: string;
  pattern: string;
  defaultFields: Record<string, unknown>;
  occurrences: number;
}

function TemplatesView({ templates }: { templates: Record<string, Template> }) {
  const entries = Object.entries(templates).sort((a, b) => b[1].occurrences - a[1].occurrences);

  if (entries.length === 0) {
    return (
      <div className="explorer-empty">
        <span className="empty-icon">❖</span>
        <h3>No templates discovered yet</h3>
        <p>Templates are recognized patterns in your task descriptions</p>
      </div>
    );
  }

  return (
    <div className="templates-view">
      <div className="view-header">
        <h3>Task Templates</h3>
        <span className="count-badge">{entries.length} patterns</span>
      </div>
      <div className="templates-list">
        {entries.map(([id, template]) => (
          <div key={id} className="template-card">
            <div className="template-header">
              <span className="template-name">{template.name}</span>
              <span className="template-count">{template.occurrences}×</span>
            </div>
            <div className="template-pattern">Pattern: "{template.pattern}"</div>
            {Object.keys(template.defaultFields).length > 0 && (
              <div className="template-fields">
                {Object.keys(template.defaultFields).map((f, i) => (
                  <span key={i} className="field-tag">{f}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Schema View
interface FieldDef {
  type: string;
  description: string;
  examples?: string[];
  aliases?: string[];
  enum?: string[];
  category?: string;
}

interface Schema {
  version: number;
  lastUpdated: string;
  fields: Record<string, FieldDef>;
}

function SchemaView({ schema }: { schema?: Schema }) {
  if (!schema) {
    return (
      <div className="explorer-empty">
        <span className="empty-icon">⬡</span>
        <h3>Schema not available</h3>
      </div>
    );
  }

  const byCategory: Record<string, [string, FieldDef][]> = {
    core: [],
    relationship: [],
    recurrence: [],
    custom: [],
  };

  for (const [name, def] of Object.entries(schema.fields)) {
    const category = def.category || "custom";
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push([name, def]);
  }

  const categoryLabels: Record<string, string> = {
    core: "Core Fields",
    relationship: "Relationship Fields",
    recurrence: "Recurrence Fields",
    custom: "Custom Fields",
  };

  return (
    <div className="schema-view">
      <div className="view-header">
        <h3>Task Schema</h3>
        <div className="schema-meta">
          <span className="schema-version">v{schema.version}</span>
          <span className="schema-updated">
            Updated: {new Date(schema.lastUpdated).toLocaleDateString()}
          </span>
        </div>
      </div>

      {Object.entries(byCategory).map(([category, fields]) =>
        fields.length > 0 ? (
          <div key={category} className="schema-category">
            <h4 className="category-title">{categoryLabels[category]} ({fields.length})</h4>
            <div className="schema-fields">
              {fields.map(([name, def]) => (
                <div key={name} className="schema-field">
                  <div className="field-header">
                    <span className="field-name">{name}</span>
                    <span className="field-type">{def.type}</span>
                  </div>
                  <div className="field-desc">{def.description}</div>
                  {def.aliases && def.aliases.length > 0 && (
                    <div className="field-meta">
                      <span className="meta-label">Aliases:</span>
                      {def.aliases.map((a, i) => (
                        <span key={i} className="meta-tag">{a}</span>
                      ))}
                    </div>
                  )}
                  {def.enum && def.enum.length > 0 && (
                    <div className="field-meta">
                      <span className="meta-label">Values:</span>
                      {def.enum.map((e, i) => (
                        <span key={i} className="meta-tag enum">{e}</span>
                      ))}
                    </div>
                  )}
                  {def.examples && def.examples.length > 0 && (
                    <div className="field-meta">
                      <span className="meta-label">Examples:</span>
                      {def.examples.slice(0, 3).map((e, i) => (
                        <span key={i} className="meta-tag example">{e}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null
      )}
    </div>
  );
}

