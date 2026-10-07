/*
 * Exports:
 * - default WorkbenchThreadCompactionController: own canonical compaction admission, execution and failure settlement.
 */
import { randomUUID } from "node:crypto";
import type WorkbenchProvider from "./WorkbenchProvider";
import type WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import type { DaemonTranscriptRegistration } from "./daemon-runtime-objects";
import {
  WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";

type CompactionProvider = {
  threads: Pick<WorkbenchProvider["threads"], "compact" | "latestTurn">;
};

export default class WorkbenchThreadCompactionController {
  private readonly active = new Set<string>();

  constructor(
    private readonly admission: Pick<WorkbenchThreadAdmissionController, "run">,
    private readonly ports: {
      record: DaemonTranscriptRegistration["record"];
      setCompacting?(threadId: string, compacting: boolean): void;
      now(): number;
      itemId?(): string;
    },
  ) {}

  hasPendingWork() { return this.active.size > 0; }

  compact(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    return this.exclusive(threadId, () => this.admission.run(
      threadId,
      () => this.execute(threadId, provider, signal),
    ));
  }

  compactInsideAdmission(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    return this.exclusive(threadId, () => this.execute(threadId, provider, signal));
  }

  private async exclusive(threadId: string, operation: () => Promise<void>) {
    if (this.active.has(threadId)) throw new Error("This thread is already compacting.");
    this.active.add(threadId);
    try {
      await operation();
    } finally {
      this.active.delete(threadId);
    }
  }

  private async execute(threadId: string, provider: CompactionProvider, signal?: AbortSignal) {
    this.ports.setCompacting?.(threadId, true);
    try {
      signal?.throwIfAborted();
      const turn = await provider.threads.latestTurn(threadId);
      signal?.throwIfAborted();
      if (!turn) throw new Error("Compaction requires an existing turn.");
      const scope = {
        itemId: WorkbenchItemIdSchema.parse(this.ports.itemId?.() ?? randomUUID()),
        turnId: WorkbenchTurnIdSchema.parse(turn.id),
      };
      const canonicalThreadId = WorkbenchThreadIdSchema.parse(threadId);
      await this.ports.record([{
        kind: "contextCompaction",
        itemId: scope.itemId,
        threadId: canonicalThreadId,
        turnId: scope.turnId,
        phase: "started",
        observedAt: this.ports.now(),
        reference: null,
      }], { source: "workbench" });
      try {
        await provider.threads.compact(threadId, { scope, signal });
      } catch (error) {
        await this.ports.record([{
          kind: "contextCompaction",
          itemId: scope.itemId,
          threadId: canonicalThreadId,
          turnId: scope.turnId,
          phase: "failed",
          observedAt: this.ports.now(),
          reference: null,
        }], { source: "workbench" });
        throw error;
      }
    } finally {
      this.ports.setCompacting?.(threadId, false);
    }
  }
}
