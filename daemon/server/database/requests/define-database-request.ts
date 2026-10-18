/*
 * Exports:
 * - WorkbenchDatabaseWorkerContext: what a registered request's worker body reads: the connection, long-lived repositories, inventory and diagnostics.
 * - WorkbenchDatabaseRequestDefinition/defineDatabaseRequest: one database request: its worker body, read class, thread-state ordering and
 *   local short-circuit.
 */
import type Database from "better-sqlite3";
import type { WorkbenchDatabaseDiagnosticEvent } from "workbench-shared/database/workbench-database-diagnostic";
import type GitArcProposalDiffRepository from "../git/GitArcProposalDiffRepository.ts";
import type WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";
import type WorkbenchTranscriptRetentionRepository from "../retention/WorkbenchTranscriptRetentionRepository.ts";
import type WorkbenchSearchRepository from "../search/WorkbenchSearchRepository.ts";
import type WorkbenchStatsAttributionRepository from "../stats/WorkbenchStatsAttributionRepository.ts";
import type WorkbenchStatsImportRepository from "../stats/WorkbenchStatsImportRepository.ts";
import type WorkbenchStatsRepository from "../stats/WorkbenchStatsRepository.ts";
import type WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import type WorkbenchThreadLaunchRepository from "../thread-launch/WorkbenchThreadLaunchRepository.ts";
import type WorkbenchThreadStateRelationalRepository from "../thread-state/WorkbenchThreadStateRelationalRepository.ts";
import type WorkbenchTranscriptIdentityRepository from "../transcript/WorkbenchTranscriptIdentityRepository.ts";
import type WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import type { WorkbenchDatabaseInventory, WorkbenchDatabaseReadClass } from "../workbench-database-protocol.ts";

/** Every member throws while its owner is not initialized, such as writer-only repositories on a reader. */
export interface WorkbenchDatabaseWorkerContext {
  readonly database: Database.Database;
  readonly projects: WorkbenchProjectRepository;
  readonly threadLaunches: WorkbenchThreadLaunchRepository;
  readonly threadIdentities: WorkbenchThreadIdentityRepository;
  readonly transcriptIdentities: WorkbenchTranscriptIdentityRepository;
  readonly transcripts: WorkbenchTranscriptRepository;
  readonly threadState: WorkbenchThreadStateRelationalRepository;
  readonly search: WorkbenchSearchRepository;
  readonly stats: WorkbenchStatsRepository;
  readonly statsImports: WorkbenchStatsImportRepository;
  readonly statsAttribution: WorkbenchStatsAttributionRepository;
  readonly proposalDiffs: GitArcProposalDiffRepository;
  readonly retention: WorkbenchTranscriptRetentionRepository;
  inventory(): WorkbenchDatabaseInventory;
  postDiagnostic(diagnostic: WorkbenchDatabaseDiagnosticEvent): void;
}

export interface WorkbenchDatabaseRequestDefinition<Args extends unknown[], Result> {
  /** Pure reads run on the reader pool in this priority class; anything else runs on the writer. */
  readonly read?: WorkbenchDatabaseReadClass;
  /** Thread-state reads wait for the latest thread-state write; thread-state writes become that latest write. */
  readonly ordering?: "threadStateRead" | "threadStateWrite";
  /** Answers on the caller's side without a worker round trip, such as for an empty batch; undefined asks the worker. */
  readonly local?: (...args: NoInfer<Args>) => { value: NoInfer<Result> } | undefined;
  readonly run: (context: WorkbenchDatabaseWorkerContext, ...args: Args) => Result;
}

export function defineDatabaseRequest<Args extends unknown[], Result>(
  definition: WorkbenchDatabaseRequestDefinition<Args, Result>,
): WorkbenchDatabaseRequestDefinition<Args, Result> {
  return definition;
}
