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

  await adapter.record({
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
