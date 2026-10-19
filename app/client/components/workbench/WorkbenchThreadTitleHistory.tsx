/*
 * Exports:
 * - default WorkbenchThreadTitleHistory: previous titles hung off the current title on a hairline, with hover-revealed rename/dismiss intent and local action feedback.
 */
"use client";

import { useState } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { useThread } from "./use-thread";
import { PanelCloseIcon, ReapplyTitleIcon } from "./workbench-icons";

const actionClassName = `
  flex size-5 shrink-0 items-center justify-center rounded text-fg/muted
  hover:bg-accent-soft hover:text-text focus-visible:outline-accent disabled:opacity-40
`;

export default function WorkbenchThreadTitleHistory({ projectId, harness, threadId }: {
  projectId: ProjectId;
  harness: WorkbenchHarness;
  threadId: WorkbenchThreadId;
}) {
  const history = useThread.titleHistory(projectId, harness, threadId);
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
    <div className="ml-[0.4rem] flex min-w-0 flex-col border-l border-fg/12 pl-2.5" aria-busy={pending}>
      {history.previousTitles.length ? (
        <ol aria-label="Previous titles" className="m-0 flex list-none flex-col p-0">
          {history.previousTitles.map(({ title }) => (
            <li key={title} className="group/title flex min-w-0 items-center gap-0.5 text-[0.76rem] leading-[1.35rem] text-fg/muted">
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="flex opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 coarse-touch:opacity-100 motion-reduce:transition-none">
                <button
                  type="button"
                  aria-label={`Reapply title: ${title}`}
                  title="Reapply title"
                  disabled={pending}
                  className={actionClassName}
                  onClick={() => void apply("reapply", title)}
                >
                  <ReapplyTitleIcon size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Dismiss previous title: ${title}`}
                  title="Dismiss previous title"
                  disabled={pending}
                  className={actionClassName}
                  onClick={() => void apply("dismiss", title)}
                >
                  <PanelCloseIcon size={14} />
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {error ? <p role="alert" className="m-0 break-words text-[0.76rem] text-fg/muted">{error}</p> : null}
    </div>
  );
}
