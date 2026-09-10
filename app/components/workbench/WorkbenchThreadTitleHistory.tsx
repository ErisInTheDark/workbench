/*
 * Exports:
 * - default WorkbenchThreadTitleHistory: show previous titles with rename/dismiss intent and local action feedback.
 */
"use client";

import { useState } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { useWorkbenchThreadTitleHistory } from "./use-workbench-client";
import { PanelCloseIcon } from "./workbench-icons";

export default function WorkbenchThreadTitleHistory({ projectId, harness, threadId }: {
  projectId: ProjectId;
  harness: WorkbenchHarness;
  threadId: WorkbenchThreadId;
}) {
  const history = useWorkbenchThreadTitleHistory(projectId, harness, threadId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async (kind: "reapply" | "dismiss", title: string) => {
    setPending(true);
    setError(null);
    try {
      await history[kind](title);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message.slice(0, 300) : "The title action failed.";
      console.error("Thread title history action failed.", message);
      setError(message);
    } finally {
      setPending(false);
    }
  };
  if (!history.previousTitles.length && !error) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" aria-busy={pending}>
      {history.previousTitles.map(({ title }) => (
        <div key={title} className="flex min-w-0 items-start gap-1 text-[0.8rem] text-muted">
          <span className="min-w-0 flex-1 truncate py-1">{title}</span>
          <button
            type="button"
            aria-label={`Reapply title: ${title}`}
            title="Reapply title"
            disabled={pending}
            className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent-soft hover:text-text focus-visible:outline-accent disabled:opacity-40"
            onClick={() => void apply("reapply", title)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={`Dismiss previous title: ${title}`}
            title="Dismiss previous title"
            disabled={pending}
            className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent-soft hover:text-text focus-visible:outline-accent disabled:opacity-40"
            onClick={() => void apply("dismiss", title)}
          >
            <PanelCloseIcon />
          </button>
        </div>
      ))}
      {error ? <p role="alert" className="m-0 break-words text-[0.8rem] text-muted">{error}</p> : null}
    </div>
  );
}
