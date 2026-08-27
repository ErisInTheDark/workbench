/*
 * Exports:
 * - default CodexThreadWindowLoader: import Codex turn identities and materialize one requested provider turn window. Keywords: codex, thread, pagination, window.
 */
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadTurnsListParams } from "../lib/codex/generated/app-server/v2/ThreadTurnsListParams";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { WorkbenchThreadHydrationRequest } from "../lib/codex/server-orchestrator";
import type { WorkbenchThreadTurnHistoryEntry } from "../lib/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type CodexTranscriptStore from "./CodexTranscriptStore";

type CodexThreadWindowStore = Pick<
  CodexTranscriptStore,
  "readProviderPreviousCursor" | "recordProviderTurnCatalog" | "recordProviderTurnPage"
>;

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

export default class CodexThreadWindowLoader {
  constructor(
    private readonly request: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
  ) {}

  async ensureWindow(
    store: CodexThreadWindowStore,
    metadataThread: Thread,
    hydratedThread: Thread,
    hydration: WorkbenchThreadHydrationRequest,
  ) {
    if (hydration.mode === "legacyFull") return false;
    if (hydration.mode === "latest") {
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
    await store.recordProviderTurnPage(metadataThread, turn, page.nextCursor);
    return true;
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
        await store.recordProviderTurnCatalog(thread, []);
        return true;
      }
      throw error;
    }

    const metadataLatestTurn = metadataPage.data[0] ?? null;
    if (!metadataLatestTurn) {
      if (storedLatestTurnId !== null) {
        throw new Error(`Codex returned no latest turn for stored turn ${storedLatestTurnId}.`);
      }
      await store.recordProviderTurnCatalog(thread, []);
      return true;
    }
    if (metadataLatestTurn.id === storedLatestTurnId && hasTurn(hydratedThread, storedLatestTurnId)) {
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
      await store.recordProviderTurnPage(thread, latestTurn, firstPage.nextCursor);
      return true;
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

    await store.recordProviderTurnCatalog(
      thread,
      descendingTurns.slice().reverse(),
      { cursor: firstPage.nextCursor, turnId: latestTurn.id },
    );
    await store.recordProviderTurnPage(thread, latestTurn, firstPage.nextCursor);
    return true;
  }

  private async requestTurns(params: ThreadTurnsListParams) {
    return readPage(await this.request({
      method: "thread/turns/list",
      params,
    }));
  }
}
