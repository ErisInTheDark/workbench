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
import OpenCodeTranscriptAdapter, { openCodeToolContentItems } from "./OpenCodeTranscriptAdapter";
import { createThreadStateTestDatabase } from "../../workbench-thread-state-test-database";
import WorkbenchTranscriptRepository from "../../database/transcript/WorkbenchTranscriptRepository";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import WorkbenchTranscriptLiveController from "../../database/transcript/WorkbenchTranscriptLiveController";
import OpenCodeEventController from "./OpenCodeEventController";
import { writeTranscriptText, readTranscriptText } from "workbench-shared/workbench/transcript/thread-transcript-stream";

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
    threads: { currentTurn: () => active, latestTurn: async () => ({ id: active.turnId }),
      acceptExecutionEvent: () => true, completeExecution: async () => undefined, executionIntentVersion: () => 0,
      syncNative: async () => admitted, markExecutionSettled: () => undefined, markExecutionStarted: () => undefined },
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
  await adapter.record({
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
