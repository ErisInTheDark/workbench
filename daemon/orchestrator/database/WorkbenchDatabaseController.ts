/*
 * WorkbenchDatabaseControllerOptions: construction inputs for the database lifecycle owner.
 * WorkbenchDatabaseRequestFailure: one rolled-back request that leaves the database lifecycle ready.
 * WorkbenchDatabaseFailure: stable controller failure carrying one bounded cause.
 * WorkbenchDatabaseController: owns one worker and the complete database lifecycle.
 */
import { Worker } from "node:worker_threads";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

import type {
  WorkbenchDatabaseControllerState,
  WorkbenchDatabaseInventory,
  WorkbenchDatabaseMutationResult,
  WorkbenchDatabaseRequest,
  WorkbenchDatabaseRequestPayload,
  WorkbenchDatabaseResponse,
} from "./workbench-database-protocol";
import type {
  WorkbenchDatabaseMutation,
  WorkbenchDatabaseQuery,
  WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptObservation,
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
} from "./transcript/workbench-transcript-types";
import type {
  WorkbenchThreadRecordQuery, WorkbenchThreadStateCommit, WorkbenchSubagentRelationshipRead,
  WorkbenchThreadStateProjectDocument, WorkbenchThreadStateGlobalDocument,
} from "./thread-state/workbench-thread-state-persistence";
import type { WorkbenchThreadLayoutOwner } from "./thread-state/WorkbenchThreadStateLayoutRepository";
import type { WorkbenchStoredThreadTitleHistory } from "../WorkbenchThreadStateStore";
import type {
  WorkbenchNativeThreadIdentity,
  WorkbenchThreadIdentityLookup,
  WorkbenchThreadIdentityMetadata,
  WorkbenchTurnIdentityLookup,
  WorkbenchTurnIdentityMetadata,
} from "./thread-identity/workbench-thread-identity-types";
import type { WorkbenchSearchRequest } from "workbench-shared/workbench/search/workbench-search";
import { TranscriptQueryError, type TranscriptQuery } from "./transcript/transcript-query-contract";
import type { WorkbenchStatsReadRequest } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchStatsDetailedReadRequest } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import type { WorkbenchClaimStatsRequest } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";
import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchSubagentReservation } from "../workbench-subagent-record";
import type { WorkbenchRateLimitObservation } from "./stats/WorkbenchStatsRepository";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "../stats/git-claim-observation";
import type {
  WorkbenchGitClaimImportCandidate,
  WorkbenchGitClaimImportDiscovery,
  WorkbenchGitClaimImportSettlement,
  WorkbenchStatsUsageImportCandidate,
  WorkbenchStatsUsageImportSettlement,
} from "./stats/WorkbenchStatsImportRepository";

export interface WorkbenchDatabaseControllerOptions {
  beforeMigration?(backupPath: string): void;
  databasePath: string;
  workerUrl?: URL;
}

export class WorkbenchDatabaseFailure extends Error {
  override readonly name = "WorkbenchDatabaseFailure";
}

export class WorkbenchDatabaseRequestFailure extends Error {
  override readonly name = "WorkbenchDatabaseRequestFailure";
}

interface PendingRequest {
  resolve: (response: WorkbenchDatabaseResponse) => void;
  reject: (error: Error) => void;
}

interface DatabaseSuspension {
  admission: Promise<void>;
  closed: Promise<void>;
  release(): void;
  retire(): void;
}

export default class WorkbenchDatabaseController {
  readonly #beforeMigration: WorkbenchDatabaseControllerOptions["beforeMigration"];
  readonly #databasePath: string;
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #state: WorkbenchDatabaseControllerState = "starting";
  #failure: WorkbenchDatabaseFailure | null = null;
  #startPromise: Promise<WorkbenchDatabaseInventory> | null = null;
  #suspension: DatabaseSuspension | null = null;
  #termination: Promise<number> | null = null;

