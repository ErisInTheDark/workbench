/*
 * Exports:
 * - default ThreadAgentTabs: render lifecycle-ordered agent tabs, shared Lock controls, status icons, and settled-history disclosure. Keywords: thread, subagent, tabs, lock, lifecycle.
 */
import { useCallback, useSyncExternalStore, type MouseEvent } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary, WorkbenchThreadSidebarStore } from "workbench-shared/types";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import ContextMenuCapability from "../ContextMenuCapability";
import { CompletedThreadIcon, LockIcon, NeedsAttentionThreadIcon, RestoreThreadIcon, SettleThreadIcon, StoppedThreadIcon, UnlockIcon, WorkingThreadIcon } from "../workbench-icons";
import { getThreadAgentAccentColor } from "../../../workbench/thread/thread-subagents";
import ThreadAgentName from "./ThreadAgentName";

interface SubagentTab {
  id: string;
  isPinned: boolean;
  isLoading: boolean;
  subagent: WorkbenchSubagentSummary | null;
  suffix: string;
  thread: ThreadPayload | null;
}

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function handleThreadLinkClick(event: MouseEvent<HTMLAnchorElement>, onSelect: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  onSelect();
}

const tabClassName = "relative inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[0.95rem] font-medium leading-none transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";
const selectedTabClassName = "text-text";
const unselectedTabClassName = "text-muted opacity-60 hover:opacity-80 hover:text-text";
const EMPTY_THREAD_SIDEBAR_SUBSCRIBE = () => () => undefined;

function SelectedTabUnderline({ color }: { color: string }) {
  return <span aria-hidden="true" className="pointer-events-none absolute inset-x-1 bottom-0 border-t border-dotted" style={{ borderColor: color }} />;
}

function ThreadLifecycleStatusIcon({ accentChromaPercent, lifecycle, subagent }: { accentChromaPercent?: number; lifecycle: WorkbenchThreadLifecycle | null; subagent?: WorkbenchSubagentSummary | null }) {
  const Icon = lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : CompletedThreadIcon;
  return (
    <span
      className={joinClasses("inline-flex shrink-0", lifecycle?.kind === "stopped" && "text-red-600 dark:text-red-300")}
      style={subagent && lifecycle?.kind !== "stopped" ? { color: getThreadAgentAccentColor(subagent, accentChromaPercent) } : undefined}
    >
      <Icon className="size-4" />
    </span>
  );
}

