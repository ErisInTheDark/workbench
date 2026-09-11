/*
 * No production exports. Protect bounded provider recovery and exact previous-turn paging.
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
    model: null,
    projectId: null,
    reasoningEffort: null,
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

test("previous paging discovers an absent cursor using metadata and settles it before fetching the body", async () => {
  let settled = false;
  const loader = new CodexThreadWindowLoader(async request => {
    const params = request.params as { cursor?: string; itemsView: string; limit: number };
    if (params.itemsView === "full") {
      assert.ok(settled);
      assert.equal(params.cursor, "before-old");
      return response({ data: [turn("old", ["body"])], nextCursor: null });
    }
    if (params.limit === 100) return response({ data: [turn("new"), turn("boundary"), turn("old")], nextCursor: null });
    return response(params.cursor
      ? { data: [turn("boundary")], nextCursor: "before-old" }
      : { data: [turn("new")], nextCursor: "before-boundary" });
  });
  const result = await loader.ensureWindow({
    readProviderPreviousCursor: async () => undefined,
    recordProviderWindow: async record => {
      assert.deepEqual(record.catalog?.boundary, { turnId: "boundary", cursor: "before-old" });
      settled = true;
    },
  }, thread(), withHistory([], [history("old", "unloaded"), history("boundary", "unloaded")]), {
    mode: "previous", beforeTurnId: "boundary",
  });
  assert.ok(result);
  assert.equal(result.recording.page?.turn.id, "old");
});

test("recovery settles each full page before fetching another and retains only chronological metadata", async () => {
  const requests: JsonRpcRequest[] = [];
  const recorded: string[] = [];
  const loader = new CodexThreadWindowLoader(async (request) => {
    requests.push(request);
    if ((request.params as { itemsView: string }).itemsView === "notLoaded") {
      return response({ data: [turn("new"), turn("old")], nextCursor: null });
    }
    assert.equal(requests.length, recorded.length + 2);
    return response(requests.length === 2
      ? { data: [turn("new", ["new-item"])], nextCursor: "older" }
      : { data: [turn("old", ["old-item"])], nextCursor: null });
  });
  const catalog = await loader.recoverThread(thread(), async (page) => {
    recorded.push(page.turn.id);
  });
  assert.deepEqual(recorded, ["new", "old"]);
  assert.deepEqual(catalog.map(({ id, items }) => ({ id, items })), [
    { id: "old", items: [] }, { id: "new", items: [] },
  ]);
  assert.deepEqual(requests.map(({ params }) => params), [
    { threadId: "thread", sortDirection: "desc", itemsView: "notLoaded", limit: 100 },
    { threadId: "thread", sortDirection: "desc", itemsView: "full", limit: 1 },
    { threadId: "thread", sortDirection: "desc", itemsView: "full", limit: 1, cursor: "older" },
  ]);
});

for (const failure of ["recording", "repeated cursor", "repeated turn", "incomplete turn"] as const) {
  test(`recovery cannot complete after ${failure}`, async () => {
    let reads = 0;
    const loader = new CodexThreadWindowLoader(async (request) => {
      if ((request.params as { itemsView: string }).itemsView === "notLoaded") {
        return response({ data: [turn("one")], nextCursor: null });
      }
      reads++;
      return response({
        data: [failure === "incomplete turn" ? turn("one") : turn(
          failure === "repeated turn" ? "one" : String(reads), ["item"],
        )],
        nextCursor: "again",
      });
    });
    await assert.rejects(loader.recoverThread(thread(), async () => {
      if (failure === "recording") throw new Error("recorder failed");
    }));
    assert.ok(reads <= 2);
  });
}

test("recovery cannot close over a catalogued turn omitted by full paging", async () => {
  const loader = new CodexThreadWindowLoader(async (request) => response({
    data: (request.params as { itemsView: string }).itemsView === "notLoaded" ? [turn("missing")] : [],
    nextCursor: null,
  }));
  await assert.rejects(loader.recoverThread(thread(), async () => {}), /every catalogued turn/);
});

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

for (const overlap of [false, true]) {
  test(`latest loading tolerates an omitted stored turn with earlier overlap ${overlap}`, async (context) => {
    const warnings: object[] = [];
    context.mock.method(console, "warn", (...args: object[]) => { warnings.push(args); });
    const latest = turn("new", ["new-item"]);
    const results = [
      response({ data: [turn("new")], nextCursor: "older" }),
      response({ data: [latest], nextCursor: "older" }),
      response({ data: [turn(overlap ? "known" : "unseen")], nextCursor: overlap ? "do-not-fetch" : null }),
    ];
    let reads = 0;
    const loader = new CodexThreadWindowLoader(async () => {
      reads++;
      assert.ok(results.length, "must stop at existing history");
      return results.shift()!;
    });
    const hydrated = withHistory([turn("stored", ["stored-item"])], [
      history("known", "unloaded"), history("stored", "loaded"),
    ]);
    const loaded = await loader.ensureWindow(fakeStore().store, thread(), hydrated, { mode: "latest" });
    assert.ok(loaded);
    assert.deepEqual(loaded.recording.page?.turn, latest);
    assert.deepEqual(loaded.recording.catalog?.turns.map(({ id }) => id), overlap ? ["new"] : ["unseen", "new"]);
    assert.equal(reads, 3);
    assert.equal(warnings.length, 1);
  });
}

for (const emptyStage of ["metadata", "body"] as const) {
  test(`an empty latest ${emptyStage} page retains available stored content`, async (context) => {
    const warnings: object[] = [];
    context.mock.method(console, "warn", (...args: object[]) => { warnings.push(args); });
    let reads = 0;
    const loader = new CodexThreadWindowLoader(async () => {
      reads++;
      return response({ data: emptyStage === "body" && reads === 1 ? [turn("new")] : [], nextCursor: null });
    });
    const hydrated = withHistory([turn("stored", ["stored-item"])], [history("stored", "loaded")]);
    assert.equal(await loader.ensureWindow(fakeStore().store, thread(), hydrated, { mode: "latest" }), false);
    assert.equal(reads, emptyStage === "metadata" ? 1 : 2);
    assert.equal(warnings.length, 1);
  });
}

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
