/*
 * Exports:
 * - OpenCodeThreadWindow: one complete native turn and its private continuation.
 * - default OpenCodeThreadWindowLoader: seek serial native pages without retaining an archive.
 */
import type { SessionMessageInfo } from "@opencode/client";
import { z } from "zod";
import type { WorkbenchThreadReconciliationTarget } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import { isOpenCodeTurnRoot } from "./OpenCodeTranscriptAdapter";

const continuation = z.object({
  cursor: z.string().nullable(),
  beforeId: z.string().nullable(),
});

export interface OpenCodeThreadWindow {
  messages: SessionMessageInfo[];
  previousCursor: string | null;
}

export default class OpenCodeThreadWindowLoader {
  constructor(private readonly client: Pick<WorkbenchOpenCodeClient, "message">) {}

  async load(
    sessionID: string,
    target: WorkbenchThreadReconciliationTarget,
    storedCursor: string | null | undefined,
    signal: AbortSignal,
  ): Promise<OpenCodeThreadWindow> {
    signal.throwIfAborted();
    if (target.mode === "previous" && storedCursor === null) return { messages: [], previousCursor: null };
    const resume = target.mode === "previous" && storedCursor !== undefined
      ? continuation.parse(JSON.parse(storedCursor!)) : null;
    let cursor = resume?.cursor ?? null;
    const beforeId = resume?.beforeId ?? (target.mode === "previous" && !resume ? target.beforeTurnId : null);
    let seekingBoundary = beforeId !== null;
    const visited = new Set<string>();
    let descending: SessionMessageInfo[] = [];
    do {
      signal.throwIfAborted();
      if (cursor !== null) {
        if (visited.has(cursor)) throw new Error("OpenCode message pagination repeated a cursor.");
        visited.add(cursor);
      }
      const page = await this.client.message.list(
        { sessionID, limit: 100, ...(cursor === null ? { order: "desc" as const } : { cursor }) },
        { signal },
      );
      signal.throwIfAborted();
      for (let index = 0; index < page.data.length; index++) {
        const message = page.data[index]!;
        if (seekingBoundary) {
          if (message.id === beforeId) seekingBoundary = false;
          continue;
        }
        descending.push(message);
        if (!isOpenCodeTurnRoot(message)) continue;
        if (target.mode === "exact" && message.id !== target.turnId) {
          descending = [];
          continue;
        }
        const next = index + 1 < page.data.length
          ? JSON.stringify({ cursor, beforeId: message.id })
          : page.cursor.next ? JSON.stringify({ cursor: page.cursor.next, beforeId: null }) : null;
        return { messages: descending.reverse(), previousCursor: next };
      }
      cursor = page.data.length ? page.cursor.next ?? null : null;
    } while (cursor !== null);
    if (seekingBoundary || target.mode === "exact") throw new Error("OpenCode did not return the requested turn boundary.");
    return { messages: descending.reverse(), previousCursor: null };
  }
}
