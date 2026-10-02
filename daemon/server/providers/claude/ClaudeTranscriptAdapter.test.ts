/* No production exports. Tests protect Claude streamed text admission (live deltas once, one durable body, no echo) and native file-tool evidence. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");

type Recorded = { kind: string; publicItemId?: string; lifecycle?: string; item?: {
  type: string; text?: string; content?: string[]; status?: string; metadata?: unknown;
} };

function fixture(assets?: object) {
  const records: Recorded[] = [];
  const live: { itemId: string; text: string; append: boolean }[] = [];
  const adapter = new ClaudeTranscriptAdapter({
    threads: {
      observe: async () => ({ threadId }),
      observeTurn: async () => ({ turnId, turnIndex: 0 }),
    },
    items: {
      admit: async (requests: { sources: { reference: string }[] }[]) =>
        requests.map(request => ({ itemId: `item:${request.sources[0]!.reference}` })),
    },
    transcript: {
      record: async (observations: Recorded[]) => {
        records.push(...observations);
        return { changedThreadIds: [] };
      },
      acceptLiveUpdate: (update: { itemId: string; text: string; append: boolean }) => { live.push(update); },
      readContextUsage: async () => null,
    },
    ...(assets ? { assets } : {}),
  } as never);
  const items = () => records.filter(record => record.kind === "item"
    && record.item?.type !== "userMessage");
  return { adapter, items, live, records };
}

test("a delivered screenshot records as the marked image steer with its bytes stored as an asset", async () => {
  const writes: { threadId: string; mimeType: string }[] = [];
  const { adapter, records } = fixture({
    writeTranscriptAsset: async (input: { threadId: string; mimeType: string }) => {
      writes.push({ threadId: input.threadId, mimeType: input.mimeType });
      return { assetUrl: `/api/transcript-assets/${threadId}/${"a".repeat(64)}.png`, byteLength: 3, digest: "a".repeat(64), mimeType: "image/png" };
    },
  });
  await adapter.recordScreenshotSteer(threadId, turnId, "data:image/png;base64,AAAA");
  const item = records.find(record => record.kind === "item")?.item as unknown as Parameters<typeof isAgentScreenshotSteerUserMessage>[0];
  assert.ok(item && isAgentScreenshotSteerUserMessage(item));
  assert.deepEqual(writes, [{ threadId, mimeType: "image/png" }]);
  assert.equal(JSON.stringify(item).includes("base64"), false, "screenshot bytes belong in asset storage, not the transcript row");
});

const stream = (event: object) => ({ type: "stream_event", parent_tool_use_id: null, event }) as never;
const assistant = (content: object[]) => ({
  type: "assistant", parent_tool_use_id: null, uuid: "assistant-uuid",
  message: { id: "msg_1", content, usage: { input_tokens: 1, output_tokens: 1 } },
}) as never;

test("streamed text shows each delta once and settles into one durable body without an echo", async () => {
  const { adapter, items, live } = fixture();
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "message_start", message: { id: "msg_1" } }));
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }));
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }));
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "content_block_stop", index: 0 }));
  await adapter.recordAssistant(threadId, turnId, assistant([{ type: "text", text: "Hello" }]));
  assert.deepEqual(live.map(update => [update.text, update.append]), [["Hel", true], ["lo", true]]);
  const bodies = items();
  assert.deepEqual(bodies.map(record => record.lifecycle), ["streaming", "completed"]);
  assert.equal(new Set(bodies.map(record => record.publicItemId)).size, 1, "the streamed item settles in place");
  assert.equal(bodies.at(-1)?.item?.text, "Hello");
});

test("an unstreamed reply records its text without a live append", async () => {
  const { adapter, items, live } = fixture();
  await adapter.recordAssistant(threadId, turnId, assistant([{ type: "text", text: "Whole" }]));
  assert.deepEqual(live, []);
  assert.deepEqual(items().map(record => [record.lifecycle, record.item?.text]), [["completed", "Whole"]]);
});

const toolResult = (id: string, isError: boolean, toolUseResult?: object) => ({
  type: "user", parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: isError ? "denied" : "ok", is_error: isError }] },
  ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
}) as never;
const fileTool = (id: string, tool: string, filePath: string) => assistant([{ type: "tool_use", id, name: tool, input: { file_path: filePath } }]);

test("native Edit and Write record the effective diff Claude applied, not the call's arguments", async () => {
  const { adapter, items } = fixture();
  await adapter.recordAssistant(threadId, turnId, fileTool("edit", "Edit", "C:/repo/a.ts"));
  await adapter.recordNativeToolResults(threadId, toolResult("edit", false, {
    filePath: "C:/repo/a.ts", oldString: "b", newString: "B", originalFile: "a\nb\nc\n", replaceAll: false, userModified: false,
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] }],
  }));
  await adapter.recordAssistant(threadId, turnId, fileTool("write", "Write", "C:/repo/new.ts"));
  await adapter.recordNativeToolResults(threadId, toolResult("write", false, {
    type: "create", filePath: "C:/repo/new.ts", content: "one\ntwo\n", structuredPatch: [], originalFile: null,
  }));
  await adapter.recordAssistant(threadId, turnId, fileTool("stray", "Edit", "C:/repo/target.ts"));
  await adapter.recordNativeToolResults(threadId, toolResult("stray", false, {
    filePath: "C:/repo/other.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }],
  }));
  const settled = items().filter(record => record.item?.status === "completed").map(record => record.item?.metadata);
  assert.deepEqual(settled, [
    { fileChange: { kind: "update", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c" } },
    { fileChange: { kind: "add", diff: "one\ntwo\n" } },
    undefined,
  ], "a result for a different path is never attributed to the call");
});

test("a claim denial marks only the denied call's failed result as unclaimed", async () => {
  const { adapter, items } = fixture();
  adapter.recordNativeToolDenial(turnId, "denied");
  await adapter.recordAssistant(threadId, turnId, fileTool("denied", "Write", "C:/repo/a.ts"));
  await adapter.recordAssistant(threadId, turnId, fileTool("broken", "Edit", "C:/repo/b.ts"));
  await adapter.recordNativeToolResults(threadId, toolResult("denied", true));
  await adapter.recordNativeToolResults(threadId, toolResult("broken", true));
  assert.deepEqual(items().filter(record => record.item?.status === "failed").map(record => record.item?.metadata),
    [{ workbenchFailureKind: "unclaimed" }, undefined]);
});

test("settling a turn completes a block that was cut off mid-stream with the text that arrived", async () => {
  const { adapter, items } = fixture();
  await adapter.startTurn({ threadId, sessionId: "session", cwd: "C:/repo", clientMessageId: turnId, content: [] });
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "message_start", message: { id: "msg_1" } }));
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
  await adapter.recordStreamEvent(threadId, turnId, stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "par" } }));
  await adapter.settleTurn(turnId, "interrupted");
  const last = items().at(-1);
  assert.equal(last?.lifecycle, "completed");
  assert.deepEqual(last?.item?.content, ["par"]);
});
