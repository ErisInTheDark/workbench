/*
 * Exports:
 * - default ThreadTodoCommandItem: one wb todo call as a card, or as a step inside another card's history. An added
 *   todo's line is its #id and title, opening into the live status-row todo row while the viewed thread still lists it;
 *   a removal's line is each removed #id and title, opening to their text; a listing opens to what the agent read. A
 *   card with history (the listing folded before it) opens onto that first.
 */
"use client";

import { useContext, useState } from "react";

import { parseWorkbenchThreadTodos, workbenchThreadTodoTitle } from "workbench-shared/workbench/thread/thread-todo";
import type { WorkbenchTodoOperation } from "../../../workbench/thread/thread-command-matchers";
import { AsteriskIcon, ClipboardListIcon } from "../workbench-icons";
import ThreadCard from "./ThreadCard";
import ThreadCardHistoryContext from "./ThreadCardHistoryContext";
import ThreadStepRow from "./ThreadStepRow";
import { ThreadTodoRow } from "./ThreadTodoPanel";
import { ThreadTodoControlsContext } from "./thread-todo-controls";
import { ThreadRowChromeContext } from "./thread-row-chrome";
import { isFailedStep, stepLabel, stepLabels } from "./thread-step";

type Outcome = "completed" | "failed" | "inProgress";

/** An added todo's line is its #id and title, so its done label is empty. */
const LABELS = {
  add: stepLabels("Adding todo", "", "Failed to add todo"),
  list: stepLabels("Listing todos", "Listed todos", "Failed to list todos"),
  remove: stepLabels("Removing", "Removed", "Failed to remove"),
} as const;

const TEXT_CLASS = "m-0 whitespace-pre-wrap break-words px-1 py-1 text-[0.86em] text-text";

/** `wb todo` acknowledges an add with `Added todo 3 (required).` */
function readAddedTodoId(output: string) {
  const id = /\bAdded todo (\d+)\b/u.exec(output)?.[1];
  return id ? Number(id) : undefined;
}

function todoTitle(text: string) {
  return workbenchThreadTodoTitle(text) ?? text.split("\n")[0]!;
}

function TodoId({ id }: { id: number }) {
  return <span className="shrink-0 text-[0.86em] font-semibold tabular-nums">#{id}</span>;
}

/** The todo as the thread lists it now, editable in place; read-only text outside a live thread view. */
function LiveTodo({ id, text }: { id: number; text: string }) {
  const controls = useContext(ThreadTodoControlsContext);
  const [error, setError] = useState("");
  if (!controls) return <p className={TEXT_CLASS}>{text}</p>;
  const todo = controls.todos.find(entry => entry.id === id);
  if (!todo) return <p className="m-0 px-1 py-1 text-[0.86em] text-fg/muted">No longer on the list.</p>;
  return (
    <>
      <ul aria-label="Todo" className="m-0 list-none p-0"><ThreadTodoRow controls={controls} onError={setError} todo={todo} /></ul>
      {error ? <p className="m-0 px-2 text-[0.74em] text-danger" role="alert">{error}</p> : null}
    </>
  );
}

function Subject({ addedId, operation, removed }: {
  addedId: number | undefined;
  operation: WorkbenchTodoOperation;
  removed: ReturnType<typeof parseWorkbenchThreadTodos>;
}) {
  if (operation.action === "add") {
    return (
      <>
        {addedId !== undefined ? <TodoId id={addedId} /> : null}
        <span className="min-w-0 truncate font-medium text-text">{todoTitle(operation.text)}</span>
      </>
    );
  }
  if (operation.action !== "remove") return null;
  // Outputs from before removals printed their text name only the ids.
  if (!removed.length) return <span className="min-w-0 truncate font-medium text-text">{operation.ids.map(id => `#${id}`).join(", ")}</span>;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
      {removed.map((todo, index) => (
        <span className="flex min-w-0 items-baseline gap-1" key={todo.id}>
          <TodoId id={todo.id} />
          <span className="min-w-0 truncate font-medium text-text">{todoTitle(todo.text)}{index < removed.length - 1 ? "," : ""}</span>
        </span>
      ))}
    </span>
  );
}

export default function ThreadTodoCommandItem({ durationMs, operation, outcome, output }: {
  durationMs: number | null;
  operation: WorkbenchTodoOperation;
  outcome: Outcome;
  output: string;
}) {
  const history = useContext(ThreadCardHistoryContext);
  const asStep = useContext(ThreadRowChromeContext) === "step";
  const completed = outcome === "completed";
  const addedId = operation.action === "add" && completed ? readAddedTodoId(output) : undefined;
  const removed = operation.action === "remove" && completed ? parseWorkbenchThreadTodos(output) : [];
  const failure = outcome === "failed" ? output.trim().slice(0, 500) : "";
  const own = failure ? <p className="m-0 text-[0.86em] text-fg/muted">{failure}</p>
    : addedId !== undefined && operation.action === "add" ? <LiveTodo id={addedId} text={operation.text} />
      : removed.length ? removed.map(todo => <p className={TEXT_CLASS} key={todo.id}>{removed.length > 1 ? `#${todo.id} ` : ""}{todo.text}</p>)
        : operation.action === "list" && completed && output.trim()
          ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.8em] text-fg/muted">{output.trim()}</pre>
          : null;
  const body = history || own ? <>{history ? <div>{history.content}</div> : null}{own}</> : null;
  const line = {
    bodyInset: addedId === undefined,
    icon: <ClipboardListIcon size={16} />,
    iconClassName: isFailedStep(outcome) ? "text-danger" : undefined,
    label: stepLabel(LABELS[operation.action], outcome),
    meta: [operation.action === "add" && operation.required ? <AsteriskIcon aria-label="required" key="required" size={14} /> : null],
    progress: { durationMs, state: outcome },
    subject: <Subject addedId={addedId} operation={operation} removed={removed} />,
  };
  return asStep ? <ThreadStepRow {...line}>{body}</ThreadStepRow> : <ThreadCard {...line}>{body}</ThreadCard>;
}
