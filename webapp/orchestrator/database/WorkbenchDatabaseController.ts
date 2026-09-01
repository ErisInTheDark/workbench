/*
 * WorkbenchDatabaseControllerOptions: construction inputs for the database lifecycle owner. Keywords: database, worker, lifecycle.
 * WorkbenchDatabaseRequestFailure: one rolled-back request that leaves the database lifecycle ready. Keywords: database, request, rollback.
 * WorkbenchDatabaseFailure: stable controller failure carrying one bounded cause. Keywords: database, failure, lifecycle.
 * WorkbenchDatabaseController: owns one worker and the complete database lifecycle. Keywords: database, worker, controller.
 */
import { Worker } from "node:worker_threads";

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
} from "./transcript/workbench-transcript-types";

export interface WorkbenchDatabaseControllerOptions {
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

export default class WorkbenchDatabaseController {
  readonly #databasePath: string;
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #state: WorkbenchDatabaseControllerState = "starting";
  #failure: WorkbenchDatabaseFailure | null = null;
  #startPromise: Promise<WorkbenchDatabaseInventory> | null = null;

  constructor({ databasePath, workerUrl = new URL("./workbench-database-worker.ts", import.meta.url) }: WorkbenchDatabaseControllerOptions) {
    this.#databasePath = databasePath;
    const moduleWarning = "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON";
    const execArgv = process.execArgv.includes(moduleWarning) ? process.execArgv : [...process.execArgv, moduleWarning];
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

  start() {
    if (this.#state === "failed") return Promise.reject(this.#failure);
    if (this.#state === "closed") return Promise.reject(new WorkbenchDatabaseFailure("Workbench database is closed"));
    this.#startPromise ??= this.#request({ type: "initialize", databasePath: this.#databasePath }).then((response) => {
      if (response.type !== "ready") throw new WorkbenchDatabaseFailure(`Unexpected database startup response: ${response.type}`);
      this.#state = "ready";
      return response.inventory;
    });
    return this.#startPromise;
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

  async readTranscriptMaterializedTurnIds(threadId: string, turnIds: readonly string[]) {
    await this.start();
    if (turnIds.length === 0) return [];
    const response = await this.#request({ type: "readTranscriptMaterializedTurnIds", threadId, turnIds });
    if (response.type !== "transcriptMaterializedTurnIds") {
      throw new WorkbenchDatabaseFailure(`Unexpected transcript materialization response: ${response.type}`);
    }
    return response.turnIds;
  }

  async close() {
    if (this.#state === "closed") return;
    if (this.#state === "starting" && this.#startPromise === null) {
      this.#state = "closed";
      await this.#worker.terminate();
      return;
    }
    if (this.#state === "failed") {
      await this.#worker.terminate();
      this.#state = "closed";
      return;
    }
    const response = await this.#request({ type: "close" });
    if (response.type !== "closed") throw new WorkbenchDatabaseFailure(`Unexpected database close response: ${response.type}`);
    this.#state = "closed";
    await this.#worker.terminate();
  }

  #request(request: WorkbenchDatabaseRequestPayload): Promise<WorkbenchDatabaseResponse> {
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
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }
}
