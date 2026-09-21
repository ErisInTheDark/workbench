/*
 * Exports:
 * - CodexThreadWindowLoad: hydrated window plus provenance-tagged recording input.
 * - CodexThreadWindowRecord: provider or Workbench recovery window with explicit source.
 * - CodexThreadWindowStore: cursor and source-aware ordered recording port.
 * - default CodexThreadWindowLoader: bounded provider paging and recovery.
 */
import type { Thread as NativeThread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadTurnsListParams } from "workbench-shared/codex/generated/app-server/v2/ThreadTurnsListParams";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchThreadHydrationRequest } from "./lib/codex/thread-hydration";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
type Thread = Omit<NativeThread, "turns"> & { turns: Turn[] };
export type CodexThreadWindowRecord = {
  catalog?: {
    boundary?: { cursor: string | null; turnId: string };
    turns: Turn[];
  };
  page?: {
    previousCursor: string | null;
    turn: Turn;
  };
  source: "provider";
  settlement?: never;
  thread: Thread;
} | {
  source: "workbench";
  thread: Thread;
  settlement: { turnId: string; completedAt: number };
  catalog?: never;
  page?: never;
};

export interface CodexThreadWindowLoad {
  recording: CodexThreadWindowRecord;
  thread: Thread;
}

export interface CodexThreadWindowStore {
  readProviderPreviousCursor: (threadId: string, beforeTurnId: string) => Promise<string | null | undefined>;
  recordWindow: (record: CodexThreadWindowRecord) => void | Promise<void>;
}

type ThreadWithHistory = Thread & {
  workbenchTurnHistory?: WorkbenchThreadTurnHistoryEntry[];
};

