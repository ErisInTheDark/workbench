/*
 * Exports:
 * - ClaudeUsageThread: the Workbench turns and native session one hydration reads.
 * - ClaudeUsageHydratorOptions: session log, thread reader, usage recorder, and clock.
 * - default ClaudeUsageHydrator: derive every Claude turn's billing usage from Claude's session log, one read per thread at a time.
 */
import type { WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import { ClaudeSessionCallReader, claudeTurnUsage, type ClaudeTurnUsage } from "./claude-session-usage";
import type ClaudeSessionLog from "./claude-session-log";

export interface ClaudeUsageThread {
  threadId: WorkbenchThreadId;
  sessionId: string;
  turns: readonly { id: WorkbenchTurnId; startedAt: number | null }[];
}

export interface ClaudeUsageHydratorOptions {
  log: Pick<ClaudeSessionLog, "locate" | "lines">;
  readThread(threadId: string): Promise<ClaudeUsageThread>;
  record(threadId: WorkbenchThreadId, usage: ClaudeTurnUsage, observedAt: number): Promise<void>;
  signal: AbortSignal;
  now?: () => number;
  warn?: (message: string) => void;
}

type HydrationState = "completed" | "unavailable";

export default class ClaudeUsageHydrator {
  private readonly runs = new Map<string, { dirty: boolean; done: Promise<HydrationState> }>();

  constructor(private readonly options: ClaudeUsageHydratorOptions) {}

  /**
   * Re-derive the thread's usage from its session log. A request during a running read marks it dirty, and
   * the running read repeats once more, so a burst of triggers costs at most one follow-up read.
   */
  hydrate(threadId: string): Promise<HydrationState> {
    const current = this.runs.get(threadId);
    if (current) {
      current.dirty = true;
      return current.done;
    }
    const run = { dirty: false, done: null as unknown as Promise<HydrationState> };
    run.done = (async () => {
      try {
        let state: HydrationState;
        do {
          run.dirty = false;
          state = await this.read(threadId);
        } while (run.dirty && !this.options.signal.aborted);
        return state;
      } finally {
        this.runs.delete(threadId);
      }
    })();
    this.runs.set(threadId, run);
    return run.done;
  }

  hasPendingWork() { return this.runs.size > 0; }

  async settle() {
    await Promise.allSettled([...this.runs.values()].map(run => run.done));
  }

  private async read(threadId: string): Promise<HydrationState> {
    this.options.signal.throwIfAborted();
    const thread = await this.options.readThread(threadId);
    const file = await this.options.log.locate(thread.sessionId);
    if (!file) return "unavailable";
    const reader = new ClaudeSessionCallReader();
    for await (const line of this.options.log.lines(file)) reader.push(line);
    if (reader.malformed) {
      this.options.warn?.(`[claude] session usage skipped ${reader.malformed} malformed call line(s) in ${thread.sessionId}`);
    }
    const observedAt = (this.options.now ?? Date.now)();
    for (const usage of claudeTurnUsage(reader.read(), thread.turns)) {
      this.options.signal.throwIfAborted();
      await this.options.record(thread.threadId, usage, observedAt);
    }
    return "completed";
  }
}
