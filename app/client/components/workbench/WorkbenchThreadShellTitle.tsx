/*
 * Exports:
 * - default WorkbenchThreadShellTitle: the shell header's thread title and activity line, leasing the route's root thread entry itself; non-thread views render their own header children.
 */
"use client";

import type { ReactNode, RefObject } from "react";

import type { ThreadPayload } from "workbench-shared/types";
import { createDraftTitle, normalizeWorkbenchTimestampMs, type WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import resolveThreadActivityTimestampMs from "./thread-view/thread-activity-timestamp";
import { getThreadTitle } from "./thread-view/thread-view-formatters";
import ThreadShellTitleInput from "./ThreadShellTitleInput";
import { useThread } from "./use-thread";
import { useThreads } from "./use-threads";
import WorkbenchDraftTitleIcons from "./WorkbenchDraftTitleIcons";
import WorkbenchRelativeTime from "./WorkbenchRelativeTime";

export default function WorkbenchThreadShellTitle({
  children, draft, onSaveTitle, projectId, showThreadView, statusRef, target, thread, threadId, titleRef, unavailable,
}: {
  /** The header for views other than a thread. */
  children: ReactNode;
  draft: { prompt: string; attachments: readonly unknown[]; referenceKinds?: Parameters<typeof WorkbenchDraftTitleIcons>[0]["referenceKinds"] } | null;
  onSaveTitle?: (source: { harness: ThreadPayload["harness"]; id: string }, title: string) => Promise<string>;
  projectId: string;
  showThreadView: boolean;
  statusRef: RefObject<HTMLParagraphElement | null>;
  target: WorkbenchThreadRouteTarget | null;
  thread: ThreadPayload | null;
  threadId: string;
  titleRef: RefObject<HTMLParagraphElement | null>;
  /** A failed selection shows "Thread unavailable" instead of a loading title. */
  unavailable: boolean;
}) {
  // The root thread's own entry names it even when the browse folder's sidebar does not list it.
  const rootTarget: WorkbenchThreadRouteTarget | null = !showThreadView ? null
    : target?.kind === "subagent" ? { kind: "provider", harness: target.harness, threadId: target.parentThreadId }
      : target?.kind === "provider" ? target : null;
  const rootEntry = useThread(projectId, rootTarget).entry;
  const runtimeThreads = useThreads().threads;
  if (!showThreadView) return <>{children}</>;
  const summary = runtimeThreads.find(candidate => candidate.id === threadId) ?? null;
  const source = thread ?? summary ?? (rootEntry ? {
    harness: rootEntry.identity.harness, id: rootEntry.identity.threadId, name: rootEntry.title, preview: rootEntry.title,
  } : null);
  const activityMs = thread || summary
    ? resolveThreadActivityTimestampMs(thread ?? summary!, summary)
    : rootEntry ? normalizeWorkbenchTimestampMs(rootEntry.activityAt) : null;
  const title = source ? getThreadTitle(source) : "";
  const activity = activityMs ? <WorkbenchRelativeTime label="Last activity" timestampMs={activityMs} /> : null;
  if (thread?.isDraft && source) {
    return (
      <>
        <p id="file-path" ref={titleRef} className="flex min-w-0 items-center gap-1 truncate text-base font-semibold leading-tight">
          <WorkbenchDraftTitleIcons hasImages={Boolean(draft?.attachments.length)} referenceKinds={draft?.referenceKinds} />
          <span className="truncate">{draft ? createDraftTitle(draft.prompt) : title}</span>
        </p>
        <p id="status-line" ref={statusRef} className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted">{activity}</p>
      </>
    );
  }
  if (source) {
    return (
      <ThreadShellTitleInput
        key={`${source.harness}:${source.id}`}
        activityLabel={activity}
        statusRef={statusRef}
        title={title}
        titleRef={titleRef}
        onSave={onSaveTitle ? async (nextTitle) => await onSaveTitle(source, nextTitle) : undefined}
      />
    );
  }
  return (
    <>
      <p id="file-path" ref={titleRef} className="truncate text-base font-semibold leading-tight">
        {unavailable ? "Thread unavailable" : (
          <span className="block h-4 w-48 max-w-[60vw] rounded-full workbench-skeleton" aria-hidden="true" />
        )}
      </p>
      <p id="status-line" ref={statusRef} hidden className="mt-1 text-[0.84rem] tracking-[0.02em] text-fg/muted" />
    </>
  );
}
