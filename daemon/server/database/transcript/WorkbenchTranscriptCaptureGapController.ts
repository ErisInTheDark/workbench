/*
 * Exports:
 * - WorkbenchTranscriptCaptureGapEntry: one open recording failure and its unreconciled anchor turns.
 * - WorkbenchTranscriptCaptureGapControllerOptions: database, identity and clock ports.
 * - default WorkbenchTranscriptCaptureGapController: persist turn-anchored failures and select provider reconciliation.
 */
import { randomUUID } from "node:crypto";
import { selectRows } from "workbench-shared/database/workbench-database-statements";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import { describeErrorCauseChain } from "workbench-shared/process/error-cause-chain";
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import type { WorkbenchTranscriptCaptureGapObservation } from "./workbench-transcript-types.ts";

const CAPTURE_GAP_REASON = "sqlite transcript settlement failed";
const ERROR_TEXT_LIMIT = 500;

export interface WorkbenchTranscriptCaptureGapEntry {
  errorText: string;
  id: string;
  openedAt: number;
  threadId: WorkbenchThreadId;
  /** Anchors no provider window has re-read yet. */
  turnIds: WorkbenchTurnId[];
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
    const pending = await this.options.database.query(selectRows(evidenceTables.transcriptCaptureGaps, { where: { state: "open" } }));
    return [...new Set(pending
      .map(row => WorkbenchThreadIdSchema.parse(row.thread_id)))].sort();
  }

  /** Record a failed capture against the turns it named; the repository anchors the latest turn when none are stored. */
  async captureFailure(input: {
    error: unknown;
    recoverability: "provider" | "unrecoverable";
    threadId: string;
    turnIds: readonly string[];
  }): Promise<Error> {
    try {
      const { threadId, turnIds } = await this.#resolve(input.threadId, input.turnIds);
      const now = (this.options.now ?? Date.now)();
      await this.options.database.settleTranscript([{
        kind: "captureGap",
        gapId: (this.options.randomId ?? randomUUID)(),
        threadId,
        turnIds,
        ...(input.recoverability === "provider"
          ? { state: "open" as const, closedAt: null }
          : { state: "unrecoverable" as const, closedAt: now }),
        openedAt: now,
        reason: CAPTURE_GAP_REASON,
        errorText: describeErrorCauseChain(input.error, ERROR_TEXT_LIMIT) || "Unknown capture failure.",
      }]);
      return new Error(`SQLite transcript settlement failed for thread ${input.threadId}.`, { cause: input.error });
    } catch (captureError) {
      return new AggregateError([input.error, captureError], "SQLite transcript settlement and capture-gap recording failed.");
    }
  }

  async #resolve(threadId: string, turnIds: readonly string[]) {
    const resolve = this.options.resolveReference;
    if (!resolve) {
      return { threadId: WorkbenchThreadIdSchema.parse(threadId), turnIds: turnIds.map(id => WorkbenchTurnIdSchema.parse(id)) };
    }
    const thread = await resolve({ threadId, turnId: null });
    const turns = await Promise.all(turnIds.map(turnId => resolve({ threadId, turnId })));
    return {
      threadId: WorkbenchThreadIdSchema.parse(thread.threadId),
      turnIds: turns.flatMap(turn => turn.turnId === null ? [] : [WorkbenchTurnIdSchema.parse(turn.turnId)]),
    };
  }

  async readRecovery(threadId: WorkbenchThreadId): Promise<WorkbenchTranscriptCaptureGapEntry[]> {
    const pending = await this.options.database.query(selectRows(evidenceTables.transcriptCaptureGaps, {
      where: { thread_id: threadId, state: "open" },
    }));
    if (!pending.length) return [];
    const anchors = await this.options.database.query(selectRows(evidenceTables.transcriptCaptureGapTurns, {
      whereIn: { gap_id: pending.map(row => row.id) },
    }));
    return pending.map(row => ({
      id: row.id, threadId, openedAt: row.opened_at, errorText: row.error_text ?? "",
      turnIds: anchors.flatMap(anchor => anchor.gap_id === row.id && anchor.reconciled_at === null
        ? [WorkbenchTurnIdSchema.parse(anchor.turn_id)] : []),
    }));
  }

  /** `turnIds` are every turn the provider window re-read, so anchors added during that same settlement reconcile too. */
  createRecoveryObservation(entry: WorkbenchTranscriptCaptureGapEntry, turnIds: readonly WorkbenchTurnId[]): WorkbenchTranscriptCaptureGapObservation {
    return {
      kind: "captureGap", gapId: entry.id, threadId: entry.threadId, turnIds,
      openedAt: entry.openedAt, closedAt: (this.options.now ?? Date.now)(),
      errorText: entry.errorText, reason: CAPTURE_GAP_REASON, state: "reconciled",
    };
  }
}
