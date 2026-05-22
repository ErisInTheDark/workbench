/*
 * Exports:
 * - default ThreadView: render the main thread, subthread tabs, live activity, and polled turn history. Keywords: thread view, subthread, polling, workbench.
 */
"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, mergeTurnsPreservingLiveItems } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  ThreadUnreadBadge,
  WorkbenchHarness,
  WorkbenchModelOption,
  WorkbenchPendingUserInputRequest,
  WorkbenchQuestionnaireDraft,
  WorkbenchSendThreadMessageOptions,
  WorkbenchSubmitUserInputRequestOptions,
  WorkbenchThreadComposerDraft,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import {
  persistThreadLiveActivityOpen,
  readStoredThreadLiveActivityOpen,
} from "../../../lib/workbench/state/browser-state";
import {
  getCollabAgentThreadIds,
  getPrimaryCollabAgentThreadId,
  getThreadAgentTabLabel,
} from "../../../lib/workbench/thread/thread-collab-agents";
import { ThreadQuestionBadge, ThreadUnreadBadge as ThreadUnreadBadgeView } from "../ThreadStatusBadges";
import ThreadAgentName from "./ThreadAgentName";
import ThreadComposer from "./ThreadComposer";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadRateLimits from "./ThreadRateLimits";
import { ThreadThreadContent, ThreadTurnDetails } from "./thread-view-items";

const SUBTHREAD_POLL_INTERVAL_MS = 1500;

type LiveThreadActivity =
  | {
    body: string | null;
    hiddenItemId: string | null;
    kind: "reasoning";
    title: string;
  }
  | {
    hiddenItemId: string;
    kind: "subagentWait";
    receiverThreadId: string;
  };

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function countThreadItems (thread: Pick<ThreadPayload, "turns">) {
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

function mergeSubthreadTurnSnapshots (
  incomingThread: ThreadPayload,
  existingThread: ThreadPayload | undefined,
) {
  if (!existingThread || existingThread.id !== incomingThread.id || existingThread.harness !== incomingThread.harness) {
    return incomingThread;
  }

  const existingTurnsById = new Map(existingThread.turns.map((turn) => [turn.id, turn]));
  let changed = false;
  const mergedTurns = mergeTurnsPreservingLiveItems(incomingThread.turns, existingThread.turns);
  if (mergedTurns !== incomingThread.turns) {
    changed = true;
  }

  const turns = mergedTurns.map((incomingTurn) => {
    const existingTurn = existingTurnsById.get(incomingTurn.id);
    if (!existingTurn || incomingTurn.status !== "inProgress" || existingTurn.status !== "inProgress") {
      return incomingTurn;
    }

    const incomingItemIds = new Set(incomingTurn.items.map((item) => item.id));
    const missingActiveCommandItems = existingTurn.items.filter((item) => (
      item.type === "commandExecution"
      && item.status === "inProgress"
      && !incomingItemIds.has(item.id)
    ));
    if (!missingActiveCommandItems.length) {
      return incomingTurn;
    }

    changed = true;
    return {
      ...incomingTurn,
      items: [
        ...incomingTurn.items,
        ...missingActiveCommandItems,
      ],
    };
  });

  return changed ? { ...incomingThread, turns } : incomingThread;
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

function cleanReasoningTitleLine (value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^\[(.+)\]$/, "$1")
    .replace(/:$/, "")
    .trim() || null;
}

function getReasoningStepBody (sections: string[]) {
  const bodySections: string[] = [];
  let removedTitle = false;

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    if (!removedTitle) {
      const firstTextLineIndex = lines.findIndex((line) => line.trim());
      if (firstTextLineIndex !== -1) {
        lines.splice(firstTextLineIndex, 1);
        removedTitle = true;
      }
    }

    const bodySection = lines.join("\n").trim();
    if (bodySection) {
      bodySections.push(bodySection);
    }
  }

  return bodySections.join("\n\n").trim() || null;
}

function getCurrentReasoningStep (turn: ThreadPayload["turns"][number] | null) {
  if (!turn || turn.status !== "inProgress") {
    return null;
  }

  const latestItem = turn.items.at(-1);
  if (!latestItem || latestItem.type !== "reasoning") {
    return null;
  }

  const visibleSections = latestItem.summary.length ? latestItem.summary : latestItem.content;
  for (const section of visibleSections) {
    const title = cleanReasoningTitleLine(section);
    if (title) {
      return {
        body: getReasoningStepBody(visibleSections),
        id: latestItem.id,
        title,
      };
    }
  }

  return {
    body: getReasoningStepBody(visibleSections),
    id: latestItem.id,
    title: "Thinking",
  };
}

