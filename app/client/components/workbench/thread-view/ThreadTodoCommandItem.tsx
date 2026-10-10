/*
 * Exports:
 * - default ThreadTodoCommandItem: one wb todo call as its own row; an added or removed todo shows as the todo pill
 *   (its #id once the call reports it), and a listing opens to what the agent read.
 */
"use client";

import type { WorkbenchTodoOperation } from "../../../workbench/thread/thread-command-matchers";
import Disclosure from "../../ui/Disclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadTodoPill from "./ThreadTodoPill";

type Outcome = "completed" | "failed" | "inProgress";

const VERBS: Record<WorkbenchTodoOperation["action"], Record<Outcome, string>> = {
  add: { inProgress: "Adding todo", failed: "Could not add todo", completed: "Added todo" },
  list: { inProgress: "Listing todos", failed: "Could not list todos", completed: "Listed todos" },
  remove: { inProgress: "Removing", failed: "Could not remove", completed: "Removed" },
};

/** `wb todo` acknowledges an add with `Added todo 3 (required).` */
function readAddedTodoId(output: string) {
  const id = /\bAdded todo (\d+)\b/u.exec(output)?.[1];
  return id ? Number(id) : undefined;
}

export default function ThreadTodoCommandItem({ durationMs, operation, outcome, output }: {
  durationMs: number | null;
  operation: WorkbenchTodoOperation;
  outcome: Outcome;
  output: string;
}) {
  const summary = (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="shrink-0">{VERBS[operation.action][outcome]}</span>
      {operation.action === "add" ? (
        <ThreadTodoPill
          id={outcome === "completed" ? readAddedTodoId(output) : undefined}
          required={operation.required}
          text={operation.text}
        />
      ) : operation.action === "remove" ? operation.ids.map(id => <ThreadTodoPill id={id} key={id} required={false} />) : null}
      {durationMs === null ? null : <ThreadDurationText className="shrink-0 text-[0.78em] text-fg/muted" durationMs={durationMs} />}
    </span>
  );
  if (operation.action === "list" && outcome === "completed" && output.trim()) {
    return (
      <Disclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        renderContent={() => <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.8em] text-fg/muted">{output.trim()}</pre>}
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      />
    );
  }
  return (
    <div className="py-2 text-[0.92em] leading-[1.6] text-fg/muted">
      {summary}
      {outcome === "failed" && output.trim() ? <p className="m-0 mt-1 pl-6 text-[0.86em]">{output.trim().slice(0, 500)}</p> : null}
    </div>
  );
}
