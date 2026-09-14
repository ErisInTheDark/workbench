/*
 * Exports:
 * - StandaloneThreadState: selected SQL transcript, page progress and scoped read failure.
 * - default StandaloneThreadController: own bounded standalone paging and one socket using shared SQL/text controllers.
 */
import { CodexAppServerClient } from "workbench-shared/codex/app-server-client";
import { isCodexJsonRpcFailure } from "workbench-shared/codex/protocol";
import { toThreadPayload } from "workbench-shared/codex/thread-adapter";
import type { ThreadPayload } from "workbench-shared/types";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { WORKBENCH_THREAD_PAGE_READ_METHOD, type WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";
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

type Client = Pick<CodexAppServerClient, "connectSocket" | "sendRequest" | "onWorkbenchNotification" | "onConnectionClose" | "onReconnect" | "close">;

export default class StandaloneThreadController {
  readonly text: ThreadTextPresentationController;
  readonly #client: Client;
  readonly #threadId: string;
  readonly #transcripts: WorkbenchTranscriptClient;
  readonly #projection: ThreadTranscriptProjectionController;
  readonly #stops: Array<() => void>;
  readonly #listeners = new Set<() => void>();
  #state: StandaloneThreadState = { thread: null, source: { status: "idle" }, loading: false, error: null, nextCursor: null };
  #generation = 0;
  #disposed = false;

  constructor(threadId: string, {
    client = new CodexAppServerClient(),
    text = new ThreadTextPresentationController(),
  }: { client?: Client; text?: ThreadTextPresentationController } = {}) {
    this.#threadId = threadId;
    this.#client = client;
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
        const key = {
          source: { kind: "sqlite" as const, sourceKey: `codex:${update.threadId}` },
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
    const response = await this.#client.sendRequest<T>({ method, params, workbenchHarness: "codex" }, { socketOnly: true });
    if (isCodexJsonRpcFailure(response)) throw new Error(response.error.message);
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
      const page = await this.#request<WorkbenchThreadPageResponse<WorkbenchThreadId>>(WORKBENCH_THREAD_PAGE_READ_METHOD, {
        threadId: this.#state.thread?.id ?? this.#threadId, cursor,
      });
      if (this.#disposed || generation !== this.#generation) return;
      const next = toThreadPayload(page.thread, "codex");
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
      const nextCursor = cursor !== null || !this.#state.thread ? page.nextCursor : this.#state.nextCursor;
      this.#publish({ thread, nextCursor, loading: false });
      this.#projection.select({ thread });
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      this.#publish({ loading: false, error: error instanceof Error ? error.message : "Unable to load the transcript page." });
    }
  }

  #publish(patch: Partial<StandaloneThreadState>) {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
