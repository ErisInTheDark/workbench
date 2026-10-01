/* No production exports. Tests protect event-boundary forwarding and clean synthetic endings. */
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";
import OpenCodeSseTap, { type OpenCodeSseTapClose } from "./OpenCodeSseTap";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function upstream(chunks: string[]) {
  let index = 0;
  let cancelled: unknown;
  let hang!: () => void;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
      else await new Promise<void>(resolve => { hang = resolve; });
    },
    cancel(reason) { cancelled = reason; hang?.(); },
  }, { highWaterMark: 0 });
  const input = { kind: "primary", sessionID: "session",
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }) } as SessionHttpResponse;
  return { input, cancelled: () => cancelled };
}

test("events split across provider chunks reach OpenCode whole", async () => {
  const { input } = upstream(["data: {\"a\"", ":1}\n\ndata: b\r", "\n\r\n"]);
  const events: string[] = [];
  OpenCodeSseTap.wrap(input, { event: data => events.push(data) });
  const reader = input.response.body!.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "data: {\"a\":1}\n\n");
  assert.deepEqual(events, ["{\"a\":1}"]);
  assert.equal(decoder.decode((await reader.read()).value), "data: b\r\n\r\n");
  assert.deepEqual(events, ["{\"a\":1}", "b"]);
  await reader.cancel();
});

test("a cut while OpenCode waits on the provider ends cleanly and cancels the provider", async () => {
  const { input, cancelled } = upstream(["data: one\n\n"]);
  const closed: OpenCodeSseTapClose[] = [];
  const tap = OpenCodeSseTap.wrap(input, { closed: async reason => { closed.push(reason); } });
  const reader = input.response.body!.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "data: one\n\n");
  const waiting = reader.read();
  assert.equal(await tap.cut("data: end\n\n"), true);
  assert.equal(decoder.decode((await waiting).value), "data: end\n\n");
  assert.equal((await reader.read()).done, true);
  assert.ok(cancelled());
  assert.deepEqual(closed, ["cut"]);
  assert.equal(await tap.cut("data: again\n\n"), false);
});

test("a cut decided after observing a segment forwards that segment but never a partial event", async () => {
  const { input } = upstream(["data: seen\n\ndata: {\"partial\""]);
  let tap!: OpenCodeSseTap;
  tap = OpenCodeSseTap.wrap(input, { settle: async () => { await tap.cut("data: end\n\n"); } });
  assert.equal(await input.response.text(), "data: seen\n\ndata: end\n\n");
});

test("observation failure keeps forwarding native bytes", async () => {
  const { input } = upstream(["data: bad\n\n", "data: next\n\n"]);
  const failures: unknown[] = [];
  OpenCodeSseTap.wrap(input, {
    event: () => { throw new Error("observer bug"); },
    failed: async error => { failures.push(error); },
  });
  const reader = input.response.body!.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "data: bad\n\n");
  assert.equal(decoder.decode((await reader.read()).value), "data: next\n\n");
  assert.equal(failures.length, 1);
  await reader.cancel();
});
