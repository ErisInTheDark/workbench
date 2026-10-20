/*
 * Exports:
 * - default ThreadTodoPanel: a thread's goal and todos as always-live plain-text fields, and a trailing blank row that becomes a new todo once it holds text.
 * - ThreadTodoRow: one live todo that can be picked for the next message, edited, marked required or removed; shared with transcript todo cards.
 * - threadTodoRowClassNames: todo row geometry for sibling rows in the same panel.
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { WORKBENCH_THREAD_GOAL_MAX_LENGTH, type WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";
import {
  WORKBENCH_THREAD_TODO_MAX_LENGTH, workbenchThreadTodoReference, type WorkbenchThreadTodo,
} from "workbench-shared/workbench/thread/thread-todo";
import IconButton from "../../ui/IconButton";
import { AsteriskIcon, AsteriskOffIcon, FlagFilledIcon, FlagIcon, XIcon } from "../workbench-icons";
import PlaintextEditable, { threadPlaintextEditableClassName } from "./PlaintextEditable";
import type { ThreadTodoControls } from "./thread-todo-controls";

const rowClassName = "group/row flex min-w-0 items-start gap-1 rounded-[0.6rem] px-1 transition-colors";
const textClassName = "min-w-0 flex-1 py-1 text-[0.86em] leading-[1.6] text-text";
const fieldClassName = `${threadPlaintextEditableClassName} ${textClassName} whitespace-pre-wrap break-words outline-none`;
// One text line tall (0.86em at 1.6 leading, plus its padding), so markers centre on the first line.
const markerClassName = "flex h-[calc(1.376em+0.5rem)] min-w-7 shrink-0 items-center justify-center text-fg/muted";
const serialClassName = "text-[0.72em] font-semibold tabular-nums";
const revealClassName = "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 coarse-touch:opacity-100";
/** Row geometry the addressed feedback rows under the todos share, so both lists line up. */
export const threadTodoRowClassNames = { marker: markerClassName, reveal: revealClassName, row: rowClassName, text: textClassName };

