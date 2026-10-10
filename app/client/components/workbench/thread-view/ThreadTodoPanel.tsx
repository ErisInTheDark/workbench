/*
 * Exports:
 * - default ThreadTodoPanel: a thread's goal and todos; text edits in place, todos can be picked for the next message, marked required or removed, and a trailing blank row becomes a new todo once it holds text.
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { WORKBENCH_THREAD_GOAL_MAX_LENGTH, type WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";
import { WORKBENCH_THREAD_TODO_MAX_LENGTH, type WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import IconButton from "../../ui/IconButton";
import { AsteriskIcon, AsteriskOffIcon, FlagFilledIcon, FlagIcon, XIcon } from "../workbench-icons";
import PlaintextEditable, { threadPlaintextEditableClassName } from "./PlaintextEditable";
import MarkdownRender from "../../ui/MarkdownRender";
import type { ThreadTodoSelection } from "./use-thread-todo-selection";

const rowClassName = "group/row flex min-w-0 items-start gap-1 rounded-[0.6rem] px-1 transition-colors";
const textClassName = "min-w-0 flex-1 py-1 text-[0.86em] leading-[1.6] text-text";
const fieldClassName = `${threadPlaintextEditableClassName} ${textClassName} whitespace-pre-wrap break-words outline-none`;
// One text line tall (0.86em at 1.6 leading, plus its padding), so markers centre on the first line.
const markerClassName = "flex h-[calc(1.376em+0.5rem)] min-w-7 shrink-0 items-center justify-center text-fg/muted";
const serialClassName = "text-[0.72em] font-semibold tabular-nums";
const revealClassName = "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 coarse-touch:opacity-100";

/** Plain text field: Enter or leaving commits, Escape reverts. */
function InlineField ({ ariaLabel, autoFocus, draft, onCommit, onDraft, onEnter, onRevert, placeholder }: {
  ariaLabel: string;
  autoFocus?: boolean;
  draft: string;
  /** Leaving the field. */
  onCommit: () => void;
  onDraft: (text: string) => void;
  /** Replaces leaving the field on Enter. */
  onEnter?: () => void;
  onRevert: () => void;
  placeholder: string;
}) {
  const reverting = useRef(false);
  return (
    <div className="min-w-0 flex-1">
      <PlaintextEditable
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        className={fieldClassName}
        onBlur={() => {
          if (reverting.current) reverting.current = false;
          else onCommit();
        }}
        onChange={onDraft}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Escape") {
            reverting.current = true;
            onRevert();
            event.currentTarget.blur();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (onEnter) onEnter();
          else event.currentTarget.blur();
        }}
        placeholder={placeholder}
        spellCheck
        value={draft}
      />
    </div>
  );
}

/** Rendered text that turns into its editor when clicked. */
function EditableText ({ ariaLabel, children, onSave, placeholder, value }: {
  ariaLabel: string;
  children: ReactNode;
  onSave: (text: string) => void;
  placeholder: string;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <button
        aria-label={`Edit ${ariaLabel.toLowerCase()}`}
        className={`${textClassName} cursor-text text-left [overflow-wrap:anywhere] focus-visible:outline-none`}
        onClick={(event) => {
          // Links inside the text keep working.
          if (event.target instanceof Element && event.target.closest("a")) return;
          setDraft(value);
        }}
        type="button"
      >
        {value ? children : <span className="text-fg/muted">{placeholder}</span>}
      </button>
    );
  }
  return (
    <InlineField
      ariaLabel={ariaLabel}
      autoFocus
      draft={draft}
      onCommit={() => {
        setDraft(null);
        if (draft.trim() !== value.trim()) onSave(draft.trim());
      }}
      onDraft={setDraft}
      onRevert={() => setDraft(null)}
      placeholder={placeholder}
    />
  );
}

function RowButtons ({ disabled = false, onRemove, onToggleRequired, removeLabel, required }: {
  disabled?: boolean;
  onRemove: () => void;
  onToggleRequired: () => void;
  removeLabel: string;
  required: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center py-0.5">
      <IconButton
        aria-pressed={required}
        className={required || disabled ? "" : revealClassName}
        disabled={disabled}
        display="hover-border"
        label={required ? "Required" : "Optional"}
        onClick={onToggleRequired}
        size="compact"
      >
        {required ? <AsteriskIcon size={14} /> : <AsteriskOffIcon size={14} />}
      </IconButton>
      <IconButton
        className={disabled ? "" : revealClassName}
        disabled={disabled}
        display="hover-border"
        label={removeLabel}
        onClick={onRemove}
        size="compact"
        tone="danger"
      >
        <XIcon size={14} />
      </IconButton>
    </span>
  );
}

