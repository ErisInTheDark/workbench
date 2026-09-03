/*
 * Exports:
 * - No production exports; Node tests protect bounded Codex catalog import and exact previous-turn paging. Keywords: codex, thread, pagination, window, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexThreadWindowLoader from "./CodexThreadWindowLoader";

function turn(id: string, itemIds: string[] = []): Turn {
  return {
    completedAt: 2,
    durationMs: 1_000,
    error: null,
    id,
    items: itemIds.map((itemId) => ({
      clientId: null,
      content: [{ text: itemId, text_elements: [], type: "text" }],
      id: itemId,
      type: "userMessage",
    })),
    itemsView: itemIds.length ? "full" : "notLoaded",
    startedAt: 1,
    status: "completed",
  };
}

function thread(turns: Turn[] = []): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "test",
    createdAt: 1,
    cwd: "C:/repo",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy",
    id: "thread",
    modelProvider: "openai",
    name: null,
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: 2,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns,
    updatedAt: 2,
  };
}

function history(turnId: string, loadState: WorkbenchThreadTurnHistoryEntry["loadState"]): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: 2,
    durationMs: 1_000,
    itemCount: loadState === "loaded" ? 1 : 0,
    loadState,
    startedAt: 1,
    status: "completed",
    turnId,
  };
}

function withHistory(turns: Turn[], entries: WorkbenchThreadTurnHistoryEntry[]) {
  return Object.assign(thread(turns), { workbenchTurnHistory: entries });
}

function response(result: unknown): JsonRpcResponse {
  return { id: 1, result };
}

function fakeStore(previousCursors: Record<string, string | null | undefined> = {}) {
  const catalogs: Array<{ boundary?: { cursor: string | null; turnId: string }; turns: Turn[] }> = [];
  const pages: Array<{ cursor: string | null; turn: Turn }> = [];
  const recordings: Array<{
    catalog?: { boundary?: { cursor: string | null; turnId: string }; turns: Turn[] };
    page?: { previousCursor: string | null; turn: Turn };
    thread: Thread;
  }> = [];
  return {
    catalogs,
    pages,
    recordings,
    store: {
      async readProviderPreviousCursor(_threadId: string, beforeTurnId: string) {
        return previousCursors[beforeTurnId];
      },
      recordProviderWindow(recording: typeof recordings[number]) {
        recordings.push(recording);
        if (recording.catalog) catalogs.push(recording.catalog);
        if (recording.page) {
          pages.push({
            cursor: recording.page.previousCursor,
            turn: recording.page.turn,
          });
        }
      },
    },
  };
}

test("unseen threads import every identity and materialize only the latest turn", async () => {
  const requests: JsonRpcRequest[] = [];
  const latest = turn("latest", ["latest-item"]);
  const latestMetadata = turn("latest");
  const middle = turn("middle");
  const oldest = turn("oldest");
  const results = [
    response({ data: [latestMetadata], nextCursor: "after-latest" }),
    response({ data: [latest], nextCursor: "after-latest" }),
    response({ data: [middle, oldest], nextCursor: null }),
  ];
  const loader = new CodexThreadWindowLoader(async (request) => {
    requests.push(request);
    return results.shift()!;
  });
  const owner = fakeStore();

  const loaded = await loader.ensureWindow(owner.store, thread(), thread(), { mode: "latest" });
  assert.deepEqual(loaded && loaded.thread.turns.map(({ id }) => id), ["oldest", "middle", "latest"]);
  assert.deepEqual(requests.map((request) => request.params), [
    { itemsView: "notLoaded", limit: 1, sortDirection: "desc", threadId: "thread" },
    { itemsView: "full", limit: 1, sortDirection: "desc", threadId: "thread" },
    { cursor: "after-latest", itemsView: "notLoaded", sortDirection: "desc", threadId: "thread" },
  ]);
  assert.deepEqual(loaded && loaded.recording.catalog?.turns.map((candidate) => candidate.id), [
    "oldest",
    "middle",
    "latest",
  ]);
  assert.deepEqual(loaded && loaded.recording.catalog?.boundary, {
    cursor: "after-latest",
    turnId: "latest",
  });
  assert.deepEqual(loaded && {
    cursor: loaded.recording.page?.previousCursor,
    turnId: loaded.recording.page?.turn.id,
  }, {
    cursor: "after-latest",
    turnId: "latest",
  });
});

test("previous windows use the stored boundary and accept only the exact predecessor", async () => {
  const requests: JsonRpcRequest[] = [];
  const older = turn("older", ["older-item"]);
  const loader = new CodexThreadWindowLoader(async (request) => {
    requests.push(request);
    return response({ data: [older], nextCursor: null });
  });
  const owner = fakeStore({ latest: "after-latest" });
  const hydrated = withHistory([turn("latest", ["latest-item"])], [
    history("older", "unloaded"),
    history("latest", "loaded"),
  ]);

  const loaded = await loader.ensureWindow(owner.store, thread(), hydrated, {
    beforeTurnId: "latest",
    mode: "previous",
  });
  assert.deepEqual(loaded && loaded.thread.turns.map(({ id }) => id), ["older"]);
  assert.deepEqual(requests[0]?.params, {
    cursor: "after-latest",
    itemsView: "full",
    limit: 1,
    sortDirection: "desc",
    threadId: "thread",
  });
  assert.deepEqual(loaded && {
    cursor: loaded.recording.page?.previousCursor,
    turnId: loaded.recording.page?.turn.id,
  }, {
    cursor: null,
    turnId: "older",
  });
});

test("already materialized latest windows use one metadata probe without fetching provider content", async () => {
  const requests: JsonRpcRequest[] = [];
  const loader = new CodexThreadWindowLoader(async (request) => {
    requests.push(request);
    return response({ data: [turn("latest")], nextCursor: "after-latest" });
  });
  const owner = fakeStore();
  const hydrated = withHistory([turn("latest", ["latest-item"])], [history("latest", "loaded")]);

  assert.equal(await loader.ensureWindow(owner.store, thread(), hydrated, { mode: "latest" }), false);
  assert.deepEqual(requests.map((request) => request.params), [
    { itemsView: "notLoaded", limit: 1, sortDirection: "desc", threadId: "thread" },
  ]);
  assert.deepEqual(owner.catalogs, []);
  assert.deepEqual(owner.pages, []);
});

test("inactive provider metadata repairs the same durable turn from one full provider page", async () => {
  const requests: JsonRpcRequest[] = [];
  const providerTurn = turn("latest", ["user", "assistant"]);
  const loader = new CodexThreadWindowLoader(async (request) => {
    requests.push(request);
    return response({ data: [providerTurn], nextCursor: "after-latest" });
  });
  const owner = fakeStore();
  const storedTurn = {
    ...turn("latest", ["user"]),
    completedAt: null,
    durationMs: null,
    status: "inProgress" as const,
  };
  const hydrated = withHistory([storedTurn], [{
    ...history("latest", "loaded"),
    completedAt: null,
    durationMs: null,
    itemCount: 1,
    status: "inProgress",
  }]);

  const loaded = await loader.ensureWindow(
    owner.store,
    thread(),
    hydrated,
    { mode: "latest" },
    { recoveryOnly: true },
  );
  assert.deepEqual(loaded && loaded.thread.turns.map(({ id }) => id), ["latest"]);
  assert.deepEqual(requests.map((request) => request.params), [{
    itemsView: "full",
    limit: 1,
    sortDirection: "desc",
    threadId: "thread",
  }]);
  assert.deepEqual(loaded && {
    cursor: loaded.recording.page?.previousCursor,
    itemIds: loaded.recording.page?.turn.items.map(({ id }) => id),
    status: loaded.recording.page?.turn.status,
    turnId: loaded.recording.page?.turn.id,
  }, {
    cursor: "after-latest",
    itemIds: ["user", "assistant"],
    status: "completed",
    turnId: "latest",
  });
});

test("inactive recovery fails closed when provider latest identity differs", async () => {
  const loader = new CodexThreadWindowLoader(async () => response({
    data: [turn("other", ["assistant"])],
    nextCursor: null,
  }));
  const owner = fakeStore();
  const storedTurn = {
    ...turn("latest", ["user"]),
    completedAt: null,
    durationMs: null,
    status: "inProgress" as const,
  };
  const hydrated = withHistory([storedTurn], [{
    ...history("latest", "loaded"),
    completedAt: null,
    durationMs: null,
    status: "inProgress",
  }]);

  await assert.rejects(
    loader.ensureWindow(owner.store, thread(), hydrated, { mode: "latest" }, { recoveryOnly: true }),
    /did not match stored turn latest/u,
  );
  assert.deepEqual(owner.pages, []);
});

test("stale latest windows import only the missing suffix and materialize the provider latest turn", async () => {
  const requests: JsonRpcRequest[] = [];
  const latest = turn("latest", ["latest-item"]);
  const missingMiddle = turn("missing-middle");
  const storedLatest = turn("stored-latest");
  const results = [
    response({ data: [turn("latest")], nextCursor: "after-latest" }),
    response({ data: [latest], nextCursor: "after-latest" }),
    response({ data: [missingMiddle, storedLatest], nextCursor: "before-stored" }),
  ];
  const loader = new CodexThreadWindowLoader(async (request) => {
    requests.push(request);
    return results.shift()!;
  });
  const owner = fakeStore();
  const hydrated = withHistory([turn("stored-latest", ["stored-item"])], [
    history("stored-latest", "loaded"),
  ]);

  const loaded = await loader.ensureWindow(owner.store, thread(), hydrated, { mode: "latest" });
  assert.deepEqual(loaded && loaded.thread.turns.map(({ id }) => id), ["missing-middle", "latest"]);
  assert.deepEqual(requests.map((request) => request.params), [
    { itemsView: "notLoaded", limit: 1, sortDirection: "desc", threadId: "thread" },
    { itemsView: "full", limit: 1, sortDirection: "desc", threadId: "thread" },
    { cursor: "after-latest", itemsView: "notLoaded", sortDirection: "desc", threadId: "thread" },
  ]);
  assert.deepEqual(loaded && loaded.recording.catalog?.turns.map((candidate) => candidate.id), [
    "missing-middle",
    "latest",
  ]);
  assert.deepEqual(loaded && loaded.recording.catalog?.boundary, {
    cursor: "after-latest",
    turnId: "latest",
  });
  assert.deepEqual(loaded && {
    cursor: loaded.recording.page?.previousCursor,
    turnId: loaded.recording.page?.turn.id,
  }, {
    cursor: "after-latest",
    turnId: "latest",
  });
});

test("wrong provider predecessors fail without materializing a turn", async () => {
  const loader = new CodexThreadWindowLoader(async () => response({
    data: [turn("wrong", ["wrong-item"])],
    nextCursor: null,
  }));
  const owner = fakeStore({ latest: "after-latest" });
  const hydrated = withHistory([turn("latest", ["latest-item"])], [
    history("older", "unloaded"),
    history("latest", "loaded"),
  ]);

  await assert.rejects(
    loader.ensureWindow(owner.store, thread(), hydrated, {
      beforeTurnId: "latest",
      mode: "previous",
    }),
    /did not match expected turn older/u,
  );
  assert.deepEqual(owner.pages, []);
});
