/*
 * Exports:
 * - WorkbenchTranscriptCaptureGapEntry: one durable recording failure.
 * - WorkbenchTranscriptCaptureGapControllerOptions: database, identity and clock ports.
 * - default WorkbenchTranscriptCaptureGapController: persist failures and select provider reconciliation.
 */
import { randomUUID } from "node:crypto";
import { selectRows } from "workbench-shared/database/workbench-database-statements";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import type { WorkbenchTranscriptCaptureGapObservation } from "./workbench-transcript-types.ts";

export interface WorkbenchTranscriptCaptureGapEntry {
  errorText: string;
  id: string;
  openedAt: number;
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId | null;
}

export interface WorkbenchTranscriptCaptureGapControllerOptions {
  database: Pick<WorkbenchDatabaseController, "query" | "settleTranscript">;
  now?: () => number;
  randomId?: () => string;
  resolveReference?: (
    reference: { threadId: string; turnId: string | null },
  ) => Promise<{ threadId: string; turnId: string | null }>;
}

export default class WorkbenchTranscriptCaptureGapController {
  constructor(private readonly options: WorkbenchTranscriptCaptureGapControllerOptions) {}

  get pendingRecoveryThreadIds(): Promise<WorkbenchThreadId[]> {
    return this.#pendingRecoveryThreadIds();
  }

  async #pendingRecoveryThreadIds() {
    const [pending, failed] = await Promise.all([
      this.options.database.query(selectRows(evidenceTables.transcriptCaptureGaps, { where: { state: "open" } })),
      this.options.database.query(selectRows(evidenceTables.transcriptCaptureGaps, { where: { state: "unrecoverable" } })),
    ]);
    const unrecoverable = new Set(failed.map(row => row.thread_id));
    return [...new Set(pending.filter(row => !unrecoverable.has(row.thread_id))
      .map(row => WorkbenchThreadIdSchema.parse(row.thread_id)))].sort();
  }

  async captureFailure(input: {
    error: unknown;
    recoverability: "provider" | "unrecoverable";
    threadId: string;
    turnId: string | null;
  }): Promise<Error> {
    try {
      const reference = await this.options.resolveReference?.(input) ?? input;
      const now = (this.options.now ?? Date.now)();
      await this.options.database.settleTranscript([{
        kind: "captureGap",
        gapId: (this.options.randomId ?? randomUUID)(),
        threadId: WorkbenchThreadIdSchema.parse(reference.threadId),
        turnId: reference.turnId === null ? null : WorkbenchTurnIdSchema.parse(reference.turnId),
        ...(input.recoverability === "provider"
          ? { state: "open" as const, closedAt: null }
          : { state: "unrecoverable" as const, closedAt: now }),
        openedAt: now,
        reason: "sqlite transcript settlement failed",
        errorText: (input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 500),
      }]);
      return new Error(`SQLite transcript settlement failed for thread ${input.threadId}.`, { cause: input.error });
    } catch (captureError) {
      return new AggregateError([input.error, captureError], "SQLite transcript settlement and capture-gap recording failed.");
    }
  }

  async requireRecovery(threadId: WorkbenchThreadId): Promise<WorkbenchTranscriptCaptureGapEntry[]> {
    const rows = await this.options.database.query(selectRows(evidenceTables.transcriptCaptureGaps, {
      where: { thread_id: threadId },
    }));
    if (rows.some(row => row.state === "unrecoverable")) {
      throw new Error(`SQLite transcript capture gap for thread ${threadId} is not provider-recoverable.`);
    }
    const pending = rows.filter(row => row.state === "open");
    if (!pending.length) throw new Error(`SQLite transcript capture recovery has no entry for thread ${threadId}.`);
    return pending.map(row => ({
      id: row.id, threadId, turnId: row.turn_id === null ? null : WorkbenchTurnIdSchema.parse(row.turn_id),
      openedAt: row.opened_at, errorText: row.error_text ?? "",
    }));
  }

  createRecoveryObservation(entry: WorkbenchTranscriptCaptureGapEntry, turnId: WorkbenchTurnId | null): WorkbenchTranscriptCaptureGapObservation {
    return {
      kind: "captureGap", gapId: entry.id, threadId: entry.threadId, turnId,
      openedAt: entry.openedAt, closedAt: (this.options.now ?? Date.now)(),
      errorText: entry.errorText, reason: "sqlite transcript settlement failed", state: "reconciled",
    };
  }
}
