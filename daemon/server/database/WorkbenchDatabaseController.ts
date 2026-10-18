/*
 * WorkbenchDatabaseControllerOptions: construction inputs for the database lifecycle owner.
 * WorkbenchDatabaseRequestFailure: one rolled-back request that leaves the database lifecycle ready.
 * WorkbenchDatabaseFailure: stable controller failure carrying one bounded cause.
 * WorkbenchDatabaseController: owns the writer worker, the priority reader pool, their heap readings, the complete database lifecycle,
 *   step-sliced retention, and one method per registered request (./workbench-database-requests).
 */
import { Worker } from "node:worker_threads";
import type {
    WorkbenchDatabaseQuery,
    WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchStatsReadRequest, WorkbenchStatsSectionData,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchStoredStatsSection } from "./stats/WorkbenchStatsRepository.ts";
import type { WorkbenchGitClaimRename } from "../stats/git-claim-observation";
import type { WorkbenchProjectPersistence, WorkbenchProjectPreparation, WorkbenchProjectStartup } from "./project/workbench-project-persistence";
import { TranscriptQueryError, type TranscriptQuery } from "./transcript/transcript-query-contract";
import type { WorkbenchTranscriptRetentionCutoffs } from "./retention/WorkbenchTranscriptRetentionRepository.ts";
import type {
    WorkbenchDatabaseControllerState,
    WorkbenchDatabaseInventory,
    WorkbenchDatabaseRequest,
    WorkbenchDatabaseRequestPayload,
    WorkbenchDatabaseResponse,
    WorkbenchDatabaseWorkerMessage,
} from "./workbench-database-protocol";
import { getWorkbenchDatabaseReadClass, getWorkbenchDatabaseRequestOrdering } from "./workbench-database-protocol";
import {
  workbenchDatabaseRequests,
  type WorkbenchDatabaseRequestArgs,
  type WorkbenchDatabaseRequestMethods,
  type WorkbenchDatabaseRequestName,
  type WorkbenchDatabaseRequestResult,
} from "./workbench-database-requests";
import WorkbenchDatabaseReadPool, { type WorkbenchDatabaseReader } from "./WorkbenchDatabaseReadPool";
import {
  formatWorkbenchDatabaseDiagnostic,
  type WorkbenchDatabaseDiagnosticEvent,
} from "workbench-shared/database/workbench-database-diagnostic";

/** Newly admitted assets may not be referenced yet; collection waits out this grace. */
const ASSET_ADMISSION_GRACE_MS = 3_600_000;
/** 1024 pages is about 4 MiB of file movement: short enough to keep each writer step well under a second. */
const RECLAIMED_PAGES_PER_STEP = 1_024;

export interface WorkbenchDatabaseControllerOptions {
  beforeMigration?(backupPath: string): void;
  onDiagnostic?(diagnostic: WorkbenchDatabaseDiagnosticEvent): void;
  prepareProjects?(signal: AbortSignal): Promise<WorkbenchProjectPreparation>;
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

// Registered requests become methods of the same name; the constructor installs them.
interface WorkbenchDatabaseController extends WorkbenchDatabaseRequestMethods {}

class WorkbenchDatabaseController implements WorkbenchProjectPersistence {
  readonly #beforeMigration: WorkbenchDatabaseControllerOptions["beforeMigration"];
  readonly #onDiagnostic: WorkbenchDatabaseControllerOptions["onDiagnostic"];
  readonly #prepareProjects: WorkbenchDatabaseControllerOptions["prepareProjects"];
  #preparation: AbortController | null = null;
  #initialProjects: WorkbenchProjectStartup | null = null;
  readonly #databasePath: string;
  readonly #worker: Worker;
  /** Pure reads run here by priority; until the pool is ready they fall back to the writer. */
  readonly #readers: WorkbenchDatabaseReadPool;
  readonly #pending = new Map<number, PendingRequest>();
  // Thread-state reads retain write-before-read ordering across the writer and reader pool.
  #threadStateWrite: Promise<void> = Promise.resolve();
  #nextRequestId = 1;
  #state: WorkbenchDatabaseControllerState = "starting";
  #failure: WorkbenchDatabaseFailure | null = null;
  #startPromise: Promise<WorkbenchDatabaseInventory> | null = null;
  #suspension: DatabaseSuspension | null = null;
  #termination: Promise<number> | null = null;

