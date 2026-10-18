/*
 * Exports:
 * - maintenanceRequests: database requests for schema inventory, generic statement batches and reads, and the step-sized retention passes.
 */
import {
  compileWorkbenchDatabaseStatement,
  type WorkbenchDatabaseMutation,
  type WorkbenchDatabaseQuery,
  type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type { WorkbenchTranscriptRetentionCutoffs } from "../retention/WorkbenchTranscriptRetentionRepository.ts";
import WorkbenchFeedbackRepository from "../stats/WorkbenchFeedbackRepository.ts";
import WorkbenchTranscriptAssetStore from "../transcript/WorkbenchTranscriptAssetStore.ts";
import { workbenchDatabaseTables } from "../workbench-database-schema.ts";
import type { WorkbenchDatabaseMutationResult } from "../workbench-database-protocol.ts";
import { defineDatabaseRequest, type WorkbenchDatabaseWorkerContext } from "./define-database-request.ts";

/** Reclaims at most `maxPages` free pages per call so callers can yield the writer between chunks. */
function reclaimDatabasePages({ database, postDiagnostic }: WorkbenchDatabaseWorkerContext, maxPages: number) {
  const pageCount = database.pragma("page_count", { simple: true }) as number;
  const mode = database.pragma("auto_vacuum", { simple: true }) as number;
  let fullCompaction = false;
  if (mode === 0) {
    const startedAt = performance.now();
    postDiagnostic({
      source: "database", operation: "compaction", phase: "pending", level: "info",
      detail: `${pageCount} pages`, elapsedMs: null, progress: null,
    });
    database.pragma("auto_vacuum = INCREMENTAL");
    database.exec("VACUUM");
    fullCompaction = true;
    const compactedPages = database.pragma("page_count", { simple: true }) as number;
    postDiagnostic({
      source: "database", operation: "compaction", phase: "completed", level: "info",
      detail: `${compactedPages} pages`, elapsedMs: performance.now() - startedAt, progress: null,
    });
  } else {
    if (mode === 1) database.pragma("auto_vacuum = INCREMENTAL");
    database.pragma(`incremental_vacuum(${Math.max(1, Math.trunc(maxPages))})`);
  }
  const retainedPages = database.pragma("page_count", { simple: true }) as number;
  return {
    fullCompaction,
    reclaimedPages: Math.max(0, pageCount - retainedPages),
    remainingFreePages: database.pragma("freelist_count", { simple: true }) as number,
  };
}

export const maintenanceRequests = {
  getInventory: defineDatabaseRequest({
    read: "core",
    run: ({ inventory }) => inventory(),
  }),
  executeTransaction: defineDatabaseRequest({
    run: ({ database }, statements: readonly WorkbenchDatabaseMutation[]): WorkbenchDatabaseMutationResult => database.transaction(() => {
      let changes = 0;
      for (const statement of statements) {
        const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
        changes += database.prepare(compiled.sql).run(...compiled.parameters).changes;
      }
      return { changes };
    })(),
    local: statements => statements.length ? undefined : { value: { changes: 0 } },
  }),
  readRows: defineDatabaseRequest({
    read: "core",
    run: ({ database }, statement: WorkbenchDatabaseQuery) => {
      const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
      return database.prepare(compiled.sql).all(...compiled.parameters) as WorkbenchDatabaseRow[];
    },
  }),
  expireRetainedPayloads: defineDatabaseRequest({
    run: ({ retention }, cutoffs: WorkbenchTranscriptRetentionCutoffs) => retention.expire(cutoffs),
  }),
  listOrphanAssetCandidates: defineDatabaseRequest({
    run: ({ database }, createdBefore: number) => new WorkbenchTranscriptAssetStore(database).listOrphanCandidates(createdBefore),
  }),
  collectOrphanAsset: defineDatabaseRequest({
    run: ({ database }, digest: string, createdBefore: number) => new WorkbenchTranscriptAssetStore(database).collectOrphan(digest, createdBefore),
  }),
  evictProposalCaches: defineDatabaseRequest({
    run: ({ proposalDiffs }, cutoff: number) => proposalDiffs.evictOlderThan(cutoff),
  }),
  expireResolvedFeedback: defineDatabaseRequest({
    run: ({ database }, now: number) => new WorkbenchFeedbackRepository(database).expireResolved(now),
  }),
  reclaimDatabasePages: defineDatabaseRequest({
    run: (context, maxPages: number) => reclaimDatabasePages(context, maxPages),
  }),
};
