/*
 * Keywords: codex, context, usage, retained evidence.
 * Exports:
 * - readCodexContextUsage: admit one provider measurement for its requested thread.
 * - recoverCodexContextUsage: select the newest valid retained measurement.
 */
import type { ThreadTokenUsage } from "workbench-shared/codex/generated/app-server/v2/ThreadTokenUsage";
import { z } from "zod";
import { ThreadTokenUsageSchema } from "workbench-shared/workbench/thread/thread-context-usage";
import type { JsonRpcNotification } from "./bridge-types";
import type { CodexTranscriptRawEvent } from "./codex-transcript-types";

export function readCodexContextUsage(threadId: string, notification: JsonRpcNotification): ThreadTokenUsage | null {
  if (notification.method !== "thread/tokenUsage/updated") return null;
  const result = z.object({ threadId: z.literal(threadId), tokenUsage: ThreadTokenUsageSchema }).safeParse(notification.params);
  if (!result.success) throw new Error("Codex context measurement is malformed or belongs to another thread.");
  return result.data.tokenUsage;
}

export function recoverCodexContextUsage(
  threadId: string,
  events: readonly CodexTranscriptRawEvent[],
  reportInvalid: () => void,
): ThreadTokenUsage | null {
  for (const event of [...events].reverse().sort((left, right) => right.receivedAt - left.receivedAt)) {
    if (event.method !== "thread/tokenUsage/updated") continue;
    const envelope = z.object({ method: z.literal("thread/tokenUsage/updated"), params: z.record(z.string(), z.json()) }).safeParse(event.payload);
    if (!envelope.success) {
      reportInvalid();
      continue;
    }
    try {
      return readCodexContextUsage(threadId, envelope.data);
    } catch {
      reportInvalid();
    }
  }
  return null;
}
