/*
 * Exports:
 * - tests: protect OpenCode message grouping and transcript translation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptItemSource } from "../../database/transcript/workbench-transcript-types";
import type { WorkbenchTranscriptObservation } from "../../database/transcript/workbench-transcript-types";
import OpenCodeTranscriptAdapter, {
  openCodeTokenBreakdown,
  openCodeToolContentItems,
} from "./OpenCodeTranscriptAdapter";
import { createThreadStateTestDatabase } from "../../workbench-thread-state-test-database";
import WorkbenchTranscriptRepository from "../../database/transcript/WorkbenchTranscriptRepository";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import WorkbenchTranscriptLiveController from "../../database/transcript/WorkbenchTranscriptLiveController";
import OpenCodeEventController from "./OpenCodeEventController";
import { writeTranscriptText, readTranscriptText } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type { SessionMessageInfo } from "@opencode/client";
import WorkbenchTranscriptAssetStore from "../../database/transcript/WorkbenchTranscriptAssetStore";

test("converts cumulative OpenCode usage without losing cache or reasoning tokens", () => {
  assert.deepEqual(openCodeTokenBreakdown({
    input: 100, output: 13, reasoning: 5, cache: { read: 11, write: 7 },
  }), {
    cacheWriteInputTokens: 7,
    cachedInputTokens: 11,
    inputTokens: 118,
    outputTokens: 13,
    reasoningOutputTokens: 5,
    totalTokens: 136,
  });
});

test("live context usage subtracts the persisted turn baseline and preserves a known model window", async () => {
  const observations: WorkbenchTranscriptObservation[] = [];
  const adapter = new OpenCodeTranscriptAdapter({
    modelContext: async () => null,
    threads: {} as never,
    items: {} as never,
    transcript: {
      record: async entries => {
        observations.push(...entries);
        return { changedThreadIds: [] };
      },
    },
  });
  const baseline = {
    cacheWriteInputTokens: 1, cachedInputTokens: 2, inputTokens: 13,
    outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 17,
  };
  const tokenUsage = await adapter.recordContextUsage({
    threadId: WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    baseline,
    current: { input: 16, output: 5, reasoning: 1, cache: { read: 3, write: 2 } },
    model: { providerID: "provider", id: "model" },
    nativeLocation: "C:/repo",
    modelContextWindow: 200_000,
    canCommit: () => true,
  });
  assert.deepEqual(tokenUsage, {
    last: {
      cacheWriteInputTokens: 1, cachedInputTokens: 1, inputTokens: 8,
      outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 10,
    },
    total: {
      cacheWriteInputTokens: 2, cachedInputTokens: 3, inputTokens: 21,
      outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 27,
    },
    modelContextWindow: 200_000,
  });
  assert.deepEqual(observations.at(-1), {
    kind: "threadContextUsage",
    threadId: "00000000-0000-4000-8000-000000000001",
    snapshot: { tokenUsage },
    initialise: false,
  });
});

test("sent and native OpenCode user images survive transcript rereads without duplicates", async context => {
  const fixture = createThreadStateTestDatabase();
  context.after(() => fixture.sqlite.close());
  fixture.admitThread(testProjectIds.project, "wb-thread", "opencode", "session", "C:/repo");
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  const assets = new WorkbenchTranscriptAssetStore(fixture.sqlite);
  const adapter = new OpenCodeTranscriptAdapter({
    ...fixture.identities,
    assets: { writeTranscriptAsset: async input => assets.write(input) },
    transcript: { record: async observations => repository.settle(observations) },
  });
  const session = {
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 3 }, location: { directory: "C:/repo" },
  };
  const png = Buffer.from("image bytes");
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const metadata = { workbench: {
    version: 1 as const, delivery: "queue" as const,
    itemId: WorkbenchItemIdSchema.parse("00000000-0000-4000-8000-000000000020"),
    clientMessageId: "sent-image",
    input: [{ type: "text" as const, text: "look", text_elements: [] }, { type: "image" as const, url: dataUrl }],
  } };
  const root: SessionMessageInfo = { id: "root", type: "user", text: "look", time: { created: 1 }, metadata };
  const project = { id: testProjectIds.project, rootPath: "C:/repo" };
  const read = () => {
    const projected = projectWorkbenchTranscript(repository.read({ threadId: "wb-thread", turnLimit: 3 })!);
    assert.ok(projected.success);
    return projected.data.turns.flatMap(turn => turn.items).filter(
      (item): item is Extract<typeof item, { type: "userMessage" }> => item.type === "userMessage",
    );
  };
  await adapter.record(session, [root], project);
  const [sent] = read();
  assert.deepEqual(sent?.content.map(part => part.type), ["text", "image"]);
  const imageUrl = sent?.content[1]?.type === "image" ? sent.content[1].url : null;
  assert.match(imageUrl ?? "", /^\/api\/transcript-assets\//u);
  const assetName = imageUrl!.split("/").at(-1)!;
  assert.deepEqual(Buffer.from(assets.read({ threadId: "wb-thread", assetName })!.bytes), png);

  const echoed: SessionMessageInfo = {
    ...root, files: [{ data: png.toString("base64"), mime: "image/png", source: { type: "inline" } }],
  };
  const native: SessionMessageInfo = {
    id: "native", type: "user", text: "native", time: { created: 2 },
    files: [{ data: dataUrl, mime: "image/png", source: { type: "inline" } }],
  };
  const local: SessionMessageInfo = {
    id: "local", type: "user", text: "local", time: { created: 3 },
    metadata: { workbench: {
      ...metadata.workbench,
      itemId: WorkbenchItemIdSchema.parse("00000000-0000-4000-8000-000000000021"),
      clientMessageId: "local-image",
      input: [{ type: "text", text: "local", text_elements: [] },
        { type: "localImage", path: "C:/repo/photo.png" }],
    } },
    files: [{ data: png.toString("base64"), mime: "image/png", source: { type: "uri", uri: "file:///C:/repo/photo.png" } }],
  };
  await adapter.record(session, [echoed, native, local], project);
  const [reread, nativeRead, localRead] = read();
  assert.deepEqual(reread?.content.map(part => part.type), ["text", "image"]);
  assert.equal(reread?.content[1]?.type === "image" ? reread.content[1].url : null, imageUrl);
  assert.deepEqual(nativeRead?.content.map(part => part.type), ["text", "image"]);
  assert.equal(nativeRead?.content[1]?.type === "image" ? nativeRead.content[1].url : null, imageUrl);
  assert.deepEqual(localRead?.content.map(part => part.type), ["text", "image"]);
  assert.equal(localRead?.content[1]?.type === "image" ? localRead.content[1].url : null, imageUrl);
});

test("an obsolete canonical read cannot reopen a turn interrupted while its identities were resolving", async context => {
  const fixture = createThreadStateTestDatabase();
  context.after(() => fixture.sqlite.close());
  fixture.admitThread(testProjectIds.project, "wb-thread", "opencode", "session", "C:/repo");
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  const adapter = new OpenCodeTranscriptAdapter({
    ...fixture.identities,
    transcript: { record: async observations => repository.settle(observations) },
  });
  const session = {
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 }, location: { directory: "C:/repo" },
  };
  const messages: SessionMessageInfo[] = [
    { id: "root", type: "user", text: "work", time: { created: 1 } },
    { id: "assistant", type: "assistant", agent: "agent", model: { id: "model", providerID: "provider" },
      content: [], time: { created: 2 } },
  ];
  const project = { id: testProjectIds.project, rootPath: "C:/repo" };
  const admitted = await adapter.record(session, messages, project);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admit = fixture.identities.items.admit.bind(fixture.identities.items);
  context.mock.method(fixture.identities.items, "admit", async (...args: Parameters<typeof admit>) => {
    entered.resolve();
    await release.promise;
    return admit(...args);
  });
  let current = true;
  const stale = adapter.record(session, messages, project, {
    window: { latest: true, previousCursor: null, gapIds: [] },
    canCommit: () => current,
  });
  await entered.promise;
  try {
    current = false;
    await adapter.recordTurnState({ threadId: admitted.threadId, turnId: admitted.latestTurnId!,
      state: "interrupted", observedAt: 3 });
  } finally { release.resolve(); }
  await stale;
  const turn = repository.read({ threadId: admitted.threadId, turnLimit: 1 })!.turns[0]!;
  assert.equal(turn.state, "interrupted");
  assert.equal(turn.ended_at, 3);
});

for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
  test(`native idle ${outcome} survives canonical rereads without reopening a turn`, async context => {
    const fixture = createThreadStateTestDatabase();
    context.after(() => fixture.sqlite.close());
    fixture.admitThread(testProjectIds.project, "wb-thread", "opencode", "session", "C:/repo");
    const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
    const adapter = new OpenCodeTranscriptAdapter({
      ...fixture.identities,
      transcript: { record: async observations => repository.settle(observations) },
    });
    const session = {
      id: "session", projectID: "project", title: "Thread", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 4 }, location: { directory: "C:/repo" },
    };
    const messages: SessionMessageInfo[] = [
      { id: "root", type: "user", text: "work", time: { created: 1 } },
      { id: "assistant", type: "assistant", agent: "agent", model: { id: "model", providerID: "provider" },
        content: [], time: { created: 2 } },
      { id: "idle", type: "idle", outcome, time: { created: 4 } },
    ];
    const project = { id: testProjectIds.project, rootPath: "C:/repo" };
    const window = { previousCursor: null, gapIds: [], latest: true };
    const recorded = await adapter.record(session, messages, project, { window });
    await adapter.record(session, messages, project, { window });
    const expected = outcome === "succeeded" ? "completed" : outcome;
    assert.equal(recorded.latestTurnState, expected);
    assert.equal(repository.read({ threadId: recorded.threadId, turnLimit: 1 })!.turns[0]!.state, expected);
    const stillTerminal = await adapter.record(session, messages, project, { window, keepLatestTurnOpen: true });
    assert.equal(stillTerminal.latestTurnState, expected, "a native idle marker must win over an active snapshot");
    const next = await adapter.record(session, [...messages,
      { id: "next", type: "user", text: "next task", time: { created: 5 } },
    ], project, { window });
    assert.equal(next.latestTurnState, "inProgress");
    assert.deepEqual(repository.read({ threadId: recorded.threadId, turnLimit: 2 })!.turns.map(turn => turn.state),
      [expected, "inProgress"]);
  });
}

test("native reasoning streams through SQLite identity and live projection before its end event", async () => {
  const fixture = createThreadStateTestDatabase();
  fixture.admitThread(testProjectIds.project, "wb-thread", "opencode", "session", "C:/repo");
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  const live = new WorkbenchTranscriptLiveController();
  const adapter = new OpenCodeTranscriptAdapter({
    ...fixture.identities,
    transcript: {
      record: async observations => {
        const result = repository.settle(observations);
        live.settle(result.changes ?? []);
        return result;
      },
      acceptLiveUpdate: input => live.acceptLiveUpdate(input),
    },
  });
  const admitted = await adapter.record({
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 }, location: { directory: "C:/repo" },
  }, [{ id: "root", type: "user", text: "work", time: { created: 1 } }],
  { id: testProjectIds.project, rootPath: "C:/repo" });
  const active = { threadId: admitted.threadId, turnId: admitted.latestTurnId! };
  const events = new OpenCodeEventController({
    observe: async () => undefined,
    threads: { observeCompaction: () => {}, currentTurn: () => active,
      acceptExecutionEvent: () => true, settleExecution: () => undefined, executionIntentVersion: () => 0,
      syncNative: async () => admitted, markExecutionSettled: () => undefined, markExecutionStarted: () => undefined,
      recordUsage: async () => null },
    transcript: adapter,
  });
  const data = { sessionID: "session", assistantMessageID: "assistant", ordinal: 0 };
  await events.accept({ type: "session.reasoning.started", created: 2, data } as never);
  const projected = projectWorkbenchTranscript(repository.read({ threadId: active.threadId, turnLimit: 1 })!);
  assert.ok(projected.success);
  const reasoning = projected.data.turns[0]!.items.find(item => item.type === "reasoning")!;
  live.open("view", repository.read({ threadId: active.threadId, turnLimit: 1 }), update => {
    if (update.kind === "text" && update.itemId === reasoning.id) writeTranscriptText(reasoning, update);
  });
  await events.accept({ type: "session.reasoning.delta", created: 3, data: { ...data, delta: "partial" } } as never);
  assert.equal(readTranscriptText(reasoning, "reasoningSummary", 0), "partial");
  await events.accept({ type: "session.reasoning.delta", created: 4, data: { ...data, delta: " thought" } } as never);
  assert.equal(readTranscriptText(reasoning, "reasoningSummary", 0), "partial thought");
  await events.accept({ type: "session.reasoning.ended", created: 5, data: { ...data, text: "partial thought" } } as never);
  assert.equal(readTranscriptText(reasoning, "reasoningSummary", 0), "partial thought");
  const reopened = projectWorkbenchTranscript(repository.read({ threadId: active.threadId, turnLimit: 1 })!);
  assert.ok(reopened.success);
  assert.equal(readTranscriptText(reopened.data.turns[0]!.items.find(item => item.id === reasoning.id)!, "reasoningSummary", 0), "partial thought");
  live.dispose();
});

test("complete windows settle steers, usage and cursors in SQLite without historical usage regression", async () => {
  const fixture = createThreadStateTestDatabase();
  fixture.admitThread(testProjectIds.project, "wb-thread", "opencode", "session", "C:/repo");
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  const adapter = new OpenCodeTranscriptAdapter({
    ...fixture.identities,
    transcript: { record: async observations => repository.settle(observations) },
  });
  const session = {
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 10 }, location: { directory: "C:/repo" },
  };
  const project = { id: testProjectIds.project, rootPath: "C:/repo" };
  const latest = await adapter.record(session, [
    { id: "root", type: "user", text: "hello", time: { created: 5 } },
    { id: "steer", type: "user", text: "continue", time: { created: 6 }, metadata: { workbench: {
      version: 1, delivery: "steer", itemId: "00000000-0000-4000-8000-000000000020",
      clientMessageId: "steer-request", input: [{ type: "text", text: "continue", text_elements: [] }],
    } } },
    { id: "answer", type: "assistant", agent: "agent", model: { id: "model", providerID: "provider" },
      content: [{ type: "text", text: "answer" }], tokens: session.tokens, time: { created: 7, completed: 9 } },
  ], project, { settleUsage: true, window: { previousCursor: "native-cursor", gapIds: [], latest: true } });
  assert.ok(latest.latestTurnId);
  const saved = repository.read({ threadId: latest.threadId, turnLimit: 1 })!;
  const projected = projectWorkbenchTranscript(saved);
  assert.ok(projected.success);
  assert.deepEqual(projected.data.turns[0]!.items.map(item => item.type === "userMessage"
    ? item.content.flatMap(input => input.type === "text" ? [input.text] : []).join("")
    : item.type === "agentMessage" ? item.text : item.type), ["hello", "continue", "answer"]);
  assert.equal(repository.readProviderPreviousCursor(latest.threadId, latest.latestTurnId), "native-cursor");
  const usage = repository.readContextUsage(latest.threadId);
  assert.ok(usage?.tokenUsage);
  assert.equal(latest.deliveredSteerClientMessageIds[0], "steer-request");
  const successor = saved.turns[0]!;
  await adapter.record(session, [
    { id: "old-root", type: "user", text: "older", time: { created: 1 } },
    { id: "old-answer", type: "assistant", agent: "agent", model: { id: "old-model", providerID: "provider" },
      content: [{ type: "text", text: "old answer" }], time: { created: 2, completed: 3 } },
  ], project, { settleUsage: false, window: { previousCursor: null, gapIds: [], latest: false, successor: {
    kind: "turn", threadId: latest.threadId, turnId: latest.latestTurnId,
    nativeTurnId: NativeTurnIdSchema.parse(successor.native_turn_id),
    nativeThreadId: NativeThreadIdSchema.parse(successor.native_thread_id), nativeLocation: successor.native_location,
    harnessId: "opencode", state: "completed", createdAt: successor.created_at, startedAt: successor.started_at,
    endedAt: successor.ended_at, durationMs: successor.duration_ms,
  } } });
  const both = repository.read({ threadId: latest.threadId, turnLimit: 2 })!;
  assert.deepEqual(both.turns.map(turn => turn.native_turn_id), ["old-root", "root"]);
  assert.deepEqual(repository.readContextUsage(latest.threadId), usage);
  assert.deepEqual(both.rows.threadItemAssistantMessages.map(row => row.text).sort(), ["answer", "old answer"]);
});

test("child capture retains complete MCP evidence with Workbench provenance and stable identity", async () => {
  const recorded: WorkbenchTranscriptObservation[] = [];
  const origins: string[] = [];
  const itemId = WorkbenchItemIdSchema.parse("a3c25f4a-aee4-46a6-b7bd-a9f4718e001f");
  const adapter = new OpenCodeTranscriptAdapter({
    threads: { observe: async () => { throw new Error("no current-turn lookup"); }, observeTurns: async () => [] },
    items: {
      admit: async inputs => inputs.map(input => ({ ...input, itemId, sources: input.sources.map(source => ({
        ...source, component: source.component ?? { kind: "item" as const, index: 0 },
      })) })),
      itemIdForSource: () => itemId,
    },
    transcript: { record: async (observations, options) => {
      recorded.push(...observations);
      origins.push(options!.source);
      return { changedThreadIds: [] };
    } },
  });
  const reference = await adapter.startToolTranscript({
    threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: WorkbenchTurnIdSchema.parse("original"),
    sourceId: "child", parentId: "execute", tool: "rg", arguments: { args: ["needle"] }, startedAt: 1,
  });
  const result = { content: [{ type: "text", text: "full output" }, { type: "image", data: "base64", mimeType: "image/png" }],
    structuredContent: { rows: [1, 2] }, _meta: { extra: "retained" }, isError: true };
  await adapter.finishToolTranscript(reference, result);
  assert.deepEqual(origins, ["workbench", "workbench"]);
  const completed = recorded.at(-1)!;
  assert.ok(completed.kind === "item" && completed.item.type === "mcpToolCall");
  assert.equal(completed.turnId, "original");
  assert.equal(completed.publicItemId, itemId);
  assert.equal(completed.item.toolCallGroupId, "execute");
  assert.equal(completed.item.status, "failed");
  assert.equal(completed.item.error, null, "returned MCP errors must not replace the full output in existing renderers");
  assert.deepEqual(completed.item.result, { content: result.content, structuredContent: result.structuredContent, _meta: result._meta });
});

test("preserves OpenCode tool content and structured failures", () => {
  assert.deepEqual(openCodeToolContentItems([
    { type: "text", text: "answered" },
  ]), [{ type: "inputText", text: "answered" }]);
  assert.deepEqual(openCodeToolContentItems(undefined, {
    message: "The operation timed out.",
  }), [{ type: "inputText", text: "The operation timed out." }]);
});

test("keeps a delivered steer in its active WB turn and starts the next root separately", async () => {
  let recorded: readonly WorkbenchTranscriptObservation[] = [];
  const admittedSources: WorkbenchTranscriptItemSource[] = [];
  const adapter = new OpenCodeTranscriptAdapter({
    threads: {
      observe: async () => ({ threadId: WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001") } as never),
      observeTurns: async inputs => inputs.map((input, index) => ({
        threadId: input.threadId,
        turnId: WorkbenchTurnIdSchema.parse(`00000000-0000-4000-8000-00000000000${index + 2}`),
        turnIndex: index,
        native: {
          harness: input.harnessId,
          nativeLocation: input.nativeLocation,
          nativeThreadId: NativeThreadIdSchema.parse(input.nativeThreadId),
          nativeTurnId: NativeTurnIdSchema.parse(input.nativeTurnId),
        },
      })),
    },
    items: {
      admit: async inputs => inputs.map((input, index) => {
        admittedSources.push(input.sources[0]!);
        return {
          ...input,
          sources: input.sources.map(source => ({
            ...source,
            component: source.component ?? { kind: "item" as const, index: 0 },
          })),
          itemId: input.itemId
            ?? WorkbenchItemIdSchema.parse(`00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`),
        };
      }),
      itemIdForSource: () => { throw new Error("not used"); },
    },
    transcript: {
      record: async observations => {
        recorded = observations;
        return { changedThreadIds: [] };
      },
    },
  });
  const result = await adapter.record({
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 4 }, location: { directory: "C:/repo" },
  }, [
    { id: "user-1", type: "user", text: "hello", time: { created: 1 } },
    {
      id: "assistant-1",
      type: "assistant",
      agent: "agent",
      model: { id: "m", providerID: "p" },
      content: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "hi" },
        {
          type: "tool",
          id: "tool-1",
          name: "execute",
          state: {
            status: "completed",
            input: { code: "tools.wb.rg({})" },
            output: "legacy output",
            content: [{ type: "text", text: "preserved result" }],
            metadata: { error: true },
          },
          time: { created: 2, ran: 2, completed: 3 },
        } as never,
      ],
      time: { created: 2, completed: 3 },
    },
    {
      id: "steer-1",
      type: "user",
      text: "change course",
      time: { created: 4 },
      metadata: {
        workbench: {
          version: 1,
          delivery: "steer",
          itemId: "00000000-0000-4000-8000-000000000020",
          clientMessageId: "00000000-0000-4000-8000-000000000021",
          input: [{ type: "text", text: "change course", text_elements: [] }],
        },
      },
    },
    {
      id: "assistant-2",
      type: "assistant",
      agent: "agent",
      model: { id: "m", providerID: "p" },
      content: [{ type: "text", text: "changed" }],
      time: { created: 5, completed: 6 },
    },
    { id: "user-2", type: "user", text: "again", time: { created: 7 } },
    {
      id: "compaction-1",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "summary",
      recent: "recent",
      time: { created: 8 },
    },
  ], { id: "00000000-0000-4000-8000-000000000010", rootPath: "C:/repo" }, { settleUsage: true });

  assert.equal(result.latestOperation, "compaction");
  assert.equal(recorded.filter(entry => entry.kind === "turn").length, 2);
  assert.equal(recorded.filter(entry => entry.kind === "item").length, 7);
  assert.equal(recorded.some(entry => entry.kind === "item" && entry.item.type === "contextCompaction"), true);
  assert.equal(recorded.find(entry => entry.kind === "threadContextUsage")?.snapshot.tokenUsage, null);
  const toolObservation = recorded.find(entry => entry.kind === "item"
    && entry.item.type === "dynamicToolCall");
  assert.ok(toolObservation?.kind === "item");
  const tool = toolObservation.item;
  assert.ok(tool?.type === "dynamicToolCall");
  const { id: _admittedItemId, ...toolEvidence } = tool;
  assert.deepEqual(toolEvidence, {
    type: "dynamicToolCall",
    namespace: "opencode",
    tool: "execute",
    toolCallGroupId: "tool-1",
    metadata: { error: true },
    arguments: { code: "tools.wb.rg({})" },
    status: "failed",
    contentItems: [{ type: "inputText", text: "preserved result" }],
    success: false,
    durationMs: 1,
  });
  const [steer] = recorded.filter(entry => entry.kind === "steer");
  assert.deepEqual({
    clientUserMessageId: steer?.entry.clientUserMessageId,
    publicItemId: steer?.publicItemId,
    status: steer?.entry.status,
    turnId: steer?.entry.turnId,
  }, {
    clientUserMessageId: "00000000-0000-4000-8000-000000000021",
    publicItemId: "00000000-0000-4000-8000-000000000020",
    status: "sent",
    turnId: "00000000-0000-4000-8000-000000000002",
  });
  assert.deepEqual(admittedSources, [
    {
      turnId: "00000000-0000-4000-8000-000000000002",
      kind: "stable",
      reference: "user-1",
      component: { kind: "item", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000002",
      kind: "stable",
      reference: "assistant-1",
      component: { kind: "reasoning", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000002",
      kind: "stable",
      reference: "assistant-1",
      component: { kind: "text", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000002",
      kind: "stable",
      reference: "tool-1",
      component: { kind: "item", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000002",
      kind: "stable",
      reference: "steer-1",
      component: { kind: "item", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000002",
      kind: "stable",
      reference: "assistant-2",
      component: { kind: "text", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000003",
      kind: "stable",
      reference: "user-2",
      component: { kind: "item", index: 0 },
    },
    {
      turnId: "00000000-0000-4000-8000-000000000003",
      kind: "stable",
      reference: "compaction-1",
      component: { kind: "item", index: 0 },
    },
  ]);
});

test("keeps the latest turn open while a WB steer awaits native delivery", async () => {
  let turnState: string | undefined;
  let usage: Extract<WorkbenchTranscriptObservation, { kind: "threadContextUsage" }> | undefined;
  const adapter = new OpenCodeTranscriptAdapter({
    modelContext: async model => model.providerID === "p" && model.id === "m" ? 200_000 : null,
    threads: {
      observe: async () => ({ threadId: WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001") } as never),
      observeTurns: async inputs => inputs.map(input => ({
        threadId: input.threadId,
        turnId: WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002"),
        turnIndex: 0,
        native: {
          harness: input.harnessId,
          nativeLocation: input.nativeLocation,
          nativeThreadId: NativeThreadIdSchema.parse(input.nativeThreadId),
          nativeTurnId: NativeTurnIdSchema.parse(input.nativeTurnId),
        },
      })),
    },
    items: {
      admit: async inputs => inputs.map((input, index) => ({
        ...input,
        sources: input.sources.map(source => ({
          ...source,
          component: source.component ?? { kind: "item" as const, index: 0 },
        })),
        itemId: WorkbenchItemIdSchema.parse(`00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`),
      })),
      itemIdForSource: () => { throw new Error("not used"); },
    },
    transcript: {
      record: async observations => {
        turnState = observations.find(entry => entry.kind === "turn")?.state;
        usage = observations.find(entry => entry.kind === "threadContextUsage");
        return { changedThreadIds: [] };
      },
    },
  });

  const result = await adapter.record({
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 3 }, location: { directory: "C:/repo" },
  }, [{
    id: "user", type: "user", text: "hello", time: { created: 1 },
  }, {
    id: "assistant", type: "assistant", agent: "agent", model: { id: "m", providerID: "p" },
    content: [{ type: "text", text: "done" }], time: { created: 2, completed: 3 },
    tokens: { input: 100, output: 13, reasoning: 5, cache: { read: 11, write: 7 } },
  }], {
    id: "00000000-0000-4000-8000-000000000010",
    rootPath: "C:/repo",
  }, { keepLatestTurnOpen: true, settleUsage: true });

  assert.equal(turnState, "inProgress");
  assert.equal(result.latestTurnState, "inProgress");
  assert.deepEqual(usage?.snapshot.tokenUsage?.last, {
    cacheWriteInputTokens: 7,
    cachedInputTokens: 11,
    inputTokens: 118,
    outputTokens: 13,
    reasoningOutputTokens: 5,
    totalTokens: 136,
  });
  assert.equal(usage?.snapshot.tokenUsage?.modelContextWindow, 200_000);
});

test("a fresh Workbench steer admits its own item identity, stays held outside the transcript, and enters it on delivery", async context => {
  const fixture = createThreadStateTestDatabase();
  context.after(() => fixture.sqlite.close());
  fixture.admitThread(testProjectIds.project, "wb-thread", "opencode", "session", "C:/repo");
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  const adapter = new OpenCodeTranscriptAdapter({
    ...fixture.identities,
    transcript: { record: async observations => repository.settle(observations) },
  });
  const session = {
    id: "session", projectID: "project", title: "Thread", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, location: { directory: "C:/repo" },
  };
  await adapter.record(session, [{ id: "root", type: "user", text: "work", time: { created: 1 } }],
    { id: testProjectIds.project, rootPath: "C:/repo" });
  const turnId = WorkbenchTurnIdSchema.parse(repository.read({ threadId: "wb-thread", turnLimit: 1 })!.turns.at(-1)!.id);
  const itemId = WorkbenchItemIdSchema.parse("00000000-0000-4000-8000-000000000030");
  const pending = {
    threadId: WorkbenchThreadIdSchema.parse("wb-thread"), turnId, itemId, entryKey: itemId,
    input: [{ type: "text" as const, text: "steer", text_elements: [] }], status: "pending" as const,
    attemptedAt: 2, resolvedAt: null, requestId: null, canonicalItemId: null, clientUserMessageId: "steer-client",
    dispatchSequence: null, error: null,
  };
  const steerItems = () => {
    const projected = projectWorkbenchTranscript(repository.read({ threadId: "wb-thread", turnLimit: 1 })!);
    assert.ok(projected.success);
    return projected.data.turns.flatMap(turn => turn.items).filter(item => item.id === itemId);
  };
  const held = () => repository.read({ threadId: "wb-thread", turnLimit: 1 })!.rows.threadHeldSteers.map(({ public_id }) => public_id);
  await adapter.recordSteer(pending);
  assert.equal(steerItems().length, 0);
  assert.deepEqual(held(), [itemId]);
  await adapter.recordSteer({ ...pending, status: "sent", resolvedAt: 3 });
  assert.equal(steerItems().length, 1, "delivery gives the admitted identity its transcript item");
  assert.deepEqual(held(), []);
});
