/*
 * Exports:
 * - default ThreadTodoCommandItem: one wb todo call as a card. An added todo's line is its #id and title, opening into the
 *   live status-row todo row while the viewed thread still lists it; a removal is one line, and a listing opens to what
 *   the agent read.
 */
"use client";

import { useContext, useState } from "react";

import { workbenchThreadTodoTitle } from "workbench-shared/workbench/thread/thread-todo";
import type { WorkbenchTodoOperation } from "../../../workbench/thread/thread-command-matchers";
import { AsteriskIcon, ClipboardListIcon } from "../workbench-icons";
import ThreadCard from "./ThreadCard";
import { ThreadTodoRow } from "./ThreadTodoPanel";
import { ThreadTodoControlsContext } from "./thread-todo-controls";
import { isFailedStep, stepLabel, stepLabels } from "./thread-step";

type Outcome = "completed" | "failed" | "inProgress";

/** An added todo's line is its #id and title, so its done label is empty. */
const LABELS = {
  add: stepLabels("Adding todo", "", "Failed to add todo"),
  list: stepLabels("Listing todos", "Listed todos", "Failed to list todos"),
  remove: stepLabels("Removing", "Removed", "Failed to remove"),
} as const;

/** `wb todo` acknowledges an add with `Added todo 3 (required).` */
function readAddedTodoId(output: string) {
  const id = /\bAdded todo (\d+)\b/u.exec(output)?.[1];
  return id ? Number(id) : undefined;
}

/** The todo as the thread lists it now, editable in place; read-only text outside a live thread view. */
function LiveTodo({ id, text }: { id: number; text: string }) {
  const controls = useContext(ThreadTodoControlsContext);
  const [error, setError] = useState("");
  if (!controls) return <p className="m-0 whitespace-pre-wrap break-words px-1 py-1 text-[0.86em] text-text">{text}</p>;
  const todo = controls.todos.find(entry => entry.id === id);
  if (!todo) return <p className="m-0 px-1 py-1 text-[0.86em] text-fg/muted">No longer on the list.</p>;
  return (
    <>
      <ul aria-label="Todo" className="m-0 list-none p-0"><ThreadTodoRow controls={controls} onError={setError} todo={todo} /></ul>
      {error ? <p className="m-0 px-2 text-[0.74em] text-danger" role="alert">{error}</p> : null}
    </>
  );
}

export default function ThreadTodoCommandItem({ durationMs, operation, outcome, output }: {
  durationMs: number | null;
  operation: WorkbenchTodoOperation;
  outcome: Outcome;
  output: string;
}) {
  const addedId = operation.action === "add" && outcome === "completed" ? readAddedTodoId(output) : undefined;
  const verb = stepLabel(LABELS[operation.action], outcome);
  const subject = operation.action === "add" ? workbenchThreadTodoTitle(operation.text) ?? operation.text.split("\n")[0]
    : operation.action === "remove" ? operation.ids.map(id => `#${id}`).join(", ") : null;
  const failure = outcome === "failed" ? output.trim().slice(0, 500) : "";
  const body = failure ? <p className="m-0 text-[0.86em] text-fg/muted">{failure}</p>
    : addedId !== undefined && operation.action === "add" ? <LiveTodo id={addedId} text={operation.text} />
      : operation.action === "list" && outcome === "completed" && output.trim()
        ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.8em] text-fg/muted">{output.trim()}</pre>
        : null;
  return (
    <ThreadCard
      bodyInset={addedId === undefined}
      icon={<ClipboardListIcon size={16} />}
      iconClassName={isFailedStep(outcome) ? "text-danger" : undefined}
      label={verb}
      meta={[operation.action === "add" && operation.required ? <AsteriskIcon aria-label="required" key="required" size={14} /> : null]}
      progress={{ durationMs, state: outcome }}
      subject={(
        <>
          {addedId !== undefined ? <span className="shrink-0 text-[0.86em] font-semibold tabular-nums">#{addedId}</span> : null}
          {subject ? <span className="min-w-0 truncate font-medium text-text">{subject}</span> : null}
        </>
      )}
    >
      {body}
    </ThreadCard>
  );
}
