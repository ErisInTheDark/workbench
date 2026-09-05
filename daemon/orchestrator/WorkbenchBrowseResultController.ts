/*
 * Exports:
 * - WorkbenchBrowseActiveThread: resolved thread-owned metadata used only behind the result boundary. Keywords: browse, result, thread, harness.
 * - WorkbenchBrowseResultCallbacks: bridge-owned thread operations injected into result enrichment. Keywords: browse, result, bridge, callback.
 * - default WorkbenchBrowseResultController: resolve thread metadata, serialize deferred sidecars, and deliver explicit screenshots. Keywords: browse, result, controller, thread, sidecar, context.
 */
import { createHash } from "node:crypto";

import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn } from "workbench-shared/codex/thread-state";
import type { WorkbenchBrowseResultEntry, WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchBrowseResultEvent, WorkbenchBrowseResultSink, WorkbenchBrowseScreenshotDelivery } from "../lib/workbench/browse/browse-result-events";
import type { WorkbenchToolContextRequest, WorkbenchToolContextResponse } from "workbench-shared/workbench/thread/thread-tool-output";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";

const IDLE_TAIL = Promise.resolve();

export interface WorkbenchBrowseActiveThread {
  commandItemId: string | null;
  harness: WorkbenchHarness;
  turnId: string;
}

export interface WorkbenchBrowseResultCallbacks {
  logError: (message: string) => void;
  listHarnesses: () => readonly WorkbenchHarness[];
  readThread: (harness: WorkbenchHarness, threadId: string) => Promise<ThreadReadResponse>;
  recordResult: (entry: WorkbenchBrowseResultEntry) => Promise<void>;
  steerTurn: (harness: WorkbenchHarness, threadId: string, expectedTurnId: string, input: UserInput[]) => Promise<string | null>;
  injectToolContext?: (request: WorkbenchToolContextRequest) => Promise<WorkbenchToolContextResponse>;
}

function isActiveBrowseCommandItem(item: ThreadReadResponse["thread"]["turns"][number]["items"][number]) {
  return (item.type === "commandExecution" && item.status === "inProgress" && item.command.includes("/api/browse"))
    || (item.type === "mcpToolCall" && item.status === "inProgress" && item.server === "wb" && item.tool === "browse_run");
}

function findLatestBrowseCommandItemId(response: ThreadReadResponse) {
  const turn = getCurrentInProgressTurn(response.thread) ?? response.thread.turns.at(-1) ?? null;
  if (!turn) return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (isActiveBrowseCommandItem(item)) return item.id;
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

  async deliverScreenshot(threadId: string, imageUrl: string): Promise<WorkbenchBrowseScreenshotDelivery> {
    const activeThread = await this.readActiveThread(threadId, true);
    if (!activeThread) throw new Error("Unable to deliver screenshot because the target thread has no active turn.");
    if (activeThread.harness === "codex") {
      if (!this.callbacks.injectToolContext) throw new Error("Codex screenshot context delivery is not configured.");
      const accepted = await this.callbacks.injectToolContext({
        threadId, expectedTurnId: activeThread.turnId,
        toolOutput: { name: "screenshot", namespace: "workbench", output: [
          { type: "input_text", text: createAgentScreenshotSteerText() },
          { type: "input_image", image_url: imageUrl },
        ] },
      });
      return { kind: "injected", acceptedAt: accepted.acceptedAt, turnId: accepted.turnId };
    }
    const input = [
      { type: "text" as const, text: createAgentScreenshotSteerText(), text_elements: [] },
      { type: "image" as const, url: imageUrl },
    ];
    return {
      kind: "steered",
      turnId: await this.callbacks.steerTurn(activeThread.harness, threadId, activeThread.turnId, input) ?? activeThread.turnId,
    };
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
    for (const harness of this.callbacks.listHarnesses()) {
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
