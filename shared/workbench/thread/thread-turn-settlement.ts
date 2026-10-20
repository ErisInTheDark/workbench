/*
 * Exports:
 * - endTurnItem: one item as its ended turn leaves it: a tool call still marked running is over; anything else is unchanged.
 */
import type { ThreadItem } from "./workbench-thread-items.ts";

/**
 * A turn that ended runs nothing, whether the call's own finish arrived or not. Its outcome is unknown, so a call
 * reads as completed, and a subagent call, which has an interrupted state, as interrupted.
 */
export function endTurnItem(item: ThreadItem): ThreadItem {
  if (!("status" in item) || item.status !== "inProgress") return item;
  switch (item.type) {
    case "commandExecution":
    case "dynamicToolCall":
    case "fileChange":
    case "mcpToolCall":
      return { ...item, status: "completed" };
    case "collabAgentToolCall":
      return { ...item, status: "interrupted" };
    default:
      return item;
  }
}