export default function ThreadTodoPanel ({
  goal,
  selection,
  threadId,
  todos,
  onAddTodo,
  onClearGoal,
  onRemoveTodo,
  onSetGoal,
  onSetTodoRequired,
  onSetTodoText,
}: {
  goal: WorkbenchThreadGoal | null;
  selection: ThreadTodoSelection;
  threadId: string;
  todos: readonly WorkbenchThreadTodo[];
  onAddTodo: (text: string, required: boolean) => Promise<void>;
  onClearGoal: () => Promise<void>;
  onRemoveTodo: (id: number) => Promise<void>;
  onSetGoal: (objective: string) => Promise<void>;
  onSetTodoRequired: (id: number, required: boolean) => Promise<void>;
  onSetTodoText: (id: number, text: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [goalDraft, setGoalDraft] = useState(goal?.objective ?? "");
  const [goalFocused, setGoalFocused] = useState(false);
  const [blank, setBlank] = useState({ key: 0, text: "", required: false, refocus: false });
  const nextNumber = todos.reduce((highest, todo) => Math.max(highest, todo.id), 0) + 1;
  useEffect(() => { if (!goalFocused) setGoalDraft(goal?.objective ?? ""); }, [goal?.objective, goalFocused]);

  const run = (operation: () => Promise<void>, fallback: string) => {
    setError("");
    void operation().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : fallback));
  };
  const tooLong = (text: string, limit: number) => {
    if (text.length <= limit) return false;
    setError(`Over ${limit.toLocaleString()} characters.`);
    return true;
  };
  /** Text makes the blank row real; a fresh blank row takes its place, focused when Enter made it. */
  const commitBlank = (refocus: boolean) => {
    const text = blank.text.trim();
    if (!text || tooLong(text, WORKBENCH_THREAD_TODO_MAX_LENGTH)) return;
    const { required } = blank;
    setBlank(current => ({ key: current.key + 1, text: "", required: false, refocus }));
    run(() => onAddTodo(text, required), "Unable to add the todo.");
  };
  const clearBlank = () => setBlank(current => ({ ...current, text: "", required: false }));

  return (
    <div className="space-y-1 px-2 py-2">
      {/* The goal is always a live field: focus edits it, leaving saves it, emptying clears it. */}
      <div className={`${rowClassName} focus-within:bg-fg/5`} onFocus={() => setGoalFocused(true)}>
        <span aria-hidden="true" className={`${markerClassName} ${goal ? "text-text" : ""}`}>
          {goal ? <FlagFilledIcon size={14} /> : <FlagIcon size={14} />}
        </span>
        <InlineField
          ariaLabel="Goal"
          draft={goalDraft}
          onCommit={() => {
            setGoalFocused(false);
            const text = goalDraft.trim();
            if (text === (goal?.objective ?? "")) return;
            if (!text) run(onClearGoal, "Unable to clear the goal.");
            else if (!tooLong(text, WORKBENCH_THREAD_GOAL_MAX_LENGTH)) run(() => onSetGoal(text), "Unable to save the goal.");
          }}
          onDraft={setGoalDraft}
          onRevert={() => {
            setGoalFocused(false);
            setGoalDraft(goal?.objective ?? "");
          }}
          placeholder="Add a persistent goal across context compactions and turns"
        />
      </div>
      <ul aria-label="Todos" className="m-0 list-none space-y-0.5 p-0">
        {todos.map((todo) => {
          const selected = selection.isSelected(todo.id);
          return (
            <li
              className={`
                ${rowClassName}
                ${selected ? "bg-accent-soft/60 ring-1 ring-inset ring-accent" : "hover:bg-fg/4 focus-within:bg-fg/5"}
              `}
              key={todo.id}
            >
              <button
                aria-label={`Attach todo ${todo.id}`}
                aria-pressed={selected}
                className={`
                  ${markerClassName} cursor-pointer rounded-md transition
                  hover:bg-fg/7 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                  ${selected ? "text-accent" : ""}
                `}
                onClick={() => selection.toggle(todo.id)}
                type="button"
              >
                <span className={serialClassName}>#{todo.id}</span>
              </button>
              <EditableText
                ariaLabel={`Todo ${todo.id}`}
                onSave={(text) => {
                  if (!text) run(() => onRemoveTodo(todo.id), "Unable to remove the todo.");
                  else if (!tooLong(text, WORKBENCH_THREAD_TODO_MAX_LENGTH)) run(() => onSetTodoText(todo.id, text), "Unable to save the todo.");
                }}
                placeholder="Todo"
                value={todo.text}
              >
                <MarkdownRender markdown={todo.text} />
              </EditableText>
              <RowButtons
                onRemove={() => run(() => onRemoveTodo(todo.id), "Unable to remove the todo.")}
                onToggleRequired={() => run(() => onSetTodoRequired(todo.id, !todo.required), "Unable to update the todo.")}
                removeLabel={`Remove todo ${todo.id}`}
                required={todo.required}
              />
            </li>
          );
        })}
        <li
          className={`${rowClassName} focus-within:bg-fg/5`}
          key={`new-${blank.key}`}
          // Its own buttons keep the row in progress; leaving the whole row commits it.
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) commitBlank(false); }}
        >
          <span aria-hidden="true" className={`${markerClassName} opacity-60`}><span className={serialClassName}>#{nextNumber}</span></span>
          <InlineField
            ariaLabel="New todo"
            autoFocus={blank.refocus}
            draft={blank.text}
            onCommit={() => undefined}
            onDraft={(text) => setBlank(current => ({ ...current, text }))}
            onEnter={() => commitBlank(true)}
            onRevert={clearBlank}
            placeholder="Add a new todo"
          />
          <RowButtons
            disabled={!blank.text.trim()}
            onRemove={clearBlank}
            onToggleRequired={() => setBlank(current => ({ ...current, required: !current.required }))}
            removeLabel="Discard new todo"
            required={blank.required}
          />
        </li>
      </ul>
      {error ? <p className="m-0 px-2 text-[0.74em] text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