  constructor({ beforeMigration, databasePath, workerUrl = new URL("./workbench-database-worker.ts", import.meta.url) }: WorkbenchDatabaseControllerOptions) {
    this.#beforeMigration = beforeMigration;
    this.#databasePath = databasePath;
    const moduleWarning = "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON";
    const transformTypes = "--experimental-transform-types";
    const execArgv = [...process.execArgv];
    if (!execArgv.includes(moduleWarning)) execArgv.push(moduleWarning);
    if (!execArgv.includes(transformTypes)) execArgv.push(transformTypes);
    this.#worker = new Worker(workerUrl, { execArgv });
    this.#worker.on("message", (response: WorkbenchDatabaseResponse) => this.#settle(response));
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (this.#state !== "closed" && this.#state !== "failed") {
        this.#fail(new Error(`Workbench database worker exited unexpectedly with code ${code}`));
      }
    });
  }

  get state() {
    return this.#state;
  }

  get failure() {
    return this.#failure;
  }

  assertReady() {
    if (this.#state === "ready") return;
    if (this.#failure) throw this.#failure;
    throw new WorkbenchDatabaseFailure(`Workbench database is not ready: ${this.#state}`);
  }

  start(): Promise<WorkbenchDatabaseInventory> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#state === "closed") return Promise.reject(new WorkbenchDatabaseFailure("Workbench database is closed"));
    if (this.#suspension) return this.#suspension.admission.then(() => this.start());
    this.#startPromise ??= this.#request({
      type: "initialize", databasePath: this.#databasePath, acknowledgeMigration: !!this.#beforeMigration,
    }).then((response) => {
      if (response.type !== "ready") throw new WorkbenchDatabaseFailure(`Unexpected database startup response: ${response.type}`);
      this.#state = "ready";
      return response.inventory;
    });
    return this.#startPromise;
  }

  async suspend() {
    if (this.#suspension) return await this.#suspension.closed;
    await this.start();
    if (this.#suspension) return await this.#suspension.closed;
    let release!: () => void;
    let rejectAdmission!: (error: Error) => void;
    const admission = new Promise<void>((resolve, reject) => { release = resolve; rejectAdmission = reject; });
    // The node can retire an unused gate. Individual callers still receive its rejection.
    void admission.catch(() => {});
    this.#state = "suspended";
    const closed = this.#request({ type: "suspend" }).then((response) => {
      if (response.type !== "suspended") throw new WorkbenchDatabaseFailure(`Unexpected database suspension response: ${response.type}`);
    }).catch((error: unknown) => {
      this.#fail(error);
      throw error;
    });
    this.#suspension = {
      admission, closed, release,
      retire: () => rejectAdmission(new WorkbenchDatabaseFailure("Suspended database admission was retired.")),
    };
    await closed;
  }

  retireSuspendedAdmission() {
    this.#suspension?.retire();
  }

  async resume(restoreBackupPath?: string) {
    const suspension = this.#suspension;
    if (!suspension) {
      this.assertReady();
      return;
    }
    await suspension.closed;
    this.#state = "starting";
    this.#startPromise = this.#request({ type: "resume", restoreBackupPath }).then((response) => {
      if (response.type !== "ready") throw new WorkbenchDatabaseFailure(`Unexpected database resume response: ${response.type}`);
      this.#state = "ready";
      this.#failure = null;
      this.#suspension = null;
      suspension.release();
      return response.inventory;
    }).catch((error: unknown) => {
      if (error instanceof WorkbenchDatabaseRequestFailure) {
        this.#state = "suspended";
        this.#failure = new WorkbenchDatabaseFailure(error.message);
        suspension.release();
      } else {
        this.#fail(error);
      }
      throw error;
    });
    await this.#startPromise;
  }

  async abortPreparation() {
    if (this.#state === "closed") { await this.#termination; return; }
    this.#state = "closed";
    const error = new WorkbenchDatabaseFailure("Candidate database preparation was retired.");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#suspension?.release();
    this.#suspension = null;
    await (this.#termination ??= this.#worker.terminate());
  }

  async getInventory() {
    await this.start();
    const response = await this.#request({ type: "getInventory" });
    if (response.type !== "inventory") throw new WorkbenchDatabaseFailure(`Unexpected database inventory response: ${response.type}`);
    return response.inventory;
  }

  async executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<WorkbenchDatabaseMutationResult> {
    await this.start();
    if (statements.length === 0) return { changes: 0 };
    const response = await this.#request({ type: "executeTransaction", statements });
    if (response.type !== "mutationResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected database mutation response: ${response.type}`);
    }
    return response.result;
  }

  async query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]> {
    await this.start();
    const response = await this.#request({ type: "query", statement });
    if (response.type !== "queryResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected database query response: ${response.type}`);
    }
    return response.rows as Row[];
  }

  async observeThreadIdentities(inputs: readonly WorkbenchThreadIdentityMetadata[]) {
    await this.start();
    if (!inputs.length) return [];
    const response = await this.#request({ type: "observeThreadIdentities", inputs });
    if (response.type !== "threadIdentities") {
      throw new WorkbenchDatabaseFailure(`Unexpected thread identity admission response: ${response.type}`);
    }
    return response.identities;
  }

  async resolveThreadIdentity(input: WorkbenchThreadIdentityLookup) {
    await this.start();
    const response = await this.#request({ type: "resolveThreadIdentity", input });
    if (response.type !== "threadIdentity") {
      throw new WorkbenchDatabaseFailure(`Unexpected thread identity lookup response: ${response.type}`);
    }
    return response.identity;
  }

  async resolveNativeThreadIdentity(input: WorkbenchNativeThreadIdentity) {
    await this.start();
    const response = await this.#request({ type: "resolveNativeThreadIdentity", input });
    if (response.type !== "threadIdentity") {
      throw new WorkbenchDatabaseFailure(`Unexpected native thread identity lookup response: ${response.type}`);
    }
    return response.identity;
  }

  async listThreadIdentities() {
    await this.start();
    const response = await this.#request({ type: "listThreadIdentities" });
    if (response.type !== "threadIdentities") {
      throw new WorkbenchDatabaseFailure(`Unexpected thread identity catalog response: ${response.type}`);
    }
    return response.identities;
  }

  async observeTurnIdentities(inputs: readonly WorkbenchTurnIdentityMetadata[]) {
    await this.start();
    if (!inputs.length) return [];
    const response = await this.#request({ type: "observeTurnIdentities", inputs });
    if (response.type !== "turnIdentities") {
      throw new WorkbenchDatabaseFailure(`Unexpected turn identity admission response: ${response.type}`);
    }
    return response.identities;
  }

  async resolveTurnIdentity(input: WorkbenchTurnIdentityLookup) {
    await this.start();
    const response = await this.#request({ type: "resolveTurnIdentity", input });
    if (response.type !== "turnIdentity") {
      throw new WorkbenchDatabaseFailure(`Unexpected turn identity lookup response: ${response.type}`);
    }
    return response.identity;
  }

  async admitTranscriptItemIdentities(inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]) {
    await this.start();
    if (!inputs.length) return [];
    const response = await this.#request({ type: "admitTranscriptItemIdentities", inputs });
    if (response.type !== "transcriptItemIdentities") {
      throw new WorkbenchDatabaseFailure(`Unexpected item identity admission response: ${response.type}`);
    }
    return response.identities;
  }

  async resolveTranscriptItemIdentity(input: WorkbenchTranscriptItemIdentityLookup) {
    await this.start();
    const response = await this.#request({ type: "resolveTranscriptItemIdentity", input });
    if (response.type !== "transcriptItemIdentity") {
      throw new WorkbenchDatabaseFailure(`Unexpected item identity lookup response: ${response.type}`);
    }
    return response.identity;
  }

  async settleTranscript(observations: readonly WorkbenchTranscriptObservation[]) {
    await this.start();
    if (observations.length === 0) return { changedThreadIds: [] };
    const response = await this.#request({ type: "settleTranscript", observations });
    if (response.type !== "transcriptSettlement") {
      throw new WorkbenchDatabaseFailure(`Unexpected transcript settlement response: ${response.type}`);
    }
    return response.settlement;
  }

  async readTranscript(request: WorkbenchTranscriptReadRequest) {
    await this.start();
    const response = await this.#request({ type: "readTranscript", request });
    if (response.type !== "transcriptSnapshot") {
      throw new WorkbenchDatabaseFailure(`Unexpected transcript read response: ${response.type}`);
    }
    return response.snapshot;
  }

  async readThreadContextUsage(threadId: string) {
    await this.start();
    const response = await this.#request({ type: "readThreadContextUsage", threadId });
    if (response.type !== "threadContextUsage") {
      throw new WorkbenchDatabaseFailure(`Unexpected context usage response: ${response.type}`);
    }
    return response.snapshot;
  }

  async readThreadStateProject(projectId: ProjectId) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateProject", projectId });
    if (response.type !== "threadStateProject") throw new WorkbenchDatabaseFailure(`Unexpected project response: ${response.type}`);
    return response.document;
  }

  async readThreadStateTitleHistories(projectId: ProjectId) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateTitleHistories", projectId });
    if (response.type !== "threadStateTitleHistories") throw new WorkbenchDatabaseFailure(`Unexpected title history response: ${response.type}`);
    return response.histories;
  }

  async writeThreadStateProject(projectId: ProjectId, document: WorkbenchThreadStateProjectDocument, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    await this.start();
    const response = await this.#request({ type: "writeThreadStateProject", projectId, document, titleHistories });
    if (response.type !== "mutationResult") throw new WorkbenchDatabaseFailure(`Unexpected project write response: ${response.type}`);
  }

  async readThreadStateGlobal(documentId: WorkbenchThreadStateGlobalDocument["id"]) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateGlobal", documentId });
    if (response.type !== "threadStateGlobal") throw new WorkbenchDatabaseFailure(`Unexpected global response: ${response.type}`);
    return response.document;
  }

  async writeThreadStateGlobal(document: WorkbenchThreadStateGlobalDocument) {
    await this.start();
    const response = await this.#request({ type: "writeThreadStateGlobal", document });
    if (response.type !== "mutationResult") throw new WorkbenchDatabaseFailure(`Unexpected global write response: ${response.type}`);
  }

  async readThreadStateRecords(query: WorkbenchThreadRecordQuery) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateRecords", query });
    if (response.type !== "threadStateRecords") throw new WorkbenchDatabaseFailure(`Unexpected thread state response: ${response.type}`);
    return response.records;
  }

  async readThreadStateDrafts(projectId: ProjectId) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateDrafts", projectId });
    if (response.type !== "threadStateDrafts") throw new WorkbenchDatabaseFailure(`Unexpected draft response: ${response.type}`);
    return response.drafts;
  }

  async readThreadStateProfile(projectId: ProjectId) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateProfile", projectId });
    if (response.type !== "threadStateProfile") throw new WorkbenchDatabaseFailure(`Unexpected thread profile response: ${response.type}`);
    return response.profile;
  }

  async readThreadStateLayout(owner: WorkbenchThreadLayoutOwner) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateLayout", owner });
    if (response.type !== "threadStateLayout") throw new WorkbenchDatabaseFailure(`Unexpected thread layout response: ${response.type}`);
    return response.layout;
  }

  async readThreadStatePinnedImports() {
    await this.start();
    const response = await this.#request({ type: "readThreadStatePinnedImports" });
    if (response.type !== "threadStatePinnedImports") throw new WorkbenchDatabaseFailure(`Unexpected pinned import response: ${response.type}`);
    return response.projectIds;
  }

  async readThreadStateArchiveDeadline() {
    await this.start();
    const response = await this.#request({ type: "readThreadStateArchiveDeadline" });
    if (response.type !== "threadStateArchiveDeadline") throw new WorkbenchDatabaseFailure(`Unexpected archive deadline response: ${response.type}`);
    return response.activeAt;
  }

  async readThreadStateActivity(projectId: ProjectId) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateActivity", projectId });
    if (response.type !== "threadStateActivity") throw new WorkbenchDatabaseFailure(`Unexpected thread activity response: ${response.type}`);
    return response.activityAt;
  }

  async readThreadStateSnoozeSources(targetThreadId: WorkbenchThreadId) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateSnoozeSources", targetThreadId });
    if (response.type !== "threadStateSnoozeSources") throw new WorkbenchDatabaseFailure(`Unexpected snooze source response: ${response.type}`);
    return response.sources;
  }

  async readThreadStateArchiveEligible(activeBefore: number) {
    await this.start();
    const response = await this.#request({ type: "readThreadStateArchiveEligible", activeBefore });
    if (response.type !== "threadStateArchiveEligible") throw new WorkbenchDatabaseFailure(`Unexpected archive eligibility response: ${response.type}`);
    return response.records;
  }

  async commitThreadState(changes: WorkbenchThreadStateCommit) {
    await this.start();
    const response = await this.#request({ type: "commitThreadState", changes });
    if (response.type !== "mutationResult") throw new WorkbenchDatabaseFailure(`Unexpected thread commit response: ${response.type}`);
  }

  async readSubagents(query: WorkbenchSubagentRelationshipRead) {
    await this.start();
    const response = await this.#request({ type: "readSubagents", query });
    if (response.type !== "subagents" || response.records === null) throw new WorkbenchDatabaseFailure(`Unexpected subagent list response: ${response.type}`);
    return response.records;
  }

  async readOwnedSubagents(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadIds: readonly WorkbenchThreadId[]) {
    await this.start();
    const response = await this.#request({ type: "readOwnedSubagents", parentThreadId, projectId, threadIds });
    if (response.type !== "subagents") throw new WorkbenchDatabaseFailure(`Unexpected owned subagent response: ${response.type}`);
    return response.records;
  }

  async reserveSubagent(record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">) {
    await this.start();
    const response = await this.#request({ type: "reserveSubagent", record });
    if (response.type !== "subagentReservation") throw new WorkbenchDatabaseFailure(`Unexpected subagent reservation response: ${response.type}`);
    return response.record;
  }

  async activateSubagent(parentThreadId: WorkbenchThreadId, reservationId: string, record: WorkbenchSubagentRelationship) {
    await this.start();
    const response = await this.#request({ type: "activateSubagent", parentThreadId, reservationId, record });
    if (response.type !== "mutationResult") throw new WorkbenchDatabaseFailure(`Unexpected subagent activation response: ${response.type}`);
  }

  async removeSubagent(parentThreadId: WorkbenchThreadId, identifier: string) {
    await this.start();
    const response = await this.#request({ type: "removeSubagent", parentThreadId, identifier });
    if (response.type !== "mutationResult") throw new WorkbenchDatabaseFailure(`Unexpected subagent removal response: ${response.type}`);
  }

  async queryTranscript(request: TranscriptQuery) {
    await this.start();
    const response = await this.#request({ type: "queryTranscript", request });
    if (response.type !== "transcriptQueryResult") throw new WorkbenchDatabaseFailure(`Unexpected transcript query response: ${response.type}`);
    if (response.result.ok === false) throw new TranscriptQueryError(response.result.error);
    return response.result.page;
  }

  async readTranscriptMaterializedTurnIds(threadId: string, turnIds: readonly string[]) {
    await this.start();
    if (turnIds.length === 0) return [];
    const response = await this.#request({ type: "readTranscriptMaterializedTurnIds", threadId, turnIds });
    if (response.type !== "transcriptMaterializedTurnIds") {
      throw new WorkbenchDatabaseFailure(`Unexpected transcript materialization response: ${response.type}`);
    }
    return response.turnIds;
  }

  async replaceSearchProjects(projects: readonly { id: string; name: string; rootPath: string }[]) {
    await this.start();
    const response = await this.#request({ type: "replaceSearchProjects", projects });
    if (response.type !== "mutationResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected search project replacement response: ${response.type}`);
    }
  }

  async replaceSearchProjectFiles(projectId: string, paths: readonly string[]) {
    await this.start();
    const response = await this.#request({ type: "replaceSearchProjectFiles", projectId, paths });
    if (response.type !== "mutationResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected search file replacement response: ${response.type}`);
    }
  }

  async search(request: WorkbenchSearchRequest) {
    await this.start();
    const response = await this.#request({ type: "search", request });
    if (response.type !== "searchResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected search response: ${response.type}`);
    }
    return response.result;
  }

  async recordStatsClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot) {
    await this.#statsMutation({ type: "recordStatsClaimSnapshot", snapshot });
  }

  async recordStatsRateLimits(observation: WorkbenchRateLimitObservation) {
    await this.#statsMutation({ type: "recordStatsRateLimits", observation });
  }

  async readStats(request: WorkbenchStatsReadRequest, now?: number, renames: readonly WorkbenchGitClaimRename[] = []) {
    await this.start();
    const response = await this.#request({ type: "readStats", request, renames, ...(now === undefined ? {} : { now }) });
    if (response.type !== "statsResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected stats response: ${response.type}`);
    }
    return response.result;
  }

  async beginStatsImport(runId: string, harnesses: WorkbenchHarness[], now: number) {
    await this.start();
    const response = await this.#request({ type: "beginStatsImport", runId, harnesses, now });
    if (response.type !== "statsImportProgress") throw new WorkbenchDatabaseFailure(`Unexpected stats import response: ${response.type}`);
    return response.progress;
  }

  async readStatsDetailed(request: WorkbenchStatsDetailedReadRequest, now?: number, renames: readonly WorkbenchGitClaimRename[] = []) {
    await this.start();
    const response = await this.#request({ type: "readStatsDetailed", request, renames, ...(now === undefined ? {} : { now }) });
    if (response.type !== "statsDetailedResult") throw new WorkbenchDatabaseFailure(`Unexpected detailed stats response: ${response.type}`);
    return response.result;
  }

  async readClaimStats(request: WorkbenchClaimStatsRequest, now?: number, renames: readonly WorkbenchGitClaimRename[] = []) {
    await this.start();
    const response = await this.#request({ type: "readClaimStats", request, renames, ...(now === undefined ? {} : { now }) });
    if (response.type !== "claimStatsResult") throw new WorkbenchDatabaseFailure(`Unexpected claim stats response: ${response.type}`);
    return response.result;
  }

  async addStatsClaimDiscoveries(runId: string, discoveries: WorkbenchGitClaimImportDiscovery[], now: number) {
    await this.start();
    const response = await this.#request({ type: "addStatsClaimDiscoveries", runId, discoveries, now });
    if (response.type !== "statsImportProgress") throw new WorkbenchDatabaseFailure(`Unexpected stats discovery response: ${response.type}`);
    return response.progress;
  }

  async claimStatsUsageImport(runId: string, harnesses: WorkbenchHarness[], now: number): Promise<WorkbenchStatsUsageImportCandidate | null> {
    await this.start();
    const response = await this.#request({ type: "claimStatsUsageImport", runId, harnesses, now });
    if (response.type !== "statsUsageImportCandidate") throw new WorkbenchDatabaseFailure(`Unexpected stats usage claim response: ${response.type}`);
    return response.candidate;
  }

  async claimStatsClaimImport(runId: string, now: number): Promise<WorkbenchGitClaimImportCandidate | null> {
    await this.start();
    const response = await this.#request({ type: "claimStatsClaimImport", runId, now });
    if (response.type !== "statsClaimImportCandidate") throw new WorkbenchDatabaseFailure(`Unexpected stats claim claim response: ${response.type}`);
    return response.candidate;
  }

  async settleStatsUsageImport(runId: string, candidate: WorkbenchStatsUsageImportCandidate, settlement: WorkbenchStatsUsageImportSettlement, now: number) {
    await this.start();
    const response = await this.#request({ type: "settleStatsUsageImport", runId, candidate, settlement, now });
    if (response.type !== "statsImportProgress") throw new WorkbenchDatabaseFailure(`Unexpected stats import settlement response: ${response.type}`);
    return response.progress;
  }

  async settleStatsClaimImport(runId: string, candidate: WorkbenchGitClaimImportCandidate, settlement: WorkbenchGitClaimImportSettlement, now: number) {
    await this.start();
    const response = await this.#request({ type: "settleStatsClaimImport", runId, candidate, settlement, now });
    if (response.type !== "statsImportProgress") throw new WorkbenchDatabaseFailure(`Unexpected stats claim settlement response: ${response.type}`);
    return response.progress;
  }

  async repairStatsAttributions(now: number, threadId: string | null = null) {
    await this.start();
    const response = await this.#request({ type: "repairStatsAttributions", now, threadId });
    if (response.type !== "mutationResult") throw new WorkbenchDatabaseFailure(`Unexpected stats attribution response: ${response.type}`);
    return response.result;
  }

  async readStatsImportProgress(state: WorkbenchStatsImportProgress["state"], revision: number, unsupportedClaimCheckpoints = 0) {
    await this.start();
    const response = await this.#request({ type: "readStatsImportProgress", state, revision, unsupportedClaimCheckpoints });
    if (response.type !== "statsImportProgress") throw new WorkbenchDatabaseFailure(`Unexpected stats import progress response: ${response.type}`);
    return response.progress;
  }

  async #statsMutation(request:
    | Extract<WorkbenchDatabaseRequestPayload, { type: "recordStatsClaimSnapshot" }>
    | Extract<WorkbenchDatabaseRequestPayload, { type: "recordStatsRateLimits" }>
  ) {
    await this.start();
    const response = await this.#request(request);
    if (response.type !== "mutationResult") {
      throw new WorkbenchDatabaseFailure(`Unexpected stats mutation response: ${response.type}`);
    }
  }

  async close() {
    if (this.#state === "closed") { await this.#termination; return; }
    if (this.#suspension) {
      try { await this.#suspension.closed; }
      catch (error) {
        if (!this.#failure) throw error;
        // The suspension caller owns this failure; close still terminates its worker.
      }
    }
    if (this.#state === "starting" && this.#startPromise) {
      try { await this.#startPromise; }
      catch (error) {
        if (error !== this.#failure) throw error;
        // Startup already reported this failure. Close still owns worker cleanup.
      }
    }
    if (this.#state === "starting" && this.#startPromise === null) {
      this.#state = "closed";
      await (this.#termination ??= this.#worker.terminate());
      return;
    }
    if (this.#state === "failed") {
      await (this.#termination ??= this.#worker.terminate());
      this.#state = "closed";
      return;
    }
    const response = await this.#request({ type: "close" });
    if (response.type !== "closed") throw new WorkbenchDatabaseFailure(`Unexpected database close response: ${response.type}`);
    this.#state = "closed";
    this.#suspension?.release();
    this.#suspension = null;
    await (this.#termination ??= this.#worker.terminate());
  }

  async #request(request: WorkbenchDatabaseRequestPayload): Promise<WorkbenchDatabaseResponse> {
    if (this.#suspension && request.type !== "suspend" && request.type !== "resume" && request.type !== "close") {
      await this.#suspension.admission;
    }
    if (this.#state === "failed") return Promise.reject(this.#failure);
    if (this.#state === "closed") return Promise.reject(new WorkbenchDatabaseFailure("Workbench database is closed"));
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...request, id } satisfies WorkbenchDatabaseRequest);
    });
  }

  #settle(response: WorkbenchDatabaseResponse) {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    if (response.type === "migrationCheckpoint") {
      try {
        if (!this.#beforeMigration) throw new Error("Database requested an unowned migration checkpoint.");
        this.#beforeMigration(response.backupPath);
        this.#worker.postMessage({ id: response.id, type: "acknowledgeMigration" } satisfies WorkbenchDatabaseRequest);
      } catch (error) {
        this.#fail(error);
      }
      return;
    }
    this.#pending.delete(response.id);
    if (response.type === "requestFailure") {
      pending.reject(new WorkbenchDatabaseRequestFailure(response.message));
      return;
    }
    if (response.type === "fatalFailure") {
      const failure = new WorkbenchDatabaseFailure(response.message);
      pending.reject(failure);
      this.#fail(failure);
      return;
    }
    pending.resolve(response);
  }

  #fail(error: unknown) {
    if (this.#state === "failed" || this.#state === "closed") return;
    const message = error instanceof Error ? error.message : String(error);
    this.#failure = error instanceof WorkbenchDatabaseFailure ? error : new WorkbenchDatabaseFailure(message.slice(0, 1_000));
    this.#state = "failed";
    this.#suspension?.release();
    this.#suspension = null;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }
}
