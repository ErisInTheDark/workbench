/*
 * Exports:
 * - WorkbenchBrowseActiveThread: resolved thread-owned metadata used only behind the result boundary.
 * - WorkbenchBrowseResultCallbacks: bridge-owned thread operations injected into result enrichment.
 * - default WorkbenchBrowseResultController: resolve thread metadata, serialize deferred sidecars, and deliver explicit screenshots.
 */
import { createHash } from "node:crypto";

import type { WorkbenchThreadContextReadResponse } from "workbench-shared/types";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getCurrentInProgressTurn } from "workbench-shared/workbench/thread/thread-runtime-state";
import type { WorkbenchBrowseResultEntry, WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchBrowseResultEvent, WorkbenchBrowseResultSink, WorkbenchBrowseScreenshotDelivery } from "./lib/workbench/browse/browse-result-events";
import type { WorkbenchToolContextRequest, WorkbenchToolContextResponse } from "workbench-shared/workbench/thread/thread-tool-output";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";

const IDLE_TAIL = Promise.resolve();
type ThreadReadResponse = Pick<WorkbenchThreadContextReadResponse, "thread">;

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
  private generation = new AbortController();
  private readonly writes = new Set<Promise<void>>();

  constructor(callbacks: WorkbenchBrowseResultCallbacks) {
    this.callbacks = callbacks;
  }

  record(event: WorkbenchBrowseResultEvent) {
    const signal = this.generation.signal;
    if (signal.aborted) return;
    const previous = this.tails.get(event.threadId) ?? IDLE_TAIL;
    const current = previous.catch(() => undefined).then(async () => {
      signal.throwIfAborted();
      const activeThread = await this.readActiveThread(event.threadId, false, signal);
      signal.throwIfAborted();
      if (!activeThread) return;
      const write = this.callbacks.recordResult(this.createEntry(event, activeThread));
      this.writes.add(write);
      try { await write; }
      finally { this.writes.delete(write); }
    }).catch((error) => {
      if (error !== signal.reason) this.callbacks.logError((error instanceof Error ? error.message : String(error)).slice(0, 500));
    }).finally(() => {
      if (this.tails.get(event.threadId) === current) this.tails.delete(event.threadId);
    });
    this.tails.set(event.threadId, current);
  }

  async deliverScreenshot(threadId: string, imageUrl: string): Promise<WorkbenchBrowseScreenshotDelivery> {
    const signal = this.generation.signal;
    signal.throwIfAborted();
    const activeThread = await this.readActiveThread(threadId, true, signal);
    signal.throwIfAborted();
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
    await Promise.allSettled([...this.writes]);
  }

  expire() {
    this.generation.abort(new Error("Browse result generation retired."));
    this.tails.clear();
  }

  resume() {
    if (this.generation.signal.aborted) this.generation = new AbortController();
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

  private async readActiveThread(threadId: string, requireInProgress: boolean, signal: AbortSignal): Promise<WorkbenchBrowseActiveThread | null> {
    let lastError: Error | null = null;
    let readSucceeded = false;
    for (const harness of this.callbacks.listHarnesses()) {
      try {
        signal.throwIfAborted();
        const response = await this.callbacks.readThread(harness, threadId);
        signal.throwIfAborted();
        readSucceeded = true;
        const turn = getCurrentInProgressTurn(response.thread) ?? (requireInProgress ? null : response.thread.turns.at(-1) ?? null);
        if (turn) return { commandItemId: findLatestBrowseCommandItemId(response), harness, turnId: turn.id };
      } catch (error) {
        signal.throwIfAborted();
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!readSucceeded && lastError) throw lastError;
    return null;
  }
}
