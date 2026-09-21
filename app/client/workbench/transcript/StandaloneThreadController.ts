/*
 * Exports:
 * - StandaloneThreadState: selected SQL transcript, page progress and scoped read failure.
 * - default StandaloneThreadController: own bounded standalone paging and one socket using shared SQL/text controllers.
 */
import WorkbenchSocketClient from "workbench-shared/workbench/WorkbenchSocketClient";
import { isWorkbenchRpcFailure } from "workbench-shared/workbench/workbench-rpc";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED, type WorkbenchThreadPageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { ThreadPayload } from "workbench-shared/types";
import { workbenchTranscriptOperations } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import WorkbenchTranscriptClient from "../database/transcript/WorkbenchTranscriptClient";
import ThreadTextPresentationController from "../thread/ThreadTextPresentationController";
import ThreadTranscriptProjectionController, { type ThreadTranscriptProjectionState } from "./ThreadTranscriptProjectionController";

export interface StandaloneThreadState {
  thread: ThreadPayload | null;
  source: ThreadTranscriptProjectionState;
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
}

type Client = Pick<WorkbenchSocketClient, "connectSocket" | "sendRequest" | "onWorkbenchNotification" | "onConnectionClose" | "onReconnect" | "close">;

export default class StandaloneThreadController {
  readonly text: ThreadTextPresentationController;
  readonly #client: Client;
  readonly #daemon: WorkbenchDaemonClient;
  readonly #threadId: string;
  readonly #transcripts: WorkbenchTranscriptClient;
  readonly #projection: ThreadTranscriptProjectionController;
  readonly #stops: Array<() => void>;
  readonly #listeners = new Set<() => void>();
  #state: StandaloneThreadState = { thread: null, source: { status: "idle" }, loading: false, error: null, nextCursor: null };
  #generation = 0;
  #disposed = false;

  constructor(threadId: string, {
    client = new WorkbenchSocketClient(),
    text = new ThreadTextPresentationController(),
  }: { client?: Client; text?: ThreadTextPresentationController } = {}) {
    this.#threadId = threadId;
    this.#client = client;
    this.#daemon = new WorkbenchDaemonClient({ request: (method, params) => this.#request(method, params) });
    this.text = text;
    this.#transcripts = new WorkbenchTranscriptClient({
      transport: {
        onNotification: listener => client.onWorkbenchNotification(listener),
        onDisconnect: listener => client.onConnectionClose(listener),
        request: (method, params) => this.#request(method, params),
      },
      reportConformance: report => {
        void this.#request(workbenchTranscriptOperations.reportConformance.method, report)
          .catch(() => { if (!this.#disposed) console.error("Standalone transcript conformance report could not be sent."); });
      },
    });
    this.#projection = new ThreadTranscriptProjectionController({
      transcripts: this.#transcripts,
      turnLimit: 1,
      onStateChange: source => this.#publish({ source }),
      onText: (update, canonicalText) => {
        const thread = this.#state.thread;
        if (!thread || thread.id !== update.threadId) return;
        const key = {
          source: { kind: "sqlite" as const, sourceKey: `${thread.harness}:${update.threadId}` },
          threadId: update.threadId, turnId: update.turnId, itemId: update.itemId, field: update.field, index: update.index,
        };
        this.text.acceptDelta({ key, canonicalText, delta: update.append ? update.text : canonicalText });
        if (!update.append) this.text.complete(key, canonicalText, { snap: true });
      },
    });
    this.#stops = [
      this.#transcripts.onAvailabilityChange(available => this.#projection.setAvailable(available)),
      client.onConnectionClose(() => {
        this.#generation++;
        this.#publish({ loading: false });
      }),
      client.onReconnect(() => { void this.refresh(); }),
    ];
  }

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  refresh = () => this.#read(null);
  loadPrevious = () => this.#state.nextCursor === null ? Promise.resolve() : this.#read(this.#state.nextCursor);

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    for (const stop of this.#stops) stop();
    this.#projection.setAvailable(false);
    void this.#projection.dispose();
    this.#transcripts.dispose();
    this.text.dispose();
    this.#client.close();
    this.#listeners.clear();
  }

  async #request<T>(method: string, params: unknown): Promise<T> {
    const response = await this.#client.sendRequest<T>({ method, params });
    if (isWorkbenchRpcFailure(response)) throw new WorkbenchDaemonRequestError(response.error.message, response.error.code);
    return response.result;
  }

  async #read(cursor: string | null) {
    if (this.#disposed || this.#state.loading) return;
    const generation = this.#generation;
    if (this.#state.source.status === "failed") this.#projection.select(null);
    this.#publish({ loading: true, error: null });
    try {
      await this.#client.connectSocket();
      if (this.#disposed || generation !== this.#generation) return;
      const input = { threadId: this.#state.thread?.id ?? this.#threadId, cursor, recoveryAware: true };
      let page: WorkbenchThreadPageResult | null = null;
      try {
        page = await this.#daemon.threads.page(input);
      } catch (error) {
        if (!(error instanceof WorkbenchDaemonRequestError) || error.code !== WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED) throw error;
      }
      if (this.#disposed || generation !== this.#generation) return;
      if (page && !page.recovery) this.#applyPage(page, cursor);
      await this.#daemon.threads.reconcile({
        threadId: input.threadId, target: cursor ? { mode: "previous", beforeTurnId: cursor } : { mode: "latest" }, refresh: false,
      });
      if (this.#disposed || generation !== this.#generation) return;
      page = await this.#daemon.threads.page(input);
      if (this.#disposed || generation !== this.#generation) return;
      if (page.recovery) throw new Error("Requested transcript history is still unavailable after reconciliation.");
      this.#applyPage(page, cursor);
      this.#publish({ loading: false });
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      const message = (error instanceof Error ? error.message : "Unable to load the transcript page.")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
      console.error("Standalone transcript page recovery failed.", message);
      this.#publish({ loading: false, error: message });
    }
  }

  #applyPage(page: WorkbenchThreadPageResult, cursor: string | null) {
    const next = page.thread;
    if (this.#state.thread && next.id !== this.#state.thread.id) throw new Error("Transcript page changed its canonical thread identity.");
    if (cursor !== null) {
      const boundary = next.turnHistory.findIndex(turn => turn.turnId === cursor);
      const expected = boundary > 0 ? next.turnHistory[boundary - 1]!.turnId : null;
      if (boundary < 0 || next.turns.length !== (expected ? 1 : 0) || next.turns.some(turn => turn.id !== expected)) {
        throw new Error("Transcript page did not return its exact canonical predecessor.");
      }
    }
    const source = this.#state.source;
    const liveTurns = source.status === "ready" || source.status === "loading" ? source.projection?.turns ?? [] : [];
    const turns = new Map<string, ThreadPayload["turns"][number]>([
      ...(this.#state.thread?.turns ?? []).map(turn => [turn.id, turn] as const),
      ...liveTurns.map((turn): [string, ThreadPayload["turns"][number]] => [turn.id, { ...turn, items: [] }]),
      ...next.turns.map((turn): [string, ThreadPayload["turns"][number]] => [turn.id, { ...turn, items: [] }]),
    ]);
    const order = new Map(next.turnHistory.map((turn, index) => [turn.turnId, index]));
    const thread = { ...next, turns: [...turns.values()].sort((left, right) =>
      (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity)) };
    const nextCursor = cursor !== null || !this.#state.thread?.turns.length ? page.nextCursor : this.#state.nextCursor;
    this.#publish({ thread, nextCursor });
    this.#projection.select({ thread });
  }

  #publish(patch: Partial<StandaloneThreadState>) {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
