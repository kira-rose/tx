import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { trpc } from "../lib/trpc";
import "./NotesView.css";

type NoteTab = "list" | "tags" | "entities";

interface Note {
  id: string;
  raw: string;
  title?: string;
  created: string;
  updated: string;
  fields: Record<string, { name: string; value: unknown }>;
  tags: string[];
  relatedTasks?: string[];
  relatedNotes?: string[];
  source?: string;
}

export function NotesView() {
  const [activeTab, setActiveTab] = useState<NoteTab>("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [newNote, setNewNote] = useState("");
  const [expandedNote, setExpandedNote] = useState<string | null>(null);

  // Queries
  const notesQuery = trpc.note.list.useQuery({
    search: searchQuery || undefined,
    tags: selectedTag ? [selectedTag] : undefined,
    limit: 100,
  });

  const tagsQuery = trpc.note.tags.useQuery();
  const entitiesQuery = trpc.note.entities.useQuery();

  // Mutations
  const createNote = trpc.note.create.useMutation({
    onSuccess: () => {
      setNewNote("");
      notesQuery.refetch();
      tagsQuery.refetch();
      entitiesQuery.refetch();
    },
  });

  const deleteNote = trpc.note.delete.useMutation({
    onSuccess: () => {
      notesQuery.refetch();
      tagsQuery.refetch();
    },
  });

  const updateNote = trpc.note.update.useMutation({
    onSuccess: () => {
      notesQuery.refetch();
      tagsQuery.refetch();
      entitiesQuery.refetch();
    },
  });

  const handleUpdateNote = async (id: string, raw: string) => {
    await updateNote.mutateAsync({ id, raw });
  };

  const handleCreateNote = () => {
    if (!newNote.trim() || createNote.isLoading) return;
    createNote.mutate({ raw: newNote });
  };

  return (
    <div className="notes-view">
      {/* Note Input */}
      <div className="note-input-section">
        <textarea
          className="note-input"
          placeholder="Write a note... (supports multiple lines)"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          rows={4}
        />
        <button
          className={`note-submit-btn ${createNote.isLoading ? "loading" : ""}`}
          onClick={handleCreateNote}
          disabled={!newNote.trim() || createNote.isLoading}
        >
          {createNote.isLoading ? (
            <>
              <span className="spinner">◌</span>
              <span>Analyzing...</span>
            </>
          ) : (
            <>
              <span className="btn-icon">✚</span>
              <span>Save Note</span>
            </>
          )}
        </button>
      </div>

      {/* Tab Navigation */}
      <div className="notes-tabs">
        <button
          className={`notes-tab ${activeTab === "list" ? "active" : ""}`}
          onClick={() => setActiveTab("list")}
          title="All Notes"
        >
          <span className="tab-icon">☰</span>
          <span className="tab-label">Notes</span>
          {notesQuery.data && (
            <span className="tab-count">{notesQuery.data.total}</span>
          )}
        </button>
        <button
          className={`notes-tab ${activeTab === "tags" ? "active" : ""}`}
          onClick={() => setActiveTab("tags")}
          title="Tags"
        >
          <span className="tab-icon">#</span>
          <span className="tab-label">Tags</span>
          {tagsQuery.data && (
            <span className="tab-count">{tagsQuery.data.length}</span>
          )}
        </button>
        <button
          className={`notes-tab ${activeTab === "entities" ? "active" : ""}`}
          onClick={() => setActiveTab("entities")}
          title="Entities"
        >
          <span className="tab-icon">◎</span>
          <span className="tab-label">Entities</span>
          {entitiesQuery.data && (
            <span className="tab-count">{entitiesQuery.data.length}</span>
          )}
        </button>
      </div>

      {/* Search/Filter Bar */}
      {activeTab === "list" && (
        <div className="notes-filter-bar">
          <input
            type="text"
            className="notes-search"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {selectedTag && (
            <div className="active-tag-filter">
              <span className="tag-pill">#{selectedTag}</span>
              <button
                className="clear-tag-btn"
                onClick={() => setSelectedTag(null)}
              >
                ×
              </button>
            </div>
          )}
        </div>
      )}

      {/* Content Area */}
      <div className="notes-content">
        {activeTab === "list" && (
          <div className="notes-list">
            {notesQuery.isLoading ? (
              <div className="notes-loading">Loading notes...</div>
            ) : notesQuery.data?.notes.length === 0 ? (
              <div className="notes-empty">
                {searchQuery || selectedTag
                  ? "No notes match your search"
                  : "No notes yet. Add one above!"}
              </div>
            ) : (
              notesQuery.data?.notes.map((note: Note) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  expanded={expandedNote === note.id}
                  onToggle={() =>
                    setExpandedNote(expandedNote === note.id ? null : note.id)
                  }
                  onTagClick={(tag) => setSelectedTag(tag)}
                  onDelete={() => deleteNote.mutate({ id: note.id })}
                  onUpdate={handleUpdateNote}
                  isUpdating={updateNote.isLoading}
                />
              ))
            )}
          </div>
        )}

        {activeTab === "tags" && (
          <div className="tags-view">
            {tagsQuery.isLoading ? (
              <div className="notes-loading">Loading tags...</div>
            ) : tagsQuery.data?.length === 0 ? (
              <div className="notes-empty">
                No tags discovered yet. Tags are extracted automatically from your notes.
              </div>
            ) : (
              <div className="tags-cloud">
                {tagsQuery.data?.map(({ tag, count }: { tag: string; count: number }) => (
                  <button
                    key={tag}
                    className="tag-cloud-item"
                    onClick={() => {
                      setSelectedTag(tag);
                      setActiveTab("list");
                    }}
                    style={{
                      fontSize: `${Math.min(1 + count * 0.1, 1.8)}rem`,
                    }}
                  >
                    <span className="tag-hash">#</span>
                    {tag}
                    <span className="tag-count">{count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "entities" && (
          <div className="entities-view">
            {entitiesQuery.isLoading ? (
              <div className="notes-loading">Loading entities...</div>
            ) : entitiesQuery.data?.length === 0 ? (
              <div className="notes-empty">
                No entities discovered yet. Entities are extracted automatically from your notes.
              </div>
            ) : (
              <div className="entities-grid">
                {groupEntitiesByType(entitiesQuery.data || []).map(
                  ([type, entities]) => (
                    <div key={type} className="entity-group">
                      <h3 className="entity-type-header">{type}</h3>
                      <div className="entity-list">
                        {entities.map((entity) => (
                          <div key={entity.name} className="entity-item">
                            <span className="entity-name">{entity.name}</span>
                            <span className="entity-stats">
                              {entity.occurrences} mention
                              {entity.occurrences !== 1 ? "s" : ""}
                              {entity.relatedNoteIds.length > 0 && (
                                <> · {entity.relatedNoteIds.length} note{entity.relatedNoteIds.length !== 1 ? "s" : ""}</>
                              )}
                              {entity.relatedTaskIds.length > 0 && (
                                <> · {entity.relatedTaskIds.length} task{entity.relatedTaskIds.length !== 1 ? "s" : ""}</>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface EntityInfo {
  name: string;
  type: "person" | "project" | "concept" | "location" | "organization" | "other";
  occurrences: number;
  relatedTaskIds: string[];
  relatedNoteIds: string[];
}

function groupEntitiesByType(entities: EntityInfo[]): [string, EntityInfo[]][] {
  const grouped: Record<string, EntityInfo[]> = {};
  for (const entity of entities) {
    const type = entity.type || "other";
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(entity);
  }
  // Sort by type name and return
  return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
}

interface NoteItemProps {
  note: Note;
  expanded: boolean;
  onToggle: () => void;
  onTagClick: (tag: string) => void;
  onDelete: () => void;
  onUpdate: (id: string, raw: string) => Promise<void>;
  isUpdating: boolean;
}

function NoteItem({
  note,
  expanded,
  onToggle,
  onTagClick,
  onDelete,
  onUpdate,
  isUpdating,
}: NoteItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(note.raw);

  const title = note.title || note.raw.substring(0, 60);
  const hasMoreContent = note.raw.length > 60 || Object.keys(note.fields).length > 0;
  const fieldCount = Object.keys(note.fields).length;

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditContent(note.raw);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditContent(note.raw);
    setIsEditing(false);
  };

  const handleSaveEdit = async () => {
    if (editContent.trim() && editContent !== note.raw) {
      await onUpdate(note.id, editContent);
    }
    setIsEditing(false);
  };

  return (
    <div className={`note-item ${expanded ? "expanded" : ""} ${isEditing ? "editing" : ""}`}>
      <div className="note-item-header" onClick={isEditing ? undefined : onToggle}>
        <div className="note-item-main">
          <span className="note-id">{note.id.slice(0, 6)}</span>
          <span className="note-title">{title}</span>
        </div>
        <div className="note-item-meta">
          {note.tags.length > 0 && (
            <div className="note-tags">
              {note.tags.slice(0, 3).map((tag) => (
                <button
                  key={tag}
                  className="note-tag"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTagClick(tag);
                  }}
                >
                  #{tag}
                </button>
              ))}
              {note.tags.length > 3 && (
                <span className="more-tags">+{note.tags.length - 3}</span>
              )}
            </div>
          )}
          {hasMoreContent && !isEditing && (
            <button className="note-expand-btn">
              {fieldCount > 0 && <span className="field-count">{fieldCount} fields</span>}
              <span className="expand-icon">{expanded ? "▾" : "▸"}</span>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="note-item-details">
          {isEditing ? (
            <div className="note-edit-form">
              <textarea
                className="note-edit-textarea"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={6}
                autoFocus
              />
              <div className="note-edit-actions">
                <button
                  className="note-cancel-btn"
                  onClick={handleCancelEdit}
                  disabled={isUpdating}
                >
                  Cancel
                </button>
                <button
                  className={`note-save-btn ${isUpdating ? "loading" : ""}`}
                  onClick={handleSaveEdit}
                  disabled={!editContent.trim() || editContent === note.raw || isUpdating}
                >
                  {isUpdating ? (
                    <>
                      <span className="spinner">◌</span>
                      <span>Saving...</span>
                    </>
                  ) : (
                    "Save"
                  )}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="note-full-content">
                <ReactMarkdown>{note.raw}</ReactMarkdown>
              </div>

              {fieldCount > 0 && (
                <div className="note-fields">
                  <h4>Extracted Fields</h4>
                  <div className="fields-grid">
                    {Object.entries(note.fields).map(([key, field]) => (
                      <div key={key} className="field-item">
                        <span className="field-name">{key}</span>
                        <span className="field-value">
                          {Array.isArray(field.value)
                            ? field.value.join(", ")
                            : String(field.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {note.relatedTasks && note.relatedTasks.length > 0 && (
                <div className="note-related">
                  <span className="related-label">Linked to {note.relatedTasks.length} task(s)</span>
                </div>
              )}

              <div className="note-actions">
                <span className="note-date">
                  Created {new Date(note.created).toLocaleDateString()}
                  {note.updated !== note.created && (
                    <> · Updated {new Date(note.updated).toLocaleDateString()}</>
                  )}
                </span>
                <div className="note-action-buttons">
                  <button
                    className="note-edit-btn"
                    onClick={handleStartEdit}
                  >
                    Edit
                  </button>
                  <button
                    className="note-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this note?")) {
                        onDelete();
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