/** Plain text field: Enter or leaving commits, Escape reverts. */
function InlineField ({ ariaLabel, autoFocus, draft, onCommit, onDraft, onEnter, onFocus, onRevert, placeholder }: {
  ariaLabel: string;
  autoFocus?: boolean;
  draft: string;
  /** Leaving the field. */
  onCommit: () => void;
  onDraft: (text: string) => void;
  /** Replaces leaving the field on Enter. */
  onEnter?: () => void;
  onFocus?: () => void;
  onRevert: () => void;
  placeholder: string;
}) {
  const reverting = useRef(false);
  return (
    <div className="min-w-0 flex-1" onFocus={onFocus}>
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

/** A stored value that is always its own editor, so focusing never swaps layout; leaving saves a changed, trimmed value. */
function LiveTextField ({ ariaLabel, onSave, placeholder, value }: {
  ariaLabel: string;
  onSave: (text: string) => void;
  placeholder: string;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  // Observed changes replace the draft only while it is not being edited.
  useEffect(() => { if (!focused) setDraft(value); }, [focused, value]);
  return (
    <InlineField
      ariaLabel={ariaLabel}
      draft={draft}
      onCommit={() => {
        setFocused(false);
        const text = draft.trim();
        if (text !== value.trim()) onSave(text);
      }}
      onDraft={setDraft}
      onFocus={() => setFocused(true)}
      onRevert={() => {
        setFocused(false);
        setDraft(value);
      }}
      placeholder={placeholder}
    />
  );
}

function RowButtons ({ onRemove, onToggleRequired, removeLabel, required }: {
  onRemove: () => void;
  onToggleRequired: () => void;
  removeLabel: string;
  required: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center">
      <IconButton
        aria-pressed={required}
        className={required ? "" : revealClassName}
        display="hover-border"
        label={required ? "Required" : "Optional"}
        onClick={onToggleRequired}
        size="small"
      >
        {required ? <AsteriskIcon size={16} /> : <AsteriskOffIcon size={16} />}
      </IconButton>
      <IconButton
        className={revealClassName}
        display="hover-border"
        label={removeLabel}
        onClick={onRemove}
        size="small"
        tone="danger"
      >
        <XIcon size={16} />
      </IconButton>
    </span>
  );
}

/** Runs a todo mutation, reporting its failure (and clearing the last one) through `onError`. */
function todoRunner(onError: (message: string) => void) {
  return {
    run(operation: () => Promise<void>, fallback: string) {
      onError("");
      void operation().catch((failure: unknown) => onError(failure instanceof Error ? failure.message : fallback));
    },
    tooLong(text: string, limit: number) {
      if (text.length <= limit) return false;
      onError(`Over ${limit.toLocaleString()} characters.`);
      return true;
    },
  };
}

/** One live todo: its #id picks it for the next message, its text edits in place, and it can be marked required or removed. */
export function ThreadTodoRow ({ controls, onError, todo }: {
  controls: ThreadTodoControls;
  onError: (message: string) => void;
  todo: WorkbenchThreadTodo;
}) {
  const { run, tooLong } = todoRunner(onError);
  const reference = workbenchThreadTodoReference(todo);
  const selected = controls.selection.isSelected(reference);
  return (
    <li
      className={`
        ${rowClassName}
        ${selected ? "bg-accent-soft/60 ring-1 ring-inset ring-accent" : "hover:bg-fg/4 focus-within:bg-fg/5"}
      `}
    >
      <button
        aria-label={`Attach todo ${todo.id}`}
        aria-pressed={selected}
        className={`
          ${markerClassName} cursor-pointer rounded-md transition
          hover:bg-fg/7 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
          ${selected ? "text-accent" : ""}
        `}
        onClick={() => controls.selection.toggle(reference)}
        type="button"
      >
        <span className={serialClassName}>#{todo.id}</span>
      </button>
      <LiveTextField
        ariaLabel={`Todo ${todo.id}`}
        onSave={(text) => {
          if (!text) run(() => controls.remove(todo.id), "Unable to remove the todo.");
          else if (!tooLong(text, WORKBENCH_THREAD_TODO_MAX_LENGTH)) run(() => controls.setText(todo.id, text), "Unable to save the todo.");
        }}
        placeholder="Todo"
        value={todo.text}
      />
      <RowButtons
        onRemove={() => run(() => controls.remove(todo.id), "Unable to remove the todo.")}
        onToggleRequired={() => run(() => controls.setRequired(todo.id, !todo.required), "Unable to update the todo.")}
        removeLabel={`Remove todo ${todo.id}`}
        required={todo.required}
      />
    </li>
  );
}

export default function ThreadTodoPanel ({
  controls,
  goal,
  onAddTodo,
  onClearGoal,
  onSetGoal,
}: {
  controls: ThreadTodoControls;
  goal: WorkbenchThreadGoal | null;
  onAddTodo: (text: string, required: boolean) => Promise<void>;
  onClearGoal: () => Promise<void>;
  onSetGoal: (objective: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [blank, setBlank] = useState({ key: 0, text: "", refocus: false });
  const { todos } = controls;
  const nextNumber = todos.reduce((highest, todo) => Math.max(highest, todo.id), 0) + 1;
  const { run, tooLong } = todoRunner(setError);
  /** Text makes the blank row real; a fresh blank row takes its place, focused when Enter made it. */
  const commitBlank = (refocus: boolean) => {
    const text = blank.text.trim();
    if (!text || tooLong(text, WORKBENCH_THREAD_TODO_MAX_LENGTH)) return;
    setBlank(current => ({ key: current.key + 1, text: "", refocus }));
    run(() => onAddTodo(text, false), "Unable to add the todo.");
  };
  const clearBlank = () => setBlank(current => ({ ...current, text: "" }));

  return (
    <div className="space-y-1 px-2 py-2">
      <div className={`${rowClassName} focus-within:bg-fg/5`}>
        <span aria-hidden="true" className={`${markerClassName} ${goal ? "text-text" : ""}`}>
          {goal ? <FlagFilledIcon size={14} /> : <FlagIcon size={14} />}
        </span>
        <LiveTextField
          ariaLabel="Goal"
          onSave={(text) => {
            if (!text) run(onClearGoal, "Unable to clear the goal.");
            else if (!tooLong(text, WORKBENCH_THREAD_GOAL_MAX_LENGTH)) run(() => onSetGoal(text), "Unable to save the goal.");
          }}
          placeholder="Add a persistent goal across context compactions and turns"
          value={goal?.objective ?? ""}
        />
      </div>
      <ul aria-label="Todos" className="m-0 list-none space-y-0.5 p-0">
        {todos.map(todo => <ThreadTodoRow controls={controls} key={todo.id} onError={setError} todo={todo} />)}
        <li
          className={`${rowClassName} focus-within:bg-fg/5`}
          key={`new-${blank.key}`}
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
        </li>
      </ul>
      {error ? <p className="m-0 px-2 text-[0.74em] text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
