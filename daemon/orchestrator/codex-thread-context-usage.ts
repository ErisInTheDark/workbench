/*
 * Exports:
 * - readCodexContextUsage: admit one provider measurement for its requested thread.
 */
import type { ThreadTokenUsage } from "workbench-shared/codex/generated/app-server/v2/ThreadTokenUsage";
import { z } from "zod";
import { ThreadTokenUsageSchema } from "workbench-shared/workbench/thread/thread-context-usage";
import type { JsonRpcNotification } from "./bridge-types";

export function readCodexContextUsage(threadId: string, notification: JsonRpcNotification): ThreadTokenUsage | null {
  if (notification.method !== "thread/tokenUsage/updated") return null;
  const result = z.object({ threadId: z.literal(threadId), tokenUsage: ThreadTokenUsageSchema }).safeParse(notification.params);
  if (!result.success) throw new Error("Codex context measurement is malformed or belongs to another thread.");
  return result.data.tokenUsage;
}
