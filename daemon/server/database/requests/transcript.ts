/*
 * Exports:
 * - transcriptRequests: database requests that settle and read canonical transcripts, their assets, context usage, undelivered user
 *   steers, history queries and approval outcomes.
 */
import type { WorkbenchTranscriptItemCursor } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { WorkbenchApprovalOutcomeEntry } from "workbench-shared/workbench/provider/provider-approval";
import { TranscriptQueryError, type TranscriptQuery, type TranscriptQueryPage } from "../transcript/transcript-query-contract.ts";
import WorkbenchApprovalOutcomeRepository from "../transcript/WorkbenchApprovalOutcomeRepository.ts";
import WorkbenchTranscriptAssetStore, { type TranscriptAssetRead, type TranscriptAssetWrite } from "../transcript/WorkbenchTranscriptAssetStore.ts";
import WorkbenchTranscriptQueryRepository from "../transcript/WorkbenchTranscriptQueryRepository.ts";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSettlement,
  WorkbenchTranscriptSettlementMode,
} from "../transcript/workbench-transcript-types.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

export const transcriptRequests = {
  settleTranscript: defineDatabaseRequest({
    run: ({ transcripts }, observations: readonly WorkbenchTranscriptObservation[], mode: WorkbenchTranscriptSettlementMode = "live"): WorkbenchTranscriptSettlement => (
      transcripts.settle(observations, mode)
    ),
    local: observations => observations.length ? undefined : { value: { changedThreadIds: [], compactionCompletions: [] } },
    describe: (observations, mode = "live") => {
      const kinds = new Map<string, number>();
      const threads = new Set<string>();
      let nested = 0;
      for (const observation of observations) {
        kinds.set(observation.kind, (kinds.get(observation.kind) ?? 0) + 1);
        if ("threadId" in observation && typeof observation.threadId === "string") threads.add(observation.threadId);
        if ("observations" in observation) nested += observation.observations.length;
        if ("catalog" in observation) nested += observation.catalog.length;
      }
      // A lone thread is named, since settlement cost follows that thread's size more than the batch's.
      const scope = threads.size === 1 ? `thread ${[...threads][0]!.slice(0, 8)}` : `${threads.size} threads`;
      return `${mode} ${[...kinds].map(([kind, count]) => `${kind}x${count}`).join(", ")}; ${scope}, ${nested} nested`;
    },
  }),
  readTranscript: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, request: WorkbenchTranscriptReadRequest) => transcripts.read(request),
  }),
  readTranscriptItemRange: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, request: { before?: WorkbenchTranscriptItemCursor; limit: number; threadId: string }) => transcripts.readItemRange(request),
  }),
  readTranscriptProviderCursor: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, threadId: string, turnId: string) => transcripts.readProviderPreviousCursor(threadId, turnId),
  }),
  readTranscriptCompactionExecution: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, input: { harnessId: string; nativeLocation: string; nativeThreadId: string; nativeTurnId: string }) => (
      transcripts.readCompactionExecution(input)
    ),
  }),
  readTranscriptContext: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, threadId: string) => transcripts.readContext(threadId),
  }),
  readThreadContextUsage: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, threadId: string) => transcripts.readContextUsage(threadId),
  }),
  readTranscriptMaterializedTurnIds: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, threadId: string, turnIds: readonly string[]) => transcripts.readMaterializedTurnIds(threadId, turnIds),
    local: (_threadId, turnIds) => turnIds.length ? undefined : { value: [] },
  }),
  readTranscriptAbandonedHoldThreadIds: defineDatabaseRequest({
    read: "query",
    run: ({ transcripts }, before: number, scope?: "compactionQueue") => transcripts.readAbandonedHoldThreadIds(before, scope),
  }),
  readTranscriptHasUndeliveredUserSteer: defineDatabaseRequest({
    read: "transcript",
    run: ({ transcripts }, threadId: string) => transcripts.hasUndeliveredUserSteer(threadId),
  }),
  /** Query errors are an expected answer, so they cross the worker boundary as a value. */
  queryTranscriptPage: defineDatabaseRequest({
    read: "query",
    run: ({ database }, request: TranscriptQuery): { ok: true; page: TranscriptQueryPage } | { ok: false; error: string } => {
      try {
        return { ok: true, page: new WorkbenchTranscriptQueryRepository(database).read(request) };
      } catch (error) {
        if (!(error instanceof TranscriptQueryError)) throw error;
        return { ok: false, error: error.message };
      }
    },
  }),
  writeTranscriptAsset: defineDatabaseRequest({
    run: ({ database }, input: TranscriptAssetWrite) => new WorkbenchTranscriptAssetStore(database).write(input),
  }),
  readTranscriptAsset: defineDatabaseRequest({
    read: "transcript",
    run: ({ database }, input: TranscriptAssetRead) => new WorkbenchTranscriptAssetStore(database).read(input),
  }),
  recordApprovalOutcome: defineDatabaseRequest({
    run: ({ database }, entry: WorkbenchApprovalOutcomeEntry) => { new WorkbenchApprovalOutcomeRepository(database).record(entry); },
  }),
  readApprovalOutcomes: defineDatabaseRequest({
    read: "core",
    run: ({ database }, threadId: string, turnIds?: readonly string[]) => new WorkbenchApprovalOutcomeRepository(database).read(threadId, turnIds),
  }),
};
