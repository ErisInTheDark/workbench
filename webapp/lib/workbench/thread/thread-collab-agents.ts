/*
 * Exports:
 * - CollabAgentToolCallItem: typed collab-agent tool-call item alias for subagent history rendering. Keywords: workbench, thread, subagent, collab.
 * - getCollabAgentThreadIds: collect unique subagent thread ids referenced by collab-agent tool calls. Keywords: workbench, thread, subagent, tabs.
 * - getPrimaryCollabAgentThreadId: pick the first receiver id for a collab-agent tool call. Keywords: workbench, thread, subagent, collab.
 * - getThreadAgentAccentColor/getThreadAgentLabelParts: derive stable local display styling and nickname-first labels for subagents. Keywords: workbench, thread, subagent, color, label.
 * - getThreadAgentTabLabel: format a compact nickname-first label for pills and bubble captions. Keywords: workbench, thread, subagent, tabs.
 */
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../codex/generated/app-server/v2/Turn";
import type { ThreadPayload } from "../../types";

export type CollabAgentToolCallItem = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

export interface ThreadAgentLabelParts {
  nickname: string | null;
  role: string | null;
  text: string;
}

type ThreadAgentIdentity = Pick<ThreadPayload, "agentNickname" | "agentRole">;

const THREAD_AGENT_ACCENT_PALETTE = [
  "oklch(var(--oklch-text-lightness) 100% 0deg)",
  "oklch(var(--oklch-text-lightness) 100% 30deg)",
  "oklch(var(--oklch-text-lightness) 100% 60deg)",
  "oklch(var(--oklch-text-lightness) 100% 120deg)",
  "oklch(var(--oklch-text-lightness) 100% 150deg)",
  "oklch(var(--oklch-text-lightness) 100% 180deg)",
  "oklch(var(--oklch-text-lightness) 100% 210deg)",
  "oklch(var(--oklch-text-lightness) 100% 240deg)",
  "oklch(var(--oklch-text-lightness) 100% 270deg)",
  "oklch(var(--oklch-text-lightness) 100% 300deg)",
  "oklch(var(--oklch-text-lightness) 100% 330deg)",
] as const;

function normalizeLabel(value: string | null | undefined) {
  const nextValue = value?.trim();
  return nextValue ? nextValue : null;
}

function hashLabel(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

export function getPrimaryCollabAgentThreadId(item: CollabAgentToolCallItem) {
  return item.receiverThreadIds[0] ?? "";
}

export function getCollabAgentThreadIds(turns: Array<Pick<Turn, "items">>) {
  const threadIds = new Set<string>();

  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== "collabAgentToolCall") {
        continue;
      }

      for (const threadId of item.receiverThreadIds) {
        if (threadId.trim()) {
          threadIds.add(threadId);
        }
      }
    }
  }

  return Array.from(threadIds);
}

export function getThreadAgentLabelParts(thread: Partial<ThreadAgentIdentity> | null | undefined): ThreadAgentLabelParts {
  const role = normalizeLabel(thread?.agentRole);
  const nickname = normalizeLabel(thread?.agentNickname);
  if (role && nickname && role.localeCompare(nickname, undefined, { sensitivity: "accent" }) !== 0) {
    return {
      nickname,
      role,
      text: `${nickname} (${role})`,
    };
  }

  return {
    nickname,
    role,
    text: nickname ?? role ?? "subagent",
  };
}

export function getThreadAgentAccentColor(
  thread: Partial<ThreadAgentIdentity> | null | undefined,
  fallbackKey = "",
) {
  const label = normalizeLabel(fallbackKey)
    ?? normalizeLabel(thread?.agentNickname)
    ?? normalizeLabel(thread?.agentRole)
    ?? "subagent";
  return THREAD_AGENT_ACCENT_PALETTE[hashLabel(label) % THREAD_AGENT_ACCENT_PALETTE.length] ?? THREAD_AGENT_ACCENT_PALETTE[0];
}

export function getThreadAgentTabLabel(thread: Partial<ThreadAgentIdentity> | null | undefined) {
  return getThreadAgentLabelParts(thread).text;
}
