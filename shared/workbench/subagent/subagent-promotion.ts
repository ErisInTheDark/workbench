/*
 * Exports:
 * - PromotedSubagent: one child a `subagent_promote` result names, with its new sidebar thread id or why it stayed.
 * - formatPromotedSubagent/formatUnpromotedSubagent: the result line the daemon writes for each child.
 * - parsePromotedSubagents: read those lines back, for the promote card.
 * - findPromotedChild: the child a completed promote call item names, the proof a take back needs.
 */
import type { ThreadItem } from "../thread/workbench-thread-items";

export type PromotedSubagent = { name: string } & ({ threadId: string; failure: null } | { threadId: null; failure: string });

export function formatPromotedSubagent(name: string, threadId: string) {
  return `${name} is now a sidebar thread (${threadId}); you no longer manage it. Next: it now belongs to the user. If it holds unproposed claims, follow the cross subagents recipe: message this thread id once as a peer to hand over remaining work for scoped Git arc proposals.`;
}

export function formatUnpromotedSubagent(name: string, failure: string) {
  return `${name} was not promoted: ${failure}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The child a completed `subagent_promote` call item (direct, or through `mcp_call`) promoted, if it names that thread. */
export function findPromotedChild(item: ThreadItem | undefined, childThreadId: string) {
  if (item?.type !== "mcpToolCall" || item.status !== "completed") return null;
  const tool = item.tool === "mcp_call" && isRecord(item.arguments) ? item.arguments.tool : item.tool;
  if (tool !== "subagent_promote") return null;
  const text = (item.result?.content ?? []).flatMap(part => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
  return parsePromotedSubagents(text).find((child): child is Extract<PromotedSubagent, { failure: null }> =>
    child.failure === null && child.threadId === childThreadId) ?? null;
}

export function parsePromotedSubagents(output: string): PromotedSubagent[] {
  return output.split("\n").flatMap((line): PromotedSubagent[] => {
    const promoted = /^(.+?) is now a sidebar thread \(([^)]+)\)/u.exec(line);
    if (promoted) return [{ name: promoted[1]!, threadId: promoted[2]!, failure: null }];
    const failed = /^(.+?) was not promoted: (.+)$/u.exec(line);
    return failed ? [{ name: failed[1]!, threadId: null, failure: failed[2]! }] : [];
  });
}