type TurnPage = {
  data: Turn[];
  nextCursor: string | null;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readHistory(thread: Thread): WorkbenchThreadTurnHistoryEntry[] {
  const history = (thread as ThreadWithHistory).workbenchTurnHistory;
  return Array.isArray(history) ? history : [];
}

function readPage(response: JsonRpcResponse): TurnPage {
  if (response.error) throw new Error(response.error.message);
  const result = record(response.result);
  const rawData = result?.data;
  const nextCursor = result?.nextCursor;
  if (!Array.isArray(rawData)
    || (nextCursor !== null && typeof nextCursor !== "string")
    || rawData.some((value) => {
      const turn = record(value);
      return typeof turn?.id !== "string" || !Array.isArray(turn.items);
    })) {
    throw new Error("Codex returned an invalid thread turn page.");
  }
  return {
    data: rawData as Turn[],
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}

function expectedTurnId(
  thread: Thread,
  hydration: Exclude<WorkbenchThreadHydrationRequest, { mode: "legacyFull" }>,
) {
  const history = readHistory(thread);
  if (hydration.mode === "latest") return history.at(-1)?.turnId ?? null;
  const beforeIndex = history.findIndex((entry) => entry.turnId === hydration.beforeTurnId);
  if (beforeIndex < 0) throw new Error(`Unknown previous-turn boundary ${hydration.beforeTurnId}.`);
  return beforeIndex > 0 ? history[beforeIndex - 1]?.turnId ?? null : null;
}

function hasTurn(thread: Thread, turnId: string | null) {
  return turnId !== null && thread.turns.some((turn) => turn.id === turnId);
}

function findTurn(thread: Thread, turnId: string | null) {
  return turnId === null ? null : thread.turns.find((turn) => turn.id === turnId) ?? null;
}

function isProviderThreadInactive(thread: Thread) {
  const status = record(thread.status)?.type;
  return status === "idle" || status === "notLoaded";
}

function recoverLaggingLatestWindow(
  thread: Thread,
  hydratedThread: Thread,
  providerLatestTurn: Turn,
): CodexThreadWindowLoad | null {
  const history = readHistory(hydratedThread);
  const storedLatestTurnId = history.at(-1)?.turnId ?? null;
  const storedLatestTurn = findTurn(hydratedThread, storedLatestTurnId);
  if (
    !isProviderThreadInactive(thread)
    || !storedLatestTurn
    || storedLatestTurn.status !== "inProgress"
    || providerLatestTurn.id === storedLatestTurnId
  ) {
    return null;
  }
  const providerLatestIndex = history.findIndex(({ turnId }) => turnId === providerLatestTurn.id);
  if (providerLatestIndex < 0 || providerLatestIndex >= history.length - 1) {
    return null;
  }
  return createWindowLoad({
    settlement: {
      turnId: storedLatestTurn.id,
      completedAt: Math.max(storedLatestTurn.startedAt ?? thread.updatedAt, thread.updatedAt),
    },
    source: "workbench",
    thread,
  });
}

function windowThread(recording: CodexThreadWindowRecord) {
  return {
    ...recording.thread,
    turns: recording.catalog?.turns ?? (recording.page ? [recording.page.turn] : []),
  };
}

function createWindowLoad(recording: CodexThreadWindowRecord): CodexThreadWindowLoad {
  return {
    recording,
    thread: windowThread(recording),
  };
}

export default class CodexThreadWindowLoader {
  constructor(
    private readonly request: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
  ) {}

  async recoverThread(
    thread: Thread,
    settlePage: (page: { turn: Turn; previousCursor: string | null }) => Promise<void>,
    settleCatalog: (turns: Turn[]) => Promise<void> = async () => undefined,
  ): Promise<Turn[]> {
    const catalog: Turn[] = [];
    for await (const page of this.recoveryPages(thread.id, "notLoaded")) {
      catalog.push(...page.data.map((turn) => ({ ...turn, items: [], itemsView: "notLoaded" as const })));
    }
    await settleCatalog(catalog.reverse());
    const turns: Turn[] = [];
    for await (const page of this.recoveryPages(thread.id, "full")) {
      const turn = page.data[0];
      if (!turn) continue;
      await settlePage({ turn, previousCursor: page.nextCursor });
      turns.push({ ...turn, items: [], itemsView: "notLoaded" });
    }
    const recovered = new Set(turns.map(({ id }) => id));
    if (catalog.some(({ id }) => !recovered.has(id))) {
      throw new Error("Codex recovery did not return every catalogued turn.");
    }
    return turns.reverse();
  }

  private async *recoveryPages(threadId: string, itemsView: "full" | "notLoaded") {
    const turnIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.requestTurns({
        threadId, itemsView, limit: itemsView === "full" ? 1 : 100, sortDirection: "desc",
        ...(cursor === null ? {} : { cursor }),
      });
      if ((itemsView === "full" && page.data.length > 1) || (!page.data.length && page.nextCursor !== null)) {
        throw new Error("Codex recovery returned an invalid turn page.");
      }
      if (page.nextCursor !== null && cursors.has(page.nextCursor)) {
        throw new Error("Codex repeated a recovery turn cursor.");
      }
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
      for (const turn of page.data) {
        if (turnIds.has(turn.id) || (itemsView === "full" && turn.itemsView !== "full")) {
          throw new Error("Codex recovery returned a repeated or incomplete turn.");
        }
        turnIds.add(turn.id);
      }
      yield page;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async ensureWindow(
    store: CodexThreadWindowStore,
    metadataThread: Thread,
    hydratedThread: Thread,
    hydration: WorkbenchThreadHydrationRequest,
    options: { recoveryOnly?: boolean; reconcile?: boolean } = {},
  ) {
    if (hydration.mode === "legacyFull") return false;
    if (options.recoveryOnly && hydration.mode !== "latest") return false;
    if (hydration.mode === "latest") {
      if (options.recoveryOnly) {
        return await this.recoverLatestWindow(store, metadataThread, hydratedThread);
      }
      return await this.ensureLatestWindow(store, metadataThread, hydratedThread, options.reconcile);
    }

    const expectedId = expectedTurnId(hydratedThread, hydration);
    if (!options.reconcile && (hasTurn(hydratedThread, expectedId) || expectedId === null)) {
      return false;
    }

    const storedCursor = await store.readProviderPreviousCursor(metadataThread.id, hydration.beforeTurnId);
    const cursor = storedCursor === undefined
      ? await this.discoverPreviousCursor(store, metadataThread, hydration.beforeTurnId)
      : storedCursor;
    if (cursor === undefined) {
      throw new Error(`No Codex previous-turn cursor exists for ${hydration.beforeTurnId}.`);
    }
    if (cursor === null) {
      if (expectedId === null) return false;
      throw new Error(`Codex history ended before expected turn ${expectedId}.`);
    }
    const expectedNative = options.reconcile
      ? (await this.requestTurns({ cursor, itemsView: "notLoaded", limit: 1, sortDirection: "desc", threadId: metadataThread.id })).data[0]?.id
      : expectedId;
    const page = await this.requestTurns({
      cursor,
      itemsView: "full",
      limit: 1,
      sortDirection: "desc",
      threadId: metadataThread.id,
    });
    const turn = page.data[0];
    if (!turn || turn.id !== expectedNative || turn.itemsView !== "full") {
      throw new Error(`Codex previous turn did not match expected turn ${expectedId}.`);
    }
    return createWindowLoad({
      ...(options.reconcile ? {
        catalog: {
          turns: [turn, ...readHistory(hydratedThread).filter(entry => entry.turnId === hydration.beforeTurnId).map(entry => ({
            id: entry.turnId, items: [], itemsView: "notLoaded" as const, error: null,
            startedAt: entry.startedAt, completedAt: entry.completedAt, durationMs: entry.durationMs, status: entry.status,
          }))],
        },
      } : {}),
      page: { previousCursor: page.nextCursor, turn },
      source: "provider",
      thread: metadataThread,
    });
  }

  async reconcileExact(store: CodexThreadWindowStore, thread: Thread, turnId: string) {
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const page = await this.requestTurns({
        threadId: thread.id, itemsView: "notLoaded", limit: 100, sortDirection: "desc",
        ...(cursor === null ? {} : { cursor }),
      });
      if (page.data.some(turn => turn.id === turnId)) {
        for (let index = 0; index < page.data.length; index++) {
          const single = await this.requestTurns({
            threadId: thread.id, itemsView: "notLoaded", limit: 1, sortDirection: "desc",
            ...(cursor === null ? {} : { cursor }),
          });
          if (single.data[0]?.id === turnId) {
            const full = await this.requestTurns({
              threadId: thread.id, itemsView: "full", limit: 1, sortDirection: "desc",
              ...(cursor === null ? {} : { cursor }),
            });
            const turn = full.data[0];
            if (turn?.id !== turnId || turn.itemsView !== "full") throw new Error("Codex exact recovery returned the wrong or incomplete turn.");
            const recording = createWindowLoad({ thread, source: "provider", page: { turn, previousCursor: full.nextCursor } });
            await store.recordWindow(recording.recording);
            return recording;
          }
          cursor = single.nextCursor;
          if (cursor === null || visited.has(cursor)) throw new Error("Codex exact recovery lost its paging boundary.");
          visited.add(cursor);
        }
        throw new Error("Codex exact recovery omitted its metadata turn.");
      }
      cursor = page.nextCursor;
      if (cursor !== null && visited.has(cursor)) throw new Error("Codex exact recovery repeated a cursor.");
      if (cursor !== null) visited.add(cursor);
    } while (cursor !== null);
    throw new Error("Codex did not return the requested recorded turn.");
  }

  private async discoverPreviousCursor(store: CodexThreadWindowStore, thread: Thread, turnId: string) {
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const page = await this.requestTurns({
        threadId: thread.id, itemsView: "notLoaded", limit: 100, sortDirection: "desc",
        ...(cursor === null ? {} : { cursor }),
      });
      if (page.data.some(turn => turn.id === turnId)) {
        // Opaque cursors address page boundaries, so replay only the matching metadata page.
        do {
          const single = await this.requestTurns({
            threadId: thread.id, itemsView: "notLoaded", limit: 1, sortDirection: "desc",
            ...(cursor === null ? {} : { cursor }),
          });
          const turn = single.data[0];
          if (turn?.id === turnId) {
            await store.recordWindow({
              source: "provider",
              thread,
              catalog: { turns: [turn], boundary: { turnId, cursor: single.nextCursor } },
            });
            return single.nextCursor;
          }
          cursor = single.nextCursor;
          if (cursor === null || visited.has(cursor)) break;
          visited.add(cursor);
        } while (true);
        break;
      }
      cursor = page.nextCursor;
      if (cursor === null || visited.has(cursor)) break;
      visited.add(cursor);
    } while (true);
    console.warn("[workbench-transcript] Provider metadata did not recover the requested paging boundary.");
    return undefined;
  }

  private async ensureLatestWindow(
    store: CodexThreadWindowStore,
    thread: Thread,
    hydratedThread: Thread,
    reconcile = false,
  ) {
    const history = readHistory(hydratedThread);
    const storedLatestTurnId = history.at(-1)?.turnId ?? null;
    const storedTurnIds = new Set(history.map(({ turnId }) => turnId));
    const hydratedLatestTurn = findTurn(hydratedThread, storedLatestTurnId);
    let metadataPage: TurnPage;
    try {
      metadataPage = await this.requestTurns({
        itemsView: "notLoaded",
        limit: 1,
        sortDirection: "desc",
        threadId: thread.id,
      });
    } catch (error) {
      if (!history.length && error instanceof Error && error.message.includes("unavailable before first user message")) {
        return createWindowLoad({
          catalog: { turns: [] },
          source: "provider",
          thread,
        });
      }
      throw error;
    }

    const metadataLatestTurn = metadataPage.data[0] ?? null;
    if (!metadataLatestTurn) {
      if (hydratedLatestTurn) {
        console.warn("[workbench-transcript] Empty Codex latest catalog; retaining stored content.");
        return false;
      }
      if (storedLatestTurnId !== null) {
        throw new Error(`Codex returned no latest turn for stored turn ${storedLatestTurnId}.`);
      }
      return createWindowLoad({
        catalog: { turns: [] },
        source: "provider",
        thread,
      });
    }
    const laggingRecovery = recoverLaggingLatestWindow(thread, hydratedThread, metadataLatestTurn);
    if (laggingRecovery) return laggingRecovery;
    if (
      !reconcile && metadataLatestTurn.id === storedLatestTurnId
      && hydratedLatestTurn
      && metadataLatestTurn.status === hydratedLatestTurn.status
    ) {
      return false;
    }

    const firstPage = await this.requestTurns({
      itemsView: "full",
      limit: 1,
      sortDirection: "desc",
      threadId: thread.id,
    });
    const latestTurn = firstPage.data[0] ?? null;
    if (!latestTurn) {
      if (hydratedLatestTurn) {
        console.warn("[workbench-transcript] Empty Codex latest body page; retaining stored content.");
        return false;
      }
      throw new Error(`Codex did not materialize latest turn ${metadataLatestTurn.id}.`);
    }
    if (reconcile && latestTurn.itemsView !== "full") throw new Error("Codex latest recovery returned an incomplete turn.");
    if (storedTurnIds.has(latestTurn.id)) {
      if (latestTurn.id !== storedLatestTurnId) {
        console.warn("[workbench-transcript] Codex latest page overlaps earlier stored history; retaining omitted turns.");
      }
      return createWindowLoad({
        page: { previousCursor: firstPage.nextCursor, turn: latestTurn },
        source: "provider",
        thread,
      });
    }

    const descendingTurns = [latestTurn];
    const turnIds = new Set([latestTurn.id]);
    const seenCursors = new Set<string>();
    let reachedStoredTurnId: string | null = null;
    let cursor = firstPage.nextCursor;
    while (cursor !== null && reachedStoredTurnId === null) {
      if (seenCursors.has(cursor)) throw new Error("Codex repeated a thread turn cursor.");
      seenCursors.add(cursor);
      const page = await this.requestTurns({
        cursor,
        itemsView: "notLoaded",
        sortDirection: "desc",
        threadId: thread.id,
      });
      for (const turn of page.data) {
        if (storedTurnIds.has(turn.id)) {
          reachedStoredTurnId = turn.id;
          break;
        }
        if (turnIds.has(turn.id)) throw new Error(`Codex repeated turn ${turn.id} in its turn catalog.`);
        turnIds.add(turn.id);
        descendingTurns.push(turn);
      }
      cursor = page.nextCursor;
    }
    if (storedLatestTurnId !== null && reachedStoredTurnId !== storedLatestTurnId) {
      // The provider catalog is not a deletion authority for independently recorded history.
      console.warn("[workbench-transcript] Codex catalog omitted the stored latest turn; merging available history without removing stored turns.");
    }

    const turns = descendingTurns.slice().reverse();
    return createWindowLoad({
      catalog: {
        boundary: { cursor: firstPage.nextCursor, turnId: latestTurn.id },
        turns,
      },
      page: { previousCursor: firstPage.nextCursor, turn: latestTurn },
      source: "provider",
      thread,
    });
  }

  private async recoverLatestWindow(
    store: CodexThreadWindowStore,
    thread: Thread,
    hydratedThread: Thread,
  ) {
    const history = readHistory(hydratedThread);
    const storedLatestTurnId = history.at(-1)?.turnId ?? null;
    const storedLatestTurn = findTurn(hydratedThread, storedLatestTurnId);
    if (
      !isProviderThreadInactive(thread)
      || !storedLatestTurn
      || storedLatestTurn.status !== "inProgress"
    ) {
      return false;
    }

    const page = await this.requestTurns({
      itemsView: "full",
      limit: 1,
      sortDirection: "desc",
      threadId: thread.id,
    });
    const providerLatestTurn = page.data[0] ?? null;
    if (!providerLatestTurn) {
      throw new Error(`Codex recovery latest turn did not match stored turn ${storedLatestTurnId}.`);
    }
    const laggingRecovery = recoverLaggingLatestWindow(thread, hydratedThread, providerLatestTurn);
    if (laggingRecovery) return laggingRecovery;
    if (providerLatestTurn.id !== storedLatestTurnId) {
      throw new Error(`Codex recovery latest turn did not match stored turn ${storedLatestTurnId}.`);
    }
    if (providerLatestTurn.status === "inProgress") {
      throw new Error(`Codex thread ${thread.id} is inactive but latest turn ${providerLatestTurn.id} is still in progress.`);
    }

    return createWindowLoad({
      page: { previousCursor: page.nextCursor, turn: providerLatestTurn },
      source: "provider",
      thread,
    });
  }

  private async requestTurns(params: ThreadTurnsListParams) {
    return readPage(await this.request({
      method: "thread/turns/list",
      params,
    }));
  }
}
