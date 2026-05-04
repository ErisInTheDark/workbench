"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  ThreadUnreadBadge,
  WorkbenchHarness,
  WorkbenchModelOption,
  WorkbenchPendingUserInputRequest,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import {
  getCollabAgentThreadIds,
  getThreadAgentTabLabel,
} from "../../../lib/workbench/thread/thread-collab-agents";
import { ThreadQuestionBadge, ThreadUnreadBadge as ThreadUnreadBadgeView } from "../ThreadStatusBadges";
import ThreadAgentName from "./ThreadAgentName";
import ThreadComposer from "./ThreadComposer";
import ThreadRateLimits from "./ThreadRateLimits";
import { ThreadTurnDetails } from "./thread-view-items";

const SUBTHREAD_POLL_INTERVAL_MS = 1500;

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function countThreadItems(thread: Pick<ThreadPayload, "turns">) {
  return thread.turns.reduce((total, turn) => total + turn.items.length, 0);
}

function areThreadPayloadsEquivalent (left: ThreadPayload | null | undefined, right: ThreadPayload | null | undefined) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExpandedSelectionWithin (root: HTMLElement | null) {
  if (!root || typeof window === "undefined" || typeof window.getSelection !== "function") {
    return false;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode));
}

export default memo(function ThreadView ({
  fontSizeRem,
  livePendingUserInputRequestsByThreadId,
  onDraftHarnessChange,
  onListModels,
  onOpenFile,
  onReadThread,
  onSendMessage,
  onStopThread,
  onSubmitUserInputRequest,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadModelChange,
  projectRootPath,
  rateLimits,
  thread,
}: {
  fontSizeRem: number;
  livePendingUserInputRequestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>;
  onDraftHarnessChange: (harness: WorkbenchHarness) => void;
  onListModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  onOpenFile: (path: string) => Promise<void>;
  onReadThread: (threadId: string, harness?: WorkbenchHarness) => Promise<ThreadPayload | null>;
  onSendMessage: (
    thread: ThreadPayload,
    input: UserInput[],
    options?: WorkbenchSendThreadMessageOptions,
  ) => Promise<ThreadPayload | null>;
  onStopThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  onSubmitUserInputRequest: (
    threadId: string,
    response: WorkbenchUserInputResponse,
    options?: WorkbenchSubmitUserInputRequestOptions,
  ) => Promise<void>;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  projectRootPath: string;
  rateLimits: RateLimitSnapshot | null;
  thread: ThreadPayload;
}) {
  const [activeThreadId, setActiveThreadId] = useState(thread.id);
  const [subthreadsById, setSubthreadsById] = useState<Record<string, ThreadPayload>>({});
  const [loadingThreadIds, setLoadingThreadIds] = useState<Record<string, true>>({});
  const [seenItemCountsByThreadId, setSeenItemCountsByThreadId] = useState<Record<string, number>>({});
  const threadViewRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const subagentThreadIds = useMemo(() => getCollabAgentThreadIds(thread.turns), [thread.turns]);
  const activeThread = activeThreadId === thread.id
    ? thread
    : subthreadsById[activeThreadId] ?? null;
  const activeHarnessUserInputRequest = activeThread
    ? livePendingUserInputRequestsByThreadId[activeThread.id] ?? null
    : null;
  const activePendingUserInputRequest = activeHarnessUserInputRequest;
  const currentTurn = activeThread?.turns.at(-1) ?? null;
  const isThinking = currentTurn?.status === "inProgress";

  const tabDefinitions = useMemo(() => {
    const baseLabelCounts = new Map<string, number>();
    for (const threadId of subagentThreadIds) {
      const label = getThreadAgentTabLabel(subthreadsById[threadId]);
      baseLabelCounts.set(label, (baseLabelCounts.get(label) ?? 0) + 1);
    }

    const usedLabels = new Map<string, number>();
    return subagentThreadIds.map((threadId) => {
      const baseLabel = getThreadAgentTabLabel(subthreadsById[threadId]);
      const totalCount = baseLabelCounts.get(baseLabel) ?? 0;
      const nextCount = (usedLabels.get(baseLabel) ?? 0) + 1;
      usedLabels.set(baseLabel, nextCount);
      return {
        id: threadId,
        isLoading: Boolean(loadingThreadIds[threadId]) && !subthreadsById[threadId],
        suffix: totalCount > 1 ? ` ${nextCount}` : "",
      };
    });
  }, [loadingThreadIds, subagentThreadIds, subthreadsById]);

  const markThreadSeen = useCallback((threadId: string, payload: ThreadPayload | null | undefined) => {
    if (!payload) {
      return;
    }

    const totalItems = countThreadItems(payload);
    setSeenItemCountsByThreadId((current) => (
      current[threadId] === totalItems
        ? current
        : {
          ...current,
          [threadId]: totalItems,
        }
    ));
  }, []);

  const loadSubthread = useCallback(async (threadId: string, harness: WorkbenchHarness = thread.harness) => {
    if (!threadId.trim() || threadId === thread.id) {
      return null;
    }

    setLoadingThreadIds((current) => (
      current[threadId]
        ? current
        : {
          ...current,
          [threadId]: true,
        }
    ));

    try {
      const payload = await onReadThread(threadId, harness);
      if (!payload) {
        return null;
      }

      setSubthreadsById((current) => {
        const existing = current[threadId];
        if (areThreadPayloadsEquivalent(existing, payload)) {
          return current;
        }

        return {
          ...current,
          [threadId]: payload,
        };
      });
      setSeenItemCountsByThreadId((current) => (
        current[threadId] !== undefined
          ? current
          : {
            ...current,
            [threadId]: countThreadItems(payload),
          }
      ));
      return payload;
    } finally {
      setLoadingThreadIds((current) => {
        if (!current[threadId]) {
          return current;
        }

        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [onReadThread, thread.harness, thread.id]);

  useEffect(() => {
    setActiveThreadId(thread.id);
    setSubthreadsById({});
    setLoadingThreadIds({});
    setSeenItemCountsByThreadId({
      [thread.id]: countThreadItems(thread),
    });
  }, [thread.id]);

  useEffect(() => {
    for (const threadId of subagentThreadIds) {
      if (threadId === thread.id || subthreadsById[threadId] || loadingThreadIds[threadId]) {
        continue;
      }

      void loadSubthread(threadId);
    }
  }, [loadSubthread, loadingThreadIds, subagentThreadIds, subthreadsById, thread.id]);

  const pollingThreadIds = useMemo(() => subagentThreadIds.filter((threadId) => {
    const payload = subthreadsById[threadId];
    return Boolean(payload && getCurrentInProgressTurn(payload));
  }), [subagentThreadIds, subthreadsById]);

  useEffect(() => {
    if (!pollingThreadIds.length) {
      return;
    }

    const intervalId = window.setInterval(() => {
      for (const threadId of pollingThreadIds) {
        void loadSubthread(threadId);
      }
    }, SUBTHREAD_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadSubthread, pollingThreadIds]);

  useLayoutEffect(() => {
    if (hasExpandedSelectionWithin(threadViewRef.current)) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      bottomSentinelRef.current?.scrollIntoView({ block: "end" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThread?.id, activeThread?.updatedAt]);

  useEffect(() => {
    if (!activeThread) {
      return;
    }

    markThreadSeen(activeThread.id, activeThread);
  }, [activeThread, markThreadSeen]);

  const handleSubthreadSelection = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    if (threadId !== thread.id) {
      void loadSubthread(threadId);
    }
  }, [loadSubthread, thread.id]);

  const handleSendMessage = useCallback(async (_threadId: string, input: UserInput[]) => {
    if (!activeThread) {
      return;
    }

    const payload = await onSendMessage(activeThread, input, {
      selectThread: activeThread.id === thread.id,
    });
    if (payload && activeThread.id !== thread.id) {
      setSubthreadsById((current) => ({
        ...current,
        [activeThread.id]: payload,
      }));
    }
  }, [activeThread, onSendMessage, thread.id]);

  const handleStopThread = useCallback(async () => {
    if (!activeThread) {
      return;
    }

    const payload = await onStopThread(activeThread);
    if (payload && activeThread.id !== thread.id) {
      setSubthreadsById((current) => ({
        ...current,
        [activeThread.id]: payload,
      }));
    }
  }, [activeThread, onStopThread, thread.id]);

  const handleThreadModelChange = useCallback((threadId: string, model: string) => {
    if (threadId === thread.id) {
      onThreadModelChange(threadId, model);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          model,
          reasoningEffort: null,
        },
      };
    });
  }, [onThreadModelChange, thread.id]);

  const handleThreadAgentChange = useCallback((threadId: string, agentPath: string | null) => {
    if (threadId === thread.id) {
      onThreadAgentChange(threadId, agentPath);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          agentPath,
        },
      };
    });
  }, [onThreadAgentChange, thread.id]);

  const handleThreadReasoningEffortChange = useCallback((threadId: string, effort: string | null) => {
    if (threadId === thread.id) {
      onThreadReasoningEffortChange(threadId, effort);
      return;
    }

    setSubthreadsById((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [threadId]: {
          ...existing,
          reasoningEffort: effort,
        },
      };
    });
  }, [onThreadReasoningEffortChange, thread.id]);

  const getTabBadge = useCallback((threadId: string, payload: ThreadPayload | null | undefined): { isQuestion: boolean; unreadBadge: ThreadUnreadBadge | null } => {
    const hasPendingQuestion = Boolean(livePendingUserInputRequestsByThreadId[threadId]);
    if (hasPendingQuestion) {
      return {
        isQuestion: true,
        unreadBadge: null,
      };
    }

    if (!payload) {
      return {
        isQuestion: false,
        unreadBadge: null,
      };
    }

    const hasActiveTurn = Boolean(getCurrentInProgressTurn(payload));
    const totalItems = countThreadItems(payload);
    const seenItemCount = seenItemCountsByThreadId[threadId] ?? totalItems;
    const unreadCount = Math.max(0, totalItems - seenItemCount);

    if (hasActiveTurn) {
      return {
        isQuestion: false,
        unreadBadge: {
          unreadCount,
          hasActiveTurn: true,
        },
      };
    }

    if (threadId === thread.id && unreadCount > 0) {
      return {
        isQuestion: false,
        unreadBadge: {
          unreadCount,
          hasActiveTurn: false,
        },
      };
    }

    return {
      isQuestion: false,
      unreadBadge: null,
    };
  }, [livePendingUserInputRequestsByThreadId, seenItemCountsByThreadId, thread.id]);

  const mainThreadBadge = getTabBadge(thread.id, thread);

  return (
    <div ref={threadViewRef} className="mx-auto w-full max-w-[56rem] pb-16" style={{ fontSize: `${fontSizeRem}rem` }}>
      {activeThread?.isDraft ? (
        <header className="pb-4">
          <h2 className="m-0 text-[1.55em] font-semibold leading-[1.1] tracking-tight text-text">
            Create new thread
          </h2>
        </header>
      ) : null}

      <div>
        {activeThread ? (
          activeThread.turns.length ? activeThread.turns.map((turn) => (
            <ThreadTurnDetails
              key={turn.id}
              onOpenFile={onOpenFile}
              projectRootPath={projectRootPath}
              relatedThreadsById={subthreadsById}
              turn={turn}
            />
          )) : (
            !activeThread.isDraft ? (
              <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4 text-[0.92em] leading-[1.6] text-muted">
                No turns were returned for this thread yet.
              </p>
            ) : null
          )
        ) : (
          <div className="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4">
            <p className="m-0 text-[0.92em] leading-[1.6] text-muted">Loading subagent thread...</p>
          </div>
        )}
      </div>
      {isThinking ? (
        <div className="py-4" aria-live="polite">
          <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
            Thinking
          </p>
        </div>
      ) : null}
      {tabDefinitions.length ? (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={joinClasses(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.78em] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                activeThreadId === thread.id
                  ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text"
                  : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-muted hover:text-text",
              )}
              onClick={() => {
                handleSubthreadSelection(thread.id);
              }}
            >
              <span>Main agent</span>
              {mainThreadBadge.isQuestion ? <ThreadQuestionBadge /> : mainThreadBadge.unreadBadge ? <ThreadUnreadBadgeView badge={mainThreadBadge.unreadBadge} /> : null}
            </button>
            <span className="text-[0.84em] text-muted" aria-hidden="true">|</span>
            {tabDefinitions.map((tab) => {
              const tabThread = subthreadsById[tab.id];
              const badge = getTabBadge(tab.id, tabThread);

              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-busy={tab.isLoading}
                  className={joinClasses(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.78em] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                    activeThreadId === tab.id
                      ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text"
                      : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-muted hover:text-text",
                    tab.isLoading && activeThreadId !== tab.id && "opacity-70",
                  )}
                  onClick={() => {
                    handleSubthreadSelection(tab.id);
                  }}
                  >
                    <ThreadAgentName
                      fallbackKey={tab.id}
                      thread={tabThread}
                    />
                    {tab.suffix ? <span className="text-muted">{tab.suffix}</span> : null}
                    {badge.isQuestion ? <ThreadQuestionBadge /> : badge.unreadBadge ? <ThreadUnreadBadgeView badge={badge.unreadBadge} /> : null}
                  </button>
                );
              })}
          </div>
        </div>
      ) : null}
      {activeThread ? (
        <>
          <ThreadComposer
            key={activeThread.id}
            onListModels={onListModels}
            onSendMessage={handleSendMessage}
            onStopThread={() => {
              void handleStopThread();
            }}
            onSubmitUserInputRequest={onSubmitUserInputRequest}
            onThreadAgentChange={handleThreadAgentChange}
            onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
            onThreadModelChange={handleThreadModelChange}
            pendingUserInputRequest={activePendingUserInputRequest}
            rateLimits={rateLimits}
            thread={activeThread}
          />
          <ThreadRateLimits
            canToggleHarness={activeThread.isDraft}
            harness={activeThread.harness}
            onHarnessToggle={() => {
              onDraftHarnessChange(activeThread.harness === "codex" ? "copilot" : "codex");
            }}
            rateLimits={rateLimits}
          />
        </>
      ) : null}
      <div ref={bottomSentinelRef} aria-hidden="true" className="h-px w-full" />
    </div>
  );
});
