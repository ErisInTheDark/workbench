/*
 * Exports:
 * - CodexThreadWindowLoad: fetched provider projection plus its ordered recording input. Keywords: codex, thread, window, load.
 * - CodexThreadWindowRecord: one fetched provider catalog and materialized page admitted for ordered recording. Keywords: codex, thread, window, record.
 * - CodexThreadWindowStore: provider-window recording port used by bounded loading and recovery. Keywords: codex, thread, window, store.
 * - default CodexThreadWindowLoader: fetch one requested provider turn window and admit it for recording. Keywords: codex, thread, pagination, window.
 */
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadTurnsListParams } from "workbench-shared/codex/generated/app-server/v2/ThreadTurnsListParams";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchThreadHydrationRequest } from "../lib/codex/thread-hydration";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
export interface CodexThreadWindowRecord {
  catalog?: {
    boundary?: { cursor: string | null; turnId: string };
    turns: Turn[];
  };
  page?: {
    previousCursor: string | null;
    turn: Turn;
  };
  thread: Thread;
}

export interface CodexThreadWindowLoad {
  recording: CodexThreadWindowRecord;
  thread: Thread;
}

export interface CodexThreadWindowStore {
  readProviderPreviousCursor: (threadId: string, beforeTurnId: string) => Promise<string | null | undefined>;
  recordProviderWindow: (record: CodexThreadWindowRecord) => void;
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
  return record(thread.status)?.type === "idle";
}

function providerWindowThread(recording: CodexThreadWindowRecord) {
  return {
    ...recording.thread,
    turns: recording.catalog?.turns ?? (recording.page ? [recording.page.turn] : []),
  };
}

function createProviderWindowLoad(recording: CodexThreadWindowRecord): CodexThreadWindowLoad {
  return {
    recording,
    thread: providerWindowThread(recording),
  };
}

export default class CodexThreadWindowLoader {
  constructor(
    private readonly request: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
  ) {}

  async ensureWindow(
    store: CodexThreadWindowStore,
    metadataThread: Thread,
    hydratedThread: Thread,
    hydration: WorkbenchThreadHydrationRequest,
    options: { recoveryOnly?: boolean } = {},
  ) {
    if (hydration.mode === "legacyFull") return false;
    if (options.recoveryOnly && hydration.mode !== "latest") return false;
    if (hydration.mode === "latest") {
      if (options.recoveryOnly) {
        return await this.recoverLatestWindow(store, metadataThread, hydratedThread);
      }
      return await this.ensureLatestWindow(store, metadataThread, hydratedThread);
    }

    const expectedId = expectedTurnId(hydratedThread, hydration);
    if (hasTurn(hydratedThread, expectedId) || expectedId === null) {
      return false;
    }

    const cursor = await store.readProviderPreviousCursor(metadataThread.id, hydration.beforeTurnId);
    if (cursor === undefined) {
      throw new Error(`No Codex previous-turn cursor exists for ${hydration.beforeTurnId}.`);
    }
    if (cursor === null) {
      throw new Error(`Codex history ended before expected turn ${expectedId}.`);
    }
    const page = await this.requestTurns({
      cursor,
      itemsView: "full",
      limit: 1,
      sortDirection: "desc",
      threadId: metadataThread.id,
    });
    const turn = page.data[0];
    if (!turn || turn.id !== expectedId) {
      throw new Error(`Codex previous turn did not match expected turn ${expectedId}.`);
    }
    return createProviderWindowLoad({
      page: { previousCursor: page.nextCursor, turn },
      thread: metadataThread,
    });
  }

  private async ensureLatestWindow(
    store: CodexThreadWindowStore,
    thread: Thread,
    hydratedThread: Thread,
  ) {
    const history = readHistory(hydratedThread);
    const storedLatestTurnId = history.at(-1)?.turnId ?? null;
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
        return createProviderWindowLoad({
          catalog: { turns: [] },
          thread,
        });
      }
      throw error;
    }

    const metadataLatestTurn = metadataPage.data[0] ?? null;
    if (!metadataLatestTurn) {
      if (storedLatestTurnId !== null) {
        throw new Error(`Codex returned no latest turn for stored turn ${storedLatestTurnId}.`);
      }
      return createProviderWindowLoad({
        catalog: { turns: [] },
        thread,
      });
    }
    const hydratedLatestTurn = findTurn(hydratedThread, storedLatestTurnId);
    if (
      metadataLatestTurn.id === storedLatestTurnId
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
      throw new Error(`Codex did not materialize latest turn ${metadataLatestTurn.id}.`);
    }
    if (latestTurn.id === storedLatestTurnId) {
      return createProviderWindowLoad({
        page: { previousCursor: firstPage.nextCursor, turn: latestTurn },
        thread,
      });
    }

    const descendingTurns = [latestTurn];
    const turnIds = new Set([latestTurn.id]);
    const seenCursors = new Set<string>();
    let reachedStoredLatestTurn = false;
    let cursor = firstPage.nextCursor;
    while (cursor !== null && (storedLatestTurnId === null || !reachedStoredLatestTurn)) {
      if (seenCursors.has(cursor)) throw new Error("Codex repeated a thread turn cursor.");
      seenCursors.add(cursor);
      const page = await this.requestTurns({
        cursor,
        itemsView: "notLoaded",
        sortDirection: "desc",
        threadId: thread.id,
      });
      for (const turn of page.data) {
        if (turn.id === storedLatestTurnId) {
          reachedStoredLatestTurn = true;
          break;
        }
        if (turnIds.has(turn.id)) throw new Error(`Codex repeated turn ${turn.id} in its turn catalog.`);
        turnIds.add(turn.id);
        descendingTurns.push(turn);
      }
      cursor = page.nextCursor;
    }
    if (storedLatestTurnId !== null && !reachedStoredLatestTurn) {
      throw new Error(`Codex turn catalog did not contain stored latest turn ${storedLatestTurnId}.`);
    }

    const turns = descendingTurns.slice().reverse();
    return createProviderWindowLoad({
      catalog: {
        boundary: { cursor: firstPage.nextCursor, turnId: latestTurn.id },
        turns,
      },
      page: { previousCursor: firstPage.nextCursor, turn: latestTurn },
      thread,
    });
  }

  private async recoverLatestWindow(
    store: CodexThreadWindowStore,
    thread: Thread,
    hydratedThread: Thread,
  ) {
    const storedLatestTurnId = readHistory(hydratedThread).at(-1)?.turnId ?? null;
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
    if (!providerLatestTurn || providerLatestTurn.id !== storedLatestTurnId) {
      throw new Error(`Codex recovery latest turn did not match stored turn ${storedLatestTurnId}.`);
    }
    if (providerLatestTurn.status === "inProgress") {
      throw new Error(`Codex thread ${thread.id} is inactive but latest turn ${providerLatestTurn.id} is still in progress.`);
    }

    return createProviderWindowLoad({
      page: { previousCursor: page.nextCursor, turn: providerLatestTurn },
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
