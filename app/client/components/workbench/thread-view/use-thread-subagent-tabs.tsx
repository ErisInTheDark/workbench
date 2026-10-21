/*
 * Exports:
 * - default useThreadSubagentTabs: a thread's subagent tab strip: stable tab order, settled-tab reveal, labels, and pin/settle/link actions.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { WorkbenchHarness, WorkbenchSubagentSummary } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchThreadRouteTarget, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import {
  getSubagentHarness,
  getSubagentSummary,
  getSubagentTabLayout,
  getSubagentThreadIds,
  getThreadAgentTabLabel,
  reconcileSubagentTabOrder,
  type SubagentTabOrder,
} from "../../../workbench/thread/thread-subagents";
import ThreadAgentTabs from "./ThreadAgentTabs";

/**
 * Display state lives with the calling view, not the strip: the strip renders inside the composer, which remounts on
 * every tab switch. Tabs keep their slot across activity; only new or unsettled children move to the front.
 */
export default function useThreadSubagentTabs ({
  activeThreadId,
  getThreadHref,
  isMessageBoardOpen,
  onOpenMessageBoard,
  onSelectThread,
  projectId,
  relatedThreadsById,
  subagents,
  thread,
  updateThreadState,
}: {
  activeThreadId: string;
  getThreadHref?: (target: WorkbenchThreadRouteTarget) => string | undefined;
  isMessageBoardOpen: boolean;
  onOpenMessageBoard: () => void;
  onSelectThread: (threadId: string) => void;
  projectId: string;
  relatedThreadsById: Readonly<Record<string, RelatedThread | undefined>>;
  /** The root thread's direct subagents, sorted. */
  subagents: readonly WorkbenchSubagentSummary[];
  thread: { harness: WorkbenchHarness; id: string };
  updateThreadState: (request: WorkbenchThreadStateRequest) => Promise<unknown>;
}): ReactNode {
  const projectHref = useWorkbenchProjectNavigation();
  const [areSettledVisible, setAreSettledVisible] = useState(false);
  const hasSettledSubagents = useMemo(() => subagents.some((subagent) => subagent.lifecycle?.settled), [subagents]);
  const orderRef = useRef<{ threadId: string; value: SubagentTabOrder } | null>(null);
  const order = useMemo(() => reconcileSubagentTabOrder(
    orderRef.current?.threadId === thread.id ? orderRef.current.value : null,
    subagents,
  ), [subagents, thread.id]);
  useEffect(() => {
    orderRef.current = { threadId: thread.id, value: order };
  }, [order, thread.id]);
  const visibleThreadIds = useMemo(() => {
    const revealedThreadIds = new Set<string>(
      areSettledVisible
        ? subagents.filter((subagent) => subagent.lifecycle?.settled).map((subagent) => subagent.threadId)
        : [],
    );
    if (activeThreadId !== thread.id) revealedThreadIds.add(activeThreadId);
    return getSubagentThreadIds(getSubagentTabLayout(subagents, { order: order.order, revealedThreadIds }).visible);
  }, [activeThreadId, areSettledVisible, order, subagents, thread.id]);

  const tabs = useMemo(() => {
    const labelFor = (threadId: string) => getThreadAgentTabLabel(relatedThreadsById[threadId], getSubagentSummary(subagents, threadId));
    const labelCounts = new Map<string, number>();
    for (const threadId of visibleThreadIds) {
      const label = labelFor(threadId);
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const usedLabels = new Map<string, number>();
    return visibleThreadIds.map((threadId) => {
      const label = labelFor(threadId);
      const nextCount = (usedLabels.get(label) ?? 0) + 1;
      usedLabels.set(label, nextCount);
      const subagent = getSubagentSummary(subagents, threadId);
      return {
        id: threadId,
        isLoading: !relatedThreadsById[threadId],
        isPinned: Boolean(subagent?.pinned),
        subagent,
        suffix: (labelCounts.get(label) ?? 0) > 1 ? ` ${nextCount}` : "",
        thread: relatedThreadsById[threadId] ?? null,
      };
    });
  }, [relatedThreadsById, subagents, visibleThreadIds]);

  const toggleSettledVisible = useCallback(() => {
    setAreSettledVisible((current) => !current);
  }, []);

  const getTabHref = useCallback((threadId: string) => {
    const target: WorkbenchThreadRouteTarget = threadId === thread.id
      ? { harness: thread.harness, kind: "provider", threadId: ThreadReferenceSchema.parse(thread.id) }
      : {
        harness: getSubagentHarness(subagents, threadId, thread.harness),
        kind: "subagent",
        parentThreadId: ThreadReferenceSchema.parse(thread.id),
        threadId: ThreadReferenceSchema.parse(threadId),
      };
    return getThreadHref?.(target) ?? projectHref(createThreadRoute(projectId, target));
  }, [getThreadHref, projectHref, projectId, subagents, thread.harness, thread.id]);

  const togglePin = useCallback((threadId: string) => {
    const subagent = getSubagentSummary(subagents, threadId);
    if (!subagent) return;
    void updateThreadState({
      identity: { harness: subagent.harness, threadId: subagent.threadId },
      method: "workbench/thread-state/pin/set",
      pinned: !subagent.pinned,
      projectId: subagent.projectId,
    });
  }, [subagents, updateThreadState]);

  const toggleSettlement = useCallback((threadId: string, settled: boolean) => {
    const subagent = getSubagentSummary(subagents, threadId);
    if (!subagent) return;
    void updateThreadState({
      identity: { harness: subagent.harness, threadId: subagent.threadId },
      method: settled ? "workbench/thread-state/settle" : "workbench/thread-state/restore",
      projectId: subagent.projectId,
    });
  }, [subagents, updateThreadState]);

  if (!tabs.length && !hasSettledSubagents) return null;
  return (
    <ThreadAgentTabs
      activeThreadId={activeThreadId}
      getThreadHref={getTabHref}
      hasSettledSubagents={hasSettledSubagents}
      isMessageBoardOpen={isMessageBoardOpen}
      isSettledSubagentsVisible={areSettledVisible}
      isRevealingMore={false}
      mainThreadHarness={thread.harness}
      mainThreadId={thread.id}
      onOpenMessageBoard={onOpenMessageBoard}
      onToggleSettledSubagents={toggleSettledVisible}
      onSelectThread={onSelectThread}
      onTogglePin={togglePin}
      onToggleSettlement={toggleSettlement}
      projectId={projectId}
      tabs={tabs}
    />
  );
}