export default function ThreadAgentTabs ({
  activeThreadId,
  hasSettledSubagents,
  getThreadHref,
  isSettledSubagentsVisible,
  isRevealingMore,
  mainThreadHarness,
  mainThreadId,
  onToggleSettledSubagents,
  onSelectThread,
  onTogglePin,
  onToggleSettlement,
  tabs,
  threadSidebarStore,
}: {
  activeThreadId: string;
  getThreadHref: (threadId: string) => string;
  hasSettledSubagents: boolean;
  isSettledSubagentsVisible: boolean;
  isRevealingMore: boolean;
  mainThreadHarness: ThreadPayload["harness"];
  mainThreadId: string;
  onToggleSettledSubagents: () => void;
  onSelectThread: (threadId: string) => void;
  onTogglePin: (threadId: string) => void;
  onToggleSettlement: (threadId: string, settled: boolean) => void;
  tabs: readonly SubagentTab[];
  threadSidebarStore: WorkbenchThreadSidebarStore | null;
}) {
  const getMainThreadLifecycle = useCallback(() => {
    const entry = threadSidebarStore?.getSnapshot()?.entries.find((candidate) => (
      candidate.entryKind !== "draft"
      && candidate.identity.harness === mainThreadHarness
      && candidate.identity.threadId === mainThreadId
    ));
    return entry && entry.entryKind !== "draft" ? entry.lifecycle : null;
  }, [mainThreadHarness, mainThreadId, threadSidebarStore]);
  const mainThreadLifecycle = useSyncExternalStore(
    threadSidebarStore?.subscribe ?? EMPTY_THREAD_SIDEBAR_SUBSCRIBE,
    getMainThreadLifecycle,
    getMainThreadLifecycle,
  );
  if (!tabs.length && !hasSettledSubagents) return null;
  const unsettledTabs = tabs.filter((tab) => !tab.subagent?.lifecycle?.settled);
  const settledTabs = tabs.filter((tab) => tab.subagent?.lifecycle?.settled);
  const renderTab = (tab: SubagentTab) => {
    const settled = Boolean(tab.subagent?.lifecycle?.settled);
    const terminal = tab.subagent?.lifecycle?.kind === "completed" || tab.subagent?.lifecycle?.kind === "stopped";
    return (
    <ContextMenuCapability
      key={tab.id}
      menu={{
        id: `subagent-tab:${tab.id}`,
        label: "Subagent tab actions",
        items: [
          ...(!settled ? [{
          icon: tab.isPinned ? <UnlockIcon className="size-4" /> : <LockIcon className="size-4" />,
          id: tab.isPinned ? "unlock" : "lock",
          label: tab.isPinned ? "Unlock subagent" : "Lock subagent",
          onSelect: () => onTogglePin(tab.id),
          }] : []),
          ...(settled ? [{
            icon: <RestoreThreadIcon className="size-4" />,
            id: "restore",
            label: "Restore subagent",
            onSelect: () => onToggleSettlement(tab.id, false),
          }] : terminal ? [{
            icon: <SettleThreadIcon className="size-4" />,
            id: "settle",
            label: "Settle subagent",
            onSelect: () => onToggleSettlement(tab.id, true),
          }] : []),
        ],
      }}
    >
      <a
        aria-busy={tab.isLoading}
        aria-label={`${tab.subagent?.name ?? "Subagent"}, ${tab.subagent?.lifecycle?.kind ?? "unknown"}${tab.subagent?.lifecycle?.settled ? ", settled" : ""}${tab.isPinned ? ", locked" : ""}`}
        className={joinClasses(tabClassName, activeThreadId === tab.id ? selectedTabClassName : unselectedTabClassName)}
        href={getThreadHref(tab.id)}
        onClick={(event) => handleThreadLinkClick(event, () => onSelectThread(tab.id))}
      >
        <ThreadLifecycleStatusIcon accentChromaPercent={activeThreadId === tab.id ? 90 : 55} lifecycle={tab.subagent?.lifecycle ?? null} subagent={tab.subagent} />
        {tab.isPinned ? <LockIcon className="size-4 shrink-0" /> : null}
        <ThreadAgentName accentChromaPercent={activeThreadId === tab.id ? 90 : 55} subagent={tab.subagent} thread={tab.thread} />
        {tab.suffix ? <span className="text-muted">{tab.suffix}</span> : null}
        {activeThreadId === tab.id && tab.subagent ? <SelectedTabUnderline color={`color-mix(in srgb, ${getThreadAgentAccentColor(tab.subagent)} 35%, transparent)`} /> : null}
      </a>
    </ContextMenuCapability>
    );
  };
  return (
    <>
      <a
        className={joinClasses(
          tabClassName,
          activeThreadId === mainThreadId
            ? selectedTabClassName
            : unselectedTabClassName,
        )}
        href={getThreadHref(mainThreadId)}
        onClick={(event) => handleThreadLinkClick(event, () => onSelectThread(mainThreadId))}
      >
        <ThreadLifecycleStatusIcon lifecycle={mainThreadLifecycle} />
        <span>Main agent</span>
        {activeThreadId === mainThreadId ? <SelectedTabUnderline color="color-mix(in srgb, var(--text) 35%, transparent)" /> : null}
      </a>
      {unsettledTabs.map(renderTab)}
      {hasSettledSubagents ? (
        <button
          type="button"
          aria-expanded={isSettledSubagentsVisible}
          aria-busy={isRevealingMore}
          aria-label={`${isSettledSubagentsVisible ? "Hide" : "Show"} settled subagents`}
          title={`${isSettledSubagentsVisible ? "Hide" : "Show"} settled subagents`}
          disabled={isRevealingMore}
          className={joinClasses(
            tabClassName,
            `${unselectedTabClassName} disabled:cursor-wait disabled:opacity-60`,
          )}
          onClick={onToggleSettledSubagents}
        >
          <span aria-hidden="true" className="block relative -mt-2 py-1">&hellip;</span>
        </button>
      ) : null}
      {settledTabs.map(renderTab)}
    </>
  );
}
