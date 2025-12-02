import { useState, useRef, useEffect } from "react";
import { trpc } from "../lib/trpc";
import "./TaskInput.css";

interface TaskInputProps {
  scope: string | null;
}

export function TaskInput({ scope }: TaskInputProps) {
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  const createMutation = trpc.task.create.useMutation({
    onSuccess: () => {
      setValue("");
      utils.task.list.invalidate();
      utils.index.stats.invalidate();
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || isSubmitting) return;

    setIsSubmitting(true);
    createMutation.mutate({ raw: value.trim() });
  };

  // Focus on mount and Cmd+K
  useEffect(() => {
    inputRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <form className="task-input-form" onSubmit={handleSubmit}>
      <div className="input-wrapper">
        <span className="input-prefix">+</span>
        <input
          ref={inputRef}
          type="text"
          className="task-input"
          placeholder="Add a task... (e.g., 'fix login bug in webapp by friday')"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isSubmitting}
        />
        {scope && (
          <span className="input-scope">
            <span className="scope-icon">◉</span>
            {scope}
          </span>
        )}
        <button
          type="submit"
          className="submit-btn"
          disabled={!value.trim() || isSubmitting}
        >
          {isSubmitting ? (
            <span className="submit-spinner" />
          ) : (
            <span className="submit-icon">↵</span>
          )}
        </button>
      </div>
      {createMutation.isError && (
        <div className="input-error">
          Failed to create task. Please try again.
        </div>
      )}
    </form>
  );
}

