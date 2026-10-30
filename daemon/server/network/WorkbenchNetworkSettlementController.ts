/*
 * Exports:
 * - default WorkbenchNetworkSettlementController: end a settled thread's network access on both sides: drop this daemon's grants
 *   naming it, and ask each daemon it still reaches to drop the grants it holds there.
 */
import type { DaemonId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { NetworkHistoryEntry } from "workbench-shared/workbench/network/network-grants";

export interface NetworkSettlementPorts {
  revokeTargeting(threadId: WorkbenchThreadId): Promise<number>;
  history: {
    read(threadId: WorkbenchThreadId): Promise<NetworkHistoryEntry[]>;
    revoke(threadId: WorkbenchThreadId, entryId: string): Promise<unknown>;
  };
  /** Asks `daemonId` to drop every grant `caller` holds there; rejects when that daemon cannot be reached. */
  release(caller: { threadId: WorkbenchThreadId; title: string }, daemonId: DaemonId): Promise<void>;
  warn(message: string): void;
}

export default class WorkbenchNetworkSettlementController {
  readonly #running = new Set<WorkbenchThreadId>();

  constructor(private readonly ports: NetworkSettlementPorts) {}

  /**
   * Safe to call on every change of a settled thread: entries stay active until their daemon confirms the release, so a daemon
   * unreachable now is retried on the thread's next change.
   */
  async settled(thread: { threadId: WorkbenchThreadId; title: string }) {
    const { threadId } = thread;
    if (this.#running.has(threadId)) return;
    this.#running.add(threadId);
    try {
      await this.ports.revokeTargeting(threadId);
      const byDaemon = new Map<DaemonId, NetworkHistoryEntry[]>();
      for (const entry of await this.ports.history.read(threadId)) {
        if (entry.revokedAt !== null) continue;
        byDaemon.set(entry.target.daemonId, [...byDaemon.get(entry.target.daemonId) ?? [], entry]);
      }
      await Promise.all([...byDaemon].map(async ([daemonId, entries]) => {
        try {
          await this.ports.release(thread, daemonId);
        } catch (error) {
          this.ports.warn(`Settled thread ${threadId} kept its grants on ${entries[0]!.target.hostname}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        for (const entry of entries) await this.ports.history.revoke(threadId, entry.id);
      }));
    } catch (error) {
      this.ports.warn(`Settled thread ${threadId} network release failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#running.delete(threadId);
    }
  }
}