  constructor({
    beforeMigration,
    onDiagnostic,
    prepareProjects,
    databasePath,
    workerUrl = new URL("./workbench-database-worker-bootstrap.mjs", import.meta.url),
  }: WorkbenchDatabaseControllerOptions) {
    this.#beforeMigration = beforeMigration;
    this.#onDiagnostic = onDiagnostic;
    this.#prepareProjects = prepareProjects;
    this.#databasePath = databasePath;
    for (const name of Object.keys(workbenchDatabaseRequests) as WorkbenchDatabaseRequestName[]) {
      Object.defineProperty(this, name, { configurable: true, writable: true, value: (...args: readonly unknown[]) => this.#call(name, args) });
    }
    this.#worker = new Worker(workerUrl);
    this.#readers = new WorkbenchDatabaseReadPool({
      create: () => new Worker(workerUrl),
      settle: response => this.#settle(response),
      fail: error => this.#fail(error),
    });
    this.#worker.on("message", (message: WorkbenchDatabaseWorkerMessage) => this.#receive(message));
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
    this.#startPromise ??= (async () => {
      let projects: WorkbenchProjectPreparation | undefined;
      if (this.#prepareProjects) {
        const preparation = new AbortController();
        this.#preparation = preparation;
        try {
          projects = await this.#prepareProjects(preparation.signal);
          preparation.signal.throwIfAborted();
        } finally { this.#preparation = null; }
      }
      const response = await this.#request({
        type: "initialize", databasePath: this.#databasePath, acknowledgeMigration: !!this.#beforeMigration, projects,
      });
      if (response.type !== "ready") throw new WorkbenchDatabaseFailure(`Unexpected database startup response: ${response.type}`);
      this.#initialProjects = response.projects ?? null;
      await this.#openReaders();
      this.#state = "ready";
      return response.inventory;
    })().catch((error: unknown) => {
      this.#fail(error);
      throw this.#failure ?? error;
    });
    return this.#startPromise;
  }

  readInitialProjectCatalog() {
    this.assertReady();
    return this.#initialProjects;
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
    const closed = this.#closeReaders().then(() => this.#request({ type: "suspend" })).then((response) => {
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
      return this.#openReaders().then(() => response);
    }).then((response) => {
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
    this.#preparation?.abort(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#suspension?.release();
    this.#suspension = null;
    await this.#readers.terminate();
    await (this.#termination ??= this.#worker.terminate());
    try { await this.#startPromise; }
    catch (failure) { if (failure !== error && failure !== this.#failure) throw failure; }
  }

  async query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]> {
    return await this.readRows(statement) as Row[];
  }

  async queryTranscript(request: TranscriptQuery) {
    const result = await this.queryTranscriptPage(request);
    if (result.ok === false) throw new TranscriptQueryError(result.error);
    return result.page;
  }

  async readStats<Section extends WorkbenchStoredStatsSection>(
    request: WorkbenchStatsReadRequest & { section: Section },
    now?: number,
    renames: readonly WorkbenchGitClaimRename[] = [],
    workbenchProjectId: string | null = null,
    /** Abandons the read while it still waits for a reader. */
    signal?: AbortSignal,
  ): Promise<WorkbenchStatsSectionData<Section>> {
    const result = await this.#call("readStatsSection", [request, now, renames, workbenchProjectId], signal);
    if (result.section !== request.section) throw new WorkbenchDatabaseFailure(`Unexpected stats response: ${result.section}`);
    return result as WorkbenchStatsSectionData<Section>;
  }

  /**
   * Runs retention as a sequence of short atomic writer steps so queued writes (and the thread-state reads gated
   * behind them) interleave instead of waiting out the whole pass. `signal` stops between steps.
   */
  async runRetention(
    cutoffs: WorkbenchTranscriptRetentionCutoffs,
    proposalCacheCutoff: number,
    signal?: AbortSignal,
    readObservedThreadIds?: () => string[],
  ) {
    await this.start();
    const startedAt = performance.now();
    this.#report({
      source: "database", operation: "retention", phase: "pending", level: "info",
      detail: `results before ${cutoffs.resultCutoff}, transcripts before ${cutoffs.transcriptCutoff}`,
      elapsedMs: null, progress: null,
    });
    const step = <Name extends WorkbenchDatabaseRequestName>(name: Name, ...args: WorkbenchDatabaseRequestArgs<Name>) => {
      signal?.throwIfAborted();
      return this.#call(name, args);
    };
    const expiry = await step("expireRetainedPayloads",
      { ...cutoffs, ...(readObservedThreadIds ? { observedThreadIds: readObservedThreadIds() } : {}) });
    const createdBefore = cutoffs.expiredAt - ASSET_ADMISSION_GRACE_MS;
    let expiredAssets = 0;
    for (const digest of await step("listOrphanAssetCandidates", createdBefore)) {
      if (await step("collectOrphanAsset", digest, createdBefore)) expiredAssets += 1;
    }
    const expiredProposalCaches = await step("evictProposalCaches", proposalCacheCutoff);
    const expiredResolvedFeedback = await step("expireResolvedFeedback", cutoffs.expiredAt);
    let fullCompaction = false;
    let reclaimedPages = 0;
    for (;;) {
      const reclamation = await step("reclaimDatabasePages", RECLAIMED_PAGES_PER_STEP);
      fullCompaction ||= reclamation.fullCompaction;
      reclaimedPages += reclamation.reclaimedPages;
      if (!reclamation.remainingFreePages || !reclamation.reclaimedPages) break;
    }
    const result = {
      ...expiry, expiredAssets, expiredProposalCaches, expiredResolvedFeedback, fullCompaction, reclaimedPages,
    };
    this.#report({
      source: "database", operation: "retention", phase: "completed", level: "info",
      detail: `${result.expiredResults} results, ${result.expiredTurns} turns, ${result.expiredAssets} assets, ${result.expiredProposalCaches} proposal caches, ${result.expiredResolvedFeedback} resolved feedback reports, ${result.reclaimedPages} pages`,
      elapsedMs: performance.now() - startedAt, progress: null,
    });
    return result;
  }

  async close() {
    this.#preparation?.abort(new WorkbenchDatabaseFailure("Database project preparation was cancelled by closure."));
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
      await this.#closeReaders();
      await (this.#termination ??= this.#worker.terminate());
      this.#state = "closed";
      return;
    }
    await this.#closeReaders();
    const response = await this.#request({ type: "close" });
    if (response.type !== "closed") throw new WorkbenchDatabaseFailure(`Unexpected database close response: ${response.type}`);
    this.#state = "closed";
    this.#suspension?.release();
    this.#suspension = null;
    await (this.#termination ??= this.#worker.terminate());
  }

  /** Each worker's own V8 heap; these sit outside the main thread's heap figures. `null` when a worker is not running. */
  async readWorkerHeaps() {
    const read = async (worker: Worker | null) => {
      if (!worker) return null;
      const { used_heap_size: used, total_heap_size: total } = await worker.getHeapStatistics();
      return { used, total };
    };
    const [writer, readers] = await Promise.all([
      read(this.#state === "closed" || this.#state === "failed" ? null : this.#worker),
      this.#readers.heaps(),
    ]);
    return { writer, readers };
  }

  async #openReaders() {
    await this.#readers.open(async (reader) => {
      const response = await this.#request({ type: "initializeReader", databasePath: this.#databasePath }, reader);
      if (response.type !== "ready") throw new WorkbenchDatabaseFailure(`Unexpected database reader startup response: ${response.type}`);
    });
  }

  async #closeReaders() {
    await this.#readers.close(async (reader) => {
      const response = await this.#request({ type: "close" }, reader);
      if (response.type !== "closed") throw new WorkbenchDatabaseFailure(`Unexpected database reader close response: ${response.type}`);
    });
  }

  /** One registered request: its local answer when it has one, otherwise a worker round trip once the database is started. */
  async #call<Name extends WorkbenchDatabaseRequestName>(
    name: Name, args: WorkbenchDatabaseRequestArgs<Name> | readonly unknown[], signal?: AbortSignal,
  ): Promise<WorkbenchDatabaseRequestResult<Name>> {
    const definition = workbenchDatabaseRequests[name] as { local?: (...args: readonly unknown[]) => { value: unknown } | undefined };
    const local = definition.local?.(...args);
    if (local) return local.value as WorkbenchDatabaseRequestResult<Name>;
    await this.start();
    const response = await this.#request({ type: "call", name, args }, undefined, signal);
    if (response.type !== "result") throw new WorkbenchDatabaseFailure(`Unexpected ${name} response: ${response.type}`);
    return response.result as WorkbenchDatabaseRequestResult<Name>;
  }

  /** `signal` abandons a read that is still queued for a reader; anything already running finishes. */
  async #request(request: WorkbenchDatabaseRequestPayload, target?: WorkbenchDatabaseReader, signal?: AbortSignal): Promise<WorkbenchDatabaseResponse> {
    const precedingThreadStateWrite = this.#threadStateWrite;
    if (this.#suspension && request.type !== "suspend" && request.type !== "resume"
      && request.type !== "close" && request.type !== "initializeReader") {
      await this.#suspension.admission;
    }
    const ordering = getWorkbenchDatabaseRequestOrdering(request);
    if (ordering === "threadStateRead") await precedingThreadStateWrite;
    if (this.#state === "failed") return Promise.reject(this.#failure);
    if (this.#state === "closed") return Promise.reject(new WorkbenchDatabaseFailure("Workbench database is closed"));
    const readClass = getWorkbenchDatabaseReadClass(request);
    const id = this.#nextRequestId++;
    const response = new Promise<WorkbenchDatabaseResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const message = { ...request, id } satisfies WorkbenchDatabaseRequest;
      if (target) target.postMessage(message);
      else if (readClass && this.#readers.ready) {
        this.#readers.run(message, readClass, {
          signal,
          abandon: (reason) => {
            this.#pending.delete(id);
            reject(reason instanceof Error ? reason : new Error("Database read was abandoned."));
          },
        });
      } else this.#worker.postMessage(message);
    });
    if (ordering === "threadStateWrite") this.#threadStateWrite = response.then(() => undefined, () => undefined);
    return await response;
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

  #receive(message: WorkbenchDatabaseWorkerMessage) {
    if (message.type !== "diagnostic") {
      this.#settle(message);
      return;
    }
    this.#report(message.diagnostic);
  }

  #report(diagnostic: WorkbenchDatabaseDiagnosticEvent) {
    const line = formatWorkbenchDatabaseDiagnostic(diagnostic);
    if (diagnostic.level === "warn") console.warn(line);
    else console.info(line);
    this.#onDiagnostic?.(diagnostic);
  }

  #fail(error: unknown) {
    if (this.#state === "failed" || this.#state === "closed") return;
    const message = error instanceof Error ? error.message : String(error);
    this.#failure = error instanceof WorkbenchDatabaseFailure ? error : new WorkbenchDatabaseFailure(message.slice(0, 1_000));
    this.#state = "failed";
    this.#preparation?.abort(this.#failure);
    this.#suspension?.release();
    this.#suspension = null;
    void this.#readers.terminate();
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }
}

export default WorkbenchDatabaseController;
