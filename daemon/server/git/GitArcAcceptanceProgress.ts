/*
 * Exports:
 * - default GitArcAcceptanceProgress: running batched acceptances by owner key, advanced as each proposal is passed and
 *   published newest-first without ever blocking the landing that advanced it.
 * - GitArcAcceptance: one running acceptance's landing and queued proposals.
 */
import type { WorkbenchGitArcLifecycleState } from "workbench-shared/workbench/thread/thread-state";

export type GitArcAcceptance = NonNullable<WorkbenchGitArcLifecycleState["acceptance"]>;

interface RunningAcceptance {
  acceptance: GitArcAcceptance;
  publication: Promise<void> | null;
  /** Must never reject; failures are the publisher's to report. */
  publish: (acceptance: GitArcAcceptance) => Promise<void>;
  /** The acceptance advanced after the in-flight publication read it. */
  stale: boolean;
}

function copy({ landingId, queuedIds }: GitArcAcceptance): GitArcAcceptance {
  return { landingId, queuedIds: [...queuedIds] };
}

export default class GitArcAcceptanceProgress {
  private readonly running = new Map<string, RunningAcceptance>();

  /** The acceptance after passing `proposalId`; passing the landing proposal lands the next queued one. */
  static advance({ landingId, queuedIds }: GitArcAcceptance, proposalId: string): GitArcAcceptance {
    const queued = queuedIds.filter(id => id !== proposalId);
    if (landingId !== proposalId) return { landingId, queuedIds: queued };
    const [next = null, ...rest] = queued;
    return { landingId: next, queuedIds: rest };
  }

  /** Starts an acceptance landing `proposalIds` in order; one per owner at a time. */
  start(key: string, proposalIds: readonly string[], publish: RunningAcceptance["publish"]) {
    if (this.running.has(key)) throw new Error("This thread is already committing proposals.");
    const [landingId = null, ...queuedIds] = proposalIds;
    this.running.set(key, { acceptance: { landingId, queuedIds }, publication: null, publish, stale: false });
  }

  read(key: string): GitArcAcceptance | null {
    const running = this.running.get(key);
    return running ? copy(running.acceptance) : null;
  }

  /**
   * Passes `proposalId` and publishes the result once any publication in flight settles, folding bursts into the newest
   * fact. Landings call this while holding repository gates, so it never waits for the publication.
   */
  advance(key: string, proposalId: string) {
    const running = this.running.get(key);
    if (!running) return;
    running.acceptance = GitArcAcceptanceProgress.advance(running.acceptance, proposalId);
    if (running.publication) {
      running.stale = true;
      return;
    }
    running.publication = this.publishLatest(running);
  }

  /** Waits for pending publications, so none lands after the settled lifecycle, then forgets the acceptance. */
  async finish(key: string) {
    try {
      await this.running.get(key)?.publication;
    } finally {
      this.running.delete(key);
    }
  }

  private async publishLatest(running: RunningAcceptance) {
    try {
      do {
        running.stale = false;
        await running.publish(copy(running.acceptance));
      } while (running.stale);
    } finally {
      running.publication = null;
    }
  }
}
