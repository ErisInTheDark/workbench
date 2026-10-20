/*
 * Exports:
 * - ThreadInlineList: labels joined as an English list ("A, B, and C").
 * - ThreadAgentNameListEntry: one subagent a command named, resolved or by its fallback name.
 * - default ThreadAgentNameList: identity-coloured subagent names as an English list.
 */
"use client";

import { Fragment, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import ThreadAgentName from "./ThreadAgentName";

export interface ThreadAgentNameListEntry {
  fallbackName?: string | null;
  subagent?: WorkbenchSubagentSummary | null;
  targetKey: string;
  thread?: RelatedThread | null;
}

function separator(index: number, count: number) {
  if (index === 0) return null;
  if (index < count - 1) return ", ";
  return count === 2 ? " and " : ", and ";
}

export function ThreadInlineList({ items }: { items: readonly { key: string; label: ReactNode }[] }) {
  return (
    <span className="min-w-0 truncate">
      {items.map((item, index) => <Fragment key={item.key}>{separator(index, items.length)}{item.label}</Fragment>)}
    </span>
  );
}

export default function ThreadAgentNameList({ entries }: { entries: readonly ThreadAgentNameListEntry[] }) {
  return (
    <ThreadInlineList
      items={entries.map((entry, index) => ({
        key: `${entry.targetKey}:${index}`,
        label: (
          <ThreadAgentName
            subagent={entry.subagent}
            thread={entry.thread ?? (entry.fallbackName ? { agentNickname: entry.fallbackName, agentRole: null } : null)}
          />
        ),
      }))}
    />
  );
}
