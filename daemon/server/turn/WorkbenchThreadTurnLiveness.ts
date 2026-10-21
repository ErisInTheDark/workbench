/*
 * Exports:
 * - default WorkbenchThreadTurnLiveness: own whether each thread's latest provider turn is live (asking the provider only about in-progress turns), publishing changes as a thread runtime fact.
 */
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";

type LivenessThreads = Pick<WorkbenchProviderThreads, "latestTurn" | "isTurnLive">;

export default class WorkbenchThreadTurnLiveness {
  /** Threads (with their harness) whose last known liveness was true; only these can end, so only these are rechecked on commit. */
  private readonly live = new Map<string, string>();

  constructor(private readonly ports: {
    threads(harness: string): LivenessThreads;
    resolveHarness(threadId: string): Promise<string | null>;
    publish(threadId: string, turnLive: boolean): void;
    warn(message: string): void;
  }) {}

  async read(threadId: string, harness: string) {
    return await this.observe(threadId, harness, await this.ports.threads(harness).latestTurn(threadId));
  }

  /** Liveness of an already known latest turn; only a turn still in progress can be live, so only it asks the provider. */
  async observe(threadId: string, harness: string, turn: Pick<Turn, "id" | "status"> | null) {
    const turnLive = turn?.status === "inProgress" ? await this.ports.threads(harness).isTurnLive(threadId, turn.id) : false;
    if (turnLive) this.live.set(threadId, harness);
    else this.live.delete(threadId);
    return turnLive;
  }

  /** A running turn was committed for this thread; true when that newly made the thread live. */
  async turnStarted(threadId: string) {
    if (this.live.has(threadId)) return false;
    const harness = await this.ports.resolveHarness(threadId);
    if (!harness || this.live.has(threadId)) return false;
    this.live.set(threadId, harness);
    this.ports.publish(threadId, true);
    return true;
  }

  /** Transcript commits changed these threads; a turn that ended always commits, so live threads are rechecked here. */
  async settled(threadIds: readonly string[]) {
    await Promise.all(threadIds.map(async threadId => {
      const harness = this.live.get(threadId);
      if (!harness) return;
      try {
        if (!await this.read(threadId, harness)) this.ports.publish(threadId, false);
      } catch (error) {
        this.ports.warn(`Turn liveness check failed for ${threadId.slice(0, 120)}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      }
    }));
  }
}
