/*
 * Exports:
 * - WorkbenchBrowseActiveThread: resolved harness, turn, and command item for Browse transcript metadata. Keywords: browse, transcript, thread, harness.
 * - WorkbenchBrowseTranscriptCallbacks: bridge-owned operations injected into Browse without loopback websocket calls. Keywords: browse, bridge, adapter, callback.
 * - default WorkbenchBrowseTranscriptAdapter: resolve active threads, steer screenshots, and record Browse results through direct bridge callbacks. Keywords: browse, transcript, bridge, steering.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn } from "../lib/codex/thread-state";
import type { WorkbenchBrowseResultEntry, WorkbenchHarness } from "../lib/types";

const VALID_HARNESSES: readonly WorkbenchHarness[] = ["codex", "copilot", "opencode"];

export interface WorkbenchBrowseActiveThread {
  commandItemId: string | null;
  harness: WorkbenchHarness;
  turnId: string;
}

export interface WorkbenchBrowseTranscriptCallbacks {
  readThread: (harness: WorkbenchHarness, threadId: string) => Promise<ThreadReadResponse>;
  recordResult: (entry: WorkbenchBrowseResultEntry) => Promise<void>;
  steerTurn: (harness: WorkbenchHarness, threadId: string, expectedTurnId: string, input: UserInput[]) => Promise<string | null>;
}

function findLatestBrowseCommandItemId(response: ThreadReadResponse) {
  const turn = getCurrentInProgressTurn(response.thread) ?? response.thread.turns.at(-1) ?? null;
  if (!turn) {
    return null;
  }
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === "commandExecution" && item.status === "inProgress" && item.command.includes("/api/browse")) {
      return item.id;
    }
  }
  return null;
}

export default class WorkbenchBrowseTranscriptAdapter {
  private readonly callbacks: WorkbenchBrowseTranscriptCallbacks;

  constructor(callbacks: WorkbenchBrowseTranscriptCallbacks) {
    this.callbacks = callbacks;
  }

  async readActiveThread(threadId: string, requireInProgress: boolean): Promise<WorkbenchBrowseActiveThread | null> {
    let lastError: Error | null = null;
    for (const harness of VALID_HARNESSES) {
      try {
        const response = await this.callbacks.readThread(harness, threadId);
        const turn = getCurrentInProgressTurn(response.thread) ?? (requireInProgress ? null : response.thread.turns.at(-1) ?? null);
        if (turn) {
          return { commandItemId: findLatestBrowseCommandItemId(response), harness, turnId: turn.id };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (requireInProgress && lastError) {
      throw lastError;
    }
    return null;
  }

  async recordResult(entry: WorkbenchBrowseResultEntry) {
    await this.callbacks.recordResult(entry);
  }

  async steerScreenshot(harness: WorkbenchHarness, threadId: string, turnId: string, input: UserInput[]) {
    return await this.callbacks.steerTurn(harness, threadId, turnId, input) ?? turnId;
  }
}
