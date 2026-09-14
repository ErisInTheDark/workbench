/*
 * Exports:
 * - default WorkbenchThreadTitleHistory: show previous titles with rename/dismiss intent and local action feedback.
 */
"use client";

import { useState } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { useWorkbenchThreadTitleHistory } from "./use-workbench-client";
import { PanelCloseIcon, ReapplyTitleIcon } from "./workbench-icons";

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
        <div key={title} className="flex min-w-0 items-start gap-1 text-[0.8rem] text-fg/muted">
          <span className="min-w-0 flex-1 truncate py-1">{title}</span>
          <button
            type="button"
            aria-label={`Reapply title: ${title}`}
            title="Reapply title"
            disabled={pending}
            className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent-soft hover:text-text focus-visible:outline-accent disabled:opacity-40"
            onClick={() => void apply("reapply", title)}
          >
            <ReapplyTitleIcon size={16} />
          </button>
          <button
            type="button"
            aria-label={`Dismiss previous title: ${title}`}
            title="Dismiss previous title"
            disabled={pending}
            className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent-soft hover:text-text focus-visible:outline-accent disabled:opacity-40"
            onClick={() => void apply("dismiss", title)}
          >
            <PanelCloseIcon size={16} />
          </button>
        </div>
      ))}
      {error ? <p role="alert" className="m-0 break-words text-[0.8rem] text-fg/muted">{error}</p> : null}
    </div>
  );
}
