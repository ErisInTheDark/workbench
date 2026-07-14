/*
 * Exports:
 * - default ThreadAgentTabs: render the main-agent tab, bounded subagent tabs, badges, and the tab-shaped reveal control. Keywords: thread, subagent, tabs, pagination, activity.
 */
import type { ThreadPayload, ThreadUnreadBadge, WorkbenchSubagentSummary } from "../../../lib/types";
import { ThreadQuestionBadge, ThreadUnreadBadge as ThreadUnreadBadgeView } from "../ThreadStatusBadges";
import ThreadAgentName from "./ThreadAgentName";

interface TabBadge {
  isQuestion: boolean;
  unreadBadge: ThreadUnreadBadge | null;
}

interface SubagentTab {
  badge: TabBadge;
  id: string;
  isLoading: boolean;
  subagent: WorkbenchSubagentSummary | null;
  suffix: string;
  thread: ThreadPayload | null;
}

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const tabClassName = "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.78em] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

function badgeView (badge: TabBadge) {
  return badge.isQuestion
    ? <ThreadQuestionBadge />
    : badge.unreadBadge ? <ThreadUnreadBadgeView badge={badge.unreadBadge} /> : null;
}

export default function ThreadAgentTabs ({
  activeThreadId,
  canRevealMore,
  isRevealingMore,
  mainThreadBadge,
  mainThreadId,
  onRevealMore,
  onSelectThread,
  tabs,
}: {
  activeThreadId: string;
  canRevealMore: boolean;
  isRevealingMore: boolean;
  mainThreadBadge: TabBadge;
  mainThreadId: string;
  onRevealMore: () => void;
  onSelectThread: (threadId: string) => void;
  tabs: readonly SubagentTab[];
}) {
  if (!tabs.length && !canRevealMore) return null;
  return (
    <>
      <button
        type="button"
        className={joinClasses(
          tabClassName,
          activeThreadId === mainThreadId
            ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text"
            : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-transparent text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text",
        )}
        onClick={() => onSelectThread(mainThreadId)}
      >
        <span>Main agent</span>
        {badgeView(mainThreadBadge)}
      </button>
      <span className="text-[0.84em] text-muted" aria-hidden="true">|</span>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-busy={tab.isLoading}
          className={joinClasses(
            tabClassName,
            activeThreadId === tab.id
              ? "border-[color-mix(in_srgb,var(--text)_18%,transparent)] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text"
              : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-transparent text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text",
            tab.isLoading && activeThreadId !== tab.id && "opacity-70",
          )}
          onClick={() => onSelectThread(tab.id)}
        >
          <ThreadAgentName fallbackKey={tab.id} subagent={tab.subagent} thread={tab.thread} />
          {tab.suffix ? <span className="text-muted">{tab.suffix}</span> : null}
          {badgeView(tab.badge)}
        </button>
      ))}
      {canRevealMore ? (
        <button
          type="button"
          aria-busy={isRevealingMore}
          aria-label="Show more subagents"
          title="Show more subagents"
          disabled={isRevealingMore}
          className={joinClasses(
            tabClassName,
            "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-transparent text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text disabled:cursor-wait disabled:opacity-60",
          )}
          onClick={onRevealMore}
        >
          <span aria-hidden="true" className="block relative -mt-2 py-1">&hellip;</span>
        </button>
      ) : null}
    </>
  );
}
