/*
 * Exports:
 * - formatThreadUnreadBadgeAccessibilityText: shared screen-reader/title copy for thread unread badges. Keywords: workbench, thread, unread, badge.
 * - ThreadUnreadBadge: shared unread/active badge used by thread lists and thread tabs. Keywords: workbench, thread, unread, badge.
 * - ThreadQuestionBadge: shared response-needed badge used by thread lists and thread tabs. Keywords: workbench, thread, questionnaire, approval, badge.
 */
"use client";

import type { ThreadUnreadBadge as ThreadUnreadBadgeValue } from "../../lib/types";

export function formatThreadUnreadBadgeAccessibilityText(badge: ThreadUnreadBadgeValue) {
  const unreadItemsLabel = badge.unreadCount === 1
    ? "1 unread turn item"
    : `${badge.unreadCount} unread turn items`;

  if (badge.unreadCount > 0) {
    return badge.hasActiveTurn
      ? `${unreadItemsLabel}. Turn still active.`
      : `${unreadItemsLabel}. Turn finished.`;
  }

  return badge.hasActiveTurn ? "Turn still active." : "Turn finished.";
}

export function ThreadUnreadBadge({ badge }: { badge: ThreadUnreadBadgeValue }) {
  const label = badge.unreadCount > 99
    ? "99+"
    : badge.unreadCount > 0
      ? String(badge.unreadCount)
      : "...";
  const isPlaceholder = badge.unreadCount === 0;

  return (
    <>
      <span className="sr-only">{formatThreadUnreadBadgeAccessibilityText(badge)}</span>
      <span
        aria-hidden="true"
        title={formatThreadUnreadBadgeAccessibilityText(badge)}
        className={`inline-flex shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold leading-none tabular-nums ${badge.hasActiveTurn ? "bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-muted" : "bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-success"}${isPlaceholder ? " min-w-[2rem] tracking-[0.16em]" : " min-w-[1.55rem]"}`}
      >
        {label}
      </span>
    </>
  );
}

export function ThreadQuestionBadge() {
  const accessibilityText = "User response needed.";

  return (
    <>
      <span className="sr-only">{accessibilityText}</span>
      <span
        aria-hidden="true"
        title={accessibilityText}
        className="inline-flex min-w-[1.55rem] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,#d0ad12_18%,transparent)] px-2 py-0.5 text-[0.72rem] font-semibold leading-none text-[#7a5b00] dark:bg-[color-mix(in_srgb,#ffd84d_18%,transparent)] dark:text-[#ffd84d]"
      >
        ?
      </span>
    </>
  );
}
