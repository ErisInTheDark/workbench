/*
 * Exports:
 * - default ThreadView: render the shared thread owner's loading, failure or admitted content.
 */
"use client";

import { useEffect, useState, type ComponentProps } from "react";
import type { ThreadPayload } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { useWorkbenchThread } from "../use-workbench-thread";
import ThreadViewContent from "./ThreadViewContent";
import ThreadLoadingSkeleton from "./ThreadLoadingSkeleton";

export default function ThreadView({ thread: fallbackThread, routeOwned = false, routeError = "", ...props }: Omit<ComponentProps<typeof ThreadViewContent>, "rootTarget"> & { thread?: ThreadPayload | null; routeOwned?: boolean; routeError?: string }) {
  const requested = props.threadTarget ?? (fallbackThread?.isDraft
    ? { kind: "draft" as const, draftId: fallbackThread.id }
    : fallbackThread ? { kind: "provider" as const, harness: fallbackThread.harness, threadId: fallbackThread.id } : null);
  const target = requested?.kind === "new" && fallbackThread?.isDraft
    ? { kind: "draft" as const, draftId: fallbackThread.id }
    : requested?.kind === "subagent"
    ? { kind: "provider" as const, threadId: requested.parentThreadId }
    : requested;
  const rootId = target?.kind === "draft" ? target.draftId : target && "threadId" in target ? target.threadId : "";
  const [selectedId, setSelectedId] = useState(props.selectedThreadId ?? rootId);
  useEffect(() => {
    setSelectedId(props.selectedThreadId ?? rootId);
  }, [props.selectedThreadId, rootId, props.viewInstanceKey]);
  const interest = routeOwned ? "route" : "view";
  const thread = useWorkbenchThread(props.projectId, target, undefined, interest);
  const child = thread.state.subagents.find(candidate => candidate.threadId === selectedId);
  const active = useWorkbenchThread(props.projectId, selectedId && selectedId !== rootId
    ? thread.state.status === "ready" ? { kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(rootId), threadId: ThreadReferenceSchema.parse(selectedId), harness: child?.harness } : null
    : target, undefined, selectedId !== rootId ? "view" : interest);
  const error = thread.state.error ?? active.state.error ?? ((!target || target.kind === "new") ? routeError : "");
  if (error) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 py-8">
        <div role="alert" className="flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger bg-danger/10 px-5 py-4 text-left">
          <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open thread</p>
          <p className="m-0 break-words text-sm text-text">{error}</p>
        </div>
      </div>
    );
  }
  if (!target || target.kind === "new" || thread.state.status !== "ready" || !thread.state.document || active.state.status !== "ready" || !active.state.document) return <ThreadLoadingSkeleton />;
  return <ThreadViewContent {...props} rootTarget={target} selectedThreadId={selectedId} onSelectedThreadChange={id => {
    setSelectedId(id);
    props.onSelectedThreadChange?.(id);
  }} />;
}