function getLiveThreadActivity ({
  pendingUserInputRequest,
  turn,
}: {
  pendingUserInputRequest: WorkbenchPendingUserInputRequest | null;
  turn: ThreadPayload["turns"][number] | null;
}): LiveThreadActivity | null {
  if (!turn || turn.status !== "inProgress" || pendingUserInputRequest) {
    return null;
  }

  const latestItem = turn.items.at(-1);
  if (latestItem?.type === "collabAgentToolCall" && latestItem.tool === "wait" && latestItem.status === "inProgress") {
    const receiverThreadId = getPrimaryCollabAgentThreadId(latestItem);
    if (!receiverThreadId) {
      return null;
    }

    return {
      hiddenItemId: latestItem.id,
      kind: "subagentWait",
      receiverThreadId,
    };
  }

  const reasoningStep = getCurrentReasoningStep(turn);
  if (reasoningStep) {
    return {
      body: reasoningStep.body,
      hiddenItemId: reasoningStep.id,
      kind: "reasoning",
      title: reasoningStep.title,
    };
  }

  return {
    body: null,
    hiddenItemId: null,
    kind: "reasoning",
    title: "Thinking",
  };
}

export default memo(function ThreadView ({
  fontSizeRem,
  livePendingUserInputRequestsByThreadId,
  onDraftHarnessChange,
  onListModels,
  onOpenFile,
  onReadThread,
  onThreadSeen,
  onSendMessage,
  onStopThread,
  onSubmitUserInputRequest,
  onThreadComposerDraftChange,
  onThreadComposerDraftClear,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadModelChange,
  projectId,
  projectRootPath,
  rateLimits,
  threadComposerDraftsByThreadId,
  threadQuestionnaireDraftsByKey,
  thread,
}: {
  fontSizeRem: number;
  livePendingUserInputRequestsByThreadId: Record<string, WorkbenchPendingUserInputRequest>;
  onDraftHarnessChange: (harness: WorkbenchHarness) => void;
  onListModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  onOpenFile: (path: string) => Promise<void>;
  onReadThread: (threadId: string, harness?: WorkbenchHarness) => Promise<ThreadPayload | null>;
  onThreadSeen: (thread: ThreadPayload) => void;
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
  onThreadComposerDraftChange: (threadId: string, draft: WorkbenchThreadComposerDraft) => void;
  onThreadComposerDraftClear: (threadId: string) => void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  projectId: string;
  projectRootPath: string;
  rateLimits: RateLimitSnapshot | null;
  threadComposerDraftsByThreadId: Record<string, WorkbenchThreadComposerDraft | undefined>;
  threadQuestionnaireDraftsByKey: Record<string, WorkbenchQuestionnaireDraft | undefined>;
  thread: ThreadPayload;
}) {
  const [activeThreadId, setActiveThreadId] = useState(thread.id);
  const [subthreadsById, setSubthreadsById] = useState<Record<string, ThreadPayload>>({});
  const [loadingThreadIds, setLoadingThreadIds] = useState<Record<string, true>>({});
  const [seenItemCountsByThreadId, setSeenItemCountsByThreadId] = useState<Record<string, number>>({});
  const [isLiveActivityOpen, setIsLiveActivityOpen] = useState(readStoredThreadLiveActivityOpen);
  const threadViewRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const hasMountedActiveThreadScrollRef = useRef(false);
  const subagentThreadIds = useMemo(() => getCollabAgentThreadIds(thread.turns), [thread.turns]);
  const activeThread = activeThreadId === thread.id
    ? thread
    : subthreadsById[activeThreadId] ?? null;
  const activeHarnessUserInputRequest = activeThread
    ? livePendingUserInputRequestsByThreadId[activeThread.id] ?? null
    : null;
  const activePendingUserInputRequest = activeHarnessUserInputRequest;
  const currentTurn = activeThread?.turns.at(-1) ?? null;
  const liveActivity = getLiveThreadActivity({
    pendingUserInputRequest: activePendingUserInputRequest,
    turn: currentTurn,
  });
  const liveSubagentThread = liveActivity?.kind === "subagentWait"
    ? subthreadsById[liveActivity.receiverThreadId] ?? null
    : null;
  const liveActivityHasDisclosureContent = liveActivity?.kind === "reasoning"
    ? Boolean(liveActivity.body)
    : Boolean(liveSubagentThread?.turns.length);

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
        const mergedPayload = mergeSubthreadTurnSnapshots(payload, existing);
        if (areThreadPayloadsEquivalent(existing, mergedPayload)) {
          return current;
        }

        return {
          ...current,
          [threadId]: mergedPayload,
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
    if (!hasMountedActiveThreadScrollRef.current) {
      hasMountedActiveThreadScrollRef.current = true;
      return;
    }

    if (hasExpandedSelectionWithin(threadViewRef.current)) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      bottomSentinelRef.current?.scrollIntoView({ block: "end" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThread?.id]);

  useEffect(() => {
    onThreadSeen(thread);
  }, [onThreadSeen, thread]);

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
              hiddenCollabAgentToolCallItemId={turn.id === currentTurn?.id && liveActivity?.kind === "subagentWait" ? liveActivity.hiddenItemId : null}
              onOpenFile={onOpenFile}
              projectRootPath={projectRootPath}
              relatedThreadsById={subthreadsById}
              turn={turn}
              hiddenReasoningItemId={turn.id === currentTurn?.id && liveActivity?.kind === "reasoning" ? liveActivity.hiddenItemId : null}
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
      {liveActivity ? (
        <div className="py-4" aria-live="polite">
          {liveActivityHasDisclosureContent ? (
            <ThreadDisclosure
              contentClassName="mt-2"
              open={isLiveActivityOpen}
              onToggle={(event) => {
                const nextIsOpen = event.currentTarget.open;
                setIsLiveActivityOpen(nextIsOpen);
                persistThreadLiveActivityOpen(nextIsOpen);
              }}
              summaryClassName="text-[0.92em] font-medium leading-[1.6]"
              summary={liveActivity.kind === "reasoning" ? (
                <span className="thread-thinking-text">{liveActivity.title}</span>
              ) : (
                <span>
                  <span className="thread-thinking-text">waiting for</span>{" "}
                  <ThreadAgentName
                    fallbackKey={liveActivity.receiverThreadId}
                    thread={liveSubagentThread}
                  />
                </span>
              )}
            >
              {liveActivity.kind === "reasoning" ? (
                liveActivity.body ? (
                  <ThreadMarkdown
                    className="text-[0.8em] text-muted"
                    markdown={liveActivity.body}
                    onOpenFile={onOpenFile}
                    projectRootPath={projectRootPath}
                  />
                ) : null
              ) : (
                <div className="flex relative h-[calc(22rem*0.9)] before:absolute before:inset-0 before:-z-1 before:block before:bg-[linear-gradient(to_right,transparent,#0008_10%,#0008_90%,transparent)] before:content-[''] before:border-y before:border-[color-mix(in_srgb,var(--text)_10%,transparent)]">
                  <div className="explorer-scrollbar my-[calc(22rem*-0.1*0.5)] h-[22rem] scale-[0.9] overflow-y-auto py-2">
                    <ThreadThreadContent
                      onOpenFile={onOpenFile}
                      projectRootPath={projectRootPath}
                      relatedThreadsById={subthreadsById}
                      thread={liveSubagentThread}
                    />
                  </div>
                </div>
              )}
            </ThreadDisclosure>
          ) : liveActivity.kind === "reasoning" ? (
            <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
              {liveActivity.title}
            </p>
          ) : (
            <p className="m-0 text-[0.92em] font-medium leading-[1.6]">
              <span className="thread-thinking-text">waiting for</span>{" "}
              <ThreadAgentName
                fallbackKey={liveActivity.receiverThreadId}
                thread={liveSubagentThread}
              />
            </p>
          )}
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
            onThreadComposerDraftChange={onThreadComposerDraftChange}
            onThreadComposerDraftClear={onThreadComposerDraftClear}
            onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
            onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
            onSubmitUserInputRequest={onSubmitUserInputRequest}
            onThreadAgentChange={handleThreadAgentChange}
            onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
            onThreadModelChange={handleThreadModelChange}
            pendingUserInputRequest={activePendingUserInputRequest}
            projectId={projectId}
            rateLimits={rateLimits}
            threadComposerDraft={threadComposerDraftsByThreadId[activeThread.id] ?? null}
            threadQuestionnaireDraft={activePendingUserInputRequest
              ? threadQuestionnaireDraftsByKey[`${activeThread.id}:${activePendingUserInputRequest.requestKey}`] ?? null
              : null}
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
