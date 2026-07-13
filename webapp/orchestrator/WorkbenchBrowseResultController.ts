/*
 * Exports:
 * - WorkbenchBrowseActiveThread: resolved thread-owned metadata used only behind the result boundary. Keywords: browse, result, thread, harness.
 * - WorkbenchBrowseResultCallbacks: bridge-owned thread operations injected into result enrichment. Keywords: browse, result, bridge, callback.
 * - default WorkbenchBrowseResultController: resolve thread metadata, serialize deferred sidecars, and steer explicit screenshots. Keywords: browse, result, controller, thread, sidecar, steer.
 */
import { createHash } from "node:crypto";

import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn } from "../lib/codex/thread-state";
import type { WorkbenchBrowseResultEntry, WorkbenchHarness } from "../lib/types";
import type { WorkbenchBrowseResultEvent, WorkbenchBrowseResultSink } from "../lib/workbench/browse/browse-result-events";
import { createAgentScreenshotSteerText } from "../lib/workbench/thread/thread-steer-markers";

const VALID_HARNESSES: readonly WorkbenchHarness[] = ["codex", "copilot", "opencode"];
const IDLE_TAIL = Promise.resolve();

export interface WorkbenchBrowseActiveThread {
  commandItemId: string | null;
  harness: WorkbenchHarness;
  turnId: string;
}

export interface WorkbenchBrowseResultCallbacks {
  logError: (message: string) => void;
  readThread: (harness: WorkbenchHarness, threadId: string) => Promise<ThreadReadResponse>;
  recordResult: (entry: WorkbenchBrowseResultEntry) => Promise<void>;
  steerTurn: (harness: WorkbenchHarness, threadId: string, expectedTurnId: string, input: UserInput[]) => Promise<string | null>;
}

function findLatestBrowseCommandItemId(response: ThreadReadResponse) {
  const turn = getCurrentInProgressTurn(response.thread) ?? response.thread.turns.at(-1) ?? null;
  if (!turn) return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === "commandExecution" && item.status === "inProgress" && item.command.includes("/api/browse")) return item.id;
  }
  return null;
}

export default class WorkbenchBrowseResultController implements WorkbenchBrowseResultSink {
  private readonly callbacks: WorkbenchBrowseResultCallbacks;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(callbacks: WorkbenchBrowseResultCallbacks) {
    this.callbacks = callbacks;
  }

  record(event: WorkbenchBrowseResultEvent) {
    const previous = this.tails.get(event.threadId) ?? IDLE_TAIL;
    const current = previous.catch(() => undefined).then(async () => {
      const activeThread = await this.readActiveThread(event.threadId, false);
      if (!activeThread) return;
      await this.callbacks.recordResult(this.createEntry(event, activeThread));
    }).catch((error) => {
      this.callbacks.logError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (this.tails.get(event.threadId) === current) this.tails.delete(event.threadId);
    });
    this.tails.set(event.threadId, current);
  }

  async steerScreenshot(threadId: string, imageUrl: string) {
    const activeThread = await this.readActiveThread(threadId, true);
    if (!activeThread) throw new Error("Unable to steer screenshot because the target thread has no active turn.");
    const input = [
      { type: "text" as const, text: createAgentScreenshotSteerText(), text_elements: [] },
      { type: "image" as const, url: imageUrl },
    ];
    return await this.callbacks.steerTurn(activeThread.harness, threadId, activeThread.turnId, input) ?? activeThread.turnId;
  }

  async waitForIdle() {
    await Promise.allSettled([...this.tails.values()]);
  }

  private createEntry(event: WorkbenchBrowseResultEvent, activeThread: WorkbenchBrowseActiveThread): WorkbenchBrowseResultEntry {
    return {
      ...event,
      commandItemId: activeThread.commandItemId,
      entryKey: createHash("sha256")
        .update([event.threadId, activeThread.turnId, activeThread.commandItemId ?? "", event.session ?? "", event.action, String(event.actionIndex)].join("\0"))
        .digest("hex"),
      recordedAt: Date.now(),
      turnId: activeThread.turnId,
    };
  }

  private async readActiveThread(threadId: string, requireInProgress: boolean): Promise<WorkbenchBrowseActiveThread | null> {
    let lastError: Error | null = null;
    let readSucceeded = false;
    for (const harness of VALID_HARNESSES) {
      try {
        const response = await this.callbacks.readThread(harness, threadId);
        readSucceeded = true;
        const turn = getCurrentInProgressTurn(response.thread) ?? (requireInProgress ? null : response.thread.turns.at(-1) ?? null);
        if (turn) return { commandItemId: findLatestBrowseCommandItemId(response), harness, turnId: turn.id };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!readSucceeded && lastError) throw lastError;
    return null;
  }
}
