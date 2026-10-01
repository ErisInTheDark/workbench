/* No production exports. Tests protect Claude streamed text admission: live deltas once, one durable body, and no echo. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");

type Recorded = { kind: string; publicItemId?: string; lifecycle?: string; item?: { type: string; text?: string; content?: string[] } };

function fixture() {
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
  } as never);
  const items = () => records.filter(record => record.kind === "item"
    && record.item?.type !== "userMessage");
  return { adapter, items, live };
}

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
