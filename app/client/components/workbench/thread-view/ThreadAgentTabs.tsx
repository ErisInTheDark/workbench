/*
 * Exports:
 * - default ThreadAgentTabs: render lifecycle-ordered agent tabs, Lock controls, status icons, and settled-history disclosure.
 */
import type { MouseEvent } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import ContextMenuCapability from "../ContextMenuCapability";
import { CompletedThreadIcon, LockIcon, NeedsAttentionThreadIcon, RestoreThreadIcon, SettleThreadIcon, StoppedThreadIcon, UnlockIcon, WorkingThreadIcon } from "../workbench-icons";
import { getThreadAgentAccentHue } from "../../../workbench/thread/thread-subagents";
import type { IdentityAccentStyle } from "../../../workbench/identity-accent-color";
import { useWorkbenchThread } from "../use-workbench-thread";
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
const unselectedTabClassName = "text-fg/muted opacity-60 hover:opacity-80 hover:text-text";
function SelectedTabUnderline({ className, style }: { className: string; style?: IdentityAccentStyle }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute inset-x-1 bottom-0 border-t border-dotted ${className}`} style={style} />;
}

function ThreadLifecycleStatusIcon({ accentChromaPercent, lifecycle, subagent }: { accentChromaPercent?: number; lifecycle: WorkbenchThreadLifecycle | null; subagent?: WorkbenchSubagentSummary | null }) {
  const Icon = lifecycle?.kind === "needsAttention" ? NeedsAttentionThreadIcon : lifecycle?.kind === "stopped" ? StoppedThreadIcon : lifecycle?.kind === "working" ? WorkingThreadIcon : CompletedThreadIcon;
  const accentStyle: IdentityAccentStyle | undefined = subagent && lifecycle?.kind !== "stopped" ? {
    "--identity-hue": getThreadAgentAccentHue(subagent),
    "--hue-chroma": `${accentChromaPercent ?? 90}%`,
  } : undefined;
  return (
    <span
      className={joinClasses(
        "inline-flex shrink-0",
        lifecycle?.kind === "stopped" ? "text-red-600 dark:text-red-300" : subagent && "text-hue-(--identity-hue)",
      )}
      style={accentStyle}
    >
      <Icon size={16} />
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
  projectId,
  tabs,
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
  projectId: string;
  tabs: readonly SubagentTab[];
}) {
  const mainThread = useWorkbenchThread(projectId, { kind: "provider", harness: mainThreadHarness, threadId: ThreadReferenceSchema.parse(mainThreadId) });
  const mainThreadLifecycle = mainThread.state.entry?.lifecycle ?? null;
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
          icon: tab.isPinned ? <UnlockIcon size={16} /> : <LockIcon size={16} />,
          id: tab.isPinned ? "unlock" : "lock",
          label: tab.isPinned ? "Unlock subagent" : "Lock subagent",
          onSelect: () => onTogglePin(tab.id),
          }] : []),
          ...(settled ? [{
            icon: <RestoreThreadIcon size={16} />,
            id: "restore",
            label: "Restore subagent",
            onSelect: () => onToggleSettlement(tab.id, false),
          }] : terminal ? [{
            icon: <SettleThreadIcon size={16} />,
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
        {tab.isPinned ? <LockIcon className="shrink-0" size={16} /> : null}
        <ThreadAgentName accentChromaPercent={activeThreadId === tab.id ? 90 : 55} subagent={tab.subagent} thread={tab.thread} />
        {tab.suffix ? <span className="text-fg/muted">{tab.suffix}</span> : null}
        {activeThreadId === tab.id && tab.subagent ? (
          <SelectedTabUnderline
            className="border-hue-(--identity-hue)/35"
            style={{ "--identity-hue": getThreadAgentAccentHue(tab.subagent) }}
          />
        ) : null}
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
        {activeThreadId === mainThreadId ? <SelectedTabUnderline className="border-[color-mix(in_srgb,var(--text)_35%,transparent)]" /> : null}
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
